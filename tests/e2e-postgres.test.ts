import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryCounter, createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock } from '../src/ports/index.ts';
import { createCreateMatchHandler } from '../src/http/handlers/matches.ts';
import {
  createGenerateSuggestionsHandler,
  createResolveSuggestionHandler,
} from '../src/http/handlers/suggestions.ts';
import {
  createCreateVersionHandler,
  createDownloadVersionPdfHandler,
} from '../src/http/handlers/resume-versions.ts';
import {
  createCreateApplicationHandler,
  createListApplicationsHandler,
  createUpdateApplicationHandler,
  DEFAULT_PAGE_SIZE,
} from '../src/http/handlers/applications.ts';
import { postJson, bodyOf } from './fakes.ts';

/**
 * 真实数据库 E2E。
 * 目的：验证 Prisma schema / 关系 / 事务 / JSON 字段在**真实 PostgreSQL** 上成立
 * —— 这是 Mock 测试永远无法覆盖的部分。
 *
 * 唯一的替身是 LLM：没有 API Key，因此不跑真实模型调用。其余全部走真实实现。
 * PostgreSQL 不可达时整份文件 skip，不产生假通过。
 */

const dbUp = await (async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

const skip = dbUp ? false : 'PostgreSQL 不可达，跳过真实库 E2E';
// 文件级唯一标记：仅含 Date.now() 会在并行加载时与其他文件撞号，导致清理误删他人 fixture
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const repos = createPrismaRepositories(prisma);

function auth() {
  return createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });
}

/** 建立一份「T2 已产出」的简历：CONFIRMED 技能 + 带 locator/excerpt 的证据 */
async function seedResume(userId: string, tag: string) {
  const resume = await prisma.resume.create({
    data: {
      userId,
      rawText: `${tag} 简历原文`,
      sourceType: 'TEXT',
      skills: {
        create: [
          { key: 'python', label: 'Python', status: 'CONFIRMED', level: '参与数据处理' },
          { key: 'kotlin', label: 'Kotlin', status: 'UNCONFIRMED' },
        ],
      },
    },
    select: { id: true, skills: { select: { id: true, key: true } } },
  });

  const python = resume.skills.find((s) => s.key === 'python');
  assert.ok(python);
  await prisma.evidence.create({
    data: {
      source: 'RESUME_TEXT',
      locator: 'resume:line:12',
      excerpt: '使用 Python 完成数据处理',
      skillId: python.id,
    },
  });
  return resume.id;
}

async function seedJd(userId: string, tag: string) {
  return repos.jds.createWithRequirements({
    userId,
    rawText: `${tag} JD 原文`,
    title: 'AI 应用开发工程师',
    company: '云枢智能',
    contentHash: `hash_${tag}`,
    reqs: {
      create: [
        { text: '精通 Python', category: 'TECH', criticality: 'MUST' },
        { text: '熟悉 RAG 检索增强', category: 'TECH', criticality: 'MUST' },
      ],
    },
  });
}

async function signUp(email: string) {
  const result = await auth().register({ email, password: 'password-1234' });
  return { token: result.token, userId: result.user.id };
}

test('E2E-01 注册写入真实库：User 与 Session 落库，密码为哈希', { skip }, async () => {
  const email = `e2e_a_${stamp}@example.com`;
  const { userId } = await signUp(email);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  assert.ok(user);
  assert.equal(user.email, email);
  assert.ok(user.passwordHash?.startsWith('scrypt$'));

  const sessions = await prisma.session.findMany({ where: { userId } });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].tokenHash.length, 64, 'session 只存 sha256 哈希');
});

test('E2E-02 简历事实从真实库读出（Skill + Evidence → Fact）', { skip }, async () => {
  const { userId } = await signUp(`e2e_b_${stamp}@example.com`);
  const resumeId = await seedResume(userId, 'b');

  const facts = await repos.resumeFacts.findFactsForResume(resumeId, userId);
  assert.ok(facts);
  const python = facts.find((f) => f.key === 'python');
  assert.ok(python);
  assert.equal(python.status, 'CONFIRMED');
  assert.equal(python.evidence[0].locator, 'resume:line:12');
  assert.equal(python.evidence[0].excerpt, '使用 Python 完成数据处理');
});

test('E2E-03 完整链路：JD → 匹配 → MatchRun/MatchItem 真实落库并可读回', { skip }, async () => {
  const { token, userId } = await signUp(`e2e_c_${stamp}@example.com`);
  const resumeId = await seedResume(userId, 'c');
  const jd = await seedJd(userId, 'c');

  const post = createCreateMatchHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    jdRepo: repos.jds,
    matchRepo: repos.matches,
  });
  const res = await post(postJson('http://t/api/matches', { resumeId, jdId: jd.id }, token));
  assert.equal(res.status, 201, `期望 201，实际 ${res.status}`);

  const body = (await bodyOf(res)) as { data: { runId: string; summary: { have: number; missing: number } } };
  assert.equal(body.data.summary.have, 1);
  assert.equal(body.data.summary.missing, 1);

  // 真实读回
  const run = await prisma.matchRun.findUnique({
    where: { id: body.data.runId },
    select: { id: true, userId: true, matcherVersion: true, summary: true, items: { orderBy: { id: 'asc' } } },
  });
  assert.ok(run);
  assert.equal(run.userId, userId);
  assert.equal(run.matcherVersion, 'v1');
  assert.equal(run.items.length, 2);
  assert.ok(run.summary, 'summary JSON 字段已落库');

  // 修复过的往返缺口：resumeEvidence 必须能从真实库读回
  const viaRepo = await repos.matches.findRunWithItemsForUser(body.data.runId, userId);
  assert.ok(viaRepo);
  const have = viaRepo.items.find((i) => i.status === 'HAVE');
  assert.ok(have);
  assert.equal(have.resumeEvidence, 'Python', 'resumeEvidence 必须可往返');
  assert.equal(have.evidenceRefs[0].locator, 'resume:line:12');
  assert.equal(have.basis.type, 'EXACT_MATCH');
});

test('E2E-04 数据链完整（ADR-010）：Suggestion.evidenceRefs 可回溯到 Resume 的 Evidence', { skip }, async () => {
  const { token, userId } = await signUp(`e2e_d_${stamp}@example.com`);
  const resumeId = await seedResume(userId, 'd');
  const jd = await seedJd(userId, 'd');

  const matchPost = createCreateMatchHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    jdRepo: repos.jds,
    matchRepo: repos.matches,
  });
  const matchRes = await matchPost(postJson('http://t/api/matches', { resumeId, jdId: jd.id }, token));
  const matchBody = (await bodyOf(matchRes)) as { data: { runId: string } };

  const sugPost = createGenerateSuggestionsHandler({
    auth: auth(),
    matchRepo: repos.matches,
    resumeEntries: repos.resumeEntries,
    resumeFacts: repos.resumeFacts,
    suggestions: repos.suggestions,
  });
  const sugRes = await sugPost(
    postJson('http://t/api/suggestions', { resumeId, matchRunId: matchBody.data.runId }, token),
  );
  assert.equal(sugRes.status, 201, `期望 201，实际 ${sugRes.status}`);

  const rows = await prisma.resumeSuggestion.findMany({ where: { resumeId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'GUIDANCE');
  assert.equal(rows[0].after, null, 'GUIDANCE 不得产出内容');
  assert.equal(rows[0].status, 'PENDING');
  assert.deepEqual(rows[0].evidenceRefs, [], 'JSON 字段读写正常');

  // ADR-010 要求的可追溯链：Resume → Evidence → MatchItem → Suggestion
  const matchItem = await prisma.matchItem.findFirst({ where: { run: { resumeId } } });
  assert.ok(matchItem);
  const evidenceRows = await prisma.evidence.findMany({ where: { skill: { resumeId } } });
  assert.ok(evidenceRows.length > 0);
  const locators = new Set(evidenceRows.map((e) => e.locator));
  const itemLocators = (matchItem.evidenceRefs as Array<{ locator: string }>).map((r) => r.locator);
  assert.ok(
    itemLocators.every((l) => locators.has(l)),
    `MatchItem 的证据必须指向该简历的 Evidence：${itemLocators.join(',')}`,
  );
});

test('E2E-05 ACCEPT 一条 GUIDANCE → 409，真实库中简历未被改动', { skip }, async () => {
  const { token, userId } = await signUp(`e2e_e_${stamp}@example.com`);
  const resumeId = await seedResume(userId, 'e');
  const jd = await seedJd(userId, 'e');

  const matchPost = createCreateMatchHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    jdRepo: repos.jds,
    matchRepo: repos.matches,
  });
  const matchBody = (await bodyOf(
    await matchPost(postJson('http://t/api/matches', { resumeId, jdId: jd.id }, token)),
  )) as { data: { runId: string } };

  const deps = {
    auth: auth(),
    matchRepo: repos.matches,
    resumeEntries: repos.resumeEntries,
    resumeFacts: repos.resumeFacts,
    suggestions: repos.suggestions,
  };
  await createGenerateSuggestionsHandler(deps)(
    postJson('http://t/api/suggestions', { resumeId, matchRunId: matchBody.data.runId }, token),
  );

  const before = await prisma.skill.findUnique({ where: { resumeId_key: { resumeId, key: 'python' } } });
  const row = await prisma.resumeSuggestion.findFirstOrThrow({ where: { resumeId } });

  const patch = createResolveSuggestionHandler(deps);
  const res = await patch(postJson(`http://t/api/suggestions/${row.id}`, { action: 'ACCEPT' }, token), row.id);
  assert.equal(res.status, 409);

  const after = await prisma.skill.findUnique({ where: { resumeId_key: { resumeId, key: 'python' } } });
  assert.deepEqual(after, before, '被拒绝的采用不得改动简历');
  const still = await prisma.resumeSuggestion.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(still.status, 'PENDING');
});

test('E2E-06 事务原子性：外键非法时整批回滚，不留半成品', { skip }, async () => {
  const { userId } = await signUp(`e2e_f_${stamp}@example.com`);
  const resumeId = await seedResume(userId, 'f');
  const jd = await seedJd(userId, 'f');

  const runsBefore = await prisma.matchRun.count({ where: { userId } });

  await assert.rejects(
    () =>
      repos.matches.createRunWithItems({
        userId,
        resumeId,
        jdId: jd.id,
        matcherVersion: 'v1',
        summary: { total: 1 } as never,
        items: {
          create: [
            {
              requirementId: 'req_not_exists_0000000000',
              reqText: '精通 Python',
              status: 'HAVE',
              category: 'TECH',
              criticality: 'MUST',
              reason: '测试',
              basisType: 'EXACT_MATCH',
              basisDetail: '测试',
              resumeEvidence: 'Python',
              evidenceRefs: [],
              isInference: false,
              needsUserConfirmation: false,
              confidence: 'HIGH',
              suggestion: null,
            },
          ],
        },
      }),
    /Foreign key|constraint|violat/i,
  );

  const runsAfter = await prisma.matchRun.count({ where: { userId } });
  assert.equal(runsAfter, runsBefore, '事务必须整体回滚，不得留下半写入的 MatchRun');
});

test('E2E-07 数据隔离在真实库生效：他人简历读不到事实', { skip }, async () => {
  const a = await signUp(`e2e_g1_${stamp}@example.com`);
  const b = await signUp(`e2e_g2_${stamp}@example.com`);
  const resumeA = await seedResume(a.userId, 'g');

  assert.ok(await repos.resumeFacts.findFactsForResume(resumeA, a.userId));
  assert.equal(await repos.resumeFacts.findFactsForResume(resumeA, b.userId), null);
  assert.equal(await repos.resumeEntries.findEntriesForResume(resumeA, b.userId), null);
});

test('E2E-08 重新匹配生成新的 MatchRun，历史保留', { skip }, async () => {
  const { token, userId } = await signUp(`e2e_h_${stamp}@example.com`);
  const resumeId = await seedResume(userId, 'h');
  const jd = await seedJd(userId, 'h');

  const post = createCreateMatchHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    jdRepo: repos.jds,
    matchRepo: repos.matches,
  });
  const r1 = await post(postJson('http://t/api/matches', { resumeId, jdId: jd.id }, token));
  const r2 = await post(postJson('http://t/api/matches', { resumeId, jdId: jd.id }, token));
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);

  const count = await prisma.matchRun.count({ where: { resumeId } });
  assert.equal(count, 2, '历史 run 必须保留（不可覆盖）');
});

test('E2E-09 版本落库：versionNo 递增、快照 JSON 可读回、pdfUrl 由 id 派生', { skip }, async () => {
  const { token, userId } = await signUp(`e2e_v_${stamp}@example.com`);
  const resumeId = await seedResume(userId, 'v');

  const post = createCreateVersionHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    resumeVersions: repos.resumeVersions,
    jdRepo: repos.jds,
  });

  const first = await post(
    postJson(`http://t/api/resumes/${resumeId}/versions`, { basics: { name: '林一舟', email: 'lin@example.com' } }, token),
    resumeId,
  );
  assert.equal(first.status, 201, `期望 201，实际 ${first.status}`);
  const firstBody = (await bodyOf(first)) as { data: { versionNo: number; confirmedCount: number; pdfUrl: string } };
  assert.equal(firstBody.data.versionNo, 1);
  assert.equal(firstBody.data.confirmedCount, 1, '只有 Python 是 CONFIRMED');

  const second = await post(
    postJson(`http://t/api/resumes/${resumeId}/versions`, { basics: { name: '林一舟' } }, token),
    resumeId,
  );
  const secondBody = (await bodyOf(second)) as { data: { versionNo: number } };
  assert.equal(secondBody.data.versionNo, 2, '版本号必须递增，不覆盖历史');

  const rows = await prisma.resumeVersion.findMany({ where: { resumeId }, orderBy: { versionNo: 'asc' } });
  assert.equal(rows.length, 2);
  assert.ok(rows[0].snapshot, 'snapshot JSON 已落库');
  const snap = rows[0].snapshot as { templateVersion: string; model: { sections: { SKILL: unknown[] } } };
  assert.equal(snap.templateVersion, 'single-column-a4-v1');
  assert.equal(snap.model.sections.SKILL.length, 1);
  assert.equal(rows[0].pdfUrl, `/api/resumes/${resumeId}/versions/${rows[0].id}/pdf`);
  // 不可变：表里没有 updatedAt，创建后不再改动
  assert.equal('updatedAt' in rows[0], false);
});

test('E2E-10 从不可变快照重新渲染出合法 PDF（快照足以复现）', { skip }, async () => {
  const { token, userId } = await signUp(`e2e_w_${stamp}@example.com`);
  const resumeId = await seedResume(userId, 'w');

  const post = createCreateVersionHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    resumeVersions: repos.resumeVersions,
    jdRepo: repos.jds,
  });
  const created = await post(
    postJson(`http://t/api/resumes/${resumeId}/versions`, { basics: { name: '林一舟' } }, token),
    resumeId,
  );
  const createdBody = (await bodyOf(created)) as { data: { versionId: string } };

  const get = createDownloadVersionPdfHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    resumeVersions: repos.resumeVersions,
    jdRepo: repos.jds,
  });
  const res = await get(new Request('http://t/x', { headers: { cookie: `jp_session=${token}` } }), resumeId, createdBody.data.versionId);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
  assert.ok(bytes.length > 1000, `PDF 体积异常：${bytes.length}`);
});

test('E2E-11 求职记录：创建 / 计数 / 状态流转 / 隔离 全部在真实库上成立', { skip }, async () => {
  const a = await signUp(`e2e_j1_${stamp}@example.com`);
  const b = await signUp(`e2e_j2_${stamp}@example.com`);

  const deps = { auth: auth(), applications: repos.applications, jdRepo: repos.jds, careerGoals: repos.careerGoals, resumeVersions: repos.resumeVersions };
  const list = createListApplicationsHandler(deps);
  const create = createCreateApplicationHandler(deps);
  const update = createUpdateApplicationHandler(deps);

  const cookie = (token: string) => `jp_session=${token}`;

  // 空库：计数为 0 而不是缺字段
  const empty = await list(new Request('http://t/x', { headers: { cookie: cookie(a.token) } }));
  assert.equal(empty.status, 200);
  const emptyBody = (await bodyOf(empty)) as { data: { counts: Record<string, number> } };
  assert.equal(emptyBody.data.counts.total, 0);

  // 创建：默认 APPLIED，不关联 JD
  const created = await create(
    postJson('http://t/api/applications', { company: '云枢智能', notes: '内推' }, a.token),
  );
  assert.equal(created.status, 201);
  const createdBody = (await bodyOf(created)) as { data: { id: string; stage: string } };
  assert.equal(createdBody.data.stage, 'APPLIED');

  const row = await prisma.jobApplication.findUniqueOrThrow({ where: { id: createdBody.data.id } });
  assert.equal(row.userId, a.userId);
  assert.equal(row.stage, 'APPLIED', '真实库中不得落到 DRAFT');
  assert.equal(row.jdId, null);

  // 计数
  const listed = await list(new Request('http://t/x', { headers: { cookie: cookie(a.token) } }));
  const listedBody = (await bodyOf(listed)) as { data: { counts: { applied: number }; items: unknown[] } };
  assert.equal(listedBody.data.counts.applied, 1);
  assert.equal(listedBody.data.items.length, 1);

  // 状态流转
  const patched = await update(
    postJson(`http://t/api/applications/${row.id}`, { stage: 'OFFER' }, a.token),
    row.id,
  );
  assert.equal(patched.status, 200);
  const after = await prisma.jobApplication.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(after.stage, 'OFFER');
  assert.ok(after.updatedAt.getTime() >= after.createdAt.getTime(), 'updatedAt 必须刷新');

  // 隔离：B 改不动 A 的记录
  const cross = await update(postJson(`http://t/api/applications/${row.id}`, { stage: 'REJECTED' }, b.token), row.id);
  assert.equal(cross.status, 404);
  const stillOffer = await prisma.jobApplication.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(stillOffer.stage, 'OFFER', '跨用户修改必须无效');

  // 隔离：B 的列表看不到 A 的记录
  const listB = await list(new Request('http://t/x', { headers: { cookie: cookie(b.token) } }));
  const listBBody = (await bodyOf(listB)) as { data: { items: unknown[] } };
  assert.equal(listBBody.data.items.length, 0);
});

test('E2E-12【BUG-002】真实库分页：60 条只返首页，groupBy 计数仍是全量', { skip }, async () => {
  const a = await signUp(`e2e_j3_${stamp}@example.com`);
  const deps = { auth: auth(), applications: repos.applications, jdRepo: repos.jds, careerGoals: repos.careerGoals, resumeVersions: repos.resumeVersions };
  const list = createListApplicationsHandler(deps);
  const create = createCreateApplicationHandler(deps);
  const cookie = (token: string) => `jp_session=${token}`;

  for (let i = 0; i < 60; i++) {
    const res = await create(postJson('http://t/api/applications', { company: `公司${i}` }, a.token));
    assert.equal(res.status, 201);
  }

  const first = await list(new Request('http://t/x', { headers: { cookie: cookie(a.token) } }));
  const firstBody = (await bodyOf(first)) as {
    data: {
      counts: { total: number; applied: number };
      items: unknown[];
      pagination: { total: number; hasMore: boolean };
    };
  };
  // Prisma 侧的 take/skip 与 groupBy 只有真实库能验证 —— 这是 Fake 覆盖不到的部分
  assert.equal(firstBody.data.items.length, DEFAULT_PAGE_SIZE, 'Prisma take 生效：一次最多返默认值');
  assert.equal(firstBody.data.pagination.hasMore, true);
  assert.equal(firstBody.data.counts.total, 60, 'groupBy 计数必须是全量，不能是当前页条数');
  assert.equal(firstBody.data.counts.applied, 60);

  const second = await list(new Request('http://t/x?offset=50', { headers: { cookie: cookie(a.token) } }));
  const secondBody = (await bodyOf(second)) as {
    data: { items: unknown[]; pagination: { hasMore: boolean; offset: number } };
  };
  assert.equal(secondBody.data.items.length, 10, 'Prisma skip 生效');
  assert.equal(secondBody.data.pagination.offset, 50);
  assert.equal(secondBody.data.pagination.hasMore, false);
});

test('E2E-13【BUG-003】数据层默认值：直接 prisma.create 不写 stage 也落 APPLIED，而非 DRAFT', { skip }, async () => {
  const { userId } = await signUp(`e2e_k_${stamp}@example.com`);

  // 绕开 handler，直接打 Prisma —— 验证 schema 默认值本身（这是 handler 兜底之外的最后一层防线）
  const direct = await prisma.jobApplication.create({
    data: { userId, company: '直写测试', appliedAt: new Date() },
  });
  assert.equal(direct.stage, 'APPLIED', 'schema 默认值必须是 APPLIED，任何绕过 handler 的写入都不得产生 DRAFT');

  // T6-2：stage 词表收窄后，非法值（DRAFT）必须被 DB CHECK 拒绝
  await assert.rejects(() =>
    prisma.jobApplication.update({ where: { id: direct.id }, data: { stage: 'DRAFT' } }),
  );
  await prisma.jobApplication.update({ where: { id: direct.id }, data: { stage: 'REJECTED' } });
  assert.equal(
    (await prisma.jobApplication.findFirst({ where: { id: direct.id } }))!.stage,
    'REJECTED',
  );
  // T6-2：合法值可自由往返（无严格状态机）
  await prisma.jobApplication.update({ where: { id: direct.id }, data: { stage: 'APPLIED' } });
  assert.equal(
    (await prisma.jobApplication.findUniqueOrThrow({ where: { id: direct.id } })).stage,
    'APPLIED',
  );
});

test('E2E-99 清理测试数据并断开连接', { skip }, async () => {
  const emails = await prisma.user.findMany({
    where: { email: { contains: `_${stamp}@example.com` } },
    select: { id: true },
  });
  const ids = emails.map((e) => e.id);
  if (ids.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.jobDescription.deleteMany({ where: { contentHash: { startsWith: `hash_` } } });
  await prisma.$disconnect();
});
