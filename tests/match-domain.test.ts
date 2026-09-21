import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findDeterministicCandidates,
  runMatch,
  hasConfirmedFacts,
  SEMANTIC_CONCURRENCY,
} from '../src/domain/match/matcher.ts';
import type { SemanticMatcher } from '../src/domain/match/matcher.ts';
import { summarizeMatch, validateMatchItem, assertMatchItemsValid } from '../src/domain/match/contract.ts';
import type { MatchItemOutput, MatchRequirement } from '../src/domain/match/types.ts';
import { MatchContractError } from '../src/domain/match/types.ts';
import { BASIS_TYPE, CONFIDENCE } from '../src/domain/ai/judgment.ts';
import { CLAIM_KIND, EVIDENCE_SOURCE, FACT_STATUS } from '../src/domain/types.ts';
import type { Fact } from '../src/domain/types.ts';
import { verifyClaim } from '../src/domain/verify.ts';

const RT = EVIDENCE_SOURCE.RESUME_TEXT;

function fact(over: Partial<Fact> & { key: string; label: string }): Fact {
  return {
    status: FACT_STATUS.CONFIRMED,
    evidence: [{ source: RT, locator: 'resume:line:1', excerpt: '示例证据' }],
    ...over,
  };
}

const PYTHON = fact({
  key: 'python',
  label: 'Python',
  aliases: ['python开发'],
  evidence: [{ source: RT, locator: 'resume:line:12', excerpt: '使用 Python 完成数据处理' }],
});
const SQL_UNCONFIRMED = fact({
  key: 'sql',
  label: 'SQL',
  status: FACT_STATUS.UNCONFIRMED,
  evidence: [{ source: RT, locator: 'resume:line:18', excerpt: 'SQL 相关描述' }],
});
const KOTLIN_OCR = fact({
  key: 'kotlin',
  label: 'Kotlin',
  evidence: [{ source: EVIDENCE_SOURCE.OCR, locator: 'resume:page:2', excerpt: 'Kotlin（OCR 识别）' }],
});
const AGENT_INFERRED = fact({
  key: 'agent',
  label: 'Agent',
  status: FACT_STATUS.INFERRED,
  evidence: [{ source: EVIDENCE_SOURCE.OCR, locator: 'resume:page:3', excerpt: 'Agent 相关（推断）' }],
});

const req = (text: string, over: Partial<MatchRequirement> = {}): MatchRequirement => ({
  id: `r_${text}`,
  text,
  category: 'TECH',
  criticality: 'MUST',
  ...over,
});

function item(over: Partial<MatchItemOutput> = {}): MatchItemOutput {
  const base: MatchItemOutput = {
    requirementId: 'r1',
    requirement: '熟悉 RAG',
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
    suggestion: null,
  };
  return { ...base, ...over };
}

/* ---------------- 基础 ---------------- */

test('T4-01 精确技能命中（exact skill match）→ HAVE', async () => {
  const out = await runMatch({ requirements: [req('精通 Python')], facts: [PYTHON] });
  assert.ok(out.ok);
  assert.equal(out.items[0].status, 'HAVE');
  assert.equal(out.items[0].basis.type, BASIS_TYPE.EXACT_MATCH);
});

test('T4-02 normalizeKey 归一后命中（大小写 / 空格 / 别名）', async () => {
  const out = await runMatch({ requirements: [req('PYTHON开发经验')], facts: [PYTHON] });
  assert.ok(out.ok);
  assert.equal(out.items[0].status, 'HAVE');
});

test('T4-03 大小写不敏感', async () => {
  const out = await runMatch({ requirements: [req('熟练使用 python 语言')], facts: [PYTHON] });
  assert.ok(out.ok);
  assert.equal(out.items[0].status, 'HAVE');
});

test('T4-04 语义匹配：确定性未命中时走语义端口', async () => {
  const semantic: SemanticMatcher = async () => ({ matchedKeys: ['python'], detail: '简历描述与之相关' });
  const out = await runMatch({ requirements: [req('用户行为数据统计与处理能力')], facts: [PYTHON] }, { semantic });
  assert.ok(out.ok);
  assert.equal(out.items[0].status, 'HAVE');
  assert.equal(out.items[0].basis.type, BASIS_TYPE.SEMANTIC_MATCH);
});

test('T4-05 HAVE 示例：CONFIRMED + 人类来源证据', async () => {
  const out = await runMatch({ requirements: [req('精通 Python')], facts: [PYTHON] });
  assert.ok(out.ok);
  const it = out.items[0];
  assert.equal(it.status, 'HAVE');
  assert.ok(it.evidenceRefs.length > 0);
  assert.equal(it.isInference, false);
  assert.equal(it.needsUserConfirmation, false);
});

test('T4-06 ENHANCE 示例：OCR 来源 → 需核验', async () => {
  const out = await runMatch({ requirements: [req('熟悉 Kotlin')], facts: [KOTLIN_OCR] });
  assert.ok(out.ok);
  assert.equal(out.items[0].status, 'ENHANCE');
  assert.equal(out.items[0].needsUserConfirmation, true);
});

test('T4-07 MISSING 示例：无任何相关事实', async () => {
  const out = await runMatch({ requirements: [req('具备 RAG 检索增强经验')], facts: [PYTHON] });
  assert.ok(out.ok);
  assert.equal(out.items[0].status, 'MISSING');
  assert.equal(out.items[0].basis.type, BASIS_TYPE.ABSENT);
});

/* ---------------- Fact Safety ---------------- */

test('T4-08 CONFIRMED 事实 → 可以 HAVE', async () => {
  const out = await runMatch({ requirements: [req('精通 Python')], facts: [PYTHON] });
  assert.ok(out.ok);
  assert.equal(out.items[0].status, 'HAVE');
});

test('T4-09 INFERRED 事实不能变成 HAVE', async () => {
  // 带上一条 CONFIRMED 事实，避免触发 §11「无已确认事实」的业务状态守卫
  const out = await runMatch({ requirements: [req('熟悉 Agent')], facts: [AGENT_INFERRED, PYTHON] });
  assert.ok(out.ok);
  assert.notEqual(out.items[0].status, 'HAVE');
  assert.equal(out.items[0].isInference, true);
  assert.equal(out.items[0].needsUserConfirmation, true);
});

test('T4-10 UNCONFIRMED 事实不能变成 HAVE', async () => {
  const out = await runMatch({ requirements: [req('熟悉 SQL')], facts: [SQL_UNCONFIRMED, PYTHON] });
  assert.ok(out.ok);
  assert.notEqual(out.items[0].status, 'HAVE');
  assert.equal(out.items[0].needsUserConfirmation, true);
});

test('T4-11 MISSING 不得携带证据', async () => {
  const out = await runMatch({ requirements: [req('熟悉 SQL')], facts: [SQL_UNCONFIRMED, PYTHON] });
  assert.ok(out.ok);
  const it = out.items[0];
  assert.equal(it.status, 'MISSING');
  assert.equal(it.evidenceRefs.length, 0);
  assert.equal(it.resumeEvidence, null);
});

test('T4-12 HAVE + isInference 同时成立 → 契约拒绝', () => {
  const issues = validateMatchItem(
    item({ status: 'HAVE', isInference: true, resumeEvidence: 'x', evidenceRefs: [{ source: RT, locator: 'resume:line:1', excerpt: 'e' }] }),
  );
  assert.ok(issues.some((i) => i.includes('HAVE 与 isInference')));
});

test('T4-13 MISSING + 非 ABSENT 依据 → 契约拒绝', () => {
  const issues = validateMatchItem(item({ basis: { type: BASIS_TYPE.SEMANTIC_MATCH, detail: '语义不相关' } }));
  assert.ok(issues.some((i) => i.includes('basis.type 必须是 ABSENT')));
});

test('T4-14 JD 证据不能变成简历证据', async () => {
  const jdSourced = fact({
    key: 'python',
    label: 'Python',
    evidence: [{ source: EVIDENCE_SOURCE.JD, locator: 'jd:req:7', excerpt: '要求 Python' }],
  });
  const out = await runMatch({ requirements: [req('精通 Python')], facts: [jdSourced] });
  assert.ok(out.ok);
  assert.equal(out.items[0].status, 'MISSING', 'JD 来源不得支撑简历侧判断');

  const issues = validateMatchItem(
    item({ status: 'HAVE', resumeEvidence: 'Python', evidenceRefs: [{ source: EVIDENCE_SOURCE.JD, locator: 'jd:req:7', excerpt: '要求 Python' }] }),
  );
  assert.ok(issues.some((i) => i.includes('JD 要求不能当作简历证据')));
});

test('T4-15 verify.ts 阻断的主张不能变成已具备', async () => {
  const facts: Fact[] = [
    { key: 'rag', label: 'RAG', status: FACT_STATUS.MISSING, evidence: [{ source: EVIDENCE_SOURCE.JD, locator: 'jd:req:7' }] },
  ];
  const verdict = verifyClaim({ text: '具备 RAG 开发经验', topicKey: 'RAG', kind: CLAIM_KIND.EXPERIENCE }, facts);
  assert.equal(verdict.verdict, 'BLOCK');

  const out = await runMatch({ requirements: [req('具备 RAG 开发经验')], facts: [{ ...PYTHON }, ...facts] });
  assert.ok(out.ok);
  const ragItem = out.items[0];
  assert.equal(ragItem.status, 'MISSING');
});

/* ---------------- Evidence ---------------- */

test('T4-16 HAVE 必须包含证据', async () => {
  const out = await runMatch({ requirements: [req('精通 Python')], facts: [PYTHON] });
  assert.ok(out.ok);
  assert.ok(out.items[0].evidenceRefs.length >= 1);
  assert.ok(out.items[0].evidenceRefs.every((r) => r.source !== EVIDENCE_SOURCE.JD));
});

test('T4-17 ENHANCE 必须包含证据', async () => {
  const out = await runMatch({ requirements: [req('熟悉 Kotlin')], facts: [KOTLIN_OCR] });
  assert.ok(out.ok);
  assert.ok(out.items[0].evidenceRefs.length >= 1);
});

test('T4-18 locator 不能为空', () => {
  const issues = validateMatchItem(
    item({ status: 'HAVE', resumeEvidence: 'x', evidenceRefs: [{ source: RT, locator: '  ', excerpt: 'e' }] }),
  );
  assert.ok(issues.some((i) => i.includes('locator 不能为空')));
});

test('T4-19 excerpt 不能为空', () => {
  const issues = validateMatchItem(
    item({ status: 'HAVE', resumeEvidence: 'x', evidenceRefs: [{ source: RT, locator: 'resume:line:1' }] }),
  );
  assert.ok(issues.some((i) => i.includes('excerpt 不能为空')));
});

test('T4-20 证据必须指向简历：缺 excerpt 的简历证据不足以支撑 HAVE', async () => {
  const noExcerpt = fact({
    key: 'python',
    label: 'Python',
    evidence: [{ source: RT, locator: 'resume:line:12' }],
  });
  const out = await runMatch({ requirements: [req('精通 Python')], facts: [noExcerpt] });
  assert.ok(out.ok);
  assert.notEqual(out.items[0].status, 'HAVE');
});

/* ---------------- 歧义 ---------------- */

test('T4-21 多个候选证据 → 必须要求用户确认', async () => {
  const a = fact({ key: '数据分析', label: '项目A 数据分析', evidence: [{ source: RT, locator: 'resume:line:40', excerpt: '项目A 数据分析' }] });
  const b = fact({ key: '数据统计', label: '实习 数据统计', evidence: [{ source: RT, locator: 'resume:line:52', excerpt: '实习 数据统计' }] });
  const out = await runMatch({ requirements: [req('需要数据分析与数据统计经验')], facts: [a, b] });
  assert.ok(out.ok);
  const it = out.items[0];
  assert.equal(it.needsUserConfirmation, true);
  assert.equal(out.summary.ambiguous, 1);
});

test('T4-22 歧义时不得静默只选一个候选', async () => {
  const a = fact({ key: '数据分析', label: '项目A', evidence: [{ source: RT, locator: 'resume:line:40', excerpt: '项目A 数据分析' }] });
  const b = fact({ key: '数据统计', label: '项目B', evidence: [{ source: RT, locator: 'resume:line:52', excerpt: '项目B 数据统计' }] });
  const out = await runMatch({ requirements: [req('需要数据分析与数据统计经验')], facts: [a, b] });
  assert.ok(out.ok);
  const locators = out.items[0].evidenceRefs.map((r) => r.locator);
  assert.equal(locators.length, 2, '两个候选证据都必须列出');
  assert.ok(out.items[0].basis.detail.includes('数据分析'));
  assert.ok(out.items[0].basis.detail.includes('数据统计'));
});

/* ---------------- 规模 ---------------- */

const BIG_FACTS: Fact[] = Array.from({ length: 40 }, (_, i) =>
  fact({ key: `skill${i}`, label: `Skill${i}`, evidence: [{ source: RT, locator: `resume:line:${i + 1}`, excerpt: `Skill${i} 证据` }] }),
);

test('T4-33 100+ 条要求可以完整处理', async () => {
  const requirements = Array.from({ length: 120 }, (_, i) => req(`需要 skill${i % 40} 能力`));
  const out = await runMatch({ requirements, facts: BIG_FACTS });
  assert.ok(out.ok);
  assert.equal(out.items.length, 120);
});

test('T4-34 大量要求下覆盖计数正确', async () => {
  const requirements = Array.from({ length: 120 }, (_, i) => req(`需要 skill${i % 40} 能力`));
  const out = await runMatch({ requirements, facts: BIG_FACTS });
  assert.ok(out.ok);
  assert.equal(out.summary.total, 120);
  assert.equal(out.summary.have + out.summary.enhance + out.summary.missing, 120);
  assert.equal(out.summary.mustTotal, 120);
});

test('T4-35 输出顺序与输入要求顺序一致（确定性）', async () => {
  const requirements = [req('需要 skill3 能力'), req('需要 skill1 能力'), req('需要 skill2 能力')];
  const out = await runMatch({ requirements, facts: BIG_FACTS });
  assert.ok(out.ok);
  assert.deepEqual(
    out.items.map((i) => i.requirement),
    requirements.map((r) => r.text),
  );
});

/* ---------------- 其他契约与业务状态 ---------------- */

test('T4-36 摘要同时给出「必须具备覆盖 n/m」，不使用百分比', async () => {
  const out = await runMatch({
    requirements: [req('精通 Python', { criticality: 'MUST' }), req('熟悉 RAG', { criticality: 'MUST' }), req('加分项 A', { criticality: 'BONUS' })],
    facts: [PYTHON],
  });
  assert.ok(out.ok);
  assert.equal(out.summary.mustTotal, 2);
  assert.equal(out.summary.mustHave, 1);
  assert.equal(Object.keys(out.summary).some((k) => /score|percent/i.test(k)), false);
});

test('T4-37 无 CONFIRMED 事实 → 业务状态，不是异常', async () => {
  const facts: Fact[] = [SQL_UNCONFIRMED, AGENT_INFERRED];
  assert.equal(hasConfirmedFacts(facts), false);
  const out = await runMatch({ requirements: [req('熟悉 SQL')], facts });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.state, 'NEEDS_RESUME_CONFIRMATION');
    assert.ok(out.message.includes('请先完成简历确认'));
  }
});

test('T4-38 契约校验失败即抛错，不返回半成品', () => {
  assert.throws(
    () => assertMatchItemsValid([item({ status: 'HAVE', evidenceRefs: [], resumeEvidence: 'x' })]),
    MatchContractError,
  );
});

test('T4-39 确定性候选检索只认简历侧 key，不受 JD 文本影响', () => {
  const candidates = findDeterministicCandidates('精通 Python', [PYTHON]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].key, 'python');
  assert.equal(findDeterministicCandidates('精通 Golang', [PYTHON]).length, 0);
});

test('T4-40 summarizeMatch 与逐条判定一致', async () => {
  const out = await runMatch({ requirements: [req('精通 Python'), req('熟悉 Kotlin'), req('熟悉 RAG')], facts: [PYTHON, KOTLIN_OCR] });
  assert.ok(out.ok);
  const again = summarizeMatch(out.items);
  assert.deepEqual(again, out.summary);
});

/* ═══════════ O-1：语义匹配受控并发（T6-3-G-5 第一批） ═══════════ */

test('O-1 并发上限：同时在途的 semantic 调用不超过 SEMANTIC_CONCURRENCY', async () => {
  let inflight = 0;
  let peak = 0;
  const slowSemantic: SemanticMatcher = async (r) => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((res) => setTimeout(res, 20));
    inflight -= 1;
    return { matchedKeys: [], detail: '无命中' };
  };
  // 全部 requirement 均确定性未命中（走 semantic）
  const requirements = Array.from({ length: 18 }, (_, i) => req(`陌生要求 ${i}`));
  const out = await runMatch({ requirements, facts: [PYTHON] }, { semantic: slowSemantic });
  assert.ok(out.ok);
  assert.equal(peak, SEMANTIC_CONCURRENCY, `峰值并发应恰为上限 ${SEMANTIC_CONCURRENCY}`);
});

test('O-1 结果完整且顺序稳定：requirement 与结果一一对应', async () => {
  const semantic: SemanticMatcher = async (r) => {
    // 从要求文本回读编号，验证回填不错位
    const n = Number(/陌生要求 (\d+)/.exec(r.requirement)![1]);
    return { matchedKeys: n % 2 === 0 ? [] : ['python'], detail: `命中判定 ${n}` };
  };
  const requirements = Array.from({ length: 12 }, (_, i) => req(`陌生要求 ${i}`));
  const out = await runMatch({ requirements, facts: [PYTHON] }, { semantic });
  assert.ok(out.ok);
  assert.equal(out.items.length, requirements.length, '结果数量正确');
  out.items.forEach((item, i) => {
    assert.equal(item.requirement, requirements[i].text, `第 ${i} 项必须与输入顺序一一对应`);
    const n = i;
    if (n % 2 === 0) {
      assert.equal(item.status, 'MISSING', `第 ${i} 项（偶数）应未命中`);
    } else {
      assert.equal(item.status, 'HAVE', `第 ${i} 项（奇数）应命中`);
      assert.match(item.basis.detail, new RegExp(`命中判定 ${n}`), 'detail 来自对应那次调用，未错位');
    }
  });
});

test('O-1 错误传播：任一 semantic 调用抛错时整次对照失败（不吞异常）', async () => {
  let calls = 0;
  const flaky: SemanticMatcher = async (r) => {
    calls += 1;
    if (calls >= 3) throw new Error('模拟上游故障');
    return { matchedKeys: [], detail: '无命中' };
  };
  const requirements = Array.from({ length: 10 }, (_, i) => req(`陌生要求 ${i}`));
  await assert.rejects(
    () => runMatch({ requirements, facts: [PYTHON] }, { semantic: flaky }),
    /模拟上游故障/,
  );
});

test('O-1 确定性命中不进入并发池：命中项不触发 semantic 调用', async () => {
  let calls = 0;
  const counting: SemanticMatcher = async () => {
    calls += 1;
    return { matchedKeys: [], detail: '无命中' };
  };
  const out = await runMatch(
    { requirements: [req('精通 Python'), req('陌生要求 A'), req('熟悉 Kotlin')], facts: [PYTHON, KOTLIN_OCR] },
    { semantic: counting },
  );
  assert.ok(out.ok);
  assert.equal(calls, 1, '仅 1 条未命中的 requirement 触发 semantic');
  assert.equal(out.items[0].basis.type, BASIS_TYPE.EXACT_MATCH);
  assert.equal(out.items[2].basis.type, BASIS_TYPE.EXACT_MATCH);
  assert.equal(out.items[1].basis.type, BASIS_TYPE.ABSENT);
});
