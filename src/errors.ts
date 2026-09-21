/** 共享错误内核。各层抛出带 code 的错误，由 HTTP 层统一映射为状态码。 */

export const ERROR_CODE = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  RATE_LIMITED: 'RATE_LIMITED',
  LLM_QUOTA_EXCEEDED: 'LLM_QUOTA_EXCEEDED',
  JD_TOO_SHORT: 'JD_TOO_SHORT',
  JD_EMPTY: 'JD_EMPTY',
  JD_SHAPE_INVALID: 'JD_SHAPE_INVALID',
  NOT_FOUND: 'NOT_FOUND',
  /** 该建议不是文本改写，不能直接写回简历（GUIDANCE / CONFIRM_FACT） */
  SUGGESTION_NOT_APPLICABLE: 'SUGGESTION_NOT_APPLICABLE',
  /** 建议已被处理过 */
  SUGGESTION_ALREADY_RESOLVED: 'SUGGESTION_ALREADY_RESOLVED',
  /** PDF 内容不合法（如无已确认事实、缺姓名） */
  PDF_CONTENT_INVALID: 'PDF_CONTENT_INVALID',
  /** PDF 渲染失败 */
  PDF_RENDER_FAILED: 'PDF_RENDER_FAILED',
  /** 模型服务未配置（如缺少 LLM_API_KEY）：属配置问题，不是服务故障 */
  SERVICE_NOT_CONFIGURED: 'SERVICE_NOT_CONFIGURED',
  /** 条目当前不可确认（无证据 / 状态不允许转换） */
  ITEM_NOT_CONFIRMABLE: 'ITEM_NOT_CONFIRMABLE',
  /** V2：能力无可核验证据，不可确认（事实安全铁律） */
  CAPABILITY_NOT_CONFIRMABLE: 'CAPABILITY_NOT_CONFIRMABLE',
  /** V2：作品集/内容写回未过事实闸门 */
  FACT_GATE_BLOCKED: 'FACT_GATE_BLOCKED',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  PERSISTENCE_FAILED: 'PERSISTENCE_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** T3-A1：成果当前状态不可编辑（Draft 之外增删 artifact / 修改） */
  RESULT_NOT_EDITABLE: 'RESULT_NOT_EDITABLE',
  /** T3-A1：提交时至少需要一个凭据 */
  RESULT_HAS_NO_ARTIFACT: 'RESULT_HAS_NO_ARTIFACT',
  /** T3-A1：状态转换不被允许（如撤销 Draft / 重复提交等） */
  RESULT_NOT_TRANSITIONABLE: 'RESULT_NOT_TRANSITIONABLE',
  /** T3-A1：相同内容成果已存在 */
  RESULT_DUPLICATE: 'RESULT_DUPLICATE',
  /** T3-A2-1：只有 SUBMITTED 状态的成果才能声明候选能力（DRAFT / REVOKED 均拒绝） */
  RESULT_NOT_SUBMITTED: 'RESULT_NOT_SUBMITTED',
  /**
   * T3-A2-2：AI 分析返回内容无法解析为本次分析要求的严格结构
   * （JSON 解析失败 / schema 不符 / 未知字段 / candidates 非数组 / 超 5 条 /
   *  artifactId 不属于该成果 / key 不合规）。
   * 语义限定于 AI 分析场景，**不复用** JD 场景的 `JD_SHAPE_INVALID`。
   */
  AI_ANALYSIS_INVALID_RESPONSE: 'AI_ANALYSIS_INVALID_RESPONSE',
  /**
   * T3-A2-6：LearningTask 状态转换不被允许（非法 status 值 / 已归档后修改 status 或 content）。
   */
  LEARNING_TASK_NOT_TRANSITIONABLE: 'LEARNING_TASK_NOT_TRANSITIONABLE',
  /**
   * T3-A2-6：LearningTask 创建时命中 (userId, actionPlanId, sourceStepId) 唯一约束，
   * 且已有记录已归档 → 不允许创建第二条（归档是终态，provenance 保留，不重开）。
   */
  LEARNING_TASK_ARCHIVED_EXISTS: 'LEARNING_TASK_ARCHIVED_EXISTS',
  /**
   * T4-2：Portfolio 归档后不可修改（PATCH / ADD / REMOVE）→ 409。
   * 有意区别于 LearningTask 的 422（见 ADR-014 G-5）。
   */
  PORTFOLIO_ARCHIVED: 'PORTFOLIO_ARCHIVED',
  /**
   * T4-2：ProjectResult 未满足加入 Portfolio 资格（DRAFT 或 REVOKED）→ 422。
   * 禁止复用 FACT_GATE_BLOCKED（见 ADR-014 P-1 / P-13）。
   */
  PORTFOLIO_RESULT_NOT_ELIGIBLE: 'PORTFOLIO_RESULT_NOT_ELIGIBLE',
  /**
   * T4-5：Interview Session 已结束，禁止写入（追加轮次 / 提交答案 / 修改 Turn）→ 409。
   */
  INTERVIEW_SESSION_ENDED: 'INTERVIEW_SESSION_ENDED',
  /**
   * T4-5：存在未回答的 Turn，禁止创建下一轮 → 409。
   */
  INTERVIEW_TURN_PENDING: 'INTERVIEW_TURN_PENDING',
  /**
   * T4-5：并发创建 Turn 冲突（唯一约束防御性兜底）→ 409。
   */
  INTERVIEW_TURN_CONFLICT: 'INTERVIEW_TURN_CONFLICT',
  /**
   * T4-5：Turn 已完成 / 处于评估中，answer 不可变更（仅可提交完全相同的 answer）→ 422。
   */
  INTERVIEW_ANSWER_IMMUTABLE: 'INTERVIEW_ANSWER_IMMUTABLE',
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

export class AppError extends Error {
  code: ErrorCode;
  details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details ?? null;
  }
}

export function appError(code: ErrorCode, message: string, details?: unknown): AppError {
  return new AppError(code, message, details);
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
