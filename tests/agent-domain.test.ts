/**
 * T5-B-1 —— Agent Domain 单元测试（纯域，无 DB）
 *
 * 覆盖授权书 §十六 Domain 与边界项：状态机（合法 / 非法 / 终态）、goalKind allowlist、
 * proposal kind/status allowlist、revision=1、basedOnRefs 校验、payload 大小与禁止键、
 * semanticVersions / quotaUsage 结构、endedAt 规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_GOAL_KINDS,
  AGENT_RUN_STATUSES,
  AGENT_RUN_TERMINAL_STATUSES,
  type AgentRunStatus,
  agentRunStatusHasOutgoing,
  canTransitionAgentRun,
  evaluateAgentRunTransition,
  isAgentGoalKind,
  isAgentRunStatus,
  isTerminalAgentRunStatus,
  resolveAgentRunEndedAt,
} from '../src/domain/agent/agent-run.ts';
import {
  AGENT_PROPOSAL_KINDS,
  AGENT_PROPOSAL_STATUSES,
  AGENT_PROPOSAL_V1_REVISION,
  isAgentProposalKind,
  isAgentProposalRevision,
  isAgentProposalStatus,
} from '../src/domain/agent/agent-proposal.ts';
import {
  AGENT_BASED_ON_ENTITY_TYPES,
  AGENT_PAYLOAD_FORBIDDEN_KEYS,
  AGENT_PAYLOAD_MAX_BYTES,
  validateAgentBasedOnRefs,
  validateAgentProposalCreateInput,
  validateAgentProposalPayload,
  validateAgentQuotaUsage,
  validateAgentRunCreateInput,
  validateAgentSemanticVersions,
} from '../src/domain/agent/validation.ts';

const at = (iso: string) => new Date(iso);

// ─── 状态转移 ────────────────────────────────────────────────────────────

test('[state] 允许的转移逐条成立', () => {
  const allowed: Array<[AgentRunStatus, AgentRunStatus]> = [
    ['CREATED', 'PLANNING'],
    ['CREATED', 'CANCELLED'],
    ['CREATED', 'FAILED'],
    ['PLANNING', 'PROPOSED'],
    ['PLANNING', 'CANCELLED'],
    ['PLANNING', 'FAILED'],
    ['PROPOSED', 'EXPIRED'],
  ];
  for (const [from, to] of allowed) {
    assert.equal(evaluateAgentRunTransition(from, to), 'ALLOWED', `${from} → ${to} 应允许`);
    assert.equal(canTransitionAgentRun(from, to), true);
  }
});

test('[state] 非法转移逐条 FORBIDDEN（含 PROPOSED → CANCELLED）', () => {
  const forbidden: Array<[AgentRunStatus, AgentRunStatus]> = [
    ['CREATED', 'PROPOSED'],
    ['CREATED', 'EXPIRED'],
    ['PLANNING', 'CREATED'],
    ['PLANNING', 'EXPIRED'],
    ['PROPOSED', 'CANCELLED'],
    ['PROPOSED', 'PLANNING'],
    ['PROPOSED', 'FAILED'],
    ['CANCELLED', 'PLANNING'],
    ['CANCELLED', 'PROPOSED'],
    ['FAILED', 'PLANNING'],
    ['FAILED', 'PROPOSED'],
    ['EXPIRED', 'PROPOSED'],
    ['EXPIRED', 'PLANNING'],
  ];
  for (const [from, to] of forbidden) {
    assert.equal(evaluateAgentRunTransition(from, to), 'FORBIDDEN', `${from} → ${to} 应禁止`);
    assert.equal(canTransitionAgentRun(from, to), false);
  }
});

test('[state] 同值 = NOOP（可接受）', () => {
  for (const s of AGENT_RUN_STATUSES) {
    assert.equal(evaluateAgentRunTransition(s, s), 'NOOP');
    assert.equal(canTransitionAgentRun(s, s), true);
  }
});

test('[state] 终态判定与出边守卫', () => {
  for (const s of AGENT_RUN_TERMINAL_STATUSES) {
    assert.equal(isTerminalAgentRunStatus(s), true, `${s} 应为终态`);
  }
  assert.equal(isTerminalAgentRunStatus('CREATED'), false);
  assert.equal(isTerminalAgentRunStatus('PLANNING'), false);
  assert.equal(isTerminalAgentRunStatus('CONFIRMED'), false);

  // 除 PROPOSED（唯一允许 → EXPIRED）外，终态无任何出边
  assert.equal(agentRunStatusHasOutgoing('PROPOSED'), true);
  assert.equal(agentRunStatusHasOutgoing('CANCELLED'), false);
  assert.equal(agentRunStatusHasOutgoing('FAILED'), false);
  assert.equal(agentRunStatusHasOutgoing('EXPIRED'), false);
  assert.equal(agentRunStatusHasOutgoing('CREATED'), true);
  assert.equal(agentRunStatusHasOutgoing('PLANNING'), true);
});

test('[state] status allowlist 恰好 6 值且不含 CONFIRMED', () => {
  assert.deepEqual([...AGENT_RUN_STATUSES], ['CREATED', 'PLANNING', 'PROPOSED', 'CANCELLED', 'FAILED', 'EXPIRED']);
  assert.equal((AGENT_RUN_STATUSES as readonly string[]).includes('CONFIRMED'), false);
  assert.equal(isAgentRunStatus('CREATED'), true);
  assert.equal(isAgentRunStatus('CONFIRMED'), false);
  assert.equal(isAgentRunStatus('created'), false);
  assert.equal(isAgentRunStatus(123), false);
});

test('[state] goalKind allowlist 仅 CAREER_ASSISTANCE', () => {
  assert.deepEqual([...AGENT_GOAL_KINDS], ['CAREER_ASSISTANCE']);
  assert.equal(isAgentGoalKind('CAREER_ASSISTANCE'), true);
  assert.equal(isAgentGoalKind('OTHER'), false);
  assert.equal(isAgentGoalKind(null), false);
});

test('[state] endedAt：进入终态写入；非终态保持；已有值不被覆盖', () => {
  const now = at('2026-09-19T00:00:00.000Z');
  // 非终态
  assert.equal(resolveAgentRunEndedAt(null, 'PLANNING', now), null);
  // 首次进入终态
  assert.equal(resolveAgentRunEndedAt(null, 'PROPOSED', now), now);
  assert.equal(resolveAgentRunEndedAt(null, 'CANCELLED', now), now);
  assert.equal(resolveAgentRunEndedAt(null, 'FAILED', now), now);
  assert.equal(resolveAgentRunEndedAt(null, 'EXPIRED', now), now);
  // 已有 endedAt（如 PROPOSED → EXPIRED）→ 保留首次进入终态的时间
  const first = at('2026-01-01T00:00:00.000Z');
  assert.equal(resolveAgentRunEndedAt(first, 'EXPIRED', now), first);
});

// ─── Proposal allowlist / revision ───────────────────────────────────────

test('[proposal] kind 仅 PLAN；status 仅 ACTIVE；revision 恒 1', () => {
  assert.deepEqual([...AGENT_PROPOSAL_KINDS], ['PLAN']);
  assert.deepEqual([...AGENT_PROPOSAL_STATUSES], ['ACTIVE']);
  assert.equal(AGENT_PROPOSAL_V1_REVISION, 1);

  assert.equal(isAgentProposalKind('PLAN'), true);
  assert.equal(isAgentProposalKind('OTHER'), false);
  assert.equal(isAgentProposalStatus('ACTIVE'), true);
  assert.equal(isAgentProposalStatus('SUPERSEDED'), false);
  assert.equal(isAgentProposalStatus('DISMISSED'), false);
  assert.equal(isAgentProposalStatus('CONFIRMED'), false);
  assert.equal(isAgentProposalStatus('EXECUTED'), false);

  assert.equal(isAgentProposalRevision(1), true);
  assert.equal(isAgentProposalRevision(2), false);
  assert.equal(isAgentProposalRevision(0), false);
  assert.equal(isAgentProposalRevision(1.5), false);
  assert.equal(isAgentProposalRevision('1'), false);
});

// ─── payload ─────────────────────────────────────────────────────────────

test('[payload] 合法对象通过；非法形状被拒', () => {
  assert.deepEqual(validateAgentProposalPayload({ plan: ['a', 'b'], note: 'ok' }), { ok: true });
  assert.deepEqual(validateAgentProposalPayload({}), { ok: true });
  assert.equal(validateAgentProposalPayload(null).ok, false);
  assert.equal(validateAgentProposalPayload([]).ok, false);
  assert.equal(validateAgentProposalPayload('text').ok, false);
  assert.equal(validateAgentProposalPayload(42).ok, false);
});

test('[payload] 超过 16 KB 被拒；恰好边界内通过', () => {
  const big = { blob: 'x'.repeat(AGENT_PAYLOAD_MAX_BYTES + 10) };
  assert.equal(validateAgentProposalPayload(big).ok, false);

  const okPayload = { blob: 'x'.repeat(1000) };
  assert.equal(validateAgentProposalPayload(okPayload).ok, true);
});

test('[payload] 禁止键（含嵌套 / 数组 / 大小写变体）被拒', () => {
  for (const key of AGENT_PAYLOAD_FORBIDDEN_KEYS) {
    assert.equal(validateAgentProposalPayload({ [key]: 'v' }).ok, false, `顶层 ${key} 应被拒`);
    assert.equal(validateAgentProposalPayload({ nested: { [key]: 'v' } }).ok, false, `嵌套 ${key} 应被拒`);
    assert.equal(validateAgentProposalPayload({ list: [{ [key]: 'v' }] }).ok, false, `数组内 ${key} 应被拒`);
  }
  // 大小写变体
  assert.equal(validateAgentProposalPayload({ RawText: 'v' }).ok, false);
  assert.equal(validateAgentProposalPayload({ SYSTEMPROMPT: 'v' }).ok, false);
  assert.equal(validateAgentProposalPayload({ ApiKey: 'v' }).ok, false);
  // 非禁止键不受影响
  assert.equal(validateAgentProposalPayload({ rawTextLength: 3, tokensUsed: 5 }).ok, true);
});

// ─── basedOnRefs ─────────────────────────────────────────────────────────

test('[basedOnRefs] 合法结构通过（version / fingerprint 可选）', () => {
  assert.deepEqual(validateAgentBasedOnRefs([]), { ok: true });
  assert.equal(
    validateAgentBasedOnRefs([{ entityType: 'RESUME', entityId: 'abc' }]).ok,
    true,
  );
  assert.equal(
    validateAgentBasedOnRefs([
      { entityType: 'JD', entityId: 'jd1', version: 'v1', fingerprint: 'f1' },
      { entityType: 'KNOWLEDGE_CHUNK', entityId: 'c1' },
    ]).ok,
    true,
  );
});

test('[basedOnRefs] 非数组 / 非对象 / 非法 entityType 被拒', () => {
  assert.equal(validateAgentBasedOnRefs({}).ok, false);
  assert.equal(validateAgentBasedOnRefs([1]).ok, false);
  assert.equal(validateAgentBasedOnRefs([{ entityType: 'URL', entityId: 'x' }]).ok, false);
  assert.equal(validateAgentBasedOnRefs([{ entityType: 'RESUME' }]).ok, false);
  assert.equal(validateAgentBasedOnRefs([{ entityType: 'RESUME', entityId: '  ' }]).ok, false);
});

test('[basedOnRefs] allowlist 恰好 9 项', () => {
  assert.deepEqual([...AGENT_BASED_ON_ENTITY_TYPES], [
    'RESUME',
    'JD',
    'MATCH_RUN',
    'CAPABILITY',
    'PROJECT_RESULT',
    'ACTION_PLAN',
    'LEARNING_TASK',
    'PORTFOLIO',
    'KNOWLEDGE_CHUNK',
  ]);
});

test('[basedOnRefs] 禁止外部引用 / URL / 正文键 / 额外键', () => {
  assert.equal(validateAgentBasedOnRefs([{ entityType: 'RESUME', entityId: 'https://evil.example' }]).ok, false);
  assert.equal(validateAgentBasedOnRefs([{ entityType: 'RESUME', entityId: 'http://evil.example' }]).ok, false);
  assert.equal(validateAgentBasedOnRefs([{ entityType: 'RESUME', entityId: '//evil.example' }]).ok, false);
  assert.equal(validateAgentBasedOnRefs([{ entityType: 'RESUME', entityId: 'x', rawText: '正文' }]).ok, false);
  assert.equal(validateAgentBasedOnRefs([{ entityType: 'RESUME', entityId: 'x', content: '正文' }]).ok, false);
  assert.equal(validateAgentBasedOnRefs([{ entityType: 'RESUME', entityId: 'x', url: 'https://a.b' }]).ok, false);
});

// ─── semanticVersions / quotaUsage ───────────────────────────────────────

test('[semanticVersions] 空对象 / 最小三键通过；未知键与非字符串被拒', () => {
  assert.equal(validateAgentSemanticVersions({}).ok, true);
  assert.equal(
    validateAgentSemanticVersions({ tokenizer: 'cjk-bigram/v1', chunker: 'x', fts: 'y' }).ok,
    true,
  );
  assert.equal(validateAgentSemanticVersions({ tokenizer: 'cjk-bigram/v1' }).ok, true);
  assert.equal(validateAgentSemanticVersions({ other: 'v' }).ok, false);
  assert.equal(validateAgentSemanticVersions({ tokenizer: 1 }).ok, false);
  assert.equal(validateAgentSemanticVersions({ tokenizer: '' }).ok, false);
  assert.equal(validateAgentSemanticVersions([]).ok, false);
});

test('[quotaUsage] 允许 4 键非负整数；providerCalls 缺省由 {} 表达', () => {
  assert.equal(validateAgentQuotaUsage({}).ok, true);
  assert.equal(validateAgentQuotaUsage({ providerCalls: 0 }).ok, true);
  assert.equal(
    validateAgentQuotaUsage({ providerCalls: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30 }).ok,
    true,
  );
  assert.equal(validateAgentQuotaUsage({ providerCalls: -1 }).ok, false);
  assert.equal(validateAgentQuotaUsage({ providerCalls: 1.5 }).ok, false);
  assert.equal(validateAgentQuotaUsage({ unknown: 1 }).ok, false);
  assert.equal(validateAgentQuotaUsage({ providerCalls: '1' }).ok, false);
});

// ─── 组合校验 ────────────────────────────────────────────────────────────

test('[createRun] 组合校验：goalKind / promptTemplateVersion / semanticVersions / quotaUsage', () => {
  const good = {
    goalKind: 'CAREER_ASSISTANCE',
    promptTemplateVersion: 'agent-plan/v1',
    semanticVersions: {},
    quotaUsage: {},
  };
  assert.deepEqual(validateAgentRunCreateInput(good), { ok: true });
  assert.equal(validateAgentRunCreateInput({ ...good, goalKind: 'OTHER' }).ok, false);
  assert.equal(validateAgentRunCreateInput({ ...good, promptTemplateVersion: '' }).ok, false);
  assert.equal(validateAgentRunCreateInput({ ...good, semanticVersions: { bad: 1 } }).ok, false);
  assert.equal(validateAgentRunCreateInput({ ...good, quotaUsage: { bad: 1 } }).ok, false);
});

test('[createProposal] 组合校验：kind / revision / payload / basedOnRefs / status', () => {
  const good = {
    kind: 'PLAN',
    revision: 1,
    payload: { steps: ['a'] },
    basedOnRefs: [{ entityType: 'RESUME', entityId: 'r1' }],
  };
  assert.deepEqual(validateAgentProposalCreateInput(good), { ok: true });
  assert.equal(validateAgentProposalCreateInput({ ...good, kind: 'OTHER' }).ok, false);
  assert.equal(validateAgentProposalCreateInput({ ...good, revision: 2 }).ok, false);
  assert.equal(validateAgentProposalCreateInput({ ...good, payload: { content: 'x' } }).ok, false);
  assert.equal(
    validateAgentProposalCreateInput({ ...good, basedOnRefs: [{ entityType: 'JD', entityId: 'https://e.x' }] }).ok,
    false,
  );
  assert.equal(validateAgentProposalCreateInput({ ...good, status: 'ACTIVE' }).ok, true);
  assert.equal(validateAgentProposalCreateInput({ ...good, status: 'CONFIRMED' }).ok, false);
});
