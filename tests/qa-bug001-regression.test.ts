import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock } from '../src/ports/index.ts';
import { UnconfiguredProvider } from '../src/llm/unconfigured-provider.ts';
import {
  buildApplicationsHandlerDeps,
  buildJdsHandlerDeps,
  buildMatchesHandlerDeps,
  buildResumeVersionsHandlerDeps,
  buildSuggestionsHandlerDeps,
} from '../src/http/deps.ts';
import { createCreateJdHandler } from '../src/http/handlers/jds.ts';
import { createCreateMatchHandler } from '../src/http/handlers/matches.ts';
import { createGenerateSuggestionsHandler } from '../src/http/handlers/suggestions.ts';
import { createListApplicationsHandler } from '../src/http/handlers/applications.ts';
import { createCreateVersionHandler } from '../src/http/handlers/resume-versions.ts';
import { postJson, getJson, bodyOf } from './fakes.ts';

/**
 * QA 独立回归 · BUG-001
 *
 * 与开发者的探针不同：本文件用**计数器插桩**证明请求真的进入了 provider 调用路径，
 * 而不是只验证"返回了 503"（503 也可能来自别处）。
 *
 * 断言前提：环境未配置 LLM_API_KEY。若已配置，本文件 skip（否则会真的打模型）。
 */

const noKey = !(process.env.LLM_API_KEY ?? '').trim();
const dbUp = await (async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();
const skip = !dbUp ? 'PostgreSQL 不可达' : !noKey ? '已配置 LLM_API_KEY，跳过未配置场景回归' : false;

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
  const r = await auth().register({ email: `qareg_${tag}_${stamp}@example.com`, password: 'password-1234' });
  return { token: r.token, userId: r.user.id };
}

const cookie = (t: string) => `jp_session=${t}`;

/** 敏感信息黑名单：任何一项出现在响应里即为泄漏 */
const LEAK_BLACKLIST = [
  'LLM_API_KEY',
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'api.deepseek.com',
  'dashscope',
  'Bearer',
  'prompt',
  '.env',
  'src/llm',
  'deps.ts',
  'at Object',
  'node_modules',
];

function assertNoLeak(res: Response, raw: string) {
  for (const needle of LEAK_BLACKLIST) {
    assert.ok(!raw.includes(needle), `响应泄漏敏感信息：${needle}`);
  }
  assert.ok(!/sk-[A-Za-z0-9_-]{8,}/.test(raw), '响应出现形似 API Key 的串');
  assert.ok(!/[A-Za-z]:\\\\|\/Users\/|\/home\/|\/root\//.test(raw), '响应出现文件系统路径');
  assert.ok(!/^\s*at\s/m.test(raw), '响应出现堆栈帧');
  assert.ok(!res.headers.get('x-powered-by')?.includes('Express'), '不应暴露技术栈标识');
}

function assertStructured503(res: Response, body: unknown) {
  assert.equal(res.status, 503);
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
  const err = (body as { error?: { code?: string; message?: string; requestId?: string } }).error;
  assert.ok(err, '响应必须是 { error: {...} } 结构，而不是框架默认错误页');
  assert.equal(err?.code, 'SERVICE_NOT_CONFIGURED');
  assert.ok(typeof err?.message === 'string' && err.message.length > 0);
  assert.ok(!String(err?.message).includes('环境变量'), '面向用户的文案不得出现环境变量名');
  assert.ok(
    typeof err?.requestId === 'string' && /^[0-9a-f-]{36}$/.test(err.requestId),
    `requestId 必须是合法 UUID，实际：${err?.requestId}`,
  );
}

/* ═══════════ 1. 装配期不再抛错，且返回的是惰性 provider ═══════════ */

test('QA-REG-01 四个 deps 构建函数均不抛错；LLM 端点在调用时才失败', { skip }, async () => {
  const a = await signUp('deps');
  let jd: Awaited<ReturnType<typeof buildJdsHandlerDeps>> | undefined;
  let match: Awaited<ReturnType<typeof buildMatchesHandlerDeps>> | undefined;
  let sug: Awaited<ReturnType<typeof buildSuggestionsHandlerDeps>> | undefined;

  await assert.doesNotReject(async () => {
    jd = await buildJdsHandlerDeps({ id: a.userId });
  });
  await assert.doesNotReject(async () => {
    match = await buildMatchesHandlerDeps({ id: a.userId });
  });
  await assert.doesNotReject(async () => {
    sug = await buildSuggestionsHandlerDeps({ id: a.userId });
  });

  assert.ok(jd!.provider instanceof UnconfiguredProvider, 'JD 端点必须拿到惰性 provider');
  assert.ok(sug!.rephrase, 'SUGGESTION 的改写端口必须存在（失败延迟到调用时）');
  assert.ok(match!.semantic, 'MATCH 的语义端口必须存在（provider 封装在 createSemanticMatcher 内）');

  // 直接调用真实装配出来的端口，证明失败发生在调用时、且是结构化错误
  await assert.rejects(
    () => match!.semantic!({ requirement: '用户增长数据分析', facts: [] }),
    (e: unknown) => {
      assert.equal((e as { code?: string }).code, 'SERVICE_NOT_CONFIGURED');
      return true;
    },
    '真实语义端口必须延迟失败，而不是装配期抛错',
  );

  // 非 LLM 端点：不涉及 provider
  assert.doesNotThrow(() => buildApplicationsHandlerDeps());
  assert.doesNotThrow(() => buildResumeVersionsHandlerDeps());
  assert.equal('provider' in buildApplicationsHandlerDeps(), false);
  assert.equal('provider' in buildResumeVersionsHandlerDeps(), false);
});

test('QA-REG-02 惰性 provider 在调用时才失败，且不吞掉错误类型', { skip }, async () => {
  const p = new UnconfiguredProvider('测试用');
  await assert.rejects(() => p.json({ system: 's', prompt: 'p', schema: {} }), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.equal((e as { code?: string }).code, 'SERVICE_NOT_CONFIGURED');
    return true;
  });
  await assert.rejects(() => p.text({ system: 's', prompt: 'p' }), (e: unknown) => {
    assert.equal((e as { code?: string }).code, 'SERVICE_NOT_CONFIGURED');
    return true;
  });
});

/* ═══════════ 2. 真正进入 provider 调用路径（计数器插桩） ═══════════ */

test('QA-REG-03 /api/jds：请求通过全部前置校验 → 计数证明 provider.json 被调用 → 503', { skip }, async () => {
  const a = await signUp('jd');
  const real = await buildJdsHandlerDeps({ id: a.userId });

  let providerCalls = 0;
  const counting = new Proxy(real.provider, {
    get(target, prop, recv) {
      if (prop === 'json') {
        return async (req: unknown) => {
          providerCalls += 1;
          return (target.json as (r: unknown) => Promise<unknown>)(req);
        };
      }
      return Reflect.get(target, prop, recv);
    },
  });

  // JD 文本 ≥50 字，确保不被 JD_TOO_SHORT 提前拦下
  const rawText =
    '岗位名称：AI 应用开发工程师\n公司：云枢智能\n岗位职责：负责公司 AI 应用的设计与开发，参与大模型应用落地\n任职要求：精通 Python，熟悉 FastAPI，具备三年以上相关经验';
  assert.ok(rawText.length >= 50, '回归用例自身必须用合法长度，否则证明不了任何事');

  const res = await createCreateJdHandler({ ...real, provider: counting })(
    postJson('http://t/api/jds', { rawText }, a.token),
  );
  const body = await bodyOf(res);
  const raw = JSON.stringify(body);

  assert.equal(providerCalls, 1, `provider.json 调用次数应为 1（证明真的进入了 LLM 路径），实际 ${providerCalls}`);
  assertStructured503(res, body);
  assertNoLeak(res, raw);
});

test('QA-REG-04 /api/matches：确定性不命中 → 语义端口被调用 → provider 失败 → 503', { skip }, async () => {
  const a = await signUp('match');

  const resume = await prisma.resume.create({
    data: {
      userId: a.userId,
      rawText: '简历原文',
      sourceType: 'TEXT',
      skills: { create: [{ key: 'python', label: 'Python', status: 'CONFIRMED' }] },
    },
    select: { id: true, skills: { select: { id: true } } },
  });
  await prisma.evidence.create({
    data: {
      source: 'RESUME_TEXT',
      locator: 'resume:line:12',
      excerpt: '使用 Python 完成数据处理',
      skillId: resume.skills[0].id,
    },
  });
  const jd = await repos.jds.createWithRequirements({
    userId: a.userId,
    rawText: 'JD',
    title: 'AI 工程师',
    company: '云枢智能',
    contentHash: `qareg_match_${stamp}`,
    // 与简历零确定性交集 → 强制进入语义匹配
    reqs: { create: [{ text: '用户增长数据分析能力', category: 'TECH', criticality: 'MUST' }] },
  });

  const real = await buildMatchesHandlerDeps({ id: a.userId });
  let semanticCalls = 0;
  const handler = createCreateMatchHandler({
    ...real,
    semantic: async (req) => {
      semanticCalls += 1;
      return real.semantic!(req);
    },
  });

  const res = await handler(postJson('http://t/api/matches', { resumeId: resume.id, jdId: jd.id }, a.token));
  const body = await bodyOf(res);
  const raw = JSON.stringify(body);

  assert.equal(semanticCalls, 1, `语义端口应被调用 1 次（证明进入了 LLM 路径），实际 ${semanticCalls}`);
  assertStructured503(res, body);
  assertNoLeak(res, raw);
});

test('QA-REG-05 /api/suggestions：产生 REPHRASE 计划 → 改写端口被调用 → provider 失败 → 503', { skip }, async () => {
  const a = await signUp('sug');

  // 弱表达的项目条目 → 会被判定为需要改写（REPHRASE），从而调用 LLM
  const projectEvidenceLocator = 'resume:line:31';
  const resume = await prisma.resume.create({
    data: {
      userId: a.userId,
      rawText: '简历原文',
      sourceType: 'TEXT',
      resumeProjects: {
        create: [{ name: 'AIGC 项目', outcome: '参与 AIGC 相关工作', status: 'CONFIRMED' }],
      },
    },
    select: { id: true, resumeProjects: { select: { id: true } } },
  });
  await prisma.evidence.create({
    data: {
      source: 'RESUME_TEXT',
      locator: projectEvidenceLocator,
      excerpt: '参与 AIGC 相关的内容生成工作',
      resumeProjectId: resume.resumeProjects[0].id,
    },
  });
  const jd = await prisma.jobDescription.create({
    data: { userId: a.userId, rawText: 'JD', contentHash: `qareg_sug_${stamp}` },
    select: { id: true },
  });

  const run = await repos.matches.createRunWithItems({
    userId: a.userId,
    resumeId: resume.id,
    jdId: jd.id,
    matcherVersion: 'v1',
    summary: {
      total: 1,
      have: 1,
      enhance: 0,
      missing: 0,
      mustTotal: 1,
      mustHave: 1,
      needsUserConfirmation: 0,
      ambiguous: 0,
    },
    items: {
      create: [
        {
          requirementId: null,
          reqText: 'AIGC 项目经验',
          status: 'HAVE',
          category: 'TECH',
          criticality: 'MUST',
          reason: '简历中有已确认的事实支持该要求',
          basisType: 'EXACT_MATCH',
          basisDetail: '精确匹配命中 aigc',
          resumeEvidence: 'AIGC 项目',
          evidenceRefs: [{ source: 'RESUME_TEXT', locator: projectEvidenceLocator, excerpt: '参与 AIGC 相关的内容生成工作' }],
          isInference: false,
          needsUserConfirmation: false,
          confidence: 'HIGH',
          suggestion: '保留',
        },
      ],
    },
  });

  const real = await buildSuggestionsHandlerDeps({ id: a.userId });
  let rephraseCalls = 0;
  const handler = createGenerateSuggestionsHandler({
    ...real,
    rephrase: async (req) => {
      rephraseCalls += 1;
      return real.rephrase!(req);
    },
  });

  const res = await handler(postJson('http://t/api/suggestions', { resumeId: resume.id, matchRunId: run.id }, a.token));
  const body = await bodyOf(res);
  const raw = JSON.stringify(body);

  assert.equal(rephraseCalls, 1, `改写端口应被调用 1 次（证明进入了 LLM 路径），实际 ${rephraseCalls}`);
  assertStructured503(res, body);
  assertNoLeak(res, raw);
});

/* ═══════════ 3. 非 LLM 端点无回归 ═══════════ */

test('QA-REG-06 /api/applications 行为不变（GET 200 / POST 201 / PATCH 200）', { skip }, async () => {
  const a = await signUp('app');

  const real = buildApplicationsHandlerDeps();
  const list = createListApplicationsHandler(real);

  const empty = await list(new Request('http://t/x', { headers: { cookie: cookie(a.token) } }));
  assert.equal(empty.status, 200);
  const emptyBody = (await bodyOf(empty)) as { data: { counts: { total: number } } };
  assert.equal(emptyBody.data.counts.total, 0);

  const { createCreateApplicationHandler, createUpdateApplicationHandler } = await import(
    '../src/http/handlers/applications.ts'
  );
  const created = await createCreateApplicationHandler(real)(
    postJson('http://t/api/applications', { company: '云枢智能' }, a.token),
  );
  assert.equal(created.status, 201);
  const createdBody = (await bodyOf(created)) as { data: { id: string; stage: string } };
  assert.equal(createdBody.data.stage, 'APPLIED');

  const patched = await createUpdateApplicationHandler(real)(
    postJson(`http://t/api/applications/${createdBody.data.id}`, { stage: 'INTERVIEWING' }, a.token),
    createdBody.data.id,
  );
  assert.equal(patched.status, 200);
  assert.equal(((await bodyOf(patched)) as { data: { stageLabel: string } }).data.stageLabel, '面试中');
});

test('QA-REG-07 /api/resumes/:id/versions 行为不变（生成 201 + 下载 200 application/pdf）', { skip }, async () => {
  const a = await signUp('ver');

  const resume = await prisma.resume.create({
    data: {
      userId: a.userId,
      rawText: '简历原文',
      sourceType: 'TEXT',
      skills: { create: [{ key: 'python', label: 'Python', status: 'CONFIRMED' }] },
    },
    select: { id: true, skills: { select: { id: true } } },
  });
  await prisma.evidence.create({
    data: {
      source: 'RESUME_TEXT',
      locator: 'resume:line:12',
      excerpt: '使用 Python 完成数据处理',
      skillId: resume.skills[0].id,
    },
  });

  const real = buildResumeVersionsHandlerDeps();
  const created = await createCreateVersionHandler(real)(
    postJson(`http://t/api/resumes/${resume.id}/versions`, { basics: { name: '林一舟' } }, a.token),
    resume.id,
  );
  assert.equal(created.status, 201, 'PDF 版本生成不得受 provider 改动影响');
  const createdBody = (await bodyOf(created)) as { data: { versionId: string; confirmedCount: number } };
  assert.equal(createdBody.data.confirmedCount, 1);

  const { createDownloadVersionPdfHandler } = await import('../src/http/handlers/resume-versions.ts');
  const pdf = await createDownloadVersionPdfHandler(real)(
    new Request('http://t/x', { headers: { cookie: cookie(a.token) } }),
    resume.id,
    createdBody.data.versionId,
  );
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = new Uint8Array(await pdf.arrayBuffer());
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
});

test('QA-REG-08 未登录访问 LLM 端点仍是 401（不会被 503 覆盖）', { skip }, async () => {
  const real = await buildJdsHandlerDeps({ id: 'qa-reg-no-such-user' });
  const res = await createCreateJdHandler(real)(
    postJson('http://t/api/jds', { rawText: '岗位名称：AI 工程师。'.repeat(5) }),
  );
  assert.equal(res.status, 401, '鉴权必须先于配置检查');
  const body = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('QA-REG-99 清理回归数据', { skip }, async () => {
  // 只清理本文件自己的数据
  const users = await prisma.user.findMany({ where: { email: { contains: `_${stamp}@example.com` } }, select: { id: true } });
  if (users.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  }
  await prisma.jobDescription.deleteMany({ where: { contentHash: { contains: `_${stamp}` } } });
  await prisma.$disconnect();
});
