/**
 * T5-B-2A —— Agent 只读工具层：Catalog / Schema / 输入边界（**纯测试，不触库**）
 *
 * 覆盖授权书 §十六：
 *   - Tool Catalog：9 tools exactly / no extra / no missing / name-schema-adapter 1:1；
 *   - Input：valid / invalid id / malformed / limit boundary / query boundary；
 *   - userId：工具输入 schema 不允许注入 userId（只来自会话）。
 *
 * 依据 ADR-017 §4（Catalog 逐字冻结）、§13（Security Model）、T5B-F-14…F-17 / F-61③④。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  AGENT_DEFERRED_TOOL_NAMES,
  AGENT_FORBIDDEN_TOOL_NAMES,
  AGENT_PUBLIC_TOOL_NAMES,
  AGENT_READ_TOOL_LAYER_VERSION,
  AGENT_READ_TOOL_NAMES,
  agentReadToolRequiresUserScope,
  agentReadToolTrust,
  isAgentReadToolName,
} from '../src/agent/contracts.ts';
import { AGENT_READ_TOOL_INPUT_SCHEMAS } from '../src/agent/tool-schemas.ts';
import { createAgentReadToolLayer } from '../src/agent/tool-layer.ts';
import type { AgentReadToolDeps } from '../src/agent/tool-deps.ts';

/** ADR-017 §4 表格中的 9 个工具名（逐字、按行序） */
const FROZEN_NAMES = [
  'get_resume_summary',
  'get_jd_summary',
  'get_match_result',
  'get_capabilities',
  'get_project_results',
  'get_action_plan',
  'get_learning_tasks',
  'get_portfolio',
  'rag_retrieve',
];

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function strip(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** 依赖围栏：任何**不应被触达**的适配器被调用即抛错（用于纯校验路径） */
function makeDeps(overrides: Partial<AgentReadToolDeps> = {}): AgentReadToolDeps {
  const notCalled = async () => {
    throw new Error('校验失败时不应触达适配器');
  };
  return {
    resumes: { listForUser: notCalled, findDetailForUser: notCalled },
    jds: { findByIdForUserWithRequirements: notCalled },
    matches: { findRunWithItemsForUser: notCalled, findLatestRunIdForUser: notCalled },
    capabilities: { listForUser: notCalled, findForUser: notCalled },
    projectResults: { listForUser: notCalled },
    actionPlans: { listForUser: notCalled, findForUser: notCalled },
    learningTasks: { listForUser: notCalled },
    portfolioProjects: { listForUser: notCalled, findForUser: notCalled },
    rag: { retrieve: async () => ({ hits: [], total: 0 }) },
    ...overrides,
  };
}

// ─── Catalog ────────────────────────────────────────────────────────────

test('[catalog] 恰好 9 个工具，且与 ADR-017 §4 逐字逐序一致', () => {
  assert.deepEqual([...AGENT_READ_TOOL_NAMES], FROZEN_NAMES);
  assert.equal(AGENT_READ_TOOL_NAMES.length, 9);
  assert.equal(new Set(AGENT_READ_TOOL_NAMES).size, 9, '不得出现重名');
});

test('[catalog] 无额外工具：DEFERRED / 永久禁止名单均不被 allowlist 接受', () => {
  for (const name of [...AGENT_DEFERRED_TOOL_NAMES, ...AGENT_FORBIDDEN_TOOL_NAMES]) {
    assert.equal(isAgentReadToolName(name), false, `${name} 不得进入 allowlist`);
    assert.equal((AGENT_READ_TOOL_NAMES as readonly string[]).includes(name), false);
  }
  // DEFERRED 三项必须确实不在 allowlist（T5B-F-15）
  assert.deepEqual([...AGENT_DEFERRED_TOOL_NAMES], ['get_interview', 'get_suggestions', 'get_applications']);
});

test('[catalog] 无缺失工具：9 名 ↔ 9 schema 一一对应', () => {
  const schemaKeys = Object.keys(AGENT_READ_TOOL_INPUT_SCHEMAS);
  assert.equal(schemaKeys.length, 9, `schema 数必须为 9，实际 ${schemaKeys.length}`);
  assert.deepEqual(schemaKeys, [...AGENT_READ_TOOL_NAMES]);
  for (const name of AGENT_READ_TOOL_NAMES) {
    assert.ok(AGENT_READ_TOOL_INPUT_SCHEMAS[name], `${name} 必须有对应 schema`);
  }
});

test('[catalog] 执行分派为**静态 switch 字面量**：9 个 case 且无按名字索引的函数表', () => {
  const code = strip(read('src/agent/tool-layer.ts'));
  const cases = [...code.matchAll(/case\s+'([a-z_]+)'/g)].map((m) => m[1]);
  assert.equal(cases.length, 9, `switch 必须恰好 9 个 case，实际 ${cases.length}`);
  assert.deepEqual([...cases].sort(), [...FROZEN_NAMES].sort(), 'case 集合必须等于 9 个冻结工具名');

  // 禁止动态分派：不得出现「按输入索引适配器表」的形态
  for (const banned of ['adapters[', 'ADAPTERS[', 'adaptersByName', 'byName[', 'table[', 'registry[']) {
    assert.equal(code.includes(banned), false, `tool-layer 不得出现动态分派形态 ${banned}`);
  }
});

test('[catalog] 层语义版本与公共工具集固定', () => {
  assert.equal(AGENT_READ_TOOL_LAYER_VERSION, 'agent-read-tool-layer/v1');
  assert.deepEqual([...AGENT_PUBLIC_TOOL_NAMES], ['rag_retrieve']);
  for (const name of AGENT_READ_TOOL_NAMES) {
    const requiresScope = name !== 'rag_retrieve';
    assert.equal(agentReadToolRequiresUserScope(name), requiresScope, `${name} 作用域判定错误`);
    assert.equal(agentReadToolTrust(name), name === 'rag_retrieve' ? 'UNTRUSTED_DATA' : 'DOMAIN_DATA');
  }
});

// ─── Input schema：strict + 边界 ────────────────────────────────────────

test('[input] 9 个 schema 全部 strict：未知字段（含 userId）一律拒绝', () => {
  for (const name of AGENT_READ_TOOL_NAMES) {
    const schema = AGENT_READ_TOOL_INPUT_SCHEMAS[name];
    const rejected = schema.safeParse({ userId: 'attacker-controlled' });
    assert.equal(rejected.success, false, `${name} 必须拒绝 userId 注入`);
    const unknown = schema.safeParse({ totallyUnknownField: 1 });
    assert.equal(unknown.success, false, `${name} 必须拒绝未知字段`);
  }
});

test('[input] schema 形状中不含 userId 字段（userId 只来自会话）', () => {
  const src = read('src/agent/tool-schemas.ts');
  const defined = [...src.matchAll(/z\s*\.object\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
  assert.equal(defined.length >= 9, true, '必须能定位至少 9 个对象 schema');
  for (const body of defined) {
    assert.equal(/\buserId\b/.test(body), false, '工具输入 schema 不得声明 userId');
  }
});

test('[input] valid input 通过；invalid id / malformed 被拒', async () => {
  const layer = createAgentReadToolLayer(
    makeDeps({ jds: { findByIdForUserWithRequirements: async () => null } }),
  );
  const ctx = { userId: 'u1' };

  // valid（仓储返回 null → 统一无 oracle 的 NOT_FOUND）
  assert.equal((await layer.invoke('get_jd_summary', { jdId: 'jd_1' }, ctx)).status, 'NOT_FOUND');

  // invalid id（空串 / 非字符串 / 超长）
  for (const bad of ['', 123, null, 'x'.repeat(65)]) {
    const r = await layer.invoke('get_jd_summary', { jdId: bad }, ctx);
    assert.equal(r.status, 'INVALID_INPUT', `jdId=${JSON.stringify(bad)} 必须被拒`);
  }
  // 缺失必填
  assert.equal((await layer.invoke('get_jd_summary', {}, ctx)).status, 'INVALID_INPUT');

  // malformed 顶层
  for (const bad of [null, undefined, 42, 'str', ['a'], true]) {
    const r = await layer.invoke('get_resume_summary', bad, ctx);
    assert.equal(r.status, 'INVALID_INPUT', `顶层输入 ${JSON.stringify(bad)} 必须被拒`);
  }
});

test('[input] limit 边界：0 / 21 被拒；1 / 20 / 缺省 被接受', async () => {
  const layer = createAgentReadToolLayer(makeDeps());
  const ctx = { userId: 'u1' };

  for (const bad of [0, 21, -1, 1.5]) {
    const r = await layer.invoke('rag_retrieve', { query: '面试', limit: bad }, ctx);
    assert.equal(r.status, 'INVALID_INPUT', `limit=${bad} 必须被拒`);
  }
  for (const ok of [1, 20, undefined]) {
    const r = await layer.invoke('rag_retrieve', { query: '面试', limit: ok }, ctx);
    assert.equal(r.status, 'OK', `limit=${String(ok)} 必须被接受`);
  }
});

test('[input] query 边界：空 / 纯空白 / 超 200 被拒；1 与 200 被接受', async () => {
  const layer = createAgentReadToolLayer(makeDeps());
  const ctx = { userId: 'u1' };

  for (const bad of ['', '   ', '\n\t ']) {
    const r = await layer.invoke('rag_retrieve', { query: bad }, ctx);
    assert.equal(r.status, 'INVALID_INPUT', `query=${JSON.stringify(bad)} 必须被拒`);
  }
  const tooLong = await layer.invoke('rag_retrieve', { query: 'a'.repeat(201) }, ctx);
  assert.equal(tooLong.status, 'INVALID_INPUT', '201 字符必须被拒');
  const absurd = await layer.invoke('rag_retrieve', { query: 'a'.repeat(801) }, ctx);
  assert.equal(absurd.status, 'INVALID_INPUT', '超机械上限必须被拒');

  assert.equal((await layer.invoke('rag_retrieve', { query: 'a' }, ctx)).status, 'OK');
  assert.equal((await layer.invoke('rag_retrieve', { query: 'a'.repeat(200) }, ctx)).status, 'OK');
});

// ─── 封闭 allowlist：未知工具名硬失败 ───────────────────────────────────

test('[allowlist] 未知 / 保留 / 非法工具名 → UNKNOWN_TOOL（硬失败，不触达适配器）', async () => {
  const layer = createAgentReadToolLayer(makeDeps());
  for (const name of [
    'get_interview',
    'get_suggestions',
    'get_applications',
    'raw_text_dump',
    'http_fetch',
    'execute_sql',
    'GET_RESUME_SUMMARY',
    'get_resume_summary ',
    'getResumeSummary',
    '',
    'a'.repeat(200),
  ]) {
    const r = await layer.invoke(name, {}, { userId: 'u1' });
    assert.equal(r.status, 'UNKNOWN_TOOL', `${JSON.stringify(name)} 必须硬失败`);
    assert.equal(r.code, 'VALIDATION_FAILED');
  }
  for (const name of [null, undefined, 42, {}, []]) {
    const r = await layer.invoke(name, {}, { userId: 'u1' });
    assert.equal(r.status, 'UNKNOWN_TOOL', `非字符串工具名 ${JSON.stringify(name)} 必须硬失败`);
  }
});

// ─── userId 来源 ────────────────────────────────────────────────────────

test('[userId] 缺少会话 userId → INVALID_INPUT（8 个有作用域工具）', async () => {
  const layer = createAgentReadToolLayer(makeDeps());
  for (const name of AGENT_READ_TOOL_NAMES) {
    if (!agentReadToolRequiresUserScope(name)) continue;
    for (const ctx of [undefined, {}, { userId: '' }]) {
      const r = await layer.invoke(name, {}, ctx);
      assert.equal(r.status, 'INVALID_INPUT', `${name} 缺少会话 userId 必须拒绝`);
    }
  }
});

test('[userId] rag_retrieve 无需 userId（公共/受控语料）', async () => {
  const layer = createAgentReadToolLayer(makeDeps());
  const r = await layer.invoke('rag_retrieve', { query: '面试' });
  assert.equal(r.status, 'OK');
  assert.equal(r.status === 'OK' && r.trust, 'UNTRUSTED_DATA');
});

test('[userId] userId 只能来自会话：输入携带 userId 时被 schema 拒绝', async () => {
  const layer = createAgentReadToolLayer(makeDeps());
  const r = await layer.invoke('get_resume_summary', { userId: 'victim' }, { userId: 'u1' });
  assert.equal(r.status, 'INVALID_INPUT');
  assert.equal(r.status === 'INVALID_INPUT' && r.issues.length > 0, true);
});

test('[userId] 适配器收到的 userId 恒等于会话 ctx.userId（而非输入）', async () => {
  const seen: string[] = [];
  const deps = makeDeps({
    resumes: {
      listForUser: async () => [],
      findDetailForUser: async (_id: string, userId: string) => {
        seen.push(userId);
        return null;
      },
    },
  });
  const layer = createAgentReadToolLayer(deps);
  await layer.invoke('get_resume_summary', { resumeId: 'r1' }, { userId: 'session-user' });
  assert.deepEqual(seen, ['session-user']);
});
