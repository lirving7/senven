import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertJudgmentsValid,
  summarizeJudgments,
  validateJudgment,
  aiJudgmentSchema,
  aiJudgmentListSchema,
  BASIS_TYPE,
  CONFIDENCE,
} from '../src/domain/ai/judgment.ts';
import type { AiJudgment } from '../src/domain/ai/judgment.ts';
import { verifyClaim } from '../src/domain/verify.ts';
import { CLAIM_KIND, FACT_STATUS } from '../src/domain/types.ts';
import type { Fact } from '../src/domain/types.ts';

function judgment(over: Partial<AiJudgment> = {}): AiJudgment {
  const base: AiJudgment = {
    requirement: '熟悉 RAG 检索增强',
    status: FACT_STATUS.MISSING,
    reason: '简历全文未出现 RAG 或检索增强相关表述',
    basis: { type: BASIS_TYPE.ABSENT, detail: '全量扫描简历文本后未命中' },
    resumeEvidence: null,
    evidenceRefs: [],
    isInference: false,
    needsUserConfirmation: true,
    confidence: CONFIDENCE.HIGH,
    suggestion: '制作一个检索增强的小项目',
  };
  return { ...base, ...over };
}

const confirmed: AiJudgment = judgment({
  requirement: '精通 Python',
  status: FACT_STATUS.CONFIRMED,
  reason: '简历原文明确写出使用 Python 完成数据处理',
  basis: { type: BASIS_TYPE.EXACT_MATCH, detail: 'normalizeKey 命中 skill:python' },
  resumeEvidence: '使用 Python 完成数据处理',
  evidenceRefs: [{ source: 'RESUME_TEXT', locator: 'resume:line:12', excerpt: '使用 Python 完成数据处理' }],
  isInference: false,
  needsUserConfirmation: false,
  confidence: CONFIDENCE.HIGH,
  suggestion: '保留',
});

test('契约 · 合法判断：CONFIRMED 且有用户来源证据，无问题', () => {
  assert.deepEqual(validateJudgment(confirmed), []);
});

test('契约 · I1：声称 CONFIRMED 却没有任何证据 → 拒绝', () => {
  const issues = validateJudgment({ ...confirmed, evidenceRefs: [] });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /没有任何证据引用/);
});

test('契约 · I1：证据只来自 OCR → 必须降级，不能算 CONFIRMED', () => {
  const issues = validateJudgment({
    ...confirmed,
    evidenceRefs: [{ source: 'OCR', locator: 'resume:page:2' }],
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /仅来自 OCR\/JD/);
});

test('契约 · I1：CONFIRMED 与 isInference=true 矛盾 → 拒绝', () => {
  const issues = validateJudgment({ ...confirmed, isInference: true });
  assert.ok(issues.some((i) => i.includes('矛盾')));
});

test('契约 · I2：声明 MISSING 却带着证据 → 判定自相矛盾', () => {
  const issues = validateJudgment(
    judgment({ evidenceRefs: [{ source: 'RESUME_TEXT', locator: 'resume:line:9' }] }),
  );
  assert.ok(issues.some((i) => i.includes('存在证据引用')));
});

test('契约 · I2：声明 MISSING 却填了 resumeEvidence → 拒绝', () => {
  const issues = validateJudgment(judgment({ resumeEvidence: '用过一点' }));
  assert.ok(issues.some((i) => i.includes('填写了 resumeEvidence')));
});

test('契约 · I3：isInference 与 status / basis 不一致 → 拒绝', () => {
  const a = validateJudgment(judgment({ status: FACT_STATUS.INFERRED, isInference: false }));
  assert.ok(a.some((i) => i.includes('isInference 与 status')));

  const b = validateJudgment(
    judgment({
      basis: { type: BASIS_TYPE.MODEL_INFERENCE, detail: '从项目描述推测' },
      isInference: false,
    }),
  );
  assert.ok(b.some((i) => i.includes('isInference 与 status')));
});

test('契约 · I4：非 CONFIRMED 必须交给用户确认', () => {
  const issues = validateJudgment(judgment({ needsUserConfirmation: false }));
  assert.ok(issues.some((i) => i.includes('必须标记 needsUserConfirmation=true')));
});

test('契约 · I4：CONFIRMED 不应再要求确认', () => {
  const issues = validateJudgment({ ...confirmed, needsUserConfirmation: true });
  assert.ok(issues.some((i) => i.includes('不应再要求用户确认')));
});

test('契约 · I5：MISSING 的依据类型必须是 ABSENT', () => {
  const issues = validateJudgment(
    judgment({ basis: { type: BASIS_TYPE.SEMANTIC_MATCH, detail: '语义上不相关' } }),
  );
  assert.ok(issues.some((i) => i.includes('basis.type 应为 ABSENT')));
});

test('契约 · I6：证据定位符不允许空串', () => {
  const issues = validateJudgment({
    ...confirmed,
    evidenceRefs: [{ source: 'RESUME_TEXT', locator: '   ' }],
  });
  assert.ok(issues.some((i) => i.includes('空 locator')));
});

test('契约 · reason 过短视为敷衍 → 拒绝', () => {
  const issues = validateJudgment({ ...confirmed, reason: '有' });
  assert.ok(issues.some((i) => i.includes('reason 过短')));
});

test('契约 · zod schema 拦非法枚举与缺字段', () => {
  assert.equal(aiJudgmentSchema.safeParse(confirmed).success, true);
  assert.equal(aiJudgmentSchema.safeParse({ ...confirmed, status: 'MAYBE' }).success, false);
  assert.equal(aiJudgmentSchema.safeParse({ ...confirmed, confidence: 'SURE' }).success, false);

  const missingField: Record<string, unknown> = { ...confirmed };
  delete missingField.basis;
  assert.equal(aiJudgmentSchema.safeParse(missingField).success, false);
});

test('契约 · 批量校验：定位到具体条目并抛错，不返回半成品', () => {
  const bad = { ...confirmed, evidenceRefs: [] };
  assert.throws(() => assertJudgmentsValid([confirmed, bad]), /AI 判断未通过契约校验：#1/);
  assert.doesNotThrow(() => assertJudgmentsValid([confirmed, judgment()]));
});

test('契约 · 覆盖计数用于替代百分比分数', () => {
  const list: AiJudgment[] = [
    confirmed,
    judgment({ status: FACT_STATUS.INFERRED, isInference: true, basis: { type: BASIS_TYPE.MODEL_INFERENCE, detail: '推测' } }),
    judgment({ status: FACT_STATUS.UNCONFIRMED }),
    judgment({ status: FACT_STATUS.MISSING }),
  ];
  const s = summarizeJudgments(list);
  assert.deepEqual(s, {
    total: 4,
    confirmed: 1,
    inferred: 1,
    unconfirmed: 1,
    missing: 1,
    needsUserConfirmation: 3,
  });
});

test('契约 · 与事实验证层协同：被阻断的主张不得出现在 CONFIRMED 判断里', () => {
  const facts: Fact[] = [
    { key: 'rag', label: 'RAG', status: FACT_STATUS.MISSING, evidence: [{ source: 'JD', locator: 'jd:req:7' }] },
  ];
  const verdict = verifyClaim({ text: '具备 RAG 开发经验', topicKey: 'RAG', kind: CLAIM_KIND.EXPERIENCE }, facts);
  assert.equal(verdict.verdict, 'BLOCK');

  // 如果模型仍然把它写成 CONFIRMED，契约必须拦下
  const forged = judgment({
    requirement: '具备 RAG 开发经验',
    status: FACT_STATUS.CONFIRMED,
    resumeEvidence: '具备 RAG 开发经验',
    evidenceRefs: [{ source: 'JD', locator: 'jd:req:7' }],
    needsUserConfirmation: false,
    basis: { type: BASIS_TYPE.EXACT_MATCH, detail: '命中' },
  });
  const issues = validateJudgment(forged);
  assert.ok(issues.length > 0, '伪造的 CONFIRMED 必须被契约拦下');
  assert.ok(issues.some((i) => i.includes('仅来自 OCR/JD')));
});

test('契约 · 列表 schema 可直接用于 LLM 输出校验', () => {
  const ok = aiJudgmentListSchema.safeParse({ judgments: [confirmed, judgment()] });
  assert.equal(ok.success, true);
  assert.equal(aiJudgmentListSchema.safeParse({ judgments: [{}] }).success, false);
  assert.equal(aiJudgmentListSchema.safeParse({ items: [] }).success, false);
});
