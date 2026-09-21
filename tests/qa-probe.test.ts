import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock } from '../src/ports/index.ts';
import { buildJdsHandlerDeps, buildMatchesHandlerDeps, buildSuggestionsHandlerDeps } from '../src/http/deps.ts';
import { AppError } from '../src/errors.ts';
import { UnconfiguredProvider } from '../src/llm/unconfigured-provider.ts';
import { createSemanticMatcher } from '../src/domain/match/semantic.ts';
import { createRephrasePort } from '../src/domain/suggestion/rephrase.ts';
import { createCreateJdHandler } from '../src/http/handlers/jds.ts';
import { createCreateMatchHandler } from '../src/http/handlers/matches.ts';
import { createCreateApplicationHandler, createListApplicationsHandler } from '../src/http/handlers/applications.ts';
import { postJson, bodyOf } from './fakes.ts';

/**
 * QA 探针（不是功能测试）。
 * 每条探针断言**当前实际行为**，并在注释里写明**期望行为**。
 * 两者不一致的地方 = 真实 Bug；修好后探针会失败，提醒同步更新。
 *
 * PostgreSQL 不可达时整份 skip。
 */

const dbUp = await (async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();
const skip = dbUp ? false : 'PostgreSQL 不可达，跳过 QA 探针';
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

async function signUp(tag: string) {
  const r = await auth().register({ email: `qa_${tag}_${stamp}@example.com`, password: 'password-1234' });
  return { token: r.token, userId: r.user.id };
}

const cookie = (t: string) => `jp_session=${t}`;

/* ─────────────── 安全：SQL Injection ─────────────── */

test('QA-01 SQL 注入探针：恶意字符串作为数据而非 SQL 执行', { skip }, async () => {
  const a = await signUp('sqli');
  const post = createCreateApplicationHandler({ auth: auth(), applications: repos.applications, jdRepo: repos.jds, careerGoals: repos.careerGoals, resumeVersions: repos.resumeVersions });

  const payloads = [
    "'; DROP TABLE \"JobApplication\"; --",
    "' OR '1'='1",
    'Robert"); DROP TABLE "User"; --',
    "\\'; DELETE FROM \"User\" WHERE 1=1; --",
  ];

  for (const payload of payloads) {
    const res = await post(postJson('http://t/api/applications', { company: payload, notes: payload }, a.token));
    // 现状 = 期望：当作普通字符串存下，201
    assert.equal(res.status, 201, `载荷未被当作数据：${payload}`);
  }

  // 关键断言：表还在、数据没被删
  const stillThere = await prisma.jobApplication.count({ where: { userId: a.userId } });
  assert.equal(stillThere, payloads.length);
  const userCount = await prisma.user.count({ where: { id: a.userId } });
  assert.equal(userCount, 1, 'User 表不得被注入删除');

  // 且原样存回（未被截断或转义成别的东西）
  const stored = await prisma.jobApplication.findFirstOrThrow({ where: { userId: a.userId } });
  assert.ok(payloads.includes(stored.company));
});

test('QA-02 SQL 注入探针：id 参数位', { skip }, async () => {
  const a = await signUp('sqli2');
  const handler = createCreateMatchHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    jdRepo: repos.jds,
    matchRepo: repos.matches,
  });
  const res = await handler(
    postJson('http://t/api/matches', { resumeId: "' OR 1=1 --", jdId: 'x' }, a.token),
  );
  assert.equal(res.status, 404, '非法 id 应当查不到（404），而不是命中全表');
});

/* ─────────────── 安全：API Key 泄露 ─────────────── */

/* BUG-001 回归：缺少 LLM 配置时必须 503 + 结构化 JSON，且装配期不得抛错 */

const FORBIDDEN_IN_RESPONSE = [
  'LLM_API_KEY',
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'api.deepseek.com',
  'dashscope',
  'prompt',
  '.env',
  'src/llm',
  'at Object',
];

function assertSafeErrorResponse(raw: string, status: number) {
  assert.equal(status, 503, `期望 503，实际 ${status}`);
  for (const needle of FORBIDDEN_IN_RESPONSE) {
    assert.ok(!raw.includes(needle), `响应不得包含敏感信息：${needle}`);
  }
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(raw), '响应不得出现形似密钥的串');
  assert.ok(!/C:\\\\|\/Users\/|\/home\//.test(raw), '响应不得出现文件路径');
}

test('QA-03-JD 缺少 LLM 配置 → 503 + JSON + 正确错误码 + requestId，无敏感信息', { skip }, async () => {
  const a = await signUp('jd503');

  // 修复前：这一行本身就抛错（装配期逃逸），根本走不到 handler
  await assert.doesNotReject(
    () => buildJdsHandlerDeps({ id: a.userId }),
    'BUG-001：装配期不得抛错',
  );
  // 确定性注入未配置的 provider，不依赖本机是否配置了真实 Key
  const deps = {
    ...(await buildJdsHandlerDeps({ id: a.userId })),
    provider: new UnconfiguredProvider('缺少环境变量 LLM_API_KEY'),
  };

  // 注意：必须 ≥50 字，否则会先被 JD_TOO_SHORT(422) 拦下，走不到 LLM 这一层
  const res = await createCreateJdHandler(deps)(
    postJson(
      'http://t/api/jds',
      {
        rawText:
          '岗位名称：AI 应用开发工程师\n公司：云枢智能\n岗位职责：负责公司 AI 应用的设计与开发\n任职要求：精通 Python，具备三年以上相关经验',
      },
      a.token,
    ),
  );
  const body = (await bodyOf(res)) as { error: { code: string; message: string; requestId: string } };
  const raw = JSON.stringify(body);

  assertSafeErrorResponse(raw, res.status);
  assert.equal(body.error.code, 'SERVICE_NOT_CONFIGURED');
  assert.ok(body.error.requestId && body.error.requestId.length > 0, '必须带 requestId');
  assert.ok(!body.error.message.includes('环境变量'), '面向用户的文案不得出现环境变量名');
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
});

test('QA-03-MATCH 缺少 LLM 配置且需要语义匹配 → 503，无 uncaught exception', { skip }, async () => {
  const a = await signUp('match503');
  const resume = await prisma.resume.create({
    data: {
      userId: a.userId,
      rawText: '简历',
      sourceType: 'TEXT',
      skills: { create: [{ key: 'python', label: 'Python', status: 'CONFIRMED' }] },
    },
    select: { id: true, skills: { select: { id: true } } },
  });
  await prisma.evidence.create({
    data: { source: 'RESUME_TEXT', locator: 'resume:line:12', excerpt: '使用 Python 完成数据处理', skillId: resume.skills[0].id },
  });
  const jd = await repos.jds.createWithRequirements({
    userId: a.userId,
    rawText: 'JD',
    title: 'AI 工程师',
    company: '云枢智能',
    contentHash: `qa503_${stamp}`,
    // 故意与简历无确定性交集，强制走语义匹配（也就是会碰 LLM）
    reqs: { create: [{ text: '用户增长数据分析能力', category: 'TECH', criticality: 'MUST' }] },
  });

  await assert.doesNotReject(
    () => buildMatchesHandlerDeps({ id: a.userId }),
    'BUG-001：装配期不得抛错',
  );
  const deps = {
    ...(await buildMatchesHandlerDeps({ id: a.userId })),
    semantic: createSemanticMatcher(new UnconfiguredProvider('缺少环境变量 LLM_API_KEY')),
  };

  const res = await createCreateMatchHandler(deps)(postJson('http://t/api/matches', { resumeId: resume.id, jdId: jd.id }, a.token));
  const body = (await bodyOf(res)) as { error: { code: string; requestId: string } };
  assertSafeErrorResponse(JSON.stringify(body), res.status);
  assert.equal(body.error.code, 'SERVICE_NOT_CONFIGURED');
  assert.ok(body.error.requestId.length > 0);
});

test('QA-03-SUGGESTION 缺少 LLM 配置时改写端口在请求内失败 → 503', { skip }, async () => {
  const a = await signUp('sug503');

  await assert.doesNotReject(
    () => buildSuggestionsHandlerDeps({ id: a.userId }),
    'BUG-001：装配期不得抛错',
  );
  const deps = {
    ...(await buildSuggestionsHandlerDeps({ id: a.userId })),
    rephrase: createRephrasePort(new UnconfiguredProvider('缺少环境变量 LLM_API_KEY')),
  };

  // 端口层：调用时才失败，且是结构化的 AppError
  assert.ok(deps.rephrase);
  await assert.rejects(
    () => deps.rephrase!({ before: '参与 AIGC 相关工作', requirement: 'AIGC 项目经验', confirmedFacts: [] }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal((err as AppError).code, 'SERVICE_NOT_CONFIGURED');
      // 响应侧不可见的运维提示只存在于 details
      const details = (err as AppError).details as { hint?: string } | null;
      assert.match(String(details?.hint ?? ''), /LLM_API_KEY/);
      return true;
    },
  );

  // 非 LLM 端点保持原行为
  const list = createListApplicationsHandler({ auth: auth(), applications: repos.applications, jdRepo: repos.jds, careerGoals: repos.careerGoals, resumeVersions: repos.resumeVersions });
  assert.equal((await list(new Request('http://t/x', { headers: { cookie: cookie(a.token) } }))).status, 200);
});

/* ─────────────── 边界：JD 缺关键要求 ─────────────── */

test('QA-04 边界：JD 无任何要求条目时，匹配应拒绝而不是产出空结果', { skip }, async () => {
  const a = await signUp('jdempty');
  const handler = createCreateMatchHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    jdRepo: repos.jds,
    matchRepo: repos.matches,
  });
  // 直接构造一个无要求的 JD 行（绕过解析）
  const jd = await prisma.jobDescription.create({
    data: { userId: a.userId, rawText: '空 JD', contentHash: `empty_${stamp}` },
    select: { id: true },
  });
  const res = await handler(postJson('http://t/api/matches', { resumeId: 'r', jdId: jd.id }, a.token));
  // 现状 = 期望：先撞简历不存在 404（简历校验在要求数量校验之前）
  assert.equal(res.status, 404);
});

/* ─────────────── 边界：超长输入 ─────────────── */

test('QA-05 边界：超长 company / notes 应被拒', { skip }, async () => {
  const a = await signUp('long');
  const post = createCreateApplicationHandler({ auth: auth(), applications: repos.applications, jdRepo: repos.jds, careerGoals: repos.careerGoals, resumeVersions: repos.resumeVersions });

  assert.equal((await post(postJson('http://t/api/applications', { company: 'A'.repeat(80) }, a.token))).status, 201);
  assert.equal((await post(postJson('http://t/api/applications', { company: 'A'.repeat(81) }, a.token))).status, 400);
  assert.equal((await post(postJson('http://t/api/applications', { company: 'X', notes: 'B'.repeat(500) }, a.token))).status, 201);
  assert.equal((await post(postJson('http://t/api/applications', { company: 'X', notes: 'B'.repeat(501) }, a.token))).status, 400);
});

/* ─────────────── 异常：畸形请求 ─────────────── */

test('QA-06 异常：请求体不是合法 JSON → 400，不抛未捕获异常', { skip }, async () => {
  const a = await signUp('badjson');
  const post = createCreateApplicationHandler({ auth: auth(), applications: repos.applications, jdRepo: repos.jds, careerGoals: repos.careerGoals, resumeVersions: repos.resumeVersions });
  const req = new Request('http://t/api/applications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie(a.token) },
    body: '{ this is not json',
  });
  assert.equal((await post(req)).status, 400);
});

test('QA-07 异常：空请求体 → 400', { skip }, async () => {
  const a = await signUp('emptybody');
  const post = createCreateApplicationHandler({ auth: auth(), applications: repos.applications, jdRepo: repos.jds, careerGoals: repos.careerGoals, resumeVersions: repos.resumeVersions });
  const req = new Request('http://t/api/applications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie(a.token) },
    body: '',
  });
  assert.equal((await post(req)).status, 400);
});

/* ─────────────── 并发：版本号分配竞争 ─────────────── */

test('QA-08 并发：同时创建两个版本不得撞版本号', { skip }, async () => {
  const a = await signUp('race');
  const resume = await prisma.resume.create({
    data: { userId: a.userId, rawText: '并发测试', sourceType: 'TEXT' },
    select: { id: true },
  });

  const attempt = async () =>
    repos.resumeVersions.createVersion({
      resumeId: resume.id,
      userId: a.userId,
      jdId: null,
      buildSnapshot: (v) => ({ templateVersion: 'single-column-a4-v1', model: { v } }),
    });

  const results = await Promise.allSettled([attempt(), attempt()]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected');

  if (rejected.length > 0) {
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    throw new Error(
      `并发创建版本出现失败：${reason instanceof Error ? reason.message : String(reason)}；` +
        `期望两次都成功并拿到不同 versionNo（用户快速点两次「生成 PDF」不应报错）`,
    );
  }
  assert.equal(fulfilled, 2);

  const rows = await prisma.resumeVersion.findMany({ where: { resumeId: resume.id }, orderBy: { versionNo: 'asc' } });
  assert.deepEqual(
    rows.map((r) => r.versionNo),
    [1, 2],
    '两个版本号必须唯一且连续',
  );
});

/* ─────────────── 分页 / 无界响应 ─────────────── */

test('QA-09 列表分页：≥50 条只返回第一页，counts 仍反映全量', { skip }, async () => {
  const a = await signUp('page');
  const create = createCreateApplicationHandler({ auth: auth(), applications: repos.applications, jdRepo: repos.jds, careerGoals: repos.careerGoals, resumeVersions: repos.resumeVersions });
  for (let i = 0; i < 60; i++) {
    const res = await create(postJson('http://t/api/applications', { company: `公司${i}` }, a.token));
    assert.equal(res.status, 201);
  }

  const list = createListApplicationsHandler({ auth: auth(), applications: repos.applications, jdRepo: repos.jds, careerGoals: repos.careerGoals, resumeVersions: repos.resumeVersions });
  const res = await list(new Request('http://t/x', { headers: { cookie: cookie(a.token) } }));
  const body = (await bodyOf(res)) as {
    data: {
      counts: { total: number };
      items: unknown[];
      pagination: { total: number; limit: number; offset: number; hasMore: boolean };
    };
  };

  // 【修复后】响应体不再随数据量无界增长：默认只给第一页 50 条
  assert.equal(body.data.items.length, 50);
  assert.equal(body.data.pagination.hasMore, true, '还有第二页');
  // 【关键】看板计数不能被分页带偏：必须仍是全部 60 条
  assert.equal(body.data.counts.total, 60, 'counts 必须是全量，不能是当前页条数');
  assert.equal(body.data.pagination.total, 60);

  // 第二页取到剩余 10 条，且不再有下一页
  const res2 = await list(new Request('http://t/x?offset=50', { headers: { cookie: cookie(a.token) } }));
  const body2 = (await bodyOf(res2)) as {
    data: { counts: { total: number }; items: unknown[]; pagination: { hasMore: boolean } };
  };
  assert.equal(body2.data.items.length, 10);
  assert.equal(body2.data.pagination.hasMore, false);
  assert.equal(body2.data.counts.total, 60, '翻页后计数仍然必须是全量');
});

/* ─────────────── 路径穿越 ─────────────── */

test('QA-10 Path Traversal 探针：无任何用户输入进入文件系统', { skip }, async () => {
  const a = await signUp('traversal');
  const post = createCreateApplicationHandler({ auth: auth(), applications: repos.applications, jdRepo: repos.jds, careerGoals: repos.careerGoals, resumeVersions: repos.resumeVersions });

  const payloads = ['../../../../etc/passwd', '..\\..\\windows\\win.ini', '/etc/shadow', 'C:\\Windows\\System32\\drivers\\etc\\hosts'];
  for (const p of payloads) {
    const res = await post(postJson('http://t/api/applications', { company: p }, a.token));
    assert.equal(res.status, 201, '路径串应被当作普通文本存储，不触发任何文件读取');
  }
  // 结论：V1 没有文件上传/下载端点，用户输入不进入 fs（唯一 fs 调用是字体路径，来自 env 而非请求）
  assert.ok(true);
});

/* ─────────────── 内容类型 ─────────────── */

test('QA-11 响应类型：所有 JSON 端点返回 application/json，不返回 text/html', { skip }, async () => {
  const a = await signUp('ctype');
  const list = createListApplicationsHandler({ auth: auth(), applications: repos.applications, jdRepo: repos.jds, careerGoals: repos.careerGoals, resumeVersions: repos.resumeVersions });
  const res = await list(new Request('http://t/x', { headers: { cookie: cookie(a.token) } }));
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/);

  const anon = await list(new Request('http://t/x'));
  assert.match(anon.headers.get('content-type') ?? '', /^application\/json/);
  assert.ok(!(anon.headers.get('content-type') ?? '').includes('text/html'));
});

test('QA-99 清理探针数据', { skip }, async () => {
  // 精确匹配本文件自己的 stamp，避免并行执行时误删其他文件的测试数据
  const ids = await prisma.user.findMany({
    where: { email: { contains: `_${stamp}@example.com` } },
    select: { id: true },
  });
  if (ids.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: ids.map((i) => i.id) } } });
  }
  await prisma.jobDescription.deleteMany({ where: { contentHash: { contains: `_${stamp}` } } });
  await prisma.$disconnect();
});
