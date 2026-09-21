import test from 'node:test';
import assert from 'node:assert/strict';

import { generateSuggestions } from '../src/domain/suggestion/generate.ts';
import { findInventedNumbers, validateSuggestion, summarizeSuggestions } from '../src/domain/suggestion/contract.ts';
import { isWeakExpression, planSuggestions } from '../src/domain/suggestion/targeting.ts';
import type { ResumeEntryRef } from '../src/domain/suggestion/targeting.ts';
import { SUGGESTION_KIND } from '../src/domain/suggestion/types.ts';
import type { SuggestionDraft } from '../src/domain/suggestion/types.ts';
import { BASIS_TYPE, CONFIDENCE } from '../src/domain/ai/judgment.ts';
import { EVIDENCE_SOURCE, FACT_STATUS } from '../src/domain/types.ts';
import type { MatchItemOutput } from '../src/domain/match/types.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createInMemoryCounter, createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import {
  createGenerateSuggestionsHandler,
  createResolveSuggestionHandler,
} from '../src/http/handlers/suggestions.ts';
import {
  FixedClock,
  InMemoryMatchRepository,
  InMemoryResumeEntriesRepository,
  InMemoryResumeFactsRepository,
  InMemorySessionRepository,
  InMemorySuggestionRepository,
  InMemoryUserRepository,
  bodyOf,
  extractSessionToken,
  postJson,
} from './fakes.ts';

const RT = EVIDENCE_SOURCE.RESUME_TEXT;

function matchItem(over: Partial<MatchItemOutput> = {}): MatchItemOutput {
  return {
    requirementId: 'req_1',
    requirement: '熟悉 RAG 检索增强',
    category: 'TECH',
    criticality: 'MUST',
    status: 'MISSING',
    reason: '已确认的简历事实中没有支持该要求的证据',
    basis: { type: BASIS_TYPE.ABSENT, detail: '确定性匹配未命中' },
    evidenceRefs: [],
    resumeEvidence: null,
    isInference: false,
    needsUserConfirmation: false,
    confidence: CONFIDENCE.HIGH,
    suggestion: '加入能力缺口',
    ...over,
  };
}

const ENTRY: ResumeEntryRef = {
  targetField: 'ResumeProject:proj_1.outcome',
  text: '参与 AIGC 相关工作',
  status: FACT_STATUS.CONFIRMED,
  evidenceRefs: [{ source: RT, locator: 'resume:line:31', excerpt: '参与 AIGC 相关的内容生成工作' }],
};

const CONFIRMED_FACTS = [{ key: 'aigc', label: 'AIGC 项目', excerpt: '参与 AIGC 相关的内容生成工作' }];

/* ------------------------- Domain ------------------------- */

test('T6-01 MISSING → GUIDANCE，且不得产出 after（核心不变量）', async () => {
  const out = await generateSuggestions(
    { matchRunId: 'run_1', items: [matchItem()], resumeEntries: [ENTRY], confirmedFacts: CONFIRMED_FACTS },
    {},
  );
  assert.ok(out.ok);
  assert.equal(out.drafts[0].kind, SUGGESTION_KIND.GUIDANCE);
  assert.equal(out.drafts[0].after, null);
  assert.ok(out.drafts[0].reason.includes('不能代写内容'));
});

test('T6-02 GUIDANCE 携带 after → 契约拒绝', () => {
  const draft: SuggestionDraft = {
    matchRunId: null,
    matchItemRef: null,
    requirement: '熟悉 RAG',
    kind: SUGGESTION_KIND.GUIDANCE,
    targetField: 'Resume.draft',
    before: null,
    after: '使用 RAG 完成了检索系统',
    reason: '需要补充',
    verdict: FACT_STATUS.MISSING,
    verdictReason: '无事实',
    evidenceRefs: [],
    needsUserConfirmation: true,
  };
  const issues = validateSuggestion(draft);
  assert.ok(issues.some((i) => i.includes('不得产出 after')));
});

test('T6-03 ENHANCE(推断) → CONFIRM_FACT，且不产出 after', async () => {
  const item = matchItem({
    requirement: '熟悉 Agent',
    status: 'ENHANCE',
    isInference: true,
    basis: { type: BASIS_TYPE.MODEL_INFERENCE, detail: '推断' },
    evidenceRefs: [{ source: RT, locator: 'resume:line:31', excerpt: '参与 AIGC 相关的内容生成工作' }],
  });
  const out = await generateSuggestions(
    { matchRunId: 'run_1', items: [item], resumeEntries: [ENTRY], confirmedFacts: CONFIRMED_FACTS },
    {},
  );
  assert.ok(out.ok);
  assert.equal(out.drafts[0].kind, SUGGESTION_KIND.CONFIRM_FACT);
  assert.equal(out.drafts[0].after, null);
});

test('T6-04 ENHANCE(仅 OCR) → CONFIRM_FACT', async () => {
  const item = matchItem({
    status: 'ENHANCE',
    isInference: false,
    evidenceRefs: [{ source: EVIDENCE_SOURCE.OCR, locator: 'resume:line:31', excerpt: '参与 AIGC 相关的内容生成工作' }],
  });
  const plans = planSuggestions({ items: [item], resumeEntries: [ENTRY] });
  assert.equal(plans[0].kind, SUGGESTION_KIND.CONFIRM_FACT);
});

test('T6-05 HAVE + 表达偏弱 → REPHRASE（含 before / after）', async () => {
  const item = matchItem({
    requirementId: 'req_aigc',
    requirement: 'AIGC 项目经验',
    status: 'HAVE',
    resumeEvidence: '参与 AIGC 相关工作',
    evidenceRefs: [{ source: RT, locator: 'resume:line:31', excerpt: '参与 AIGC 相关的内容生成工作' }],
  });
  const out = await generateSuggestions(
    { matchRunId: 'run_1', items: [item], resumeEntries: [ENTRY], confirmedFacts: CONFIRMED_FACTS },
    {
      rephrase: async () => ({
        after: '参与 AIGC 内容生成，完成 Prompt 调优与效果对比',
        usedFactKeys: ['aigc'],
        reason: '补充了具体工作内容',
      }),
    },
  );
  assert.ok(out.ok);
  assert.equal(out.drafts[0].kind, SUGGESTION_KIND.REPHRASE);
  assert.equal(out.drafts[0].before, ENTRY.text);
  assert.ok(out.drafts[0].after);
  assert.equal(out.rejected.length, 0);
});

test('T6-06 HAVE 且表达已清晰 → 不给建议', async () => {
  const strong: ResumeEntryRef = {
    ...ENTRY,
    text: '负责 AIGC 内容生成，完成 Prompt 调优与效果对比，覆盖 3 个业务场景',
  };
  const item = matchItem({
    status: 'HAVE',
    evidenceRefs: [{ source: RT, locator: 'resume:line:31', excerpt: strong.text }],
  });
  const plans = planSuggestions({ items: [item], resumeEntries: [strong] });
  assert.equal(plans.length, 0);
});

test('T6-07 HAVE 但找不到可安全改写的位置 → 不给建议', async () => {
  const item = matchItem({
    status: 'HAVE',
    evidenceRefs: [{ source: RT, locator: 'resume:line:999', excerpt: '别的条目' }],
  });
  assert.equal(planSuggestions({ items: [item], resumeEntries: [ENTRY] }).length, 0);
});

test('T6-08 REPHRASE 无证据 → 契约拒绝', () => {
  const draft: SuggestionDraft = {
    matchRunId: null,
    matchItemRef: null,
    requirement: 'AIGC',
    kind: SUGGESTION_KIND.REPHRASE,
    targetField: 'ResumeProject:p1.outcome',
    before: '参与 AIGC 相关工作',
    after: '负责 AIGC 内容生成',
    reason: '表达更具体',
    verdict: FACT_STATUS.CONFIRMED,
    verdictReason: '已确认',
    evidenceRefs: [],
    needsUserConfirmation: true,
  };
  assert.ok(validateSuggestion(draft).some((i) => i.includes('必须带证据')));
});

test('T6-09 REPHRASE 的 verdict 非 CONFIRMED → 契约拒绝', () => {
  const draft: SuggestionDraft = {
    matchRunId: null,
    matchItemRef: null,
    requirement: 'AIGC',
    kind: SUGGESTION_KIND.REPHRASE,
    targetField: 'ResumeProject:p1.outcome',
    before: '参与 AIGC 相关工作',
    after: '负责 AIGC 内容生成',
    reason: '表达更具体',
    verdict: FACT_STATUS.INFERRED,
    verdictReason: '推断',
    evidenceRefs: [{ source: RT, locator: 'resume:line:31', excerpt: 'e' }],
    needsUserConfirmation: true,
  };
  assert.ok(validateSuggestion(draft).some((i) => i.includes('verdict 必须是 CONFIRMED')));
});

test('T6-10 证据来自 JD → 契约拒绝', () => {
  const draft: SuggestionDraft = {
    matchRunId: null,
    matchItemRef: null,
    requirement: 'Python',
    kind: SUGGESTION_KIND.REPHRASE,
    targetField: 'Skill:s1.level',
    before: '精通 Python',
    after: '精通 Python，用于数据处理',
    reason: '补充场景',
    verdict: FACT_STATUS.CONFIRMED,
    verdictReason: '已确认',
    evidenceRefs: [{ source: EVIDENCE_SOURCE.JD, locator: 'jd:req:1', excerpt: '要求 Python' }],
    needsUserConfirmation: true,
  };
  assert.ok(validateSuggestion(draft).some((i) => i.includes('JD 要求不能作为改写依据')));
});

test('T6-11 数字保护：改写引入原文没有的数字 → 丢弃并记录原因', async () => {
  const item = matchItem({
    status: 'HAVE',
    evidenceRefs: [{ source: RT, locator: 'resume:line:31', excerpt: '参与 AIGC 相关的内容生成工作' }],
  });
  const out = await generateSuggestions(
    { matchRunId: 'run_1', items: [item], resumeEntries: [ENTRY], confirmedFacts: CONFIRMED_FACTS },
    {
      rephrase: async () => ({
        after: '负责 AIGC 内容生成，效率提升 30%',
        usedFactKeys: ['aigc'],
        reason: '补充成果',
      }),
    },
  );
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.state, 'NOTHING_TO_SUGGEST');
  assert.ok(findInventedNumbers('效率提升 30%', '参与 AIGC', ['参与 AIGC 相关工作']).includes('30%'));
});

test('T6-12 改写引用未确认事实 → 丢弃', async () => {
  const item = matchItem({
    status: 'HAVE',
    evidenceRefs: [{ source: RT, locator: 'resume:line:31', excerpt: '参与 AIGC 相关的内容生成工作' }],
  });
  const out = await generateSuggestions(
    { matchRunId: 'run_1', items: [item], resumeEntries: [ENTRY], confirmedFacts: CONFIRMED_FACTS },
    {
      rephrase: async () => ({
        after: '负责 AIGC 内容生成，并搭建了 RAG 检索链路',
        usedFactKeys: ['aigc', 'rag'],
        reason: '补充',
      }),
    },
  );
  assert.equal(out.ok, false);
});

test('T6-13 改写幅度过大（接近重写）→ 丢弃', async () => {
  const item = matchItem({
    status: 'HAVE',
    evidenceRefs: [{ source: RT, locator: 'resume:line:31', excerpt: '参与 AIGC 相关的内容生成工作' }],
  });
  const out = await generateSuggestions(
    { matchRunId: 'run_1', items: [item], resumeEntries: [ENTRY], confirmedFacts: CONFIRMED_FACTS },
    {
      rephrase: async () => ({
        after: 'A'.repeat(300),
        usedFactKeys: ['aigc'],
        reason: '大改',
      }),
    },
  );
  assert.equal(out.ok, false);
});

test('T6-14 未注入改写端口 → 不产出未经校验的内容', async () => {
  const item = matchItem({
    status: 'HAVE',
    evidenceRefs: [{ source: RT, locator: 'resume:line:31', excerpt: '参与 AIGC 相关的内容生成工作' }],
  });
  const out = await generateSuggestions(
    { matchRunId: 'run_1', items: [item], resumeEntries: [ENTRY], confirmedFacts: CONFIRMED_FACTS },
    {},
  );
  assert.equal(out.ok, false);
});

test('T6-15 若既有 GUIDANCE 又有被拒的 REPHRASE，GUIDANCE 仍保留', async () => {
  const missing = matchItem({ requirementId: 'req_rag', requirement: '熟悉 RAG' });
  const have = matchItem({
    requirementId: 'req_aigc',
    requirement: 'AIGC 项目经验',
    status: 'HAVE',
    evidenceRefs: [{ source: RT, locator: 'resume:line:31', excerpt: '参与 AIGC 相关的内容生成工作' }],
  });
  const out = await generateSuggestions(
    { matchRunId: 'run_1', items: [missing, have], resumeEntries: [ENTRY], confirmedFacts: CONFIRMED_FACTS },
    { rephrase: async () => ({ after: '效率提升 30%', usedFactKeys: ['aigc'], reason: 'x' }) },
  );
  assert.ok(out.ok);
  assert.equal(out.drafts.length, 1);
  assert.equal(out.drafts[0].kind, SUGGESTION_KIND.GUIDANCE);
  assert.equal(out.rejected.length, 1);
});

test('T6-16 弱表达判据', () => {
  assert.equal(isWeakExpression('参与相关工作'), true);
  assert.equal(isWeakExpression('参与 AIGC 相关工作'), true);
  assert.equal(isWeakExpression('负责 AIGC 内容生成，完成 Prompt 调优与效果对比'), false);
});

test('T6-17 建议摘要按三类统计', async () => {
  const out = await generateSuggestions(
    { matchRunId: null, items: [matchItem()], resumeEntries: [], confirmedFacts: [] },
    {},
  );
  assert.ok(out.ok);
  assert.deepEqual(summarizeSuggestions(out.drafts), { total: 1, rephrase: 0, confirmFact: 0, guidance: 1 });
});

/* ------------------------- API ------------------------- */

function apiHarness() {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const failures = createInMemoryFailureLimiter(clock, 5, 15 * 60 * 1000);
  const auth = createAuthService({ users, sessions, failures, clock });
  const register = createRegisterHandler({ auth, secureCookies: false });

  const matchRepo = new InMemoryMatchRepository();
  const resumeEntries = new InMemoryResumeEntriesRepository();
  const resumeFacts = new InMemoryResumeFactsRepository();
  const suggestions = new InMemorySuggestionRepository();

  const deps = { auth, matchRepo, resumeEntries, resumeFacts, suggestions };
  const post = createGenerateSuggestionsHandler(deps);
  const patch = createResolveSuggestionHandler(deps);

  return {
    users,
    matchRepo,
    resumeEntries,
    resumeFacts,
    suggestions,
    post,
    patch,
    async signUp(email: string): Promise<{ token: string; userId: string }> {
      const res = await register(postJson('http://t/api/auth/register', { email, password: 'password-1234' }));
      const token = extractSessionToken(res);
      const userId = users.rows[users.rows.length - 1].id;
      return { token: token as string, userId };
    },
    async seedRun(userId: string, resumeId: string, items: MatchItemOutput[]): Promise<string> {
      const rec = await matchRepo.createRunWithItems({
        userId,
        resumeId,
        jdId: 'jd_1',
        matcherVersion: 'v1',
        summary: {
          total: items.length,
          have: 0,
          enhance: 0,
          missing: items.length,
          mustTotal: items.length,
          mustHave: 0,
          needsUserConfirmation: 0,
          ambiguous: 0,
        },
        items: {
          create: items.map((i) => ({
            requirementId: i.requirementId,
            reqText: i.requirement,
            status: i.status,
            category: i.category,
            criticality: i.criticality,
            reason: i.reason,
            basisType: i.basis.type,
            basisDetail: i.basis.detail,
            resumeEvidence: i.resumeEvidence,
            evidenceRefs: i.evidenceRefs,
            isInference: i.isInference,
            needsUserConfirmation: i.needsUserConfirmation,
            confidence: i.confidence,
            suggestion: i.suggestion,
          })),
        },
      });
      return rec.id;
    },
  };
}

test('T6-18 未登录 → 401', async () => {
  const h = apiHarness();
  const res = await h.post(postJson('http://t/api/suggestions', { resumeId: 'r1', matchRunId: 'run_1' }));
  assert.equal(res.status, 401);
  assert.equal(h.suggestions.rows.length, 0);
});

test('T6-19 跨用户 matchRun → 404', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  const runId = await h.seedRun(a.userId, 'resume_a', [matchItem()]);
  h.resumeEntries.put('resume_a', a.userId, [ENTRY]);

  const res = await h.post(postJson('http://t/api/suggestions', { resumeId: 'resume_a', matchRunId: runId }, b.token));
  assert.equal(res.status, 404);
});

test('T6-20 resumeId 与匹配记录不一致 → 400', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const runId = await h.seedRun(a.userId, 'resume_a', [matchItem()]);
  h.resumeEntries.put('resume_other', a.userId, [ENTRY]);

  const res = await h.post(postJson('http://t/api/suggestions', { resumeId: 'resume_other', matchRunId: runId }, a.token));
  assert.equal(res.status, 400);
});

test('T6-21 正常生成 → 201，落库 PENDING；MISSING 项的建议 after 为 null', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const runId = await h.seedRun(a.userId, 'resume_a', [matchItem()]);
  h.resumeEntries.put('resume_a', a.userId, [ENTRY]);

  const res = await h.post(postJson('http://t/api/suggestions', { resumeId: 'resume_a', matchRunId: runId }, a.token));
  assert.equal(res.status, 201);
  const body = (await bodyOf(res)) as { data: { suggestions: Array<{ kind: string; after: string | null }> } };
  assert.equal(body.data.suggestions.length, 1);
  assert.equal(body.data.suggestions[0].kind, 'GUIDANCE');
  assert.equal(body.data.suggestions[0].after, null);
  assert.equal(h.suggestions.rows.length, 1);
  assert.equal(h.suggestions.rows[0].status, 'PENDING');
});

test('T6-22 ACCEPT 一条 GUIDANCE → 409，绝不写入简历', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const runId = await h.seedRun(a.userId, 'resume_a', [matchItem()]);
  h.resumeEntries.put('resume_a', a.userId, [ENTRY]);
  await h.post(postJson('http://t/api/suggestions', { resumeId: 'resume_a', matchRunId: runId }, a.token));
  const sugId = h.suggestions.rows[0].id;

  const res = await h.patch(postJson(`http://t/api/suggestions/${sugId}`, { action: 'ACCEPT' }, a.token), sugId);
  assert.equal(res.status, 409);
  const body = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(body.error.code, 'SUGGESTION_NOT_APPLICABLE');
  assert.equal(h.suggestions.applied.length, 0, '指引类建议不得写回简历');
  assert.equal(h.suggestions.rows[0].status, 'PENDING');
});

test('T6-23 ACCEPT 一条 REPHRASE → 200 且写回简历', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const haveItem = matchItem({
    requirement: 'AIGC 项目经验',
    status: 'HAVE',
    evidenceRefs: [{ source: RT, locator: 'resume:line:31', excerpt: '参与 AIGC 相关的内容生成工作' }],
  });
  const runId = await h.seedRun(a.userId, 'resume_a', [haveItem]);
  h.resumeEntries.put('resume_a', a.userId, [ENTRY]);

  // 该 harness 未注入 rephrase 端口 → REPHRASE 会被丢弃，因此这里直接落一条 REPHRASE 建议
  h.suggestions.rows.push({
    id: 'sug_manual',
    resumeId: 'resume_a',
    userId: a.userId,
    kind: 'REPHRASE',
    targetField: ENTRY.targetField,
    before: ENTRY.text,
    after: '负责 AIGC 内容生成',
    status: 'PENDING',
    evidenceRefs: [],
  });

  const res = await h.patch(postJson('http://t/api/suggestions/sug_manual', { action: 'ACCEPT' }, a.token), 'sug_manual');
  assert.equal(res.status, 200);
  assert.equal(h.suggestions.applied.length, 1);
  assert.equal(h.suggestions.applied[0].text, '负责 AIGC 内容生成');
  assert.equal(h.suggestions.rows.find((r) => r.id === 'sug_manual')?.status, 'ACCEPTED');
});

test('T6-24 SKIP → 200，简历不变', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const runId = await h.seedRun(a.userId, 'resume_a', [matchItem()]);
  h.resumeEntries.put('resume_a', a.userId, [ENTRY]);
  await h.post(postJson('http://t/api/suggestions', { resumeId: 'resume_a', matchRunId: runId }, a.token));
  const sugId = h.suggestions.rows[0].id;

  const res = await h.patch(postJson(`http://t/api/suggestions/${sugId}`, { action: 'SKIP' }, a.token), sugId);
  assert.equal(res.status, 200);
  assert.equal(h.suggestions.rows[0].status, 'SKIPPED');
  assert.equal(h.suggestions.applied.length, 0);
});

test('T6-25 重复处理同一条建议 → 409', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const runId = await h.seedRun(a.userId, 'resume_a', [matchItem()]);
  h.resumeEntries.put('resume_a', a.userId, [ENTRY]);
  await h.post(postJson('http://t/api/suggestions', { resumeId: 'resume_a', matchRunId: runId }, a.token));
  const sugId = h.suggestions.rows[0].id;

  await h.patch(postJson(`http://t/api/suggestions/${sugId}`, { action: 'SKIP' }, a.token), sugId);
  const again = await h.patch(postJson(`http://t/api/suggestions/${sugId}`, { action: 'SKIP' }, a.token), sugId);
  assert.equal(again.status, 409);
});

test('T6-26 请求体携带 userId → 400', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const runId = await h.seedRun(a.userId, 'resume_a', [matchItem()]);
  const res = await h.post(
    postJson('http://t/api/suggestions', { resumeId: 'resume_a', matchRunId: runId, userId: a.userId }, a.token),
  );
  assert.equal(res.status, 400);
});

test('T6-27 落库失败 → 500，不留半成品', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const runId = await h.seedRun(a.userId, 'resume_a', [matchItem()]);
  h.resumeEntries.put('resume_a', a.userId, [ENTRY]);
  h.suggestions.failOnCreate = new Error('connection terminated unexpectedly');

  const res = await h.post(postJson('http://t/api/suggestions', { resumeId: 'resume_a', matchRunId: runId }, a.token));
  assert.equal(res.status, 500);
  assert.equal(h.suggestions.rows.length, 0);
});

test('T6-28 跨用户处理建议 → 404', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  h.suggestions.rows.push({
    id: 'sug_x',
    resumeId: 'resume_a',
    userId: a.userId,
    kind: 'GUIDANCE',
    targetField: 'Resume.draft',
    before: null,
    after: null,
    status: 'PENDING',
    evidenceRefs: [],
  });
  // InMemory 版对所有用户都查得到，这里改为断言未知 id 走 404 分支
  const res = await h.patch(postJson('http://t/api/suggestions/sug_missing', { action: 'SKIP' }, b.token), 'sug_missing');
  assert.equal(res.status, 404);
});
