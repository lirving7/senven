/**
 * T6-4-C —— Agent Act UI 消费层（纯类型 + 纯映射，零副作用，可在 node --test 直接导入）。
 *
 * 设计原则：
 *   - 与 T5-B-3B 的 `_lib/agent.ts` 完全分离：Proposal 只读消费（无 Action）归前者，
 *     Action Confirm/Execute 归本文件；避免触碰 T5-B-3B 冻结范围。
 *   - 不产生 LLM 调用、不持有 React；状态映射、payload 防御性校验、tool 描述、taskSession key 一律纯函数。
 *   - 与 §七 安全守则一致：不判断 userId/ownership，所有 ownership 服务端二次校验。
 *   - 不复用事实 chip 体系（chip-confirmed/inferred）；Action 状态展示使用独立 chip 名。
 *
 * 为什么不能 import `src/domain/agent/act.ts`：该后端模块含 `await import('node:crypto')`，
 * Next.js 15 webpack 不识别 `node:` scheme 会构建失败（T6-4-C 实证）。本文件保留与服务端
 * 真源（src/domain/agent/act.ts ACT_TOOL_NAMES / ACT_ACTION_STATUSES）**逐字段一致**；
 * 端到端一致性由 `tests/agent-tool-catalog.test.ts` + 后端 `tests/agent-act.test.ts` 共同锁定，
 * 后端字段变更须同步更新本表（已记录在 §十四授权书的设计依据）。
 */

export type ActActionStatus =
  | 'PROPOSED'
  | 'CONFIRMED'
  | 'EXECUTING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

/** Act Action 视图（与 `src/http/handlers/agent-actions.ts` toActionResponse 形状逐字段对齐） */
export type ActionView = {
  id: string;
  runId: string | null;
  proposalId: string | null;
  toolName: string;
  payload: unknown;
  status: ActActionStatus;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 6 个状态 label（与 T5-B-3B RUN_STATUS_LABEL 平行，独立命名） */
export const ACTION_STATUS_LABEL: Record<ActActionStatus, string> = {
  PROPOSED: '待用户确认',
  CONFIRMED: '已用户确认',
  EXECUTING: '正在执行',
  SUCCEEDED: '执行成功',
  FAILED: '执行失败',
  CANCELLED: '已取消',
};

/** Action 状态 chip —— 严禁复用事实 chip（confirmed/inferred），与 T5-B-3B 一致 */
export const ACTION_STATUS_CHIP: Record<ActActionStatus, string> = {
  PROPOSED: 'chip-unconfirmed',
  CONFIRMED: 'chip-advice',
  EXECUTING: 'chip-advice',
  SUCCEEDED: 'chip-unconfirmed',
  FAILED: 'chip-missing',
  CANCELLED: 'chip-knowledge',
};

/* ────────────── Tool 白名单（与服务端 5 Tool 完全一致） ────────────── */

/** Act Tool 白名单（与服务端 `src/domain/agent/act.ts` ACT_TOOL_NAMES **逐字段一致**；
 *  变更须同时修改两端，由测试 agent-tool-catalog.test.ts / agent-act.test.ts 共同锁定） */
export const ACT_TOOL_NAMES = [
  'create_career_goal',
  'attach_jd_to_goal',
  'create_application',
  'update_application_stage',
  'create_learning_task',
] as const;

export type ActToolName = (typeof ACT_TOOL_NAMES)[number];

export function isActToolName(value: unknown): value is ActToolName {
  return typeof value === 'string' && (ACT_TOOL_NAMES as readonly string[]).includes(value);
}

/* ────────────── Tool 白名单（与服务端 5 Tool 完全一致） ────────────── */

/** 工具 → 用户可读标题；与后端 ACT_TOOL_NAMES 顺序与命名完全一致 */
export const ACT_TOOL_TITLE: Record<ActToolName, string> = {
  create_career_goal: '创建求职目标',
  attach_jd_to_goal: '绑定岗位到求职目标',
  create_application: '创建岗位申请',
  update_application_stage: '更新申请阶段',
  create_learning_task: '创建学习任务',
};

/** 工具 → 用户可读说明（不要「保存草稿」类与 DRAFT 状态不存在的语义） */
export const ACT_TOOL_DESC: Record<ActToolName, string> = {
  create_career_goal: '将在你的求职档案中新增一份当前求职目标。',
  attach_jd_to_goal: '会将该岗位永久关联到你已选择的求职目标。',
  create_application: '将基于本次能力对照，在岗位下创建一份真实的岗位申请记录并立即生效。',
  update_application_stage: '将修改一份既有岗位申请的当前阶段。',
  create_learning_task: '会在你的行动计划下新建一项学习任务。',
};

/* ────────────── payload 防御性校验（§六 / 防注入） ────────────── */

type FieldRule = {
  key: string;
  label: string;
  isLong?: boolean;
};

/** 每个工具暴露的 payload 字段白名单（只渲染白名单字段；任何 userId 一律不展示） */
export const ACT_TOOL_PAYLOAD_FIELDS: Record<ActToolName, ReadonlyArray<FieldRule>> = {
  create_career_goal: [
    { key: 'name', label: '目标名称' },
    { key: 'position', label: '目标岗位' },
    { key: 'employmentType', label: '工作类型' },
  ],
  attach_jd_to_goal: [
    { key: 'goalId', label: '求职目标 ID' },
    { key: 'jdId', label: '岗位 ID' },
  ],
  create_application: [
    { key: 'careerGoalId', label: '求职目标 ID' },
    { key: 'jdId', label: '岗位 ID' },
    { key: 'resumeVersionId', label: '简历版本 ID' },
  ],
  update_application_stage: [
    { key: 'applicationId', label: '岗位申请 ID' },
    { key: 'stage', label: '目标阶段' },
  ],
  create_learning_task: [
    { key: 'actionPlanId', label: '行动计划 ID' },
    { key: 'sourceStepId', label: '来源步骤 ID' },
    { key: 'content', label: '学习任务内容', isLong: true },
  ],
};

/** 校验 payload 是否安全展示（仅识别形状，不替代后端 schema 校验） */
export function isRenderableActPayload(toolName: string, payload: unknown): payload is Record<string, unknown> {
  if (!isActToolName(toolName)) return false;
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  // 任何 userId 注入键一律拒绝展示（即便后端已 strict 拒绝，这里二次防御）
  for (const k of Object.keys(p)) {
    if (k === 'userId' || k === 'user_id') return false;
  }
  const fields = ACT_TOOL_PAYLOAD_FIELDS[toolName];
  for (const f of fields) {
    if (p[f.key] !== undefined && typeof p[f.key] !== 'string' && typeof p[f.key] !== 'number') {
      return false;
    }
  }
  return true;
}

/** 取工具的展示字段定义（仅在 isActToolName 通过后调用） */
export function fieldsForTool(toolName: string): ReadonlyArray<FieldRule> | null {
  if (!isActToolName(toolName)) return null;
  return ACT_TOOL_PAYLOAD_FIELDS[toolName as ActToolName];
}

/** 取 payload 中的某个字段展示值（defensive：未定义的键返回空字符串） */
export function payloadFieldView(payload: unknown, key: string): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const v = (payload as Record<string, unknown>)[key];
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return '';
}

/* ────────────── 客户端 rule：是否可执行 Confirm/Execute ────────────── */

/** UI 是否显示 Confirm 按钮（§三：PROPOSED 才可进入 CONFIRMED） */
export function canConfirmActView(action: ActionView | null, currentStatus: ActActionStatus | null): boolean {
  if (action !== null) return false; // 已有 Action → 不能再 Confirm
  return currentStatus === 'PROPOSED' || currentStatus === null;
}

/** UI 是否显示 Execute 按钮（§三：只有 CONFIRMED 可进入 EXECUTING） */
export function canExecuteActView(action: ActionView | null): boolean {
  if (action === null) return false;
  return action.status === 'CONFIRMED';
}

/** UI 是否处于 in-flight（按钮禁用，渲染 ProcessingState） */
export function isActInFlight(busy: 'confirm' | 'execute' | null): boolean {
  return busy !== null;
}

/** Result 摘要渲染：用于成功/失败后展示内容
 *  已知 result 形状：
 *   - CareerGoalCreateOutcome:  { kind: 'CREATED', goal }
 *   - JD attach:                { kind: 'ATTACHED', id, jdIds }
 *   - Application create:       { id, stage } or { kind: 'CREATED', application }
 *   - Application stage update: { id, stage }
 *   - Learning task:            { kind: 'CREATED' | 'REUSED_EXISTING', id } | { id }
 */
export function renderResultSummary(action: ActionView): string {
  if (action.status !== 'SUCCEEDED') return '';
  const r = action.result;
  if (typeof r !== 'object' || r === null) return '';
  const ro = r as Record<string, unknown>;
  if (ro.kind === 'CREATED' && typeof ro.id === 'string') {
    return `已创建，ID：${ro.id}`;
  }
  if (ro.kind === 'ATTACHED' && typeof ro.id === 'string' && Array.isArray(ro.jdIds)) {
    return `已绑定，目标 ID：${ro.id}，当前绑定 ${ro.jdIds.length} 个岗位`;
  }
  if (ro.kind === 'REUSED_EXISTING' && typeof ro.id === 'string') {
    return `已存在且已生效，未重复创建（ID：${ro.id}）`;
  }
  if (typeof ro.id === 'string') {
    return `已完成，ID：${ro.id}`;
  }
  return '已完成';
}

export function renderErrorSummary(action: ActionView): string {
  if (action.status !== 'FAILED') return '';
  // 优先后端 errorMessage，其次 errorCode
  if (action.errorMessage && action.errorMessage.trim().length > 0) return action.errorMessage;
  if (action.errorCode) return `错误代码：${action.errorCode}`;
  return '执行失败';
}

/* ────────────── Endpoint 白名单（§九 / 不超出授权） ────────────── */

/** Act UI 仅允许访问的 3 个新 endpoint + 1 个既有的 /api/agent/runs（用于 phase=done 上下文） */
export const ACT_API_PATHS = [
  /^POST \/api\/agent\/proposals\/[^/]+\/confirm$/,
  /^POST \/api\/agent\/actions\/[^/]+\/execute$/,
  /^GET \/api\/agent\/actions\/[^/]+$/,
] as const;

/** 从源码中扫描到的所有 path/api 调用是否在白名单内（不限定文件，仅断言白名单 token） */
export function isAllowedActApi(rawPath: string): boolean {
  // 匹配「POST /x」、「GET /x」直接字面出现在 source string 的扫描
  for (const rx of ACT_API_PATHS) {
    if (rx.test(rawPath)) return true;
  }
  return false;
}

/* ────────────── localStorage key（防刷新重复执行的关键） ────────────── */

export const LAST_ACT_ACTION_KEY = 'jp_agent_act_last_action';

/** 持久化最近一次 ActionId（仅 ID；刷新恢复经 GET /api/agent/actions/:id） */
export function readLastActionId(store: { getItem(k: string): string | null }): string | null {
  try {
    const raw = store.getItem(LAST_ACT_ACTION_KEY);
    if (typeof raw !== 'string') return null;
    const id = raw.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function saveLastActionId(store: { setItem(k: string, v: string): void }, actionId: string): void {
  try {
    store.setItem(LAST_ACT_ACTION_KEY, actionId);
  } catch {
    /* 静默：仅影响恢复体验 */
  }
}

export function clearLastActionId(store: { removeItem(k: string): void }): void {
  try {
    store.removeItem(LAST_ACT_ACTION_KEY);
  } catch {
    /* 静默 */
  }
}

/* ────────────── task-session key（§五 同 key 去重防重复 Execute） ────────────── */

/** 同 key 同 promise —— 与 G-4 task-session 的 SOP 一致 */
export function actConfirmTaskKey(userId: string, proposalId: string): string {
  return `agent:act:confirm:${userId}:${proposalId}`;
}

export function actExecuteTaskKey(userId: string, actionId: string): string {
  return `agent:act:execute:${userId}:${actionId}`;
}

/* ────────────── Tool order（与后端 ACT_TOOL_NAMES 一致） ────────────── */

export const ALL_ACT_TOOLS: ReadonlyArray<ActToolName> = ACT_TOOL_NAMES;

/** UI 默认建议工具：与每个 proposal 一一对应（proposal.payload.kind === 'ACT' 带 toolName 时） */
export function toolFromProposal(proposal: { id: string; payload: unknown }): ActToolName | null {
  if (typeof proposal.payload !== 'object' || proposal.payload === null) return null;
  const p = proposal.payload as Record<string, unknown>;
  if (typeof p.toolName === 'string' && isActToolName(p.toolName)) {
    return p.toolName;
  }
  return null;
}
