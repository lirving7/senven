/**
 * 端口（依赖倒置）。应用层只依赖这些接口，不依赖 Prisma / Cookie / fetch 等具体实现，
 * 因此可用内存实现离线测试（无需数据库）。
 */
import type { JobDescriptionCreateInput } from '../domain/jd/persistence.ts';
import type { MatchItemOutput, MatchRequirement, MatchSummary } from '../domain/match/types.ts';
import type { MatchRunCreateInput } from '../domain/match/persistence.ts';
import type { ResumeEntryRef } from '../domain/suggestion/targeting.ts';
import type { SuggestionCreateInput } from '../domain/suggestion/persistence.ts';
import type { ResumeSection } from '../domain/resume/types.ts';
import type { ApplicationCounts, ApplicationRecord } from '../domain/application/types.ts';
import type { EvidenceRef, Fact } from '../domain/types.ts';
import type { LearningTaskStatus } from '../domain/learning-task/learning-task.ts';

export type UserRecord = {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string | null;
  /** 自定义头像的公开 URL（Migration #18）；null = 使用前端 fallback（首字母） */
  avatarUrl: string | null;
};

export type PublicUser = {
  id: string;
  email: string;
  /** 自定义头像的公开 URL；null = 未设置（前端渲染 fallback） */
  avatarUrl: string | null;
  displayName: string | null;
};

export type SessionRecord = {
  id: string;
  userId: string;
  expiresAt: Date;
};

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(input: { email: string; passwordHash: string; displayName?: string | null }): Promise<UserRecord>;
  /**
   * 设置 / 清除自定义头像 URL。
   *
   * - 仅按 `id` 更新**单列** `avatarUrl`；不触碰 email / displayName / passwordHash；
   * - 归属由调用方（handler）用**服务端 session 推导的 userId** 传入，请求体不得提供 id；
   * - 返回更新后的记录（`updated`），非存在用户由 Prisma 抛错（不静默）。
   */
  updateAvatarUrl(id: string, avatarUrl: string | null): Promise<UserRecord>;
}

/** 用户自带 LLM API Key 的密文记录（Migration #19）。明文 Key 永不出服务端。 */
export type LlmSecretRecord = {
  /** AES-256-GCM 密文（格式 `v1.<iv>.<ct>.<tag>`，base64url）；AAD 绑定 userId */
  cipher: string;
  /** 展示用末 4 位（非敏感，服务端在加密时一并保存） */
  last4: string;
};

export interface LlmSecretRepository {
  /** 读取当前用户的 Key 密文；未配置返回 null */
  findForUser(userId: string): Promise<LlmSecretRecord | null>;
  /**
   * 保存 / 替换当前用户的 Key（User 单行两列同语句更新，天然原子：
   * 写失败即整体失败，旧 Key 保持不变）。
   * 归属由调用方（handler）用服务端 session 推导的 userId 传入，请求体不得提供。
   */
  saveForUser(userId: string, input: { cipher: string; last4: string }): Promise<void>;
  /** 删除当前用户的 Key（两列置 NULL）；未配置时幂等成功 */
  deleteForUser(userId: string): Promise<void>;
}

export interface SessionRepository {
  create(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<SessionRecord>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
  deleteExpired(now: Date): Promise<number>;
}

export type JdRecord = {
  id: string;
  userId: string;
  title: string | null;
  company: string | null;
  requirementCount: number;
};

export interface JdRepository {
  createWithRequirements(input: JobDescriptionCreateInput): Promise<JdRecord>;
  findByIdForUser(id: string, userId: string): Promise<JdRecord | null>;
  findByContentHash(userId: string, contentHash: string): Promise<JdRecord | null>;
  /** T4：带要求条目的读取，用于匹配 */
  findByIdForUserWithRequirements(id: string, userId: string): Promise<JdWithRequirements | null>;
  /** 前端列表/下拉：只读，仅返回本人数据，按创建时间倒序 */
  listForUser(userId: string): Promise<JdListItem[]>;
  /**
   * Interview V2-A（D-1）：只读、user-scoped 的 JD 原文读取（JD grounding）。
   * 仅返回**当前用户自己**的 JD rawText；非本人 / 不存在 → null（与全库隔离语义一致）。
   * 调用方（interview handler）用 null 语义 = prompt 中不出现 JD（跨用户 JD 绝不进入 prompt）。
   */
  findRawTextForUser(id: string, userId: string): Promise<string | null>;
  /**
   * 更新岗位名称；仅允许修改 title，且必须经 userId 隔离。
   * 返回更新后的记录；非本人 / 不存在 → null（调用方映射为 404）。
   */
  updateTitle(id: string, userId: string, title: string | null): Promise<JdRecord | null>;
}

export type JdListItem = {
  id: string;
  title: string | null;
  company: string | null;
  requirementCount: number;
  createdAt: Date;
};

export type JdRequirementRow = {
  id: string;
  text: string;
  category: MatchRequirement['category'];
  criticality: MatchRequirement['criticality'];
};

export type JdWithRequirements = {
  id: string;
  userId: string;
  requirements: JdRequirementRow[];
};

/** T4：读取某份简历的全部事实（四态 + 证据） */
export interface ResumeFactsRepository {
  /** 返回 null 表示简历不存在或不属于该用户 */
  findFactsForResume(resumeId: string, userId: string): Promise<Fact[] | null>;
}

export type MatchRunRecord = {
  id: string;
  userId: string;
  resumeId: string;
  jdId: string;
  itemCount: number;
  summary: unknown;
  createdAt: Date;
};

export interface MatchRepository {
  /** 原子写入：MatchRun 与其全部 MatchItem 要么全成功，要么全不写 */
  createRunWithItems(input: MatchRunCreateInput): Promise<MatchRunRecord>;
  findRunForUser(runId: string, userId: string): Promise<MatchRunRecord | null>;
  /** T6：读取一次 run 的全部 MatchItem，作为建议生成的输入 */
  findRunWithItemsForUser(runId: string, userId: string): Promise<MatchRunWithItems | null>;
}

export type MatchRunWithItems = {
  id: string;
  userId: string;
  resumeId: string;
  jdId: string;
  /** V1 修订：MatchRun.summary 落库字段（GET /api/matches/:id 恢复结果卡所需） */
  summary: MatchSummary;
  items: MatchItemOutput[];
};

/** T2：把解析结果原子写入 Resume + 四类条目 + Evidence */
export type ResumeCreateInput = {
  userId: string;
  rawText: string;
  sourceType: string;
  items: Array<{
    section: ResumeSection;
    title: string;
    detail: string | null;
    status: string;
    source: string;
    locator: string;
    excerpt: string;
  }>;
};

export type ResumeCreateResult = {
  id: string;
  itemCount: number;
  evidenceCount: number;
  unconfirmedCount: number;
  inferredCount: number;
};

export type ConfirmItemOutcome = 'CONFIRMED' | 'NOT_FOUND' | 'NO_EVIDENCE' | 'INVALID_TRANSITION';

export interface ResumeRepository {
  /** 必须在**单个事务**内完成；任一步失败整体回滚，不留半份简历 */
  createWithItems(input: ResumeCreateInput): Promise<ResumeCreateResult>;
  findForUser(resumeId: string, userId: string): Promise<{ id: string; userId: string } | null>;
  /**
   * 人工确认：仅 UNCONFIRMED / INFERRED → CONFIRMED。
   * 必须先校验用户归属；且条目必须有「locator + excerpt 都非空」的 Evidence 才允许确认。
   */
  confirmItem(
    resumeId: string,
    userId: string,
    kind: ResumeSection,
    itemId: string,
  ): Promise<ConfirmItemOutcome>;
  /** 前端「我的简历」列表：仅本人数据，含四态计数 */
  listForUser(userId: string): Promise<ResumeListItem[]>;
  /** 前端「解析确认」详情：条目带 id 与证据；非本人返回 null */
  findDetailForUser(resumeId: string, userId: string): Promise<ResumeDetail | null>;
}

export type ResumeListItem = {
  id: string;
  sourceType: string;
  createdAt: Date;
  itemCount: number;
  statusSummary: { confirmed: number; inferred: number; unconfirmed: number };
};

export type ResumeItemView = {
  id: string;
  section: ResumeSection;
  title: string;
  detail: string | null;
  status: string;
  evidence: EvidenceRef[];
};

export type ResumeDetail = {
  id: string;
  sourceType: string;
  createdAt: Date;
  items: ResumeItemView[];
};

/** T6：简历里可被改写的条目（带 targetField） */
export interface ResumeEntriesRepository {
  findEntriesForResume(resumeId: string, userId: string): Promise<ResumeEntryRef[] | null>;
}

export type ResumeVersionRecord = {
  id: string;
  resumeId: string;
  userId: string;
  versionNo: number;
  /** T6-2：Application 一致性校验需要（ResumeVersion 建版时的 JD 引用） */
  jdId: string | null;
  snapshot: unknown;
  pdfUrl: string | null;
  createdAt: Date;
};

/** T7：ResumeVersion 不可变，只提供创建与读取，刻意不提供更新快照的方法 */
export interface ResumeVersionRepository {
  /**
   * 在单个事务内分配版本号并写入。
   * buildSnapshot 以已分配的版本号作为入参回调，避免「先取号再写入」之间的竞态。
   * 返回 null 表示简历不存在或不属于该用户。
   */
  createVersion(input: {
    resumeId: string;
    userId: string;
    jdId: string | null;
    buildSnapshot: (versionNo: number) => unknown;
  }): Promise<ResumeVersionRecord | null>;
  findForUser(versionId: string, userId: string): Promise<ResumeVersionRecord | null>;
  listForResume(resumeId: string, userId: string): Promise<ResumeVersionRecord[]>;
}

export type ApplicationListQuery = {
  /** 本次返回的最大条数；缺省使用调用方默认页大小 */
  limit?: number;
  offset?: number;
  // T6-2 筛选（counts 与列表共用同一筛选，计数仍不受分页影响）
  careerGoalId?: string;
  stage?: string;
  jdId?: string;
  /** company 关键词（大小写不敏感的包含匹配） */
  company?: string;
  // T6-3-C Dashboard 普通内部查询扩展（授权书 §九/§十六：复用 applicationWhere，不新增查询层）
  /** appliedAt >= 该时刻（活动统计用，DB 侧过滤，禁止读全量后 JS 过滤） */
  appliedAfter?: Date;
  /** appliedAt <= 该时刻 */
  appliedBefore?: Date;
  /** updatedAt < 该时刻（stale 判定用） */
  updatedBefore?: Date;
  /** 排除的 stage 集合（stale 口径排除 REJECTED / WITHDRAWN）；与 stage 等值筛选互斥使用 */
  stageNotIn?: string[];
};

/** T8：求职管理。全部方法强制带 userId，非本人记录一律 null / 不返回 */
export interface ApplicationRepository {
  listForUser(userId: string, query?: ApplicationListQuery): Promise<ApplicationRecord[]>;
  /**
   * 按状态计数（与列表共用筛选条件，但**不受分页影响**）。
   * T6-2：counts = total + 6 个合法 stage（closed 已删除）。
   */
  countStagesForUser(userId: string, filter?: Omit<ApplicationListQuery, 'limit' | 'offset'>): Promise<ApplicationCounts>;
  findForUser(id: string, userId: string): Promise<ApplicationRecord | null>;
  create(input: {
    userId: string;
    company: string;
    jdId: string | null;
    careerGoalId: string | null;
    resumeVersionId: string | null;
    position: string | null;
    appliedAt: Date;
    stage: string;
    notes: string | null;
  }): Promise<ApplicationRecord>;
  /** T6-2：stage/company/notes 之外允许改 position/jdId/careerGoalId/resumeVersionId/appliedAt */
  update(
    id: string,
    userId: string,
    patch: {
      stage?: string;
      company?: string;
      notes?: string | null;
      position?: string | null;
      jdId?: string | null;
      careerGoalId?: string | null;
      resumeVersionId?: string | null;
      appliedAt?: Date;
    },
  ): Promise<ApplicationRecord | null>;
}

export const SUGGESTION_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  SKIPPED: 'SKIPPED',
} as const;
export type SuggestionStatusValue = (typeof SUGGESTION_STATUS)[keyof typeof SUGGESTION_STATUS];

export type SuggestionRecord = {
  id: string;
  resumeId: string;
  userId: string;
  kind: string;
  targetField: string;
  before: string | null;
  after: string | null;
  status: SuggestionStatusValue;
};

export interface SuggestionRepository {
  createMany(inputs: SuggestionCreateInput[]): Promise<Array<{ id: string; kind: string }>>;
  findForUser(id: string, userId: string): Promise<SuggestionRecord | null>;
  updateStatus(id: string, status: SuggestionStatusValue): Promise<void>;
  /** 仅 REPHRASE 接受后把 after 写回目标字段；返回是否真的改动了简历 */
  applyTextChange(resumeId: string, userId: string, targetField: string, text: string): Promise<boolean>;
}

/** 计数型限流（如 LLM 每小时配额） */
export interface Counter {
  consume(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }>;
}

/** 失败型限流（如登录失败次数） */
export interface FailureLimiter {
  check(key: string): Promise<{ blocked: boolean; retryAfterSeconds: number }>;
  record(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

// ─── V2 · T2 LLM 用量与配额 ──────────────────────────────────────

export const LLM_FEATURE = {
  RESUME: 'RESUME',
  JD: 'JD',
  MATCH: 'MATCH',
  ACTION_PLAN: 'ACTION_PLAN',
  LEARNING: 'LEARNING',
  PROJECT_MENTOR: 'PROJECT_MENTOR',
  PORTFOLIO: 'PORTFOLIO',
  INTERVIEW: 'INTERVIEW',
  // T5-B-2B0：ADR-017 §3（T5B-F-10）冻结的**第 9 个** LLM feature slot。
  // 本阶段仅注册槽位与额度（10 / rolling 24h），**不**引入任何 Agent Runtime / provider 调用链。
  AGENT: 'AGENT',
} as const;
export type LlmFeature = (typeof LLM_FEATURE)[keyof typeof LLM_FEATURE];

/** OK=成功 / FAILED=调用了但失败 / QUOTA_REJECTED=配额事件（未调用 provider） */
export const LLM_USAGE_STATUS = {
  OK: 'OK',
  FAILED: 'FAILED',
  QUOTA_REJECTED: 'QUOTA_REJECTED',
} as const;
export type LlmUsageStatus = (typeof LLM_USAGE_STATUS)[keyof typeof LLM_USAGE_STATUS];

export type LlmUsageRecord = {
  id: string;
  userId: string;
  feature: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  status: string;
  createdAt: Date;
};

export interface LlmUsageRepository {
  record(input: {
    userId: string;
    feature: string;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    status: string;
  }): Promise<void>;
  /** 统计窗口内「实际发生 provider 调用」的次数（不含 QUOTA_REJECTED），并给出最早一次的时间（用于 retry-after） */
  countSince(userId: string, feature: string, since: Date): Promise<{ count: number; oldest: Date | null }>;
}

// ─── V2 · T2 岗位行动计划 ─────────────────────────────────────────

export type ActionStepRecord = {
  id: string;
  order: number;
  title: string;
  desc: string;
  /** TODO / IN_PROGRESS / DONE */
  status: string;
  /** 该步骤对应的 JD 要求（可空） */
  targetRequirement: string | null;
};

export type ActionPlanRecord = {
  id: string;
  userId: string;
  matchRunId: string;
  jdId: string | null;
  /** 目标岗位描述 */
  goal: string;
  /** 已有能力（仅来自 CONFIRMED 用户事实，服务端计算，不信任 LLM） */
  have: unknown[];
  /** 能力缺口（来自 MatchRun 的缺口，服务端计算） */
  gaps: unknown[];
  createdAt: Date;
  steps: ActionStepRecord[];
};

export type ActionStepInput = {
  order: number;
  title: string;
  desc: string;
  targetRequirement: string | null;
};

export type ActionPlanCreateInput = {
  userId: string;
  matchRunId: string;
  jdId: string | null;
  goal: string;
  have: unknown[];
  gaps: unknown[];
  steps: ActionStepInput[];
};

export interface ActionPlanRepository {
  /** A3：ActionPlan + ActionStep 必须作为单个事务写入，任一步失败整体回滚 */
  createPlanWithSteps(input: ActionPlanCreateInput): Promise<ActionPlanRecord>;
  /** 仅本人计划（含 steps，按 order 升序） */
  listForUser(userId: string): Promise<ActionPlanRecord[]>;
  /** 非本人或不存在返回 null（调用方映射为 404） */
  findForUser(planId: string, userId: string): Promise<ActionPlanRecord | null>;
  /** 重生成：删旧 steps + 更新 have/gaps/goal + 写新 steps，单事务；非本人返回 null */
  replacePlanContent(
    planId: string,
    userId: string,
    input: { goal: string; have: unknown[]; gaps: unknown[]; steps: ActionStepInput[] },
  ): Promise<ActionPlanRecord | null>;
  /** 更新单步状态；step 必须属于本人的 plan，否则返回 null */
  updateStepStatus(stepId: string, userId: string, status: string): Promise<ActionStepRecord | null>;
}

// ─── V2 · T1 能力层 ─────────────────────────────────────────────

export type CapabilityRecord = {
  id: string;
  userId: string;
  key: string;
  label: string;
  level: string | null;
  status: string;
  source: string;
  createdAt: Date;
};

export type CapabilityEvidenceRecord = {
  id: string;
  type: string;
  source: string;
  url: string | null;
  excerpt: string | null;
};

export type CapabilityDetail = CapabilityRecord & { evidence: CapabilityEvidenceRecord[] };

export type ConfirmCapabilityOutcome = 'CONFIRMED' | 'NOT_FOUND' | 'NO_EVIDENCE';

// ─── V2 · T3-A2-1 项目成果 → 候选能力回流 ────────────────────────────

export type DeclareProjectEvidenceInput = {
  /** 服务端会话推导，**不接受** body 传入 */
  userId: string;
  resultId: string;
  artifactId: string;
  /**
   * T3-A2-3 **契约收紧**：由 A2-1 的「非空字符串」收紧为
   * 「**可归一为合法 canonical key 的 Capability key**」。
   *
   * 仓储**写边界强制**：内部必须经
   * `src/domain/capability/key.ts` 的 `normalizeCapabilityKey` / `validateCapabilityKey`
   * 归一与校验（§6.1 唯一来源）；不得使用 `normalizeForMatch` / `normalizeFingerprintText`，
   * 不得自行实现归一化，不得截断 key。
   * 无法归一为合法 canonical key → `INVALID_KEY`（HTTP 400 `VALIDATION_FAILED`），**零写入**。
   */
  key: string;
  label: string;
};

export type DeclareProjectEvidenceOutcome =
  | {
      kind: 'DECLARED';
      capabilityId: string;
      /** 新建时为 UNCONFIRMED；已存在时返回其**当前**状态（不改变） */
      capabilityStatus: string;
      /** 新建时为 PROJECT_RESULT；已存在时返回其**当前** source（不改变） */
      capabilitySource: string;
      evidenceId: string;
      /** true = 本次新建证据；false = 并发/重复请求命中去重（幂等成功） */
      evidenceCreated: boolean;
    }
  | { kind: 'NOT_FOUND' }
  /** 成果不是 SUBMITTED（DRAFT / REVOKED）→ 422 */
  | { kind: 'NOT_SUBMITTED' }
  /** 凭据没有可验证 URL（仅 excerpt）→ 422 */
  | { kind: 'ARTIFACT_URL_REQUIRED' }
  /**
   * T3-A2-3：key 无法归一为合法 canonical key（空 / 纯空白 / 超长 / 非白名单字符）
   * → HTTP **400 `VALIDATION_FAILED`**（复用既有错误码，**不新增码**），且**零写入**。
   */
  | { kind: 'INVALID_KEY'; reason: string };

/** 投影结果：新增 / 更新 / 无变化 / 跳过（无可用证据 → fail closed，不投影） */
export type CapabilityProjectionResult = {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
};

/**
 * 事实安全铁律：confirm 是唯一能把 Capability 推到 CONFIRMED 的路径，
 * 且必须有 ≥1 条可核验证据（url 或 excerpt 非空）。学习/项目只能写 INFERRED/UNCONFIRMED。
 */
export interface CapabilityRepository {
  listForUser(userId: string): Promise<CapabilityRecord[]>;
  findForUser(id: string, userId: string): Promise<CapabilityDetail | null>;
  confirm(id: string, userId: string): Promise<ConfirmCapabilityOutcome>;
  /**
   * T3-A2-1：确定性回流 —— 由「**已提交**成果 + 该成果下**可验证**凭据」声明一项候选能力。
   * - 只创建 `UNCONFIRMED` + `source = PROJECT_RESULT`；
   *   **已存在的 Capability 一律只读，绝不执行 UPDATE status / level / source**。
   * - 证据唯一身份 `(capabilityId, resultArtifactId)`，由 partial unique index 兜底并发。
   * - 跨用户 / 不存在的 result 与 artifact 一律返回 `NOT_FOUND`（不泄露存在性）。
   * - **不触碰 Skill**；**不调用任何 provider**（零 LLM）。
   */
  declareFromProjectArtifact(input: DeclareProjectEvidenceInput): Promise<DeclareProjectEvidenceOutcome>;
  /**
   * 幂等投影（对应验收 B7）：把该用户所有「**CONFIRMED 且带可用证据**」的简历技能投影为 Capability。
   * - 缺可用证据者 **跳过**（fail closed，绝不制造 CONFIRMED 事实）
   * - 重复调用不产生重复数据（以 `@@unique([userId, key])` 收敛）
   * - 单向：只 Skill → Capability，不反向修改 Skill
   * - T3-A2-3 / §6.1：写边界强制 —— 投影 key 必须经 `capability/key.ts` 归一 + 校验；
   *   **无法归一为合法 canonical key 的源条目跳过**（与「证据不可核验即跳过」同向，fail closed）
   * 既用于确认成功后的主路径，也用于生成 ActionPlan 前的 reconcile 兜底。
   */
  projectConfirmedSkills(userId: string): Promise<CapabilityProjectionResult>;
}

// ─── V2 · T3-A1 项目成果回流 ─────────────────────────────────────────

export type ProjectResultStatus = 'DRAFT' | 'SUBMITTED' | 'REVOKED';

export type ResultArtifactRecord = {
  id: string;
  resultId: string;
  kind: string;
  url: string | null;
  excerpt: string | null;
  dedupeKey: string;
  createdAt: Date;
};

export type ProjectResultRecord = {
  id: string;
  userId: string;
  planId: string;
  sourceStepId: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
  title: string;
  summary: string;
  contentFingerprint: string | null;
  status: ProjectResultStatus;
  createdAt: Date;
  submittedAt: Date | null;
  revokedAt: Date | null;
  artifacts: ResultArtifactRecord[];
};

export type ProjectResultListItem = {
  id: string;
  userId: string;
  planId: string;
  sourceStepId: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
  title: string;
  summary: string;
  status: ProjectResultStatus;
  artifactCount: number;
  createdAt: Date;
  submittedAt: Date | null;
  revokedAt: Date | null;
};

export type ProjectResultCreateInput = {
  userId: string;
  planId: string;
  sourceStepId: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
  title: string;
  summary: string;
};

export type ProjectResultArtifactInput = {
  kind: string;
  url?: string | null;
  excerpt?: string | null;
};

/**
 * T3-A1：项目成果仓储。
 * - 全部方法强制带 userId；非本人记录一律 null / 抛 NOT_FOUND。
 * - Draft 可编辑（增删 artifact）；Submitted 只读可撤销；Revoked 终态只读。
 * - submit 在事务内计算 contentFingerprint 并处理幂等冲突。
 * - addArtifact 对重复 dedupeKey 返回已存在行（200，不抛 409）。
 */
export interface ProjectResultRepository {
  createDraft(input: ProjectResultCreateInput): Promise<ProjectResultRecord>;
  listForUser(userId: string): Promise<ProjectResultListItem[]>;
  findForUser(id: string, userId: string): Promise<ProjectResultRecord | null>;
  addArtifact(resultId: string, userId: string, input: ProjectResultArtifactInput): Promise<ResultArtifactRecord>;
  removeDraftArtifact(resultId: string, userId: string, artifactId: string): Promise<void>;
  submit(resultId: string, userId: string, now: Date): Promise<ProjectResultRecord>;
  revoke(resultId: string, userId: string, now: Date): Promise<ProjectResultRecord>;
}

// ─── V2 · T3-A2-6 LearningTask（学习任务记录）────────────────────────────

export type LearningTaskRecord = {
  id: string;
  userId: string;
  actionPlanId: string;
  sourceStepId: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
  content: string | null;
  status: LearningTaskStatus;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type LearningTaskCreateInput = {
  /** 服务端会话推导，**不接受** body 传入 */
  userId: string;
  actionPlanId: string;
  sourceStepId: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
  content: string | null;
};

export type LearningTaskCreateOutcome =
  | { kind: 'CREATED'; task: LearningTaskRecord }
  /** 同一 (userId, actionPlanId, sourceStepId) 已存在且**未归档** → 幂等返回已有（HTTP 200） */
  | { kind: 'ACTIVE_DUPLICATE'; task: LearningTaskRecord }
  /** 同一 (userId, actionPlanId, sourceStepId) 已存在且**已归档** → HTTP 409 */
  | { kind: 'ARCHIVED_DUPLICATE' }
  /** actionPlan 不存在或不属于该用户 → 404 */
  | { kind: 'ACTION_PLAN_NOT_FOUND' };

export type LearningTaskUpdateInput = {
  status?: LearningTaskStatus;
  content?: string | null;
};

export type LearningTaskUpdateOutcome =
  | { kind: 'UPDATED'; task: LearningTaskRecord }
  | { kind: 'NOT_FOUND' }
  /** 状态非法（非 PLANNED/IN_PROGRESS/PAUSED）→ 422 */
  | { kind: 'INVALID_STATUS' }
  /** 状态迁移被禁止（IN_PROGRESS→PLANNED / PAUSED→PLANNED）→ 422（Phase 3 冻结矩阵） */
  | { kind: 'FORBIDDEN_TRANSITION' }
  /** 已归档，不允许修改 status / content → 422（archive 是终态产品操作） */
  | { kind: 'ARCHIVED' };

export type LearningTaskArchiveOutcome =
  | { kind: 'ARCHIVED'; task: LearningTaskRecord }
  | { kind: 'NOT_FOUND' };

/**
 * T3-A2-6：学习任务仓储。
 * - 全部方法强制带 userId；非本人记录一律 null / NOT_FOUND（跨用户 404，不泄露存在性）。
 * - 唯一性：`(userId, actionPlanId, sourceStepId)` 由 DB `@@unique` 兜底并发；
 *   并发命中 UNIQUE → 捕获 P2002 → 重读已有记录（不返回 500）。
 * - archive 语义：`archivedAt` 非空 = 已归档；不物理 DELETE；archive 后默认列表隐藏。
 */
export interface LearningTaskRepository {
  /**
   * 创建学习任务。业务不变量：同一 (userId, actionPlanId, sourceStepId) 最多一条。
   * - 首次 → CREATED（HTTP 201）
   * - 已存在未归档 → ACTIVE_DUPLICATE（HTTP 200，返回已有）
   * - 已存在已归档 → ARCHIVED_DUPLICATE（HTTP 409）
   * - actionPlan 非本人/不存在 → ACTION_PLAN_NOT_FOUND（HTTP 404）
   * 禁止 `find → create` 作为唯一性保证；P2002 由 repository 捕获后重读。
   */
  create(input: LearningTaskCreateInput): Promise<LearningTaskCreateOutcome>;
  /** 仅本人；默认隐藏已归档（归档是终态产品操作，默认列表不含） */
  listForUser(userId: string): Promise<LearningTaskRecord[]>;
  /** 非本人/不存在 → null（调用方映射 404）；**不做**归档过滤（历史详情可读） */
  findForUser(id: string, userId: string): Promise<LearningTaskRecord | null>;
  /** 更新 status / content；已归档 → ARCHIVED（422）；非法 status → INVALID_STATUS（422） */
  update(id: string, userId: string, input: LearningTaskUpdateInput): Promise<LearningTaskUpdateOutcome>;
  /** 归档（置 archivedAt）；幂等：已归档返回当前记录 */
  archive(id: string, userId: string, now: Date): Promise<LearningTaskArchiveOutcome>;
}

// ─── T4-2 Portfolio（作品集）────────────────────────────────────────────

export type PortfolioProjectRecord = {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  displayOrder: number;
  featured: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** detail 里的成员（含 ProjectResult 事实状态，用于二分 results / revokedResults） */
export type PortfolioMemberRecord = {
  id: string;
  portfolioProjectId: string;
  projectResultId: string;
  displayOrder: number;
  createdAt: Date;
  /** 关联 ProjectResult 的事实状态（只读，用于 active/revoked 二分） */
  submittedAt: Date | null;
  revokedAt: Date | null;
};

export type PortfolioProjectDetail = {
  project: PortfolioProjectRecord;
  results: PortfolioMemberRecord[];
  revokedResults: PortfolioMemberRecord[];
  activeResultCount: number;
};

export type PortfolioProjectCreateInput = {
  userId: string;
  title: string;
  description: string | null;
};

export type PortfolioProjectUpdateInput = {
  title?: string;
  description?: string | null;
  displayOrder?: number;
  featured?: boolean;
};

export type PortfolioProjectAddResultInput = {
  portfolioProjectId: string;
  projectResultId: string;
  displayOrder: number;
};

export type PortfolioProjectCreateOutcome =
  | { kind: 'CREATED'; project: PortfolioProjectRecord }
  | { kind: 'NOT_FOUND' };

export type PortfolioProjectUpdateOutcome =
  | { kind: 'UPDATED'; project: PortfolioProjectRecord }
  | { kind: 'NOT_FOUND' }
  /** 已归档 → 409 PORTFOLIO_ARCHIVED */
  | { kind: 'ARCHIVED' };

export type PortfolioProjectArchiveOutcome =
  | { kind: 'ARCHIVED'; project: PortfolioProjectRecord }
  | { kind: 'NOT_FOUND' };

export type PortfolioProjectAddResultOutcome =
  | { kind: 'ADDED'; member: PortfolioMemberRecord }
  /** 重复加入 → 200 existing（不创建第二条、不改 displayOrder） */
  | { kind: 'DUPLICATE'; member: PortfolioMemberRecord }
  /** 归档后 ADD → 409 */
  | { kind: 'ARCHIVED' }
  /** portfolio 不存在 / 跨用户 → 404 */
  | { kind: 'NOT_FOUND' }
  /** ProjectResult 不存在 / 跨用户 → 404 */
  | { kind: 'PROJECT_RESULT_NOT_FOUND' }
  /** ProjectResult 为 DRAFT 或 REVOKED → 422 */
  | { kind: 'NOT_ELIGIBLE' };

export type PortfolioProjectRemoveResultOutcome =
  | { kind: 'REMOVED' }
  /** 归档后 REMOVE → 409 */
  | { kind: 'ARCHIVED' }
  /** portfolio 或成员不存在 / 跨用户 → 404 */
  | { kind: 'NOT_FOUND' };

/**
 * T4-2：作品集仓储。
 * - 全部方法强制带 userId；非本人资源一律 NOT_FOUND（跨用户 404，不泄露存在性）。
 * - 归档竞态：ADD / PATCH / REMOVE / ARCHIVE 均通过 PortfolioProject 行级窄锁（FOR UPDATE）
 *   + 事务内重新读取 archivedAt；归档后返回 ARCHIVED（409）。
 * - ADD 去重：ON CONFLICT DO NOTHING + reread（不用会中止事务的 P2002 方案）。
 * - 成员二分：results（active）+ revokedResults 穷尽全部成员（依赖 P-1 无 DRAFT 成员）。
 */
export interface PortfolioProjectRepository {
  create(input: PortfolioProjectCreateInput): Promise<PortfolioProjectCreateOutcome>;
  /** 仅本人；仅 archivedAt IS NULL；排序 displayOrder ASC → createdAt ASC → id ASC */
  listForUser(userId: string): Promise<PortfolioProjectRecord[]>;
  /** 详情（含 members）；归档可读；非本人/不存在 → null */
  findForUser(id: string, userId: string): Promise<PortfolioProjectDetail | null>;
  /** PATCH；已归档 → ARCHIVED（409） */
  update(id: string, userId: string, input: PortfolioProjectUpdateInput): Promise<PortfolioProjectUpdateOutcome>;
  /** 归档；幂等：已归档返回当前记录（不改变 archivedAt） */
  archive(id: string, userId: string, now: Date): Promise<PortfolioProjectArchiveOutcome>;
  /** 加入 ProjectResult；P-1 eligibility；重复 200；归档 409 */
  addResult(id: string, userId: string, input: PortfolioProjectAddResultInput): Promise<PortfolioProjectAddResultOutcome>;
  /** 移除关系；归档 409 */
  removeResult(id: string, userId: string, resultId: string): Promise<PortfolioProjectRemoveResultOutcome>;
}

// ─── T4-5 Interview（模拟面试）─────────────────────────────────────

export type InterviewSessionRecord = {
  id: string;
  userId: string;
  jdId: string | null;
  topic: string;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InterviewTurnRecord = {
  id: string;
  sessionId: string;
  turnOrder: number;
  question: string;
  answer: string | null;
  feedback: unknown | null;
  createdAt: Date;
  updatedAt: Date;
};

export type InterviewSessionDetail = {
  session: InterviewSessionRecord;
  turns: InterviewTurnRecord[];
};

export type InterviewCreateSessionInput = {
  userId: string;
  jdId: string | null;
  topic: string;
};

export type InterviewCreateSessionOutcome =
  | { kind: 'CREATED'; session: InterviewSessionRecord }
  | { kind: 'NOT_FOUND' };

export type InterviewEndOutcome =
  | { kind: 'ENDED'; session: InterviewSessionRecord }
  | { kind: 'NOT_FOUND' };

/** 已结束 → 409（禁止写入） */
export type InterviewCreateTurnOutcome =
  | { kind: 'CREATED'; turn: InterviewTurnRecord }
  /** 已结束 → 409 INTERVIEW_SESSION_ENDED */
  | { kind: 'SESSION_ENDED' }
  /** 存在未回答 Turn → 409 INTERVIEW_TURN_PENDING */
  | { kind: 'TURN_PENDING' }
  /** Interview V2-A D-2：锁内并发兜底 —— nextOrder 已超 MAX_INTERVIEW_TURNS → 409 */
  | { kind: 'TURN_LIMIT_REACHED' }
  /** 并发唯一约束兜底 → 409 INTERVIEW_TURN_CONFLICT */
  | { kind: 'TURN_CONFLICT' }
  | { kind: 'NOT_FOUND' };

/**
 * POST /turns 前置资格检查（provider 调用之前的短事务）结果。
 * 用于在调用 question provider 前快速短路 409，避免无谓消耗 quota。
 * - OK：可继续调用 provider 生成 question
 * - SESSION_ENDED / TURN_PENDING / NOT_FOUND：直接 409/404，provider 调用 0 次
 */
export type InterviewCheckTurnOutcome =
  | { kind: 'OK' }
  | { kind: 'SESSION_ENDED' }
  | { kind: 'TURN_PENDING' }
  /** Interview V2-A D-2：已达 MAX_INTERVIEW_TURNS（8 轮）上限 → 409，provider 0 次 / quota 0 */
  | { kind: 'TURN_LIMIT_REACHED' }
  | { kind: 'NOT_FOUND' };

/**
 * Stage 1 结果：answer 保存或三态判定。
 * - SAVED：本轮首次写 answer（需进入 Stage 2 评估）
 * - ALREADY_PENDING：answer 已存在且 feedback 为空（同 answer 重试 → 进入 Stage 2）
 * - COMPLETED_SAME：已完成且 answer 相同 → 200 existing（不评估）
 */
export type InterviewSaveAnswerOutcome =
  | { kind: 'SAVED'; turn: InterviewTurnRecord }
  | { kind: 'PENDING_RETRY'; turn: InterviewTurnRecord }
  | { kind: 'COMPLETED_SAME'; turn: InterviewTurnRecord }
  | { kind: 'SESSION_ENDED' }
  | { kind: 'TURN_NOT_FOUND' }
  | { kind: 'ANSWER_IMMUTABLE' };

/**
 * Stage 3 结果：feedback 原子写入。
 * - COMMITTED：feedback 写入成功
 * - SESSION_ENDED：Stage 2 期间被 end，不写 feedback（409）
 * - NOT_PENDING：Turn 已不是 EVALUATION_PENDING（如已被并发完成）
 * - ANSWER_MISMATCH：answer 与 Stage 1 保存值不一致（防御性）
 */
export type InterviewCommitFeedbackOutcome =
  | { kind: 'COMMITTED'; turn: InterviewTurnRecord }
  | { kind: 'SESSION_ENDED' }
  | { kind: 'NOT_PENDING' }
  | { kind: 'ANSWER_MISMATCH' }
  | { kind: 'TURN_NOT_FOUND' };

export type InterviewSaveAnswerInput = {
  sessionId: string;
  turnId: string;
  answer: string;
};

export type InterviewCommitFeedbackInput = {
  sessionId: string;
  turnId: string;
  answer: string;
  feedback: unknown;
};

/**
 * T4-5：模拟面试仓储。
 * - 全部方法强制带 userId；非本人资源一律 NOT_FOUND（跨用户 404，不泄露存在性）。
 * - end / createTurn / saveAnswer / commitFeedback 均通过 InterviewSession 行级窄锁
 *   （FOR UPDATE）+ 事务内 reread endedAt；ended 后禁止写入（409）。
 * - PATCH Turn 三阶段：saveAnswer（Stage1 锁写 answer）→ handler 无锁 provider（Stage2）
 *   → commitFeedback（Stage3 锁原子写 feedback，校验 pending + answer 一致）。
 * - 无 feedback 必须为 SQL NULL（禁 Prisma.JsonNull）。
 */
export interface InterviewRepository {
  createSession(input: InterviewCreateSessionInput): Promise<InterviewCreateSessionOutcome>;
  /** 仅本人；active + ended 全量；排序 createdAt DESC → id DESC；无分页 */
  listForUser(userId: string): Promise<InterviewSessionRecord[]>;
  /** 详情（含 turns，turnOrder ASC）；ended 可读；非本人/不存在 → null */
  findForUser(id: string, userId: string): Promise<InterviewSessionDetail | null>;
  /** 结束 session；幂等（重复 end 不改变 endedAt） */
  end(id: string, userId: string, now: Date): Promise<InterviewEndOutcome>;
  /**
   * POST /turns 前置资格检查（provider 调用之前的短事务）：
   * 锁 Session 行 → reread endedAt → 检查是否存在 answer IS NULL 的未回答 Turn。
   * 存在 pending / 已结束 / 不存在时直接短路，避免无谓的 provider 调用与 quota 消耗。
   */
  checkTurnEligibility(id: string, userId: string): Promise<InterviewCheckTurnOutcome>;
  /** 创建下一轮（question 已由 handler 生成）；锁内检查 pending + 计算 turnOrder */
  createTurn(id: string, userId: string, question: string): Promise<InterviewCreateTurnOutcome>;
  /** Stage 1：锁 Session 行，写 answer / 三态判定 */
  saveAnswer(userId: string, input: InterviewSaveAnswerInput): Promise<InterviewSaveAnswerOutcome>;
  /** Stage 3：锁 Session 行，原子写 feedback（校验 pending + answer 一致） */
  commitFeedback(userId: string, input: InterviewCommitFeedbackInput): Promise<InterviewCommitFeedbackOutcome>;
}

// ─── T5-A RAG-Lite（检索只读 + 受控 ingest）──────────────────────────────

/** sourceType 允许值（Migration #13 CHECK 白名单，v1 固定三值，T5A-F-11 / T5A-F-05） */
export type KnowledgeSourceType = 'OFFICIAL_DOC' | 'JOB_GUIDE' | 'CURATED_REFERENCE';

/** GET /api/rag/sources 的最小字段（T5A-F-58：**不暴露 provenance**） */
export type KnowledgeSourceSummary = {
  key: string;
  title: string;
  sourceType: string;
  enabled: boolean;
};

/** 一条检索命中（检索最小返回粒度 = Chunk，T5A-F-19） */
export type RagRetrievalHit = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  sourceKey: string;
  sourceType: string;
  title: string;
  content: string;
  chunkOrder: number;
  rank: number;
};

export type RagRetrievalQuery = {
  /** 已由 cjk-bigram/v1 tokenizer 生成、单空格连接的检索串 */
  searchText: string;
  limit: number;
};

export type RagRetrievalResult = {
  hits: RagRetrievalHit[];
  /** 命中总数（不受 limit 影响） */
  total: number;
};

/**
 * T5-A 检索仓储（**只读**）。
 *
 * 硬约束：
 *   - T5A-F-54：本接口**不提供任何写方法**；检索输出不是事实权威（T5A-F-53）；
 *   - T5A-F-12 / T5A-F-79：语料为全局公共/受控数据，**无 userId 谓词**；
 *   - T5A-F-43：只能读到 `enabled` 的 source 与 document；
 *   - T5A-F-41：排序必须 `rank DESC, documentId ASC, chunkOrder ASC`（确定性）；
 *   - T5A-F-75 / T5A-F-76：不得 JOIN 任何用户私有 / Frozen Zone 表。
 */
export interface RagRetrievalRepository {
  /** 仅返回 enabled = true 的 source；最小字段；排序 key ASC（确定性） */
  listEnabledSources(): Promise<KnowledgeSourceSummary[]>;
  /** 参数绑定 raw SQL 检索（tsvector + GIN，config = simple） */
  retrieve(query: RagRetrievalQuery): Promise<RagRetrievalResult>;
}

// ─── T5-A 受控 ingest（**仅脚本 / fixture**，无 HTTP 入口）──────────────

export type KnowledgeSourceWriteInput = {
  key: string;
  title: string;
  sourceType: KnowledgeSourceType;
  description: string | null;
  /** required；不得入库无 provenance 的语料（T5A-F-14） */
  provenance: Record<string, unknown>;
};

export type KnowledgeChunkWriteInput = {
  chunkOrder: number;
  content: string;
  searchText: string;
  chunkHash: string;
  metadata: Record<string, unknown> | null;
};

export type KnowledgeDocumentWriteInput = {
  /** 目标 source 的稳定人工标识 */
  sourceKey: string;
  title: string;
  content: string;
  contentFingerprint: string;
  language: string;
  chunks: KnowledgeChunkWriteInput[];
};

export type KnowledgeIngestOutcome =
  | { kind: 'CREATED'; documentId: string; chunkCount: number }
  /** 同 (sourceId, contentFingerprint) 已存在 → 幂等返回既有（不新增、不 500） */
  | { kind: 'DUPLICATE'; documentId: string; chunkCount: number }
  | { kind: 'SOURCE_NOT_FOUND' };

/**
 * T5-A 受控 ingest 仓储（**写**）。
 *
 * ⚠️ 本接口**不得**被任何 HTTP handler 依赖；只允许被受控脚本 / QA fixture 使用
 * （T5A-F-61：v1 无 HTTP ingest）。
 *   - 只写 3 张 RAG 表；**零** Capability / CapabilityEvidence / Evidence / CONFIRMED 写入（T5A-F-71~74）；
 *   - 内容变化按 T5A-F-17：新增 Document（新指纹），旧 Document 置 `enabled=false`（保留审计）；
 *   - ingest 必须整体成功或整体回滚（T5A-F-64）。
 */
export interface KnowledgeIngestRepository {
  /** 注册 / 更新 source（按 key 幂等 upsert）；返回 source id */
  upsertSource(input: KnowledgeSourceWriteInput): Promise<{ id: string }>;
  ingestDocument(input: KnowledgeDocumentWriteInput): Promise<KnowledgeIngestOutcome>;
}

// ─── T5-B-1 Agent Domain Persistence（**仅持久化 + 归属隔离**）──────────────
//
// 边界（T5-B-1 授权书）：
//   - 本阶段**零 API / 零 Handler / 零 Tool / 零 LLM / 零 quota**；
//   - `AgentProposal` **不保存 userId**，归属一律经 `AgentProposal → AgentRun → userId`（§十）；
//   - **禁止**提供 `findProposalById(id)` 这类不带 userId 的业务访问接口（§十）；
//   - 状态机 / 校验属 Domain（`src/domain/agent/*`）；本层只负责 CRUD / 归属 / FK / 唯一冲突 / 状态条件更新。

export type AgentRunRecord = {
  id: string;
  userId: string;
  goalKind: string;
  status: string;
  modelVersion: string | null;
  semanticVersions: unknown;
  promptTemplateVersion: string;
  quotaUsage: unknown;
  providerRequestId: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
};

export type AgentProposalRecord = {
  id: string;
  runId: string;
  revision: number;
  kind: string;
  payload: unknown;
  basedOnRefs: unknown;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentRunCreateInput = {
  /** 服务端会话推导，**不接受** body 传入 */
  userId: string;
  goalKind: string;
  promptTemplateVersion: string;
  semanticVersions: unknown;
  quotaUsage: unknown;
  modelVersion?: string | null;
};

export type AgentRunTransitionOutcome =
  | { kind: 'UPDATED'; run: AgentRunRecord }
  | { kind: 'NOT_FOUND' }
  /** 目标状态不在 v1 allowlist（含 CONFIRMED）→ 由调用方映射 4xx */
  | { kind: 'INVALID_STATUS' }
  /** 状态机禁止的转移（含终态再次转移、PROPOSED→CANCELLED） */
  | { kind: 'FORBIDDEN_TRANSITION' }
  /** 条件更新未命中：并发下状态已被改变（不得视为成功） */
  | { kind: 'CONFLICT' };

export type AgentProposalCreateInput = {
  runId: string;
  kind: string;
  revision: number;
  payload: unknown;
  basedOnRefs: unknown;
};

export type AgentProposalCreateOutcome =
  | { kind: 'CREATED'; proposal: AgentProposalRecord }
  /** 同 (runId, revision) 已存在 → 幂等返回既有（不新增、不 500） */
  | { kind: 'DUPLICATE'; proposal: AgentProposalRecord }
  /** run 不存在或不属于该用户（跨用户不泄露存在性） */
  | { kind: 'RUN_NOT_FOUND' };

// ─── T5-B-2B Agent Runtime（**唯一新增的 Runtime 专用仓储能力**）──────────────

/**
 * T5-B-2B：计划终态提交输入。
 *
 * ⚠️ 这是本阶段**唯一**新增的仓储 API（授权书 §十一：「除此之外不得新增 Repository API」）。
 * 采用「一个方法承载两种终态」的设计，使 **成功路径的原子性**（transition + proposal 同事务）
 * 与 **失败路径的 `errorCode` 落库**（§一.11 / §十二）无需再引入第二个方法。
 */
export type AgentPlanCommitInput =
  | {
      kind: 'PROPOSED';
      runId: string;
      /** v1 revision 恒 1；与 `PLANNING → PROPOSED` 同一事务写入（`runId` 取自外层） */
      proposal: Omit<AgentProposalCreateInput, 'runId'>;
    }
  | { kind: 'FAILED'; runId: string; errorCode: string };

export type AgentPlanCommitOutcome =
  | { kind: 'COMMITTED'; run: AgentRunRecord; proposal: AgentProposalRecord | null }
  /** run 不存在 / 不属于该用户（无 oracle） */
  | { kind: 'NOT_FOUND' }
  /** 并发冲突：提交时 run 已不处于 `PLANNING`（例如并发取消）→ 不得视为成功 */
  | { kind: 'CONFLICT' };

/**
 * T5-B-1：Agent 持久化仓储。
 * - **全部读写强制带 userId**；非本人资源一律 null / NOT_FOUND（跨用户 404，不泄露存在性）；
 * - Proposal 归属**只**经 `run.userId` 校验，**不**在 proposal 上冗余 userId；
 * - `createProposal` 用 DB `@@unique([runId, revision])` 作最终防线：捕获 P2002 → 重读已有 → `DUPLICATE`
 *   （**禁止** `find → create` 作为唯一性保证）；
 * - `transitionRun` 使用**带状态条件**的更新，防止并发请求重复成功。
 */
export interface AgentRunRepository {
  createRun(input: AgentRunCreateInput): Promise<AgentRunRecord>;
  /** 非本人 / 不存在 → null */
  findRunForUser(id: string, userId: string): Promise<AgentRunRecord | null>;
  /** 仅本人；排序 createdAt DESC → id DESC（确定性） */
  listRunsForUser(userId: string): Promise<AgentRunRecord[]>;
  /** 状态转移（domain 判定 + 状态条件更新）；进入终态时写 endedAt */
  transitionRun(id: string, userId: string, to: string, now: Date): Promise<AgentRunTransitionOutcome>;
  /** 创建 proposal（v1 revision 恒 1）；ownership 经 run 校验 */
  createProposal(userId: string, input: AgentProposalCreateInput): Promise<AgentProposalCreateOutcome>;
  /** ⚠️ 必须带 userId（归属经 AgentRun）；**不得**提供不带 userId 的 proposal 读取接口 */
  findProposalForUser(proposalId: string, userId: string): Promise<AgentProposalRecord | null>;
  /** 列出某 run 的 proposals；run 非本人 / 不存在 → null */
  listProposalsForRun(runId: string, userId: string): Promise<AgentProposalRecord[] | null>;
    /**
     * T5-B-2B：**单事务**提交计划终态（本阶段唯一新增的仓储方法）。
     *
     * - `PROPOSED`：`PLANNING → PROPOSED` **与** `AgentProposal`（revision=1）创建在**同一事务**内完成
     *   ⇒ 不会出现「PROPOSED 无 proposal」或「proposal 无 PROPOSED」（授权书 §十一）；
     * - `FAILED`：`PLANNING → FAILED`（或在配额预检拒绝时 `CREATED → FAILED`）并写 `errorCode`（同一事务）；
     * - **行级窄锁**（`SELECT ... FOR UPDATE`）+ 带当前状态的**条件更新** → 防并发取消竞态；
     * - 任一步失败**整体回滚**（proposal 创建失败不会留下 `PROPOSED`）；
     * - 归属经 `run.userId`：跨用户 / 不存在 → `NOT_FOUND`；源状态不允许 → `CONFLICT`。
     */
  commitPlanOutcome(
    userId: string,
    input: AgentPlanCommitInput,
    now: Date,
  ): Promise<AgentPlanCommitOutcome>;
}

/* ─── T6-1：CareerGoal 求职目标仓储（用户自著资源；ownership 全强制） ─────── */

export type CareerGoalRecord = {
  id: string;
  userId: string;
  name: string;
  position: string;
  location: string | null;
  employmentType: string;
  status: string;
  isCurrent: boolean;
  createdAt: string;
  updatedAt: string;
  /** 关联 JD id（replace-set 语义下的当前集合，按 createdAt ASC 确定性排序） */
  jdIds: string[];
};

export type CareerGoalCreateInput = {
  name: string;
  position: string;
  location?: string;
  employmentType: string;
  status: string;
  jdIds?: string[];
};

export type CareerGoalUpdateInput = {
  name?: string;
  position?: string;
  location?: string | null;
  employmentType?: string;
  status?: string;
  jdIds?: string[];
};

export type CareerGoalUpdateOutcome =
  | { kind: 'UPDATED'; goal: CareerGoalRecord }
  /** 非本人 / 不存在 → 与不存在同形（授权书 §十，404 无 oracle） */
  | { kind: 'NOT_FOUND' }
  /** jdIds 中存在不属于该用户的 JD（含不存在）→ 422，不透露具体哪个 */
  | { kind: 'JD_NOT_FOUND' };

export type CareerGoalCurrentOutcome =
  | { kind: 'SET'; goal: CareerGoalRecord }
  /** 幂等：该 goal 已是当前目标 */
  | { kind: 'NOOP'; goal: CareerGoalRecord }
  | { kind: 'NOT_FOUND' }
  /** 仅 ACTIVE 可设为当前（授权书 §五）；或并发下唯一索引竞争 → 409 可重试 */
  | { kind: 'CONFLICT'; reason: 'GOAL_NOT_ACTIVE' | 'CURRENT_SWITCH_RACE' };

export type CareerGoalCreateOutcome =
  | { kind: 'CREATED'; goal: CareerGoalRecord }
  /** jdIds 中存在不属于该用户的 JD（含不存在）→ 422，不透露具体哪个 */
  | { kind: 'JD_NOT_FOUND' };

export interface CareerGoalRepository {
  /** 创建（用户自著）；jdIds ownership 由实现校验 */
  create(userId: string, input: CareerGoalCreateInput): Promise<CareerGoalCreateOutcome>;
  /** 列表（仅本人）；filter 可选 status / current */
  listForUser(userId: string, filter?: { status?: string; current?: boolean }): Promise<CareerGoalRecord[]>;
  /** 非本人 / 不存在 → null（无 oracle） */
  findForUser(id: string, userId: string): Promise<CareerGoalRecord | null>;
  /**
   * 更新（replace-set 语义；授权书 §八）：
   * - jdIds 提供时整体替换，逐项校验 JD ownership；
   * - status 离开 ACTIVE 时于同一事务清除 isCurrent（§十一）；
   * - **isCurrent 不在可更新字段内**（只能经 setCurrent 切换）。
   */
  update(userId: string, id: string, patch: CareerGoalUpdateInput): Promise<CareerGoalUpdateOutcome>;
  /**
   * 设为当前目标（授权书 §六）：**单事务**、并发安全——
   * 事务内先清除该用户旧 Current，再置新 Current；
   * 部分唯一索引 `CareerGoal_userId_current_key` 为最终防线，P2002 → CONFLICT（409 可重试，不 500）；
   * 幂等：已为 Current → NOOP；目标非 ACTIVE → CONFLICT。
   */
  setCurrent(userId: string, id: string): Promise<CareerGoalCurrentOutcome>;
  /** T6-2：Application 写入一致性校验 —— (careerGoalId, jdId) 是否存在绑定（§五.6；不做 DB composite FK） */
  hasJobDescriptionLink(careerGoalId: string, jdId: string): Promise<boolean>;
}


// ─── T6-4-A：Act 执行实体 ───

export type AgentActionRecord = {
  id: string;
  userId: string;
  runId: string | null;
  proposalId: string | null;
  toolName: string;
  payload: unknown;
  status: string;
  idempotencyKey: string;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentActionCreateInput = {
  userId: string;
  runId: string | null;
  proposalId: string | null;
  toolName: string;
  payload: unknown;
  status: string;
  idempotencyKey: string;
};

/** Act 执行实体仓储。ownership 一律 userId 谓词；跨用户 → null（无 oracle）。 */
export interface AgentActionRepository {
  create(input: AgentActionCreateInput): Promise<AgentActionRecord>;
  /** 非本人 / 不存在 → null */
  findForUser(id: string, userId: string): Promise<AgentActionRecord | null>;
  /** 幂等查重：同 idempotencyKey 的既有 Action（含 SUCCEEDED 复用） */
  findByIdempotencyKey(key: string): Promise<AgentActionRecord | null>;
  /** proposal 维度幂等：同 proposalId 的既有 Action */
  findByProposalId(proposalId: string): Promise<AgentActionRecord | null>;
  /** 状态机转移（调用方先经 canTransitionActStatus 判定） */
  updateStatus(
    id: string,
    userId: string,
    patch: { status: string; result?: unknown; errorCode?: string; errorMessage?: string },
  ): Promise<AgentActionRecord | null>;
}
