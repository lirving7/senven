import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import {
  buildCapabilityProjection,
  evidenceKey,
  usableEvidence,
  PROJECTION_EVIDENCE_TYPE,
  PROJECTION_SOURCE,
} from '../src/domain/capability/project.ts';

/**
 * V2 · T2→T3 桥接 · C1 —— Capability 投影服务（聚焦验证）
 *
 * 只验证 C1 这一小步：Skill → Capability 投影本身。
 * 不覆盖 C2(confirm 接入) / C3(reconcile) / C4(入口) —— 那些各自有自己的验证。
 *
 * 重点盯住事实安全（对应验收 B7）：
 *   B7.3 无可用证据 → 不投影（fail closed）
 *   B7.5 不凭空制造 CONFIRMED 事实
 *   B7.2 幂等：重复调用不产生重复数据
 *   B7.4 单向：不修改源 Skill
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

/* ═══════════ 纯函数层：事实安全规则 ═══════════ */

const ev = (source: string, locator: string, excerpt: string | null) => ({ id: `ev:${source}:${locator}`, source, locator, excerpt });

test('C1-a 非 CONFIRMED 的源条目一律不投影', () => {
  const base = { key: 'python', label: 'Python', level: '熟练', evidence: [ev('RESUME_TEXT', 'resume:line:2', 'Python')] };
  for (const status of ['UNCONFIRMED', 'INFERRED', 'MISSING']) {
    assert.equal(buildCapabilityProjection({ ...base, status }), null, `${status} 不得投影`);
  }
  assert.ok(buildCapabilityProjection({ ...base, status: 'CONFIRMED' }), 'CONFIRMED 应可投影');
});

test('C1-b 无可用证据 → 不投影（fail closed）', () => {
  const base = { key: 'python', label: 'Python', level: null, status: 'CONFIRMED' };
  assert.equal(buildCapabilityProjection({ ...base, evidence: [] }), null, '无证据不得投影');
  assert.equal(buildCapabilityProjection({ ...base, evidence: [ev('RESUME_TEXT', '', 'Python')] }), null, 'locator 为空不得投影');
  assert.equal(buildCapabilityProjection({ ...base, evidence: [ev('RESUME_TEXT', 'resume:line:2', '   ')] }), null, 'excerpt 空白不得投影');
  assert.equal(buildCapabilityProjection({ ...base, evidence: [ev('RESUME_TEXT', '  ', null)] }), null, 'excerpt 为 null 不得投影');
});

test('C1-c 可用证据判定与 confirmItem 一致（locator 与 excerpt 都非空）', () => {
  const rows = [ev('RESUME_TEXT', 'resume:line:2', 'Python'), ev('RESUME_TEXT', '', 'X'), ev('RESUME_TEXT', 'resume:line:3', null)];
  assert.equal(usableEvidence(rows).length, 1);
});

test('C1-d 投影字段映射正确，且证据按 (source, excerpt) 去重', () => {
  const projection = buildCapabilityProjection({
    key: 'python',
    label: 'Python',
    level: '熟练',
    status: 'CONFIRMED',
    evidence: [ev('RESUME_TEXT', 'resume:line:2', '  Python  '), ev('RESUME_TEXT', 'resume:line:5', 'Python')],
  });
  assert.ok(projection);
  assert.equal(projection!.status, 'CONFIRMED');
  assert.equal(projection!.source, PROJECTION_SOURCE);
  assert.equal(projection!.key, 'python');
  assert.equal(projection!.label, 'Python');
  assert.equal(projection!.level, '熟练');
  assert.equal(projection!.evidence.length, 1, '相同 (source, excerpt) 必须去重');
  assert.deepEqual(projection!.evidence[0], {
    type: PROJECTION_EVIDENCE_TYPE,
    source: 'RESUME_TEXT',
    url: null,
    excerpt: 'Python',
    resumeEvidenceId: 'ev:RESUME_TEXT:resume:line:2',
  });
  assert.equal(evidenceKey({ source: 'RESUME_TEXT', excerpt: 'Python' }), evidenceKey({ source: 'RESUME_TEXT', excerpt: ' Python ' }));
});

/* ═══════════ 仓储层：真实 Prisma ═══════════ */

async function seedUser(tag: string) {
  const u = await prisma.user.create({ data: { email: `qa_c1_${tag}_${stamp}@example.com` }, select: { id: true } });
  return u.id;
}

/** 一个简历里放 3 条技能：CONFIRMED+证据 / CONFIRMED 但无证据 / UNCONFIRMED+证据 */
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
            status: 'CONFIRMED',
            evidence: { create: [{ source: 'RESUME_TEXT', locator: 'resume:line:2', excerpt: '使用 Python 完成数据处理' }] },
          },
          { key: 'noevidence', label: 'NoEvidence', status: 'CONFIRMED' },
          {
            key: 'docker',
            label: 'Docker',
            status: 'UNCONFIRMED',
            evidence: { create: [{ source: 'RESUME_TEXT', locator: 'resume:line:3', excerpt: 'Docker' }] },
          },
        ],
      },
    },
    select: { id: true },
  });
}

test('C1-e 投影：只投影 CONFIRMED 且有证据者；无证据者 fail closed', { skip }, async () => {
  const userId = await seedUser('proj');
  await seedResume(userId);

  const result = await repos.capabilities.projectConfirmedSkills(userId);
  assert.equal(result.created, 1, '只有 python 应被投影');
  assert.equal(result.skipped, 1, 'CONFIRMED 但无证据者必须被跳过');
  assert.equal(result.updated, 0);

  const projected = await prisma.capability.findUnique({
    where: { userId_key: { userId, key: 'python' } },
    include: { evidence: true },
  });
  assert.ok(projected, 'python 应形成 Capability');
  assert.equal(projected!.status, 'CONFIRMED');
  assert.equal(projected!.source, PROJECTION_SOURCE);
  assert.equal(projected!.evidence.length, 1, '证据必须随投影带过来');
  assert.ok((projected!.evidence[0].excerpt ?? '').length > 0, '证据必须可核验');

  const noEvidence = await prisma.capability.findUnique({ where: { userId_key: { userId, key: 'noevidence' } } });
  assert.equal(noEvidence, null, '无可用证据绝不能产生 Capability（不凭空制造事实）');

  const unconfirmed = await prisma.capability.findUnique({ where: { userId_key: { userId, key: 'docker' } } });
  assert.equal(unconfirmed, null, 'UNCONFIRMED 源条目不得投影');
});

test('C1-f 幂等：重复投影不产生重复数据，且无变化时不写库', { skip }, async () => {
  const userId = await seedUser('idem');
  await seedResume(userId);

  const first = await repos.capabilities.projectConfirmedSkills(userId);
  assert.equal(first.created, 1);

  const second = await repos.capabilities.projectConfirmedSkills(userId);
  assert.equal(second.created, 0, '第二次不得再次创建');
  assert.equal(second.updated, 0, '无变化时不应写库');
  assert.equal(second.unchanged, 1, '应识别为无变化');

  assert.equal(await prisma.capability.count({ where: { userId } }), 1, 'Capability 不得重复');
  const cap = await prisma.capability.findUniqueOrThrow({ where: { userId_key: { userId, key: 'python' } }, include: { evidence: true } });
  assert.equal(cap.evidence.length, 1, '证据不得堆积');
});

test('C1-g 单向：投影不得修改源 Skill', { skip }, async () => {
  const userId = await seedUser('oneside');
  const resume = await seedResume(userId);

  const before = await prisma.skill.findMany({
    where: { resumeId: resume.id },
    select: { id: true, key: true, label: true, status: true },
    orderBy: { key: 'asc' },
  });

  await repos.capabilities.projectConfirmedSkills(userId);

  const after = await prisma.skill.findMany({
    where: { resumeId: resume.id },
    select: { id: true, key: true, label: true, status: true },
    orderBy: { key: 'asc' },
  });

  assert.deepEqual(after, before, '投影必须单向，不得改动 Skill');
});

test('C1-h 用户隔离：只投影本人的 CONFIRMED 技能', { skip }, async () => {
  const a = await seedUser('isoA');
  const b = await seedUser('isoB');
  await seedResume(a);

  const result = await repos.capabilities.projectConfirmedSkills(b);
  assert.equal(result.created, 0, 'B 没有任何技能，不得投影出任何 Capability');
  assert.equal(await prisma.capability.count({ where: { userId: b } }), 0);
  assert.equal(await prisma.capability.count({ where: { userId: a } }), 0, '不得越权投影 A 的数据');
});

/* ═══════════ 清理 ═══════════ */

test('C1-99 清理', { skip }, async () => {
  const users = await prisma.user.findMany({ where: { email: { contains: `_${stamp}@example.com` } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.$disconnect();
});
