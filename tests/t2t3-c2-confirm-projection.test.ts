import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock } from '../src/ports/index.ts';
import type { CapabilityRepository } from '../src/ports/index.ts';
import { createConfirmItemHandler } from '../src/http/handlers/resume-items.ts';
import { PROJECTION_EVIDENCE_TYPE, PROJECTION_SOURCE } from '../src/domain/capability/project.ts';

/**
 * V2 · T2→T3 桥接 · C2 —— confirm 主路径接入投影（聚焦验证）
 *
 * 目标链路：
 *   PATCH /api/resumes/:id/items/:itemId → CONFIRMED → projectConfirmedSkills(userId) → Capability
 *
 * 只验证 C2 这一小步；C3(reconcile) / C4(页面入口) 不在此覆盖。
 * 事实安全重点：投影失败**绝不伪造** Capability；确认的既有行为不得回归。
 */

const dbUp = await (async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();
const skip = dbUp ? false : 'PostgreSQL 不可达';
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const repos = createPrismaRepositories(prisma);

const auth = () =>
  createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });

async function signUp(tag: string) {
  const r = await auth().register({ email: `qa_c2_${tag}_${stamp}@example.com`, password: 'password-1234' });
  return { token: r.token, userId: r.user.id };
}

/** C2 必填依赖 capabilities：测试构造必须显式接线（漏接线由 tsc 拒绝） */
function handler(capabilitiesOverride?: CapabilityRepository) {
  return createConfirmItemHandler({
    auth: auth(),
    resumes: repos.resumes,
    capabilities: capabilitiesOverride ?? repos.capabilities,
  });
}

const patch = (resumeId: string, itemId: string, token: string) =>
  new Request(`http://qa/api/resumes/${resumeId}/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: `jp_session=${token}` },
    body: JSON.stringify({ kind: 'SKILL', confirm: true }),
  });

/**
 * 主路径夹具：python(可确认) + noevidence(无证据)。
 * 不含"预先已 CONFIRMED"的条目 —— 投影会扫描该用户**全部** CONFIRMED 技能，
 * 混入预确认条目会让计数断言失真（该场景单独用 seedResumeWithPreConfirmed）。
 */
async function seedResume(userId: string) {
  return prisma.resume.create({
    data: {
      userId,
      rawText: 'QA 简历',
      sourceType: 'TEXT',
      skills: {
        create: [
          {
            key: 'python',
            label: 'Python',
            level: '熟练',
            status: 'UNCONFIRMED',
            evidence: { create: [{ source: 'RESUME_TEXT', locator: 'resume:line:2', excerpt: '使用 Python 完成数据处理' }] },
          },
          { key: 'noevidence', label: 'NoEvidence', status: 'UNCONFIRMED' },
        ],
      },
    },
    select: { id: true, skills: { select: { id: true, key: true } } },
  });
}

/** 边界夹具：额外带一条**已 CONFIRMED**的条目，用于验证"无状态迁移 → 不触发投影" */
async function seedResumeWithPreConfirmed(userId: string) {
  return prisma.resume.create({
    data: {
      userId,
      rawText: 'QA 简历',
      sourceType: 'TEXT',
      skills: {
        create: [
          {
            key: 'preconfirmed',
            label: 'PreConfirmed',
            status: 'CONFIRMED',
            evidence: { create: [{ source: 'RESUME_TEXT', locator: 'resume:line:3', excerpt: 'PreConfirmed' }] },
          },
        ],
      },
    },
    select: { id: true, skills: { select: { id: true, key: true } } },
  });
}

const skillOf = (resume: { skills: Array<{ id: string; key: string }> }, key: string) => {
  const found = resume.skills.find((s) => s.key === key);
  assert.ok(found, `夹具缺少技能 ${key}`);
  return found!;
};

/* ═══════════ 主路径 ═══════════ */

test('C2-a 确认成功 → Capability 出现，status/source/证据均正确，既有响应体不变', { skip }, async () => {
  const a = await signUp('ok');
  const resume = await seedResume(a.userId);
  const python = skillOf(resume, 'python');

  const res = await handler()(patch(resume.id, python.id, a.token), resume.id, python.id);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown };
  assert.deepEqual(body.data, { itemId: python.id, status: 'CONFIRMED', confirmed: true }, '既有确认响应体不得改变');

  // Skill 已确认（既有行为）
  const skill = await prisma.skill.findUniqueOrThrow({ where: { id: python.id }, select: { status: true } });
  assert.equal(skill.status, 'CONFIRMED');

  // Capability 已投影
  const cap = await prisma.capability.findUnique({
    where: { userId_key: { userId: a.userId, key: 'python' } },
    include: { evidence: true },
  });
  assert.ok(cap, '确认成功后必须出现 Capability');
  assert.equal(cap!.status, 'CONFIRMED', '投影出的能力状态必须是 CONFIRMED');
  assert.equal(cap!.source, PROJECTION_SOURCE);
  assert.equal(cap!.label, 'Python');
  assert.equal(cap!.level, '熟练');
  assert.equal(cap!.evidence.length, 1, '证据必须随投影带过来');
  assert.equal(cap!.evidence[0].type, PROJECTION_EVIDENCE_TYPE);
  assert.equal(cap!.evidence[0].source, 'RESUME_TEXT');
  assert.ok((cap!.evidence[0].excerpt ?? '').length > 0, '证据必须可核验');

  // 只投影了刚确认的这一条
  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 1);
});

/* ═══════════ 不投影的场景 ═══════════ */

test('C2-b 无有效证据 → 确认被拒(422)，且不产生任何 Capability', { skip }, async () => {
  const a = await signUp('noev');
  const resume = await seedResume(a.userId);
  const noEvidence = skillOf(resume, 'noevidence');

  const res = await handler()(patch(resume.id, noEvidence.id, a.token), resume.id, noEvidence.id);
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'ITEM_NOT_CONFIRMABLE');

  assert.equal(
    await prisma.capability.findUnique({ where: { userId_key: { userId: a.userId, key: 'noevidence' } } }),
    null,
    '被拒的确认绝不能投影出 Capability',
  );
  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 0);
});

test('C2-c UNCONFIRMED 条目不会被投影（投影只扫 CONFIRMED）', { skip }, async () => {
  const a = await signUp('unconf');
  const resume = await seedResume(a.userId);
  const python = skillOf(resume, 'python');

  // 只确认 python；noevidence / preconfirmed 保持各自状态
  await handler()(patch(resume.id, python.id, a.token), resume.id, python.id);

  assert.equal(
    await prisma.capability.findUnique({ where: { userId_key: { userId: a.userId, key: 'noevidence' } } }),
    null,
    'UNCONFIRMED 条目不得被投影',
  );
});

test('C2-d 已是 CONFIRMED（未经主路径）→ 重复确认被拒且**不补投影**（该缺口由 C3 reconcile 承担）', { skip }, async () => {
  const a = await signUp('pre');
  const resume = await seedResumeWithPreConfirmed(a.userId);
  const pre = skillOf(resume, 'preconfirmed');

  const res = await handler()(patch(resume.id, pre.id, a.token), resume.id, pre.id);
  assert.equal(res.status, 422, '已 CONFIRMED 再确认必须 422（既有行为）');
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'ITEM_NOT_CONFIRMABLE');

  // 如实记录当前边界：无状态迁移 → 不触发投影 → 该 Skill 尚无 Capability。
  // 这正是 C3「生成 ActionPlan 前 reconcile」要修复的场景，不是 C2 的缺陷。
  assert.equal(
    await prisma.capability.findUnique({ where: { userId_key: { userId: a.userId, key: 'preconfirmed' } } }),
    null,
  );
});

/* ═══════════ 幂等 ═══════════ */

test('C2-e 重复确认 / 重复投影 → 不产生重复 Capability 或重复 Evidence', { skip }, async () => {
  const a = await signUp('idem');
  const resume = await seedResume(a.userId);
  const python = skillOf(resume, 'python');

  await handler()(patch(resume.id, python.id, a.token), resume.id, python.id);
  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 1);

  const again = await handler()(patch(resume.id, python.id, a.token), resume.id, python.id);
  assert.equal(again.status, 422, '重复确认仍是 422（既有行为）');
  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 1, '不得产生重复 Capability');

  // 显式重复投影（模拟 C3 reconcile 重复执行）
  const reproject = await repos.capabilities.projectConfirmedSkills(a.userId);
  assert.equal(reproject.created, 0);
  assert.equal(reproject.updated, 0);
  assert.equal(reproject.unchanged, 1);

  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 1);
  const cap = await prisma.capability.findUniqueOrThrow({
    where: { userId_key: { userId: a.userId, key: 'python' } },
    include: { evidence: true },
  });
  assert.equal(cap.evidence.length, 1, '证据不得堆积');
});

/* ═══════════ 用户隔离 ═══════════ */

test('C2-f 用户隔离：跨用户确认 404，且双方都不产生 Capability', { skip }, async () => {
  const a = await signUp('isoA');
  const b = await signUp('isoB');
  const resumeA = await seedResume(a.userId);
  const pythonA = skillOf(resumeA, 'python');

  const cross = await handler()(patch(resumeA.id, pythonA.id, b.token), resumeA.id, pythonA.id);
  assert.equal(cross.status, 404, '跨用户确认必须 404');

  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 0);
  assert.equal(await prisma.capability.count({ where: { userId: b.userId } }), 0);
  const skill = await prisma.skill.findUniqueOrThrow({ where: { id: pythonA.id }, select: { status: true } });
  assert.equal(skill.status, 'UNCONFIRMED', '被拒的跨用户请求不得改动源条目');
});

/* ═══════════ 事实安全：投影失败绝不伪造 ═══════════ */

test('C2-g 投影失败 → 确认仍成功且**不伪造** Capability；随后显式投影可修复', { skip }, async () => {
  const a = await signUp('failproj');
  const resume = await seedResume(a.userId);
  const python = skillOf(resume, 'python');

  const failing: CapabilityRepository = {
    ...repos.capabilities,
    projectConfirmedSkills: async () => {
      throw new Error('QA 注入：投影失败');
    },
  };

  const res = await handler(failing)(patch(resume.id, python.id, a.token), resume.id, python.id);
  assert.equal(res.status, 200, '投影失败不得阻断确认（既有行为不变）');
  assert.equal(((await res.json()) as { data: { status: string } }).data.status, 'CONFIRMED');

  const skill = await prisma.skill.findUniqueOrThrow({ where: { id: python.id }, select: { status: true } });
  assert.equal(skill.status, 'CONFIRMED');

  assert.equal(
    await prisma.capability.count({ where: { userId: a.userId } }),
    0,
    '投影失败时绝不能伪造出 Capability（fail closed）',
  );

  // 证明该缺口可被后续 reconcile 修复（C3 的价值，此处只验证可修复性）
  const repaired = await repos.capabilities.projectConfirmedSkills(a.userId);
  assert.equal(repaired.created, 1, '显式重投可补齐');
  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 1);
});

/* ═══════════ 清理 ═══════════ */

test('C2-99 清理', { skip }, async () => {
  const users = await prisma.user.findMany({ where: { email: { contains: `_${stamp}@example.com` } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.$disconnect();
});
