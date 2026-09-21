import { createAuthService } from '../auth/service.ts';
import type { AuthService } from '../auth/service.ts';
import { prisma } from '../db/client.ts';
import { createInMemoryCounter, createInMemoryFailureLimiter } from '../db/rate-limit.ts';
import { createPrismaRepositories } from '../db/repositories.ts';
import { providerFromEnv, providerFromUserKey } from '../llm/factory.ts';
import { decryptLlmApiKey, LlmKeyCryptoError } from '../llm/key-crypto.ts';
import type { LLMProvider } from '../llm/provider.ts';
import { createSemanticMatcher } from '../domain/match/semantic.ts';
import { systemClock } from '../ports/index.ts';
import type { CapabilityRepository, JdRepository, PublicUser, ResumeRepository } from '../ports/index.ts';
import { errorResponse, defaultLogger, newRequestId } from './request.ts';
import { appError, ERROR_CODE } from '../errors.ts';
import { readCookie, SESSION_COOKIE } from './cookies.ts';
import type { JdsHandlerDeps } from './handlers/jds.ts';
import type { AuthHandlerDeps } from './handlers/auth.ts';
import type { MatchesHandlerDeps } from './handlers/matches.ts';
import { createRephrasePort } from '../domain/suggestion/rephrase.ts';
import type { SuggestionsHandlerDeps } from './handlers/suggestions.ts';
import type { ResumeVersionsHandlerDeps } from './handlers/resume-versions.ts';
import type { ApplicationsHandlerDeps } from './handlers/applications.ts';
import { createResumeParser } from '../domain/resume/parse-resume.ts';
import { createFileAvatarStorage } from '../storage/avatar-storage.ts';
import type { ResumesHandlerDeps } from './handlers/resumes.ts';
import type { ResumeItemsHandlerDeps } from './handlers/resume-items.ts';
import type { ActionPlansHandlerDeps } from './handlers/action-plans.ts';
import type { ProjectResultsHandlerDeps } from './handlers/project-results.ts';
import type { ProjectAiAnalysisHandlerDeps } from './handlers/project-ai-analysis.ts';
import type { ProjectGuideHandlerDeps } from './handlers/project-guide.ts';
import type { LearningTasksHandlerDeps } from './handlers/learning-tasks.ts';
import type { PortfolioProjectsHandlerDeps } from './handlers/portfolio-projects.ts';
import type { CareerGoalsHandlerDeps } from './handlers/career-goals.ts';
import type { InterviewHandlerDeps } from './handlers/interview-sessions.ts';
import type { AgentActionsHandlerDeps } from './handlers/agent-actions.ts';
import type { RagHandlerDeps } from './handlers/rag-retrieval.ts';
import type { AgentRunsHandlerDeps } from './handlers/agent-runs.ts';
import type { DashboardHandlerDeps } from './handlers/dashboard.ts';
import type { LlmSecretHandlerDeps } from './handlers/llm-secret.ts';
import { createAgentReadToolLayer } from '../agent/tool-layer.ts';
import { createAgentPlanRuntime } from '../agent/runtime.ts';

/** 生产装配点：把端口接到真实实现。所有单例在此创建，避免每请求新建。 */

const repositories = createPrismaRepositories(prisma);

const authService: AuthService = createAuthService({
  users: repositories.users,
  sessions: repositories.sessions,
  failures: createInMemoryFailureLimiter(systemClock),
  clock: systemClock,
});

const llmCounter = createInMemoryCounter(systemClock);

/**
 * 头像存储单例（Migration #18 授权）。
 * 本地文件系统实现，写入 `public/uploads/avatars/`。
 * ⚠️ 前提：部署环境必须持久化本地文件系统；Serverless / 临时容器会使已上传头像在下次部署后丢失。
 */
const avatarStorage = createFileAvatarStorage();

export function getAuthService(): AuthService {
  return authService;
}

/**
 * Implementation 授权 2026-09-21 §四/§五：用户 scoped Provider 解析。
 *
 * BYO API Key = **用户级 override**：
 *  - 用户配置了自己的 Key → 解密（AAD=userId）后用 `providerFromUserKey` 构造；
 *  - 未配置 / 解密失败 → 回落 `providerFromEnv()` 等价路径（T5B-F-08 默认行为不变）；
 *  - 每次调用即时解析，**不做跨请求缓存**；解密明文仅存在于本次请求栈内；
 *  - 解密失败只记录安全类别（LlmKeyCryptoError.code），绝不记录 Key 明文 / 密文。
 * 调用方必须已经从服务端 session 解析出 userId（body/query 的 userId 一律不被信任）。
 */
export async function providerFor(userId: string): Promise<LLMProvider> {
  const secret = await repositories.llmSecrets.findForUser(userId);
  if (secret) {
    try {
      return providerFromUserKey(decryptLlmApiKey(secret.cipher, userId));
    } catch (err) {
      const category = err instanceof LlmKeyCryptoError ? err.code : 'UNKNOWN';
      defaultLogger({ level: 'warn', event: 'llm_user_key_unavailable', category, userId });
    }
  }
  return providerFromEnv();
}

/**
 * route 层 session 解析：provider 装配必须发生在「知道用户身份」之后
 * （Implementation 授权书 §七：先认证 userId → 再构建 handler deps → 再获得 provider）。
 * 返回 discriminated union：route 以 `'response' in auth` 判别。
 */
export async function requireSessionUser(
  request: Request,
): Promise<{ user: PublicUser } | { response: Response }> {
  const requestId = newRequestId();
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await authService.getCurrentUser(token);
  if (!user) {
    return { response: errorResponse(appError(ERROR_CODE.UNAUTHENTICATED, '请先登录'), requestId) };
  }
  return { user };
}

export function buildAuthHandlerDeps(): AuthHandlerDeps {
  return {
    auth: authService,
    secureCookies: process.env.NODE_ENV === 'production',
    // 仅 POST /api/auth/avatar 使用；PATCH /api/auth/me 不使用这两个依赖
    avatarStorage,
    users: repositories.users,
  };
}

/**
 * Migration #19：用户自带 API Key 的存取装配点（GET/PUT/DELETE /api/auth/me/llm-secret）。
 * 同步构建（无 provider）；归属一律由 handler 内的 session 解析，body 不接受 userId。
 */
export function buildLlmSecretHandlerDeps(): LlmSecretHandlerDeps {
  return {
    auth: authService,
    llmSecrets: repositories.llmSecrets,
  };
}

/**
 * T5-B-2C：Agent 装配点（Runtime 的**唯一**生产入口，`buildAgentRunsHandlerDeps`）。
 *
 * 组装：只读 Tool Layer（T5-B-2A）→ AgentPlanRuntime（T5-B-2B）→ 既有 quota gate / provider。
 * API 层零 Runtime 逻辑复现；本层亦不直调任何 Tool / RAG / provider —— 仅注入。
 *
 * O-3（Match shim）：v1 Runtime 只在显式提供 `matchRunId` 时装配 `get_match_result`，
 * `findLatestRunIdForUser` **永不执行** —— 此 shim 仅为满足 T5-B-2A 依赖契约的类型；
 * 若被误调用将大声抛错（不访问数据库、不被静默解析）。测试证明 `latestResolverCalls === 0`。
 *
 * ⚠️ 位置约束：刻意置于工厂区**最前部**。既有三个隔离守卫以
 * `deps.ts.slice(indexOf('buildInterview/…LearningTasksHandlerDeps'))` **切到文件尾**扫描，
 * 本工厂含 provider / 事实仓储名，若位于其后必被误扫。置顶即从其扫描范围中排除
 * （既有守卫零改动）。
 */
/** T6-1：CareerGoal 装配点（用户自著资源；**置顶**以避开既有 deps 切片扫描范围，见 MEMORY 教训） */
export function buildCareerGoalsHandlerDeps(): CareerGoalsHandlerDeps {
  return {
    auth: authService,
    careerGoals: repositories.careerGoals,
  };
}

export async function buildAgentRunsHandlerDeps(user: { id: string }): Promise<AgentRunsHandlerDeps> {
  const tools = createAgentReadToolLayer({
    resumes: repositories.resumes,
    jds: repositories.jds,
    matches: {
      ...repositories.matches,
      findLatestRunIdForUser: async () => {
        throw new Error('AGENT_V1_LATEST_MATCH_RESOLVER_MUST_NOT_BE_CALLED');
      },
    },
    capabilities: repositories.capabilities,
    projectResults: repositories.projectResults,
    actionPlans: repositories.actionPlans,
    learningTasks: repositories.learningTasks,
    portfolioProjects: repositories.portfolioProjects,
    rag: repositories.ragRetrieval,
  });
  return {
    auth: authService,
    provider: await providerFor(user.id),
    runs: repositories.agentRuns,
    clock: systemClock,
    runtime: createAgentPlanRuntime({
      tools,
      runs: repositories.agentRuns,
      usage: repositories.llmUsage,
      clock: systemClock,
    }),
  };
}

/**
 * 每次请求构建。provider 解析顺序（Implementation 授权 2026-09-21 §七）：
 * 先认证 userId → 再构建 deps → `providerFor(userId)`：
 * 用户自有 Key（override）→ 否则回落 `providerFromEnv()` 等价路径（T5B-F-08 不变）。
 */
export async function buildJdsHandlerDeps(user: { id: string }): Promise<JdsHandlerDeps> {
  return {
    auth: authService,
    provider: await providerFor(user.id),
    jdRepo: repositories.jds,
    llmCounter,
  };
}

export function buildResumeItemsHandlerDeps(): ResumeItemsHandlerDeps {
  return { auth: authService, resumes: repositories.resumes, capabilities: repositories.capabilities };
}

export async function buildResumesHandlerDeps(user: { id: string }): Promise<ResumesHandlerDeps> {
  return {
    auth: authService,
    resumes: repositories.resumes,
    parse: createResumeParser(await providerFor(user.id)),
  };
}

export function buildResumeReadHandlerDeps(): { auth: AuthService; resumes: ResumeRepository } {
  return { auth: authService, resumes: repositories.resumes };
}

export function buildJdListHandlerDeps(): { auth: AuthService; jdRepo: JdRepository } {
  return { auth: authService, jdRepo: repositories.jds };
}

export function buildCapabilitiesHandlerDeps(): { auth: AuthService; capabilities: CapabilityRepository } {
  return { auth: authService, capabilities: repositories.capabilities };
}

export function buildApplicationsHandlerDeps(): ApplicationsHandlerDeps {
  return {
    auth: authService,
    applications: repositories.applications,
    jdRepo: repositories.jds,
    careerGoals: repositories.careerGoals,
    resumeVersions: repositories.resumeVersions,
  };
}

export function buildResumeVersionsHandlerDeps(): ResumeVersionsHandlerDeps {
  return {
    auth: authService,
    resumeFacts: repositories.resumeFacts,
    resumeVersions: repositories.resumeVersions,
    jdRepo: repositories.jds,
  };
}

export async function buildSuggestionsHandlerDeps(user: { id: string }): Promise<SuggestionsHandlerDeps> {
  const provider = await providerFor(user.id);
  return {
    auth: authService,
    matchRepo: repositories.matches,
    resumeEntries: repositories.resumeEntries,
    resumeFacts: repositories.resumeFacts,
    suggestions: repositories.suggestions,
    rephrase: createRephrasePort(provider),
    llmCounter,
  };
}

export async function buildMatchesHandlerDeps(user: { id: string }): Promise<MatchesHandlerDeps> {
  const provider = await providerFor(user.id);
  return {
    auth: authService,
    resumeFacts: repositories.resumeFacts,
    jdRepo: repositories.jds,
    matchRepo: repositories.matches,
    semantic: createSemanticMatcher(provider),
    llmCounter,
  };
}

export async function buildActionPlansHandlerDeps(user: { id: string }): Promise<ActionPlansHandlerDeps> {
  return {
    auth: authService,
    provider: await providerFor(user.id),
    matchRepo: repositories.matches,
    capabilities: repositories.capabilities,
    jdRepo: repositories.jds,
    actionPlans: repositories.actionPlans,
    usage: repositories.llmUsage,
    clock: systemClock,
  };
}

export function buildProjectResultsHandlerDeps(): ProjectResultsHandlerDeps {
  return {
    auth: authService,
    actionPlans: repositories.actionPlans,
    projectResults: repositories.projectResults,
    capabilities: repositories.capabilities,
    clock: systemClock,
  };
}

/**
 * T3-A2-2：AI 分析**独立**装配点。
 *
 * ⚠️ 刻意与 `buildProjectResultsHandlerDeps` 分离：
 *  - 本 deps 含 `provider`，但**不含**任何 Capability / Skill 写仓储；
 *  - A2-1 的 deps **不得**加入 provider（其冻结测试断言 `'provider' in deps === false`）。
 */
export async function buildProjectAiAnalysisHandlerDeps(user: { id: string }): Promise<ProjectAiAnalysisHandlerDeps> {
  return {
    auth: authService,
    provider: await providerFor(user.id),
    projectResults: repositories.projectResults,
    usage: repositories.llmUsage,
    clock: systemClock,
  };
}

/**
 * Project V2 Phase 0：项目执行指导装配点（独立 LLM Deps）。
 * 与 `buildProjectAiAnalysisHandlerDeps` 同构：含 provider + usage（quota gate），
 * **不含**任何写仓储（actionPlans 仅作只读 ownership 查询）。
 */
export async function buildProjectGuideHandlerDeps(user: { id: string }): Promise<ProjectGuideHandlerDeps> {
  return {
    auth: authService,
    provider: await providerFor(user.id),
    actionPlans: repositories.actionPlans,
    usage: repositories.llmUsage,
    clock: systemClock,
  };
}

/**
 * T4-5：Interview 装配点（独立 LLM Deps）。
 * 含 provider + usage（quota gate），但**不含** Capability / CapabilityEvidence /
 * Skill / ProjectResult / Resume / Evidence 写仓储 —— 事实层零写权限（ADR-015 §9）。
 */
export async function buildInterviewHandlerDeps(user: { id: string }): Promise<InterviewHandlerDeps> {
  return {
    auth: authService,
    interviews: repositories.interviews,
    // Interview V2-A（D-1）：只读 user-scoped JD 原文读取（JD grounding）；
    // 仍不含任何事实写仓储（ADR-015 §9 不变）。
    jdTexts: repositories.jds,
    provider: await providerFor(user.id),
    usage: repositories.llmUsage,
    clock: systemClock,
  };
}

/**
 * T3-A2-6：LearningTask 装配点（**零 LLM / 零 provider**）。
 * 刻意不含 provider —— LearningTask 不启用 LEARNING 槽位、不调用真实 LLM（D-10 caller=0）。
 */
export function buildLearningTasksHandlerDeps(): LearningTasksHandlerDeps {
  return {
    auth: authService,
    actionPlans: repositories.actionPlans,
    learningTasks: repositories.learningTasks,
    clock: systemClock,
  };
}

/**
 * T4-2：Portfolio 装配点（**零 LLM / 零 provider / 零 capabilities / 零 skills / 零 projectResults 写**）。
 * 刻意不含 provider —— T4 第一阶段 PORTFOLIO LLM caller = 0。
 * 不含 Capability/CapabilityEvidence/Resume 写仓储 —— Portfolio 不写事实层（T4-F-34）。
 */
export function buildPortfolioProjectsHandlerDeps(): PortfolioProjectsHandlerDeps {
  return {
    auth: authService,
    portfolioProjects: repositories.portfolioProjects,
    clock: systemClock,
  };
}

/**
 * T5-A：RAG-Lite 装配点（**零 LLM / 零 provider / 零 quota / 零事实层写**）。
 *
 * 刻意不含 provider —— RAG 检索 Provider call count = 0（T5A-F-02 / 裁定 22·23）。
 * 只注入**只读**检索仓储（接口层无写方法，T5A-F-54）；
 * 受控 ingest 写仓储 **不注入**（v1 无 HTTP ingest，T5A-F-61）。
 */
export function buildRagHandlerDeps(): RagHandlerDeps {
  return {
    auth: authService,
    rag: repositories.ragRetrieval,
  };
}

/**
 * T6-3-C：Dashboard 装配点（**零 LLM / 零 provider / 零 quota / 零事实层写 / 零 Agent**）。
 *
 * 纯 FACT 聚合（授权书 §四/§十三）：aiAdvice 恒 null —— 不调 Runtime / Provider /
 * 不创建 AgentRun / 不消耗 quota。只注入只读聚合所需的最小仓储：
 * CareerGoalRepository + ApplicationRepository（funnel/goalScoped/activity/reminder 复用
 * countStagesForUser / listForUser，不新增查询层）。
 */
export function buildDashboardHandlerDeps(): DashboardHandlerDeps {
  return {
    auth: authService,
    careerGoals: repositories.careerGoals,
    applications: repositories.applications,
    // Interview V2-A（§五）：只读 Interview 统计（listForUser 派生 count）
    interviews: repositories.interviews,
    clock: systemClock,
  };
}


/**
 * T6-4-A：Act Confirm / Execute / Result 装配点。
 * 零 LLM / 零 provider：Act 全链路不调用模型、不消耗 quota；
 * 业务写入口全部来自既有 repositories（Fact Authority 不变）。
 */
export function buildAgentActionsHandlerDeps(): AgentActionsHandlerDeps {
  return {
    auth: authService,
    runs: repositories.agentRuns,
    agentActions: repositories.agentActions,
    careerGoals: repositories.careerGoals,
    applications: repositories.applications,
    learningTasks: repositories.learningTasks,
    jds: repositories.jds,
    resumeVersions: repositories.resumeVersions,
    actionPlans: repositories.actionPlans,
  };
}
