/**
 * T5-B-2A —— Agent 只读工具层：机械边界守卫（源码扫描，无 DB）
 *
 * 覆盖授权书 §八（Tool Layer 禁止事项）、§九（Fact Authority 安全守卫）、§十五（冻结指纹）。
 *
 * 扫描纪律（授权书 §九 要求）：
 *   - **先剥离注释**，再用**精确 token / 文件范围**判定，避免注释或无关词造成**假阳性**；
 *   - Fact Authority 符号使用 `\b` 词边界（例如 `\bEvidence\b` 不会误伤字段名 `evidenceRefs`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function strip(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function sha16(rel: string): string {
  return createHash('sha256').update(readFileSync(path.join(process.cwd(), rel))).digest('hex').slice(0, 16);
}

function agentSources(): string[] {
  const dir = path.join(process.cwd(), 'src/agent');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => `src/agent/${e.name}`)
    .sort();
}

/**
 * **工具层文件集**（T5-B-2A 的 7 个交付文件）。
 *
 * ⚠️ 语义说明：T5-B-2A 时期 `src/agent/**` **整体**即为工具层，故当时的断言用 `agentSources()` 全量扫描。
 * T5-B-2B 在同一目录新增 Runtime 文件后，为**保持原断言的原始语义**（「**工具层**不得含 …」），
 * 这里把扫描范围收敛为工具层文件集；**工具层文件本身未被改动**。
 */
const TOOL_LAYER_FILES = [
  'src/agent/contracts.ts',
  'src/agent/index.ts',
  'src/agent/tool-adapters.ts',
  'src/agent/tool-deps.ts',
  'src/agent/tool-layer.ts',
  'src/agent/tool-outcome.ts',
  'src/agent/tool-schemas.ts',
];

/** T6-4-A/B：Act 文件（Confirm/Execute 状态机 + Act Tool Contract + 执行器；与只读工具层分离） */
const ACT_FILES = ['src/agent/act-contracts.ts', 'src/agent/act-executor.ts'];

/** T5-B-2B：Runtime 文件（与工具层同目录，**不属于**工具层扫描范围） */
const RUNTIME_FILES = ['src/agent/runtime-assembly.ts', 'src/agent/runtime.ts'];

// ─── 交付物清单 ─────────────────────────────────────────────────────────

test('[§三] 交付物：src/agent = 工具层 7 文件（T5-B-2A）+ Runtime 2 文件（T5-B-2B）', () => {
  assert.equal(existsSync(path.join(process.cwd(), 'src/agent')), true, 'src/agent 必须存在');
  assert.deepEqual(agentSources(), [...TOOL_LAYER_FILES, ...RUNTIME_FILES, ...ACT_FILES].sort());
  // T5-B-2A 的 7 个工具层文件必须原样存在（不得被 Runtime 改名 / 删除）
  for (const rel of TOOL_LAYER_FILES) {
    assert.equal(agentSources().includes(rel), true, `${rel} 必须存在`);
  }
});

// ─── §八 Tool Layer 禁止事项 ────────────────────────────────────────────

test('[§八] 工具层 + Runtime 无 Prisma / DB client / raw SQL / arbitrary SQL（D-3：覆盖恢复）', () => {
  // D-3：该守卫此前被不必要地收窄为「仅工具层 7 文件」。现恢复覆盖
  // **工具层 + Runtime**（`runtime.ts` / `runtime-assembly.ts` 与工具层同目录、同属 Agent 执行面）。
  for (const rel of [...TOOL_LAYER_FILES, ...RUNTIME_FILES]) {
    const code = strip(read(rel));
    for (const forbidden of [
      '@prisma/client',
      'PrismaClient',
      'prisma.',
      '$queryRaw',
      '$executeRaw',
      'queryRawUnsafe',
      'executeRawUnsafe',
      'Prisma.sql',
      'SELECT ',
      'INSERT INTO',
      'UPDATE ',
      'DELETE FROM',
    ]) {
      assert.equal(code.includes(forbidden), false, `${rel} 不得包含 ${forbidden}`);
    }
  }
});

test('[§八] Tool Layer 无 HTTP / 外网 / 文件系统 / 动态执行', () => {
  for (const rel of agentSources()) {
    const code = strip(read(rel));
    for (const forbidden of [
      'fetch(',
      'node:http',
      'node:https',
      'node:net',
      'node:fs',
      'readFileSync',
      'writeFileSync',
      'eval(',
      'new Function',
      'import(',
      'require(',
      'process.env',
    ]) {
      assert.equal(code.includes(forbidden), false, `${rel} 不得包含 ${forbidden}`);
    }
  }
});

test('[§八] Tool Layer 无 LLM / Provider / quota / HTTP 层依赖', () => {
  for (const rel of TOOL_LAYER_FILES) {
    const code = strip(read(rel));
    for (const forbidden of [
      'src/llm',
      '../llm/',
      'providerFromEnv',
      'LLM_FEATURE',
      'llmUsage',
      'quota',
      '../http/',
      'src/http',
      'generateJsonWithUsage',
    ]) {
      assert.equal(code.includes(forbidden), false, `${rel} 不得包含 ${forbidden}`);
    }
  }
});

test('[§八] 无 Tool → Tool / 无递归 / 无 Agent Loop（适配器不回调工具层）', () => {
  const adapters = strip(read('src/agent/tool-adapters.ts'));
  assert.equal(adapters.includes('tool-layer'), false, '适配器不得依赖工具层（禁止 Tool → Tool）');
  assert.equal(adapters.includes('.invoke('), false, '适配器不得调用 invoke（禁止递归 / 循环）');
  assert.equal(adapters.includes('createAgentReadToolLayer'), false, '适配器不得自建工具层');

  const layer = strip(read('src/agent/tool-layer.ts'));
  for (const forbidden of ['while (', 'for (;;', 'recursion', 'loop']) {
    assert.equal(layer.includes(forbidden), false, `tool-layer 不得出现循环/递归形态 ${forbidden}`);
  }
});

test('[§八] 无 Agent 持久化写入：工具层不触碰 AgentRun / AgentProposal / agentRuns', () => {
  for (const rel of TOOL_LAYER_FILES) {
    const code = strip(read(rel));
    for (const forbidden of ['AgentRun', 'AgentProposal', 'agentRuns', 'createRun', 'createProposal', 'transitionRun']) {
      assert.equal(code.includes(forbidden), false, `${rel} 不得包含 ${forbidden}`);
    }
  }
});

test('[§八/§九] 无确认 / 执行 / 工具调用相关符号（精确 token，词边界）', () => {
  // 注意：必须用词边界，否则 `needsUserConfirmation` 这类**合法域字段**会被误判（授权书 §九 要求避免假阳性）
  const banned = [
    /\bConfirmation\b/,
    /\bconfirm\s*\(/,
    /\/confirm\b/,
    /\/execute\b/,
    /\bexecute\s*\(/,
    /\btoolCall\b/,
    /tool-call/,
    /AgentTool/,
    /\bapplySuggestion\b/,
    /\bsubmit\s*\(/,
    /\brevoke\s*\(/,
    /\barchive\s*\(/,
  ];
  for (const rel of agentSources()) {
    const code = strip(read(rel));
    for (const re of banned) {
      assert.equal(re.test(code), false, `${rel} 不得包含 ${re}`);
    }
  }
});

// ─── §九 Fact Authority 安全守卫（精确 token）────────────────────────────

test('[§九] Tool Layer 零引用事实层符号（精确 token，词边界）', () => {
  const exact = [
    /\bCONFIRMED\b/,
    /CapabilityEvidence/,
    /\bEvidence\b/,
    /\bEvidenceSource\b/,
    /verifyClaim/,
    /canWrite/,
    /writeBlockedResults/,
    /verify\.ts/,
    /capability\/key/,
    /FACT_GATE_BLOCKED/,
  ];
  for (const rel of agentSources()) {
    const code = strip(read(rel));
    for (const re of exact) {
      assert.equal(re.test(code), false, `${rel} 不得出现事实层符号 ${re}`);
    }
  }
});

test('[§九] 词边界判定不误伤：`evidenceRefs` / `evidenceCount` 属合法输出字段', () => {
  const adapters = strip(read('src/agent/tool-adapters.ts'));
  assert.ok(/evidenceRefs/.test(adapters), '适配器应输出证据引用字段');
  assert.ok(/evidenceCount/.test(adapters), '适配器应输出证据计数');
  assert.equal(/\bEvidence\b/.test(adapters), false, '但仍不得出现大写事实层符号');
});

// ─── 只读依赖契约 ───────────────────────────────────────────────────────

test('[§五] AgentReadToolDeps 仅声明只读方法（Pick 字面量全在白名单内）', () => {
  const src = strip(read('src/agent/tool-deps.ts'));
  const picks = [...src.matchAll(/Pick<[^>]*,\s*([^>]*)>/g)].flatMap((m) =>
    [...m[1]!.matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]!),
  );
  assert.ok(picks.length >= 13, `应解析出 ≥13 个只读方法名，实际 ${picks.length}`);

  const READ_ALLOWLIST = [
    'listForUser',
    'findDetailForUser',
    'findByIdForUserWithRequirements',
    'findRunWithItemsForUser',
    'findForUser',
    'retrieve',
  ];
  for (const m of picks) {
    assert.ok(READ_ALLOWLIST.includes(m), `${m} 不在只读方法白名单内（不得注入写方法）`);
  }
  for (const banned of ['create', 'update', 'archive', 'confirm', 'submit', 'revoke', 'delete', 'addArtifact']) {
    assert.equal(new RegExp(`${banned}\\w*\\(`).test(src), false, `依赖契约不得引用写方法 ${banned}*`);
  }
});

// ─── 无 API / 无装配点扩张 ──────────────────────────────────────────────

test('[§十三→2C] Agent API = 恰好 3 个 endpoint；deps 的 agent 装配点唯一且最小', () => {
  // T5-B-2C 授权后基线同步：app/api/agent 存在，但仅限 3 个路由（method 白名单见 agent-guards）
  assert.equal(existsSync(path.join(process.cwd(), 'app/api/agent')), true, 'T5-B-2C 已授权 app/api/agent');
  const deps = strip(read('src/http/deps.ts'));
  assert.equal(/buildAgentRunsHandlerDeps/.test(deps), true, 'deps 必须提供唯一 Agent 装配点');
  // deps 引用的 agent 模块仅限 Runtime + 工具层装配（不得引入其它 agent 模块）
  const agentImports = [...deps.matchAll(/from '\.\.\/(agent\/[\w-]+\.ts)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(agentImports, ['agent/runtime.ts', 'agent/tool-layer.ts']);
});

// ─── §十五 冻结指纹 + Migration 基线 ────────────────────────────────────

test('[§十五] 冻结文件指纹未变', () => {
  const frozen: Record<string, string> = {
    // Migration #18（Avatar）授权后基线：User 新增 avatarUrl String?
    // Migration #19（用户自带 LLM API Key，2026-09-21 授权）后基线：User 新增 llmApiKeyCipher/Last4 String?
    'prisma/schema.prisma': '5aaba57bbf1a60e8',
    'src/llm/provider.ts': '74413b00f2f6590a',
    'src/llm/openai-compat-provider.ts': '5e29d9043c5a5a88',
    'src/llm/quota.ts': '65e70d85bd5b88c4',
    'src/errors.ts': 'c9bda7eb0e38c4f4',
    'src/http/error-mapping.ts': 'f927e814c833bb67',
    'src/domain/verify.ts': 'cae2f33fed8a423b',
    'src/domain/capability/key.ts': '36e96d3c99c33b6c',
  };
  for (const [rel, expected] of Object.entries(frozen)) {
    assert.equal(sha16(rel), expected, `${rel} 指纹必须未变（冻结区）`);
  }
});

test('[§十五] Migration #10~#17 文件指纹未变；migration 恒 18（Avatar 授权新增 #18）', () => {
  const migDir = path.join(process.cwd(), 'prisma/migrations');
  const dirs = readdirSync(migDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  assert.equal(dirs.length, 19, `migration 必须为 19（#18 Avatar + #19 用户自带 LLM API Key，2026-09-21 授权），实际 ${dirs.length}`);

  const expected: Record<string, string> = {
    '20260918103146_learning_task_tier1': '6e527619f3d430f8',
    '20260918160000_portfolio_project': 'c4c4b1dd0c19f8eb',
    '20260918180000_create_interview_tables': '18c19c6d4c2e9aa5',
    '20260919000100_rag_knowledge_base': '639b4836351f0f90',
    '20260919025710_agent_domain_persistence': '37e6fad8a4c64be0',
    '20260919151000_career_goal': 'a5b8b03a8dd0cf4f',
    '20260919170000_application_tracker': '08f3754dbc0043ba',
    '20260920010000_agent_act': '30396de4bb90ff40',
  };
  for (const [dir, fp] of Object.entries(expected)) {
    assert.ok(dirs.includes(dir), `迁移 ${dir} 必须存在且未被改名`);
    assert.equal(sha16(`prisma/migrations/${dir}/migration.sql`), fp, `${dir} 指纹必须未变`);
  }
});

test('[§十六 Regression] 既有 T5-B-1 / T5-A 关键源码未被本阶段改动', () => {
  const untouched: Record<string, string> = {
    'src/domain/agent/agent-run.ts': 'dd453e05d6fbe439',
    'src/domain/agent/agent-proposal.ts': '30e2822e9ad1cad5',
    'src/domain/agent/validation.ts': '40cd34485b2bcb9a',
    'src/domain/rag/retrieval.ts': '6737f8253c3fad2b',
    'src/domain/action-plan/step-type.ts': 'e92aa440621a6908',
    // T6-4-A/B 授权后基线：读模型扩展 + Act 装配点（三个文件的既有 T5-A/T5-B 结构未变）
    // Project V2 Phase 0 授权后基线：deps.ts 追加 buildProjectGuideHandlerDeps（既有结构未变）
    // Interview V2-A 授权后基线：JdRepository.findRawTextForUser（只读 JD grounding）+
    // InterviewCheckTurnOutcome/CreateTurnOutcome + TURN_LIMIT_REACHED（8 轮上限）+
    // buildInterviewHandlerDeps.jdTexts / buildDashboardHandlerDeps.interviews（只读统计）
    // JobDescription title 可编辑：新增 JdRepository.updateTitle（接口 + Prisma 实现）
    // Avatar 上传（Migration #18）：UserRecord/PublicUser 新增 avatarUrl +
    //   UserRepository.updateAvatarUrl + buildAuthHandlerDeps 注入 avatarStorage/users
    // 用户自带 LLM API Key（Migration #19，2026-09-21 授权）：ports 新增 LlmSecretRepository、
    //   repositories 新增 llmSecrets 实现、deps 新增 providerFor/requireSessionUser/
    //   buildLlmSecretHandlerDeps + 9 个 LLM 装配点改为 async（userId-scoped provider）
    'src/db/repositories.ts': 'd6f1006aed3995ca',
    'src/ports/index.ts': '8b7670dd9998c88b',
    'src/http/deps.ts': '2509a4a6a872022e',
  };
  for (const [rel, expected] of Object.entries(untouched)) {
    assert.equal(sha16(rel), expected, `${rel} 不得被本阶段修改`);
  }
});
