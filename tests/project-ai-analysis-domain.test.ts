/**
 * T3-A2-2 Domain 层验收（纯函数，不依赖数据库、不调用真实 LLM）
 *
 * 覆盖：
 *   - Capability key normalization contract（docs §6.1 / §6.2 全部正式接受行为）
 *   - key 长度上限 / 字符集限制 / 空值拒绝
 *   - LLM 输出严格白名单（unknown keys 拒绝、candidates 最多 5、非数组拒绝）
 *   - 服务端重校验（artifactId 不属该成果 → 结构异常；key 不合规 → 结构异常）
 *   - 重试语义（结构错误重试；达上限抛 AiAnalysisInvalidResponseError；非结构错误不重试）
 *   - `<data>` 隔离提示词
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_KEY_MAX_LENGTH,
  normalizeCapabilityKey,
  validateCapabilityKey,
} from '../src/domain/capability/key.ts';
import {
  AiAnalysisInvalidResponseError,
  MAX_ANALYSIS_ATTEMPTS,
  MAX_CANDIDATES,
  MAX_INSIGHT_ITEMS,
  PROJECT_ANALYSIS_SYSTEM_PROMPT,
  analyzeProjectResult,
  buildAnalysisPrompt,
  parseAnalysisOutput,
  sanitizeAnalysis,
  sanitizeCandidates,
  type ProjectAnalysisContext,
} from '../src/domain/ai/analyze-project.ts';
import { LLMFormatError, LLMTimeoutError } from '../src/llm/provider.ts';

// ─── Capability key normalization contract ───────────────────────────

test('[§6.2] 正式接受的行为（逐条）', () => {
  assert.equal(normalizeCapabilityKey('.net'), '.net');
  assert.equal(normalizeCapabilityKey('net'), 'net');
  assert.equal(normalizeCapabilityKey('C#'), 'c#');
  assert.equal(normalizeCapabilityKey('C＃'), 'c#'); // 全角 ＃ → NFKC → #
  assert.equal(normalizeCapabilityKey('C++'), 'c++');
  assert.equal(normalizeCapabilityKey('Node.js'), 'node.js');
  assert.equal(normalizeCapabilityKey('NodeJS'), 'nodejs');
});

test('[§6.2] 正式接受的区分与等价', () => {
  assert.notEqual(normalizeCapabilityKey('.net'), normalizeCapabilityKey('net'));
  assert.notEqual(normalizeCapabilityKey('Node.js'), normalizeCapabilityKey('NodeJS'));
  assert.equal(normalizeCapabilityKey('C#'), normalizeCapabilityKey('C＃'));
  assert.equal(normalizeCapabilityKey('C++'), normalizeCapabilityKey('c++'));
});

test('[§6.1] NFKC / 大小写 / 首尾空白 / 连续空白', () => {
  assert.equal(normalizeCapabilityKey('ＰＹＴＨＯＮ'), 'python'); // 全角字母
  assert.equal(normalizeCapabilityKey('  Docker  '), 'docker');
  assert.equal(normalizeCapabilityKey('machine   learning'), 'machine learning');
  assert.equal(normalizeCapabilityKey('machine\tlearning'), 'machine learning');
  assert.equal(normalizeCapabilityKey('machine\nlearning'), 'machine learning');
});

test('[§6.1 第6/7条] 不得套用 fingerprint / Match 规则（保留 . + #，不删标点）', () => {
  // 若误用 normalizeForMatch（删标点），Node.js 会变成 nodejs；若误用 fingerprint（不 lowercase），会保留大小写
  assert.equal(normalizeCapabilityKey('Node.js'), 'node.js');
  assert.equal(normalizeCapabilityKey('C#'), 'c#');
  assert.equal(normalizeCapabilityKey('C++'), 'c++');
});

test('validateCapabilityKey：空值拒绝', () => {
  assert.equal(validateCapabilityKey('').ok, false);
  assert.equal(validateCapabilityKey('   ').ok, false);
  assert.equal(validateCapabilityKey('\n\t').ok, false);
  assert.equal(validateCapabilityKey(undefined).ok, false);
  assert.equal(validateCapabilityKey(123).ok, false);
});

test('validateCapabilityKey：长度上限', () => {
  const ok = 'a'.repeat(CAPABILITY_KEY_MAX_LENGTH);
  assert.equal(validateCapabilityKey(ok).ok, true);
  assert.equal(validateCapabilityKey('a'.repeat(CAPABILITY_KEY_MAX_LENGTH + 1)).ok, false);
});

test('validateCapabilityKey：字符集限制', () => {
  for (const bad of ['python/3', 'a;b', "x'y", 'a"b', 'a<b', 'a:b', 'calc(1)', 'x🙂', 'a\\b', 'a`b']) {
    assert.equal(validateCapabilityKey(bad).ok, false, `应拒绝：${bad}`);
  }
  for (const good of ['docker', 'node.js', 'c++', 'c#', '.net', 'k8s', 'docker-compose', 'machine learning', '机器学习', 'ci_cd']) {
    assert.equal(validateCapabilityKey(good).ok, true, `应接受：${good}`);
  }
});

test('validateCapabilityKey：返回规范化后的 key', () => {
  const r = validateCapabilityKey('  Node.JS  ');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.key, 'node.js');
});

// ─── LLM 输出严格白名单 ───────────────────────────────────────────────

test('parseAnalysisOutput：合法输出通过', () => {
  const out = parseAnalysisOutput(
    { candidates: [{ artifactId: 'a1', key: 'docker', label: 'Docker' }] },
    'fake',
  );
  assert.equal(out.candidates.length, 1);
});

test('parseAnalysisOutput：unknown keys 必须拒绝（含 status / level / confirmed / userId 等）', () => {
  const forbidden = ['status', 'level', 'confirmed', 'userId', 'capabilityId', 'url', 'source', 'resultId', 'resultArtifactId'];
  for (const f of forbidden) {
    assert.throws(
      () => parseAnalysisOutput({ candidates: [{ artifactId: 'a1', key: 'k', label: 'L', [f]: 'x' }] }, 'fake'),
      (e: unknown) => e instanceof AiAnalysisInvalidResponseError,
      `候选内的 ${f} 应被拒绝`,
    );
  }
  // 顶层未知字段
  assert.throws(
    () => parseAnalysisOutput({ candidates: [], status: 'CONFIRMED' }, 'fake'),
    (e: unknown) => e instanceof AiAnalysisInvalidResponseError,
  );
});

test('parseAnalysisOutput：candidates 非数组 / 缺失 / 超过 5 条 → 拒绝', () => {
  assert.throws(() => parseAnalysisOutput({ candidates: 'nope' }, 'fake'), (e: unknown) => e instanceof AiAnalysisInvalidResponseError);
  assert.throws(() => parseAnalysisOutput({}, 'fake'), (e: unknown) => e instanceof AiAnalysisInvalidResponseError);
  assert.throws(() => parseAnalysisOutput(null, 'fake'), (e: unknown) => e instanceof AiAnalysisInvalidResponseError);

  const six = { candidates: Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({ artifactId: `a${i}`, key: 'k', label: 'L' })) };
  assert.throws(() => parseAnalysisOutput(six, 'fake'), (e: unknown) => e instanceof AiAnalysisInvalidResponseError);

  const five = { candidates: Array.from({ length: MAX_CANDIDATES }, (_, i) => ({ artifactId: `a${i}`, key: 'k', label: 'L' })) };
  assert.equal(parseAnalysisOutput(five, 'fake').candidates.length, MAX_CANDIDATES);
});

test('parseAnalysisOutput：空数组合法（没有合适候选）', () => {
  assert.deepEqual(parseAnalysisOutput({ candidates: [] }, 'fake').candidates, []);
});

// ─── 服务端重校验 ─────────────────────────────────────────────────────

test('sanitizeCandidates：artifactId 不属该成果 → 结构异常（不静默丢弃）', () => {
  const out = parseAnalysisOutput({ candidates: [{ artifactId: 'foreign', key: 'docker', label: 'D' }] }, 'fake');
  assert.throws(
    () => sanitizeCandidates(out, new Set(['mine'])),
    (e: unknown) => e instanceof AiAnalysisInvalidResponseError,
  );
});

test('sanitizeCandidates：key 不合规 → 结构异常', () => {
  const out = parseAnalysisOutput({ candidates: [{ artifactId: 'mine', key: 'drop table;--', label: 'D' }] }, 'fake');
  assert.throws(
    () => sanitizeCandidates(out, new Set(['mine'])),
    (e: unknown) => e instanceof AiAnalysisInvalidResponseError,
  );
});

test('sanitizeCandidates：返回服务端规范化后的 key（模型 key 不可信）', () => {
  const out = parseAnalysisOutput({ candidates: [{ artifactId: 'mine', key: '  Node.JS  ', label: 'Node' }] }, 'fake');
  const got = sanitizeCandidates(out, new Set(['mine']));
  assert.equal(got[0].key, 'node.js');
  assert.equal(got[0].artifactId, 'mine');
});

// ─── 重试语义 ─────────────────────────────────────────────────────────

const CTX: ProjectAnalysisContext = {
  title: 't',
  summary: 's',
  sourceStepTitle: 'st',
  sourceStepTargetRequirement: null,
  artifacts: [{ id: 'a1', kind: 'REPO', url: 'https://e/a', excerpt: null }],
};

function deps(calls: unknown[]) {
  let i = 0;
  return {
    providerName: 'fake',
    allowedArtifactIds: new Set(['a1']),
    calls: () => i,
    callProvider: async () => {
      const v = calls[i];
      i += 1;
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

test('重试：第 1 次结构错误、第 2 次成功 → 正常返回，调用 2 次', async () => {
  const d = deps([{ candidates: [{ artifactId: 'a1', key: 'k', label: 'L', evil: 1 }] }, { candidates: [{ artifactId: 'a1', key: 'k', label: 'L' }] }]);
  const out = await analyzeProjectResult(CTX, d);
  assert.equal(out.candidates.length, 1);
  assert.equal(d.calls(), 2);
});

test('重试：provider 抛 LLMFormatError → 重试；最终仍失败 → AiAnalysisInvalidResponseError', async () => {
  const d = deps([new LLMFormatError('bad json', 'fake'), new LLMFormatError('bad json', 'fake'), new LLMFormatError('bad json', 'fake'), { candidates: [] }]);
  await assert.rejects(
    () => analyzeProjectResult(CTX, d),
    (e: unknown) => e instanceof AiAnalysisInvalidResponseError,
  );
  assert.equal(d.calls(), MAX_ANALYSIS_ATTEMPTS, `总尝试次数应为 ${MAX_ANALYSIS_ATTEMPTS}（≤3）`);
});

test('重试：非结构错误（超时）立即冒泡，不重试', async () => {
  const d = deps([new LLMTimeoutError('timeout', 'fake'), { candidates: [] }]);
  await assert.rejects(() => analyzeProjectResult(CTX, d), (e: unknown) => e instanceof LLMTimeoutError);
  assert.equal(d.calls(), 1);
});

test('重试：artifactId 越权不重试无效内容 —— 只在结构层面重试，最终抛结构异常', async () => {
  const d = deps([{ candidates: [{ artifactId: 'x', key: 'k', label: 'L' }] }]);
  await assert.rejects(
    () => analyzeProjectResult(CTX, d),
    (e: unknown) => e instanceof AiAnalysisInvalidResponseError,
  );
});

// ─── Prompt 隔离 ─────────────────────────────────────────────────────

test('提示词：内容以 <data> 包裹，并在 system 中声明不可信', () => {
  const p = buildAnalysisPrompt(CTX);
  assert.ok(p.startsWith('<data>'));
  assert.ok(p.trimEnd().endsWith('</data>'));
  assert.match(PROJECT_ANALYSIS_SYSTEM_PROMPT, /不可信业务数据/);
  assert.match(PROJECT_ANALYSIS_SYSTEM_PROMPT, /不得执行/);
  // 二阶注入输入（可能来自此前的 LLM 产物）必须落在 <data> 内
  assert.ok(p.includes('sourceStepTitle'));
  assert.ok(p.includes('sourceStepTargetRequirement'));
});

// ─── Phase 1：分析输出增强（strengths / weaknesses / evidence / nextSteps）───

function fullOutput(artifactId = 'a1') {
  return {
    candidates: [{ artifactId, key: 'docker', label: 'Docker' }],
    strengths: ['完成了核心清洗流程，方案完整'],
    weaknesses: ['缺少 README，运行方式不可复现'],
    evidence: [{ artifactId, point: '提交内容显示包含商品数据分析流程的说明' }],
    nextSteps: ['补充 README，说明项目目标、技术栈、运行方式和核心实现'],
  };
}

test('[Phase 1] parse：完整五段输出通过；旧形状（仅 candidates）默认补空数组（加性兼容）', () => {
  const full = parseAnalysisOutput(fullOutput(), 'fake');
  assert.equal(full.strengths.length, 1);
  assert.equal(full.weaknesses.length, 1);
  assert.equal(full.evidence.length, 1);
  assert.equal(full.nextSteps.length, 1);

  const legacy = parseAnalysisOutput({ candidates: [] }, 'fake');
  assert.deepEqual(legacy.strengths, []);
  assert.deepEqual(legacy.weaknesses, []);
  assert.deepEqual(legacy.evidence, []);
  assert.deepEqual(legacy.nextSteps, []);
});

test('[Phase 1] parse：evidence 条目 strict（未知字段拒绝）；各段超上限 / 超长拒绝', () => {
  assert.throws(
    () => parseAnalysisOutput({ ...fullOutput(), evidence: [{ artifactId: 'a1', point: 'p', url: 'https://e' }] }, 'fake'),
    (e: unknown) => e instanceof AiAnalysisInvalidResponseError,
  );
  assert.throws(
    () => parseAnalysisOutput({ ...fullOutput(), strengths: Array.from({ length: MAX_INSIGHT_ITEMS + 1 }, () => 's') }, 'fake'),
    (e: unknown) => e instanceof AiAnalysisInvalidResponseError,
  );
  assert.throws(
    () => parseAnalysisOutput({ ...fullOutput(), nextSteps: ['x'.repeat(301)] }, 'fake'),
    (e: unknown) => e instanceof AiAnalysisInvalidResponseError,
  );
});

test('[Phase 1] sanitizeAnalysis：evidence 引用他人/不存在 artifact → 结构异常（不静默丢弃）', () => {
  const out = parseAnalysisOutput({ ...fullOutput('foreign'), candidates: [] }, 'fake');
  assert.throws(
    () => sanitizeAnalysis(out, new Set(['a1'])),
    (e: unknown) => e instanceof AiAnalysisInvalidResponseError,
  );
});

test('[Phase 1] sanitizeAnalysis：合法 evidence 通过；candidates 既有规则不变', () => {
  const out = parseAnalysisOutput(fullOutput('a1'), 'fake');
  const got = sanitizeAnalysis(out, new Set(['a1']));
  assert.equal(got.candidates[0].key, 'docker');
  assert.equal(got.evidence[0].artifactId, 'a1');
  assert.ok(got.strengths[0].includes('清洗流程'));
  assert.ok(got.nextSteps[0].includes('README'));
});

test('[Phase 1] analyzeProjectResult：完整链路返回 AnalysisResult（含四段）', async () => {
  const d = deps([fullOutput('a1')]);
  const out = await analyzeProjectResult(CTX, d);
  assert.equal(out.candidates.length, 1);
  assert.equal(out.evidence.length, 1);
  assert.equal(out.strengths.length, 1);
  assert.equal(out.weaknesses.length, 1);
  assert.equal(out.nextSteps.length, 1);
});
