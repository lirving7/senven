/**
 * T5-B-2B —— Agent Runtime（`plan-propose/v1`）
 *
 * 固定执行顺序（授权书 §一，**不得重排**）：
 *   1. 创建 / 读取 AgentRun（**保持 `CREATED`**）
 *   2. **AGENT 配额预检**（**必须在进入 `PLANNING` 之前**；D-1）——
 *      配额不足 → `CREATED → FAILED`：零只读工具调用、零 provider 调用、不进入 `PLANNING`
 *   3. 状态进入 `PLANNING`
 *   4. 服务端按**固定 allowlist** 确定要读取的数据（确定性前置装配）
 *   5. 执行**只读**工具（T5-B-2A 工具层）
 *   6. 工具结果统一组装进 `<data>`
 *   7. 构造**一次** `LLMProvider` JSON 请求
 *   8. `schemaInPrompt = true` / `retry = 0`（单次，无重试预算）
 *   9. Provider 返回后做**严格 PLAN 校验**
 *  10. 通过则在同一 **Repository 事务**内 `PLANNING → PROPOSED` + 创建**唯一有效** `AgentProposal`
 *  11. 失败则 `PLANNING → FAILED` + 明确 `errorCode` + `endedAt`
 *  12. **不产生任何其他业务写入**
 *
 * 硬边界：
 *   - **模型不选择工具**：无 tool_choice / function calling / tool loop / 二次 provider 调用 / 自主迭代；
 *   - **零事实权威**：不写 Capability / CapabilityEvidence / Evidence / 已确认标记，不调用任何确认面，不接线 `verify.ts`；
 *   - **零其他业务写入**：仅 AgentRun 状态与 AgentProposal；
 *   - **无 API**：本阶段不创建任何 `/api/agent/*`。
 */

import { generateJsonWithUsage } from '../llm/usage-gate.ts';
import { quotaLimitFor, quotaWindowMs } from '../llm/quota.ts';
import type { JsonRequest, LLMProvider } from '../llm/provider.ts';
import { LLM_FEATURE, LLM_USAGE_STATUS } from '../ports/index.ts';
import type { AgentRunRepository, Clock, LlmUsageRepository } from '../ports/index.ts';
import { AGENT_GOAL_KINDS } from '../domain/agent/agent-run.ts';
import { AGENT_PROPOSAL_KINDS, AGENT_PROPOSAL_V1_REVISION } from '../domain/agent/agent-proposal.ts';
import { AGENT_PLAN_JSON_SCHEMA, validateAgentPlanPayload } from '../domain/agent/plan-payload.ts';
import { validateAgentProposalCreateInput } from '../domain/agent/validation.ts';
import {
  AGENT_RUN_ERROR_CODE,
  classifyAgentProviderFailure,
  isQuotaRejection,
} from '../domain/agent/runtime-error.ts';
import type { AgentRunErrorCode } from '../domain/agent/runtime-error.ts';
import { RETRIEVAL_SEMANTIC_VERSIONS } from '../domain/rag/retrieval.ts';
import type { AgentReadToolLayer } from './tool-layer.ts';
import {
  AGENT_PROMPT_TEMPLATE_VERSION,
  buildAgentPlanSystemInstruction,
  buildAgentPlanUserPrompt,
  buildAgentReadToolPlan,
} from './runtime-assembly.ts';
import type { AgentReadToolObservation, AgentRuntimeTargets } from './runtime-assembly.ts';

/** Runtime 依赖（**全部注入**；本层不读环境变量、不触碰 Prisma） */
export type AgentPlanRuntimeDeps = {
  /** T5-B-2A 只读工具层（复用，不重做、不改语义） */
  tools: AgentReadToolLayer;
  /** Agent 持久化（注入面仅：创建 / 读取 / 进入 PLANNING / 单事务提交终态） */
  runs: Pick<
    AgentRunRepository,
    'createRun' | 'findRunForUser' | 'transitionRun' | 'commitPlanOutcome'
  >;
  /**
   * 既有用量仓储。
   * 正常运行（provider 调用）**交给既有 usage-gate 记留痕**；
   * Runtime 仅在**配额预检拒绝**时复用 gate 的配额事件语义写一条 `QUOTA_REJECTED`。
   */
  usage: LlmUsageRepository;
  clock: Clock;
};

/** Runtime 输入（`targets` 由服务端装配点提供，**不来自模型**） */
export type AgentPlanRuntimeInput = {
  userId: string;
  provider: LLMProvider;
  /** 省略则新建 AgentRun；提供则在该 Run 上执行（用于取消语义） */
  runId?: string;
  targets?: AgentRuntimeTargets;
  /** 可选的额外用户诉求（L1；不得改变策略与权限） */
  request?: string;
};

export type AgentPlanRuntimeResult =
  | {
      status: 'PROPOSED';
      runId: string;
      proposalId: string;
      providerCalls: number;
      readToolCalls: number;
    }
  | {
      status: 'FAILED';
      runId: string | null;
      errorCode: AgentRunErrorCode;
      providerCalls: number;
      readToolCalls: number;
    }
  | {
      status: 'CANCELLED';
      runId: string;
      errorCode: AgentRunErrorCode;
      providerCalls: number;
      readToolCalls: number;
    }
  | { status: 'NOT_FOUND'; runId: string };

export type AgentPlanRuntime = {
  run(input: AgentPlanRuntimeInput): Promise<AgentPlanRuntimeResult>;
};

function toObservation(
  tool: AgentReadToolObservation['tool'],
  outcome: Awaited<ReturnType<AgentReadToolLayer['invoke']>>,
): AgentReadToolObservation | 'FATAL' {
  switch (outcome.status) {
    case 'OK':
      return { tool, status: 'OK', trust: outcome.trust, json: JSON.stringify(outcome.data) };
    case 'NOT_FOUND':
      return { tool, status: 'ABSENT', reason: 'NOT_FOUND' };
    case 'INVALID_INPUT':
      return { tool, status: 'ABSENT', reason: 'INVALID_INPUT' };
    case 'UNKNOWN_TOOL':
      return { tool, status: 'ABSENT', reason: 'UNKNOWN_TOOL' };
    default:
      // 工具内部失败 → 终止本次 Run（AGENT_TOOL_ERROR）
      return 'FATAL';
  }
}

/** 由**服务端已知 id** 构造可解释引用（只 id，绝不复制正文；ADR-017 §8 `T5B-F-39`） */
function buildBasedOnRefs(
  targets: AgentRuntimeTargets,
  ragChunkIds: readonly string[],
): Array<Record<string, string>> {
  const refs: Array<Record<string, string>> = [];
  const push = (entityType: string, entityId: string | undefined) => {
    if (typeof entityId === 'string' && entityId.length > 0) refs.push({ entityType, entityId });
  };
  push('RESUME', targets.resumeId);
  push('JD', targets.jdId);
  push('MATCH_RUN', targets.matchRunId);
  push('ACTION_PLAN', targets.planId);
  push('PORTFOLIO', targets.portfolioProjectId);
  for (const id of ragChunkIds.slice(0, 3)) push('KNOWLEDGE_CHUNK', id);
  return refs;
}

/**
 * 创建 Agent Runtime（**可注入**；生产装配属 T5-B-2C API 阶段）。
 *
 * ⚠️ 归属说明：所有仓储调用都携带 `userId`，`runId` 仅作定位；
 * 跨用户 / 不存在一律由仓储返回 `NOT_FOUND`（无 oracle）。
 */
export function createAgentPlanRuntime(deps: AgentPlanRuntimeDeps): AgentPlanRuntime {
  async function fail(
    userId: string,
    runId: string,
    errorCode: AgentRunErrorCode,
    providerCalls: number,
    readToolCalls: number,
  ): Promise<AgentPlanRuntimeResult> {
    await deps.runs.commitPlanOutcome(userId, { kind: 'FAILED', runId, errorCode }, deps.clock.now());
    return { status: 'FAILED', runId, errorCode, providerCalls, readToolCalls };
  }

  async function cancelled(
    runId: string,
    providerCalls: number,
    readToolCalls: number,
  ): Promise<AgentPlanRuntimeResult> {
    return {
      status: 'CANCELLED',
      runId,
      errorCode: AGENT_RUN_ERROR_CODE.AGENT_CANCELLED,
      providerCalls,
      readToolCalls,
    };
  }

  /**
   * AGENT 配额是否已耗尽（D-1 预检）。
   *
   * **复用**既有配额定义三件套——额度（`quotaLimitFor`）、窗口（`quotaWindowMs`）、
   * 计数（`countSince`，只统计真实 provider 调用）——不复制任何独立配额实现，
   * 从而保证预检与最终 provider gate 的规则**完全一致**。
   */
  async function agentQuotaExhausted(userId: string): Promise<boolean> {
    const since = new Date(deps.clock.now().getTime() - quotaWindowMs());
    const { count } = await deps.usage.countSince(userId, LLM_FEATURE.AGENT, since);
    return count >= quotaLimitFor(LLM_FEATURE.AGENT);
  }

  /**
   * 配额拒绝（D-1）：Run **保持 `CREATED`**，直接 `CREATED → FAILED`。
   *
   * 留痕复用既有「配额事件」语义（与 usage-gate 的拒绝分支同形：`requestCount = 0`，
   * 表示 provider 一次都未被调用），因此台账中仍然恰好一条 `QUOTA_REJECTED`。
   */
  async function quotaRejected(userId: string, runId: string): Promise<AgentPlanRuntimeResult> {
    await deps.usage.record({
      userId,
      feature: LLM_FEATURE.AGENT,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cost: 0,
      status: LLM_USAGE_STATUS.QUOTA_REJECTED,
    });
    return fail(userId, runId, AGENT_RUN_ERROR_CODE.LLM_QUOTA_EXCEEDED, 0, 0);
  }

  async function run(input: AgentPlanRuntimeInput): Promise<AgentPlanRuntimeResult> {
    const { userId } = input;
    let readToolCalls = 0;
    let providerCalls = 0;

    // ── 1. 创建 / 读取 AgentRun ────────────────────────────────────────
    let runId: string;
    if (input.runId === undefined) {
      const created = await deps.runs.createRun({
        userId,
        goalKind: AGENT_GOAL_KINDS[0],
        promptTemplateVersion: AGENT_PROMPT_TEMPLATE_VERSION,
        semanticVersions: { ...RETRIEVAL_SEMANTIC_VERSIONS },
        quotaUsage: { providerCalls: 0 },
      });
      runId = created.id;
    } else {
      runId = input.runId;
      const existing = await deps.runs.findRunForUser(runId, userId);
      if (existing === null) return { status: 'NOT_FOUND', runId };
      // §十三：开始前已取消 → 不调用 provider、不产生 proposal、不恢复为 PLANNING
      if (existing.status === 'CANCELLED') return cancelled(runId, 0, 0);
      if (existing.status !== 'CREATED' && existing.status !== 'PLANNING') {
        return {
          status: 'FAILED',
          runId,
          errorCode: AGENT_RUN_ERROR_CODE.AGENT_STATE_CONFLICT,
          providerCalls: 0,
          readToolCalls: 0,
        };
      }
    }

    // ── 2. AGENT 配额预检（**必须早于进入 `PLANNING`**；D-1）─────────────
    // 配额不足 → Run 保持 CREATED，直接 `CREATED → FAILED`：
    // 不进入 PLANNING、不执行任何只读工具（0 次）、不调用 provider（0 次）、不产生 proposal。
    // 最终 provider gate 仍然保留（见步骤 7/8），因此并发下不存在配额绕过。
    if (await agentQuotaExhausted(userId)) {
      return quotaRejected(userId, runId);
    }

    // ── 3. 进入 PLANNING（CREATED → PLANNING；已在 PLANNING 时为 NOOP）──
    const entered = await deps.runs.transitionRun(runId, userId, 'PLANNING', deps.clock.now());
    if (entered.kind !== 'UPDATED') {
      if (entered.kind === 'NOT_FOUND') return { status: 'NOT_FOUND', runId };
      const after = await deps.runs.findRunForUser(runId, userId);
      if (after !== null && after.status === 'CANCELLED') return cancelled(runId, 0, 0);
      return {
        status: 'FAILED',
        runId,
        errorCode: AGENT_RUN_ERROR_CODE.AGENT_STATE_CONFLICT,
        providerCalls: 0,
        readToolCalls: 0,
      };
    }

    // ── 4./5. 确定性前置装配 + 只读工具执行（无 Provider）────────────────
    const targets: AgentRuntimeTargets = input.targets ?? {};
    const toolPlan = buildAgentReadToolPlan(targets);
    const observations: AgentReadToolObservation[] = [];
    const ragChunkIds: string[] = [];

    for (const entry of toolPlan) {
      readToolCalls += 1;
      const outcome = await deps.tools.invoke(entry.tool, entry.input, { userId });
      const observation = toObservation(entry.tool, outcome);
      if (observation === 'FATAL') {
        return fail(userId, runId, AGENT_RUN_ERROR_CODE.AGENT_TOOL_ERROR, providerCalls, readToolCalls);
      }
      if (entry.tool === 'rag_retrieve' && outcome.status === 'OK') {
        const data = outcome.data as { items?: Array<{ chunkId?: unknown }> } | null;
        for (const item of data?.items ?? []) {
          if (typeof item.chunkId === 'string') ragChunkIds.push(item.chunkId);
        }
      }
      observations.push(observation);
    }

    // ── 6. 取消再检查（§十三：状态非允许继续 → 不调用 Provider）──────────
    const beforeLlm = await deps.runs.findRunForUser(runId, userId);
    if (beforeLlm === null) return { status: 'NOT_FOUND', runId };
    if (beforeLlm.status !== 'PLANNING') {
      if (beforeLlm.status === 'CANCELLED') return cancelled(runId, 0, readToolCalls);
      return {
        status: 'FAILED',
        runId,
        errorCode: AGENT_RUN_ERROR_CODE.AGENT_STATE_CONFLICT,
        providerCalls: 0,
        readToolCalls,
      };
    }

    // ── 7./8. 单次 Provider 调用（复用既有 usage-gate：配额 + 留痕；retry = 0）─
    const request: JsonRequest = {
      system: buildAgentPlanSystemInstruction(),
      prompt: buildAgentPlanUserPrompt(observations, input.request ?? ''),
      schema: AGENT_PLAN_JSON_SCHEMA,
      schemaInPrompt: true,
    };

    let raw: unknown;
    try {
      raw = await generateJsonWithUsage<unknown>(
        { usage: deps.usage, clock: deps.clock },
        { userId, feature: LLM_FEATURE.AGENT, provider: input.provider, request },
      );
      providerCalls = 1;
    } catch (err) {
      providerCalls = isQuotaRejection(err) ? 0 : 1;
      return fail(userId, runId, classifyAgentProviderFailure(err), providerCalls, readToolCalls);
    }

    // ── 9. 严格 PLAN 校验（失败 → LLM_INVALID_PLAN，**不重试**）──────────
    const validated = validateAgentPlanPayload(raw);
    if (!validated.ok) {
      return fail(userId, runId, AGENT_RUN_ERROR_CODE.LLM_INVALID_PLAN, providerCalls, readToolCalls);
    }

    // ── 10. 原子提交：PLANNING → PROPOSED + 唯一有效 proposal（同一事务）──
    const payload = validated.plan as unknown as Record<string, unknown>;
    const basedOnRefs = buildBasedOnRefs(targets, ragChunkIds);
    const precheck = validateAgentProposalCreateInput({
      kind: AGENT_PROPOSAL_KINDS[0],
      revision: AGENT_PROPOSAL_V1_REVISION,
      payload,
      basedOnRefs,
    });
    if (!precheck.ok) {
      return fail(userId, runId, AGENT_RUN_ERROR_CODE.AGENT_STATE_CONFLICT, providerCalls, readToolCalls);
    }

    const committed = await deps.runs.commitPlanOutcome(
      userId,
      {
        kind: 'PROPOSED',
        runId,
        proposal: {
          kind: AGENT_PROPOSAL_KINDS[0],
          revision: AGENT_PROPOSAL_V1_REVISION,
          payload,
          basedOnRefs,
        },
      },
      deps.clock.now(),
    );

    if (committed.kind !== 'COMMITTED' || committed.proposal === null) {
      // 并发取消 / 状态已变（不得视为成功；不重试）
      const after = await deps.runs.findRunForUser(runId, userId);
      if (after !== null && after.status === 'CANCELLED') return cancelled(runId, providerCalls, readToolCalls);
      return {
        status: 'FAILED',
        runId,
        errorCode: AGENT_RUN_ERROR_CODE.AGENT_STATE_CONFLICT,
        providerCalls,
        readToolCalls,
      };
    }

    return {
      status: 'PROPOSED',
      runId,
      proposalId: committed.proposal.id,
      providerCalls,
      readToolCalls,
    };
  }

  return { run };
}
