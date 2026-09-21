/**
 * T5-B-1 —— 机械边界守卫（源码 / 文件系统扫描，无 DB）
 *
 * 覆盖授权书 §二（绝对禁止）与 §十六 Boundary Guards：
 *   - 无 Agent API / 无 Agent Handler / 无 Agent Tool Layer / 无 Tool Calling / 无 Confirmation；
 *   - Domain 无 Prisma / 无 DB client / 无 raw SQL；
 *   - Provider 未被触碰；LLM 槽位基线 = 9（T5-B-2B0 特批新增 `AGENT`，quota 键已登记）；
 *   - Migration 恒 14 且 #14 SQL 无禁止项；#13 冻结结构未被破坏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function strip(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const AGENT_DOMAIN_FILES = [
  'src/domain/agent/agent-run.ts',
  'src/domain/agent/agent-proposal.ts',
  'src/domain/agent/validation.ts',
];

test('[§十一] Agent Domain 不依赖 Prisma / DB client / raw SQL / HTTP / Ports', () => {
  for (const rel of AGENT_DOMAIN_FILES) {
    const code = strip(read(rel));
    for (const forbidden of [
      '@prisma/client',
      '../../db/',
      '../db/',
      '../../http/',
      '../http/',
      '../../ports/',
      '../ports/',
      '$queryRaw',
      '$executeRaw',
      'PrismaClient',
    ]) {
      assert.equal(code.includes(forbidden), false, `${rel} 不得包含 ${forbidden}`);
    }
  }
});

test('[§十七→2C] Agent API 白名单：恰好 3 个 endpoint，method 逐字一致（T5-B-2C 授权）', () => {
  // T5-B-2C 授权后基线由「零 Agent API」机械同步为「恰好 3 路由」
  assert.equal(existsSync(path.join(process.cwd(), 'app/api/agent')), true, 'T5-B-2C 已授权 app/api/agent');
  const routes: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name === 'route.ts') routes.push('/' + path.relative(process.cwd(), abs).replace(/\\/g, '/'));
    }
  })(path.join(process.cwd(), 'app/api/agent'));
  assert.deepEqual(routes.sort(), [
    '/app/api/agent/actions/[id]/execute/route.ts',
    '/app/api/agent/actions/[id]/route.ts',
    '/app/api/agent/proposals/[proposalId]/confirm/route.ts',
    '/app/api/agent/runs/[id]/cancel/route.ts',
    '/app/api/agent/runs/[id]/route.ts',
    '/app/api/agent/runs/route.ts',
  ]);
  const apiRoot = readdirSync(path.join(process.cwd(), 'app/api'));
  assert.equal(apiRoot.filter((n) => /agent/i.test(n)).join(','), 'agent', 'app/api 下 agent 目录唯一');

  const methodsOf = (rel: string) =>
    [...readFileSync(path.join(process.cwd(), rel), 'utf8').matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!).sort();
  assert.deepEqual(methodsOf('app/api/agent/runs/route.ts'), ['POST']);
  assert.deepEqual(methodsOf('app/api/agent/runs/[id]/route.ts'), ['GET']);
  assert.deepEqual(methodsOf('app/api/agent/runs/[id]/cancel/route.ts'), ['POST']);
  // T6-4-A 授权：Act Confirm / Execute / Result 三个新 endpoint（§一：Plan+Propose+Confirm+Execute+Result）
  assert.deepEqual(methodsOf('app/api/agent/proposals/[proposalId]/confirm/route.ts'), ['POST']);
  assert.deepEqual(methodsOf('app/api/agent/actions/[id]/execute/route.ts'), ['POST']);
  assert.deepEqual(methodsOf('app/api/agent/actions/[id]/route.ts'), ['GET']);
});

test('[§二] 不存在 Agent Handler / Tool Layer / ToolCall / Confirmation', () => {
  const files = [...walk('src'), ...walk('app')];
  for (const rel of files) {
    const code = strip(read(rel));
    for (const forbidden of ['AgentToolCall', 'AgentConfirmation', 'AgentTool', 'agentTool', 'toolCall', 'tool-call']) {
      assert.equal(code.includes(forbidden), false, `${rel} 不得出现 ${forbidden}`);
    }
  }

  // T5-B-2C 基线同步：handlers 仅允许 agent-runs.ts；deps 仅允许唯一 Agent 装配点
  const handlers = readdirSync(path.join(process.cwd(), 'src/http/handlers'));
  assert.deepEqual(
    handlers.filter((f) => /agent/i.test(f)),
    ['agent-actions.ts', 'agent-runs.ts'],
    'handlers 中仅允许 agent-runs.ts（T5-B-2C）+ agent-actions.ts（T6-4-A 授权）',
  );
  const deps = strip(read('src/http/deps.ts'));
  assert.deepEqual(
    // 2026-09-21 授权：装配点可 async（providerFor），正则同步兼容 `export async function`
    [...deps.matchAll(/export (?:async )?function (buildAgent\w+)/g)].map((m) => m[1]),
    ['buildAgentRunsHandlerDeps', 'buildAgentActionsHandlerDeps'],
    'deps 仅允许 Agent 装配点 buildAgentRunsHandlerDeps（T5-B-2C）+ buildAgentActionsHandlerDeps（T6-4-A 授权）',
  );
});

test('[§二] Provider 未被触碰：无任何 agent 引用', () => {
  for (const rel of ['src/llm/provider.ts', 'src/llm/openai-compat-provider.ts']) {
    const code = strip(read(rel));
    assert.equal(/agent/i.test(code), false, `${rel} 不得出现 agent 引用`);
  }
});

test('[§二] quota 基线同步：LLM 槽位为 9 个且 AGENT 为第 9 项（T5-B-2B0 特批）', () => {
  const ports = strip(read('src/ports/index.ts'));
  const start = ports.indexOf('export const LLM_FEATURE = {');
  const end = ports.indexOf('} as const;', start);
  assert.ok(start >= 0 && end > start, '必须能定位 LLM_FEATURE');
  const block = ports.slice(start, end);

  // T5-B-2B0：ADR-017 §3（T5B-F-10）授权新增第 9 槽，基线由 8 项机械同步为 9 项
  assert.equal(/AGENT: 'AGENT'/.test(block), true, 'LLM_FEATURE 必须登记 AGENT 槽位');
  const slots = [...block.matchAll(/([A-Z_]+):\s*'/g)].map((m) => m[1]);
  assert.deepEqual(slots, [
    'RESUME',
    'JD',
    'MATCH',
    'ACTION_PLAN',
    'LEARNING',
    'PROJECT_MENTOR',
    'PORTFOLIO',
    'INTERVIEW',
    'AGENT',
  ]);

  const quota = strip(read('src/llm/quota.ts'));
  assert.equal(/\[LLM_FEATURE\.AGENT\]/.test(quota), true, 'quota.ts 必须登记 AGENT 额度键');
});

test('[§十] 检索/写仓储未提供无 userId 的 proposal 读取接口', () => {
  const ports = strip(read('src/ports/index.ts'));
  assert.equal(/findProposalById/.test(ports), false, '不得提供 findProposalById（必须带 userId）');
  assert.equal(/findProposalForUser/.test(ports), true, '必须提供 findProposalForUser(proposalId, userId)');

  const repo = strip(read('src/db/repositories.ts'));
  assert.equal(/findProposalById/.test(repo), false, '实现层不得出现 findProposalById');
});

test('[§二] Agent 仓储不写入任何事实层（Capability / Evidence / CONFIRMED）', () => {
  const code = strip(read('src/db/repositories.ts'));
  const start = code.indexOf('const agentRuns: AgentRunRepository = {');
  assert.ok(start >= 0, '必须能定位 agentRuns 实现块');
  const block = code.slice(start, code.indexOf('return {', start));
  for (const forbidden of ['capability', 'CapabilityEvidence', 'evidence', 'CONFIRMED', 'verifyClaim', 'llmUsage', 'providerFromEnv']) {
    assert.equal(block.includes(forbidden), false, `agentRuns 实现块不得出现 ${forbidden}`);
  }
});

test('[§十三] Migration 恒 18（Avatar 授权新增 #18）；#14 SQL 无禁止项；#13 冻结结构未被破坏', () => {
  const migDir = path.join(process.cwd(), 'prisma/migrations');
  const dirs = readdirSync(migDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  assert.equal(dirs.length, 19, `migration 必须为 19（#18 Avatar + #19 用户自带 LLM API Key，2026-09-21 授权），实际 ${dirs.length}`);
  assert.equal(dirs[13], '20260919025710_agent_domain_persistence', 'Migration #14 名称固定');
  assert.equal(dirs[15], '20260919170000_application_tracker', 'Migration #16（Application Tracker）位置固定');
  assert.equal(dirs[12], '20260919000100_rag_knowledge_base', 'Migration #13 必须保持不变');
  assert.equal(dirs[17], '20260920210000_user_avatar_url', 'Migration #18（Avatar）必须是最后一条');

  const sql = readFileSync(path.join(migDir, dirs[13], 'migration.sql'), 'utf8');
  // 剥离 `--` 行注释后再做禁止项扫描（迁移头部的「授权记录」注释会引用禁止项名称）
  const sqlCode = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  // 必备授权结构
  assert.ok(/CREATE TABLE "AgentRun"/.test(sqlCode), '#14 必须创建 AgentRun');
  assert.ok(/CREATE TABLE "AgentProposal"/.test(sqlCode), '#14 必须创建 AgentProposal');
  assert.ok(/AgentRun_userId_idx/.test(sqlCode), '#14 必须有 AgentRun(userId) 索引');
  assert.ok(/AgentProposal_runId_revision_key/.test(sqlCode), '#14 必须有 (runId, revision) 唯一索引');
  assert.ok(/AgentRun_userId_fkey/.test(sqlCode) && /ON DELETE CASCADE/.test(sqlCode), '#14 必须有 CASCADE FK');
  for (const c of [
    'AgentRun_status_check',
    'AgentRun_goalKind_check',
    'AgentProposal_kind_check',
    'AgentProposal_status_check',
  ]) {
    assert.ok(sqlCode.includes(c), `#14 必须有 ${c}`);
  }

  // 禁止项
  for (const banned of [
    'CREATE EXTENSION',
    'pgvector',
    'embedding',
    'tsvector',
    'DROP EXPRESSION',
    'DROP INDEX',
    'DROP CONSTRAINT',
    'INSERT INTO',
  ]) {
    assert.equal(sqlCode.includes(banned), false, `#14 不得出现 ${banned}`);
  }
  // 不得 ALTER 既有 RAG 表
  for (const t of ['KnowledgeChunk', 'KnowledgeDocument', 'KnowledgeSource']) {
    assert.equal(sqlCode.includes(`ALTER TABLE "${t}"`), false, `#14 不得 ALTER ${t}`);
  }
  // 不得新增其它表
  const created = [...sqlCode.matchAll(/CREATE TABLE "([A-Za-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(created, ['AgentProposal', 'AgentRun'], '#14 只允许创建 AgentRun / AgentProposal');

  // #13 冻结结构仍在（防范「预期 drift 被误删」）
  const sql13 = readFileSync(path.join(migDir, dirs[12], 'migration.sql'), 'utf8');
  assert.ok(/KnowledgeChunk_search_vector_gin/.test(sql13), '#13 GIN 索引定义必须仍在');
  assert.ok(/GENERATED ALWAYS AS/.test(sql13), '#13 生成列定义必须仍在');
});

test('[§三/§四] schema 中 Agent 字段与索引与冻结规格一致', () => {
  const schema = readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');

  const runBlock = schema.slice(schema.indexOf('model AgentRun'), schema.indexOf('model AgentProposal'));
  assert.ok(/goalKind\s+String\b/.test(runBlock));
  assert.ok(/status\s+String\s+@default\("CREATED"\)/.test(runBlock));
  assert.ok(/semanticVersions\s+Json\s+@default\("\{\}"\)/.test(runBlock));
  assert.ok(/quotaUsage\s+Json\s+@default\("\{\}"\)/.test(runBlock));
  assert.ok(/promptTemplateVersion\s+String\b/.test(runBlock));
  assert.ok(/modelVersion\s+String\?/.test(runBlock));
  assert.ok(/providerRequestId\s+String\?/.test(runBlock));
  assert.ok(/errorCode\s+String\?/.test(runBlock));
  assert.ok(/endedAt\s+DateTime\?/.test(runBlock));
  assert.ok(/onDelete:\s*Cascade/.test(runBlock));
  assert.ok(/@@index\(\[userId\]\)/.test(runBlock));
  // 只允许一个索引，不得出现 (userId, createdAt) / (userId, status)
  assert.equal(/@@index\(\[userId,/.test(runBlock), false, 'AgentRun 不得有复合索引');

  const propBlock = schema.slice(schema.indexOf('model AgentProposal'), schema.indexOf('model AgentAction'));
  assert.ok(/revision\s+Int\b/.test(propBlock));
  assert.ok(/kind\s+String\b/.test(propBlock));
  assert.ok(/payload\s+Json\b/.test(propBlock));
  assert.ok(/basedOnRefs\s+Json\s+@default\("\[]"\)/.test(propBlock));
  assert.ok(/status\s+String\s+@default\("ACTIVE"\)/.test(propBlock));
  assert.ok(/@@unique\(\[runId, revision\]\)/.test(propBlock));
  assert.equal(/userId/.test(propBlock), false, 'AgentProposal 不得有 userId');
  assert.equal(/@@index\(\[runId\]\)/.test(propBlock), false, 'AgentProposal 不得额外加 @@index([runId])');

  // T6-4-A 授权新增：AgentAction（独立 Act 状态机实体；proposal 冻结语义不变）
  const actBlock = schema.slice(schema.indexOf('model AgentAction'));
  assert.ok(/status\s+String\s+@default\("PROPOSED"\)/.test(actBlock));
  assert.ok(/idempotencyKey\s+String\s+@unique/.test(actBlock), '幂等键必须唯一');
  assert.ok(/proposalId\s+String\?\s+@unique/.test(actBlock), 'proposal 维度幂等（一个 proposal 至多一个 Action）');
  assert.ok(/@@index\(\[userId\]\)/.test(actBlock));
});
