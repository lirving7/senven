import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyClaim, verifyClaims, canWrite, writeBlockedResults, normalizeKey } from '../src/domain/verify.ts';
import { FACT_STATUS, CLAIM_KIND, VERDICT } from '../src/domain/types.ts';
import type { Claim, Fact } from '../src/domain/types.ts';

const facts: Fact[] = [
  {
    key: 'python',
    label: 'Python',
    status: FACT_STATUS.CONFIRMED,
    evidence: [{ source: 'RESUME_TEXT', locator: 'resume:line:42', excerpt: '使用 Python 完成数据处理' }],
  },
  {
    key: 'rag',
    label: 'RAG',
    status: FACT_STATUS.MISSING,
    evidence: [{ source: 'JD', locator: 'jd:req:7', excerpt: '熟悉 RAG 检索增强' }],
  },
  {
    key: 'agent',
    label: 'Agent',
    status: FACT_STATUS.INFERRED,
    evidence: [{ source: 'OCR', locator: 'resume:page:2', excerpt: 'Agent（OCR 识别）' }],
  },
  {
    key: 'kotlin',
    label: 'Kotlin',
    status: FACT_STATUS.UNCONFIRMED,
    evidence: [{ source: 'OCR', locator: 'resume:page:3' }],
  },
  {
    key: 'android',
    label: 'Android',
    status: FACT_STATUS.CONFIRMED,
    evidence: [{ source: 'OCR', locator: 'resume:page:3' }],
  },
  {
    key: 'jetson',
    label: '边缘部署',
    status: FACT_STATUS.CONFIRMED,
    evidence: [{ source: 'RESUME_TEXT', locator: 'resume:line:88' }],
    aliases: ['edge', '边缘计算'],
  },
];

const skill = (topicKey: string, text = `熟悉${topicKey}`): Claim => ({
  text,
  topicKey,
  kind: CLAIM_KIND.SKILL,
});

test('无证据主张：阻断并标 UNCONFIRMED', () => {
  const r = verifyClaim(skill('Kubernetes', '具备 Kubernetes 运维经验'), facts);
  assert.equal(r.verdict, VERDICT.BLOCK);
  assert.equal(r.status, FACT_STATUS.UNCONFIRMED);
  assert.equal(r.evidence.length, 0);
});

test('MISSING：JD 要求但用户缺失，禁止写入', () => {
  const r = verifyClaim({
    text: '具备 RAG 开发经验',
    topicKey: 'RAG',
    kind: CLAIM_KIND.EXPERIENCE,
  }, facts);
  assert.equal(r.verdict, VERDICT.BLOCK);
  assert.equal(r.status, FACT_STATUS.MISSING);
});

test('UNCONFIRMED：待用户确认前不放行', () => {
  const r = verifyClaim(skill('Kotlin'), facts);
  assert.equal(r.verdict, VERDICT.BLOCK);
  assert.equal(r.status, FACT_STATUS.UNCONFIRMED);
});

test('INFERRED + 技能：放行但必须带标注', () => {
  const r = verifyClaim(skill('Agent'), facts);
  assert.equal(r.verdict, VERDICT.ALLOW_WITH_LABEL);
  assert.equal(r.status, FACT_STATUS.INFERRED);
  assert.match(r.label ?? '', /推断（待确认）/);
  assert.equal(canWrite(r), true);
});

test('INFERRED + 经历：一律阻断（推断不能当经历）', () => {
  const r = verifyClaim({
    text: '具备 Agent 开发经验',
    topicKey: 'Agent',
    kind: CLAIM_KIND.EXPERIENCE,
  }, facts);
  assert.equal(r.verdict, VERDICT.BLOCK);
  assert.equal(canWrite(r), false);
});

test('CONFIRMED 但仅 OCR 来源 + 经历主张：降级为待核验', () => {
  const r = verifyClaim({
    text: '具备 Android 开发经验',
    topicKey: 'Android',
    kind: CLAIM_KIND.EXPERIENCE,
  }, facts);
  assert.equal(r.verdict, VERDICT.ALLOW_WITH_LABEL);
  assert.match(r.label ?? '', /来源待核验/);
});

test('CONFIRMED 且有用户提供证据：放行', () => {
  const r = verifyClaim(skill('Python'), facts);
  assert.equal(r.verdict, VERDICT.ALLOW);
  assert.equal(r.status, FACT_STATUS.CONFIRMED);
  assert.ok(r.evidence.length > 0);
});

test('别名命中与大小写/空格归一', () => {
  assert.equal(normalizeKey('  Edge  '), 'edge');
  const r = verifyClaim(skill(' edge ', '具备边缘计算部署能力'), facts);
  assert.equal(r.verdict, VERDICT.ALLOW);
});

test('反胡编：返回值只含判定字段，不携带任何生成的经历内容', () => {
  const r = verifyClaim(skill('Python'), facts);
  const allowedKeys = new Set(['verdict', 'status', 'reason', 'label', 'evidence']);
  for (const k of Object.keys(r)) {
    assert.ok(allowedKeys.has(k), `意外字段：${k}`);
  }
  assert.equal(typeof r.reason, 'string');
});

test('批量校验与阻断清单', () => {
  const results = verifyClaims([
    skill('Python'),
    skill('RAG'),
    skill('Kotlin'),
    skill('Agent'),
  ], facts);
  assert.equal(results.length, 4);
  const blocked = writeBlockedResults(results);
  // RAG(MISSING) 与 Kotlin(UNCONFIRMED) 被阻断
  assert.equal(blocked.length, 2);
  assert.equal(writeBlockedResults(results).filter((r) => r.status === FACT_STATUS.MISSING).length, 1);
});
