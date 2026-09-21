import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type {
  EvidenceSource as PrismaEvidenceSource,
  FactStatus as PrismaFactStatus,
  PrismaClient,
  ResultArtifactKind,
} from '@prisma/client';
import { normalizeForMatch } from '../domain/jd/preprocess.ts';
import {
  evaluateProjectResultEligibility,
  normalizeDescription,
} from '../domain/portfolio/portfolio.ts';
import { inferTurnState, isSameAnswer, MAX_INTERVIEW_TURNS } from '../domain/interview/interview.ts';
import { CAREER_GOAL_STATUS, isCurrentCompatible } from '../domain/career-goal/career-goal.ts';
import {
  evaluateAgentRunTransition,
  isAgentRunStatus,
  resolveAgentRunEndedAt,
} from '../domain/agent/agent-run.ts';
import type { ResumeCreateInput, ResumeRepository } from '../ports/index.ts';
import type {
  CareerGoalCreateInput,
  CareerGoalCreateOutcome,
  CareerGoalCurrentOutcome,
  CareerGoalRecord,
  CareerGoalRepository,
  CareerGoalUpdateInput,
  CareerGoalUpdateOutcome,
} from '../ports/index.ts';
import type { ApplicationRecord } from '../domain/application/types.ts';
import type {
  ApplicationRepository,
  CapabilityDetail,
  CapabilityRepository,
  JdListItem,
  JdRecord,
  JdRepository,
  JdWithRequirements,
  LlmUsageRepository,
  LlmSecretRepository,
  LlmSecretRecord,
  ActionPlanRepository,
  ActionPlanRecord,
  ActionStepRecord,
  ActionPlanCreateInput,
  ActionStepInput,
  MatchRepository,
  MatchRunRecord,
  MatchRunWithItems,
  ResumeDetail,
  ResumeEntriesRepository,
  ResumeFactsRepository,
  ResumeItemView,
  ResumeListItem,
  ResumeVersionRecord,
  ResumeVersionRepository,
  SessionRecord,
  SuggestionRepository,
  SessionRepository,
  UserRecord,
  UserRepository,
  ProjectResultRepository,
  ProjectResultRecord,
  ProjectResultListItem,
  ResultArtifactRecord,
  DeclareProjectEvidenceInput,
  DeclareProjectEvidenceOutcome,
  ConfirmCapabilityOutcome,
  LearningTaskRepository,
  LearningTaskRecord,
  LearningTaskCreateInput,
  LearningTaskCreateOutcome,
  LearningTaskUpdateInput,
  LearningTaskUpdateOutcome,
  LearningTaskArchiveOutcome,
  PortfolioProjectRepository,
  PortfolioProjectRecord,
  PortfolioMemberRecord,
  PortfolioProjectDetail,
  PortfolioProjectCreateInput,
  PortfolioProjectUpdateInput,
  PortfolioProjectAddResultInput,
  PortfolioProjectCreateOutcome,
  PortfolioProjectUpdateOutcome,
  PortfolioProjectArchiveOutcome,
  PortfolioProjectAddResultOutcome,
  PortfolioProjectRemoveResultOutcome,
  InterviewRepository,
  InterviewSessionRecord,
  InterviewTurnRecord,
  InterviewSessionDetail,
  InterviewCreateSessionInput,
  InterviewCreateSessionOutcome,
  InterviewEndOutcome,
  InterviewCreateTurnOutcome,
  InterviewCheckTurnOutcome,
  InterviewSaveAnswerOutcome,
  InterviewSaveAnswerInput,
  InterviewCommitFeedbackOutcome,
  InterviewCommitFeedbackInput,
  RagRetrievalRepository,
  RagRetrievalHit,
  RagRetrievalQuery,
  RagRetrievalResult,
  KnowledgeSourceSummary,
  KnowledgeIngestRepository,
  KnowledgeSourceWriteInput,
  KnowledgeDocumentWriteInput,
  KnowledgeIngestOutcome,
  AgentRunRepository,
  AgentActionRepository,
  AgentRunRecord,
  AgentProposalRecord,
  AgentRunCreateInput,
  AgentRunTransitionOutcome,
  AgentProposalCreateInput,
  AgentPlanCommitInput,
  AgentPlanCommitOutcome,
  AgentProposalCreateOutcome,
} from '../ports/index.ts';
import type { ResumeSection } from '../domain/resume/types.ts';
import { LLM_USAGE_STATUS } from '../ports/index.ts';
import type { ApplicationCounts } from '../domain/application/types.ts';
import type { JobDescriptionCreateInput } from '../domain/jd/persistence.ts';
import type { MatchRunCreateInput } from '../domain/match/persistence.ts';
import type { MatchItemOutput } from '../domain/match/types.ts';
import { buildFactsFromResume } from './facts.ts';
import { buildResumeEntries, parseTargetField } from './entries.ts';
import {
  buildCapabilityProjection,
  evidenceKey,
  PROJECTION_EVIDENCE_TYPE,
  PROJECT_RESULT_EVIDENCE_TYPE,
  PROJECT_RESULT_SOURCE,
} from '../domain/capability/project.ts';
import {
  computeArtifactDedupeKey,
  computeContentFingerprint,
  inferStatus,
} from '../domain/project-result/project-result.ts';
import { canDeclareFromStatus, evaluateConfirmGate, isUrlBacked } from '../domain/project-result/return.ts';
/**
 * T3-A2-3：§6.1 canonical key 契约的**唯一**来源。
 * Capability 的每个 writer 都必须在写边界经此归一 + 校验；
 * 禁止改用 `normalizeForMatch` / `normalizeFingerprintText`，禁止自行实现归一化。
 */
import { validateCapabilityKey } from '../domain/capability/key.ts';
import { isLearningTaskStatus, evaluateLearningTaskTransition } from '../domain/learning-task/learning-task.ts';
import { appError, ERROR_CODE } from '../errors.ts';

type JdRow = {
  id: string;
  userId: string;
  title: string | null;
  company: string | null;
  reqs: Array<{ id: string }>;
};

function toJdRecord(row: JdRow): JdRecord {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    company: row.company,
    requirementCount: row.reqs.length,
  };
}

/**
 * T5-B-2B / D-4 —— 事务内**不变量守卫**异常。
 *
 * `commitPlanOutcome` 的事务体在**状态更新语句已经执行之后**，若仍发现「不应继续」的情形，
 * **必须抛出**而不能 `return`：从事务回调正常 return 会**提交**已经发生的更新，
 * 从而留下「`PROPOSED` 无 proposal」之类的**半提交**状态；抛出才能让整个事务真正回滚。
 *
 * 可达的非提交路径（并发取消 / 状态已终态）一律在**写之前**判定并返回 `CONFLICT`，
 * 因此本异常只在事务内不变量被破坏时出现（构造上不可达）。
 */
class AgentPlanCommitInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentPlanCommitInvariantError';
  }
}

export type Repositories = {
  careerGoals: CareerGoalRepository;
  users: UserRepository;
  sessions: SessionRepository;
  /** Migration #19：用户自带 LLM API Key 密文（单用户单 Key；明文永不出服务端） */
  llmSecrets: LlmSecretRepository;
  jds: JdRepository;
  resumeFacts: ResumeFactsRepository;
  matches: MatchRepository;
  resumeEntries: ResumeEntriesRepository;
  suggestions: SuggestionRepository;
  resumeVersions: ResumeVersionRepository;
  applications: ApplicationRepository;
  resumes: ResumeRepository;
  capabilities: CapabilityRepository;
  llmUsage: LlmUsageRepository;
  actionPlans: ActionPlanRepository;
  projectResults: ProjectResultRepository;
  learningTasks: LearningTaskRepository;
  portfolioProjects: PortfolioProjectRepository;
  interviews: InterviewRepository;
  /** T5-A：检索**只读**仓储（接口层无任何写方法，T5A-F-54） */
  ragRetrieval: RagRetrievalRepository;
  /** T5-A：受控 ingest 写仓储（**仅脚本/fixture**使用，无 HTTP 入口，T5A-F-61） */
  knowledgeIngest: KnowledgeIngestRepository;
  /** T5-B-1：Agent 持久化仓储（仅持久化 + 归属隔离；零 API / 零 Tool / 零 LLM） */
  agentRuns: AgentRunRepository;
  /** T6-4-A：Act 执行实体仓储（状态机 + 幂等；ownership 一律 userId 谓词） */
  agentActions: AgentActionRepository;
};


const MATCH_ITEM_SELECT = {
  requirementId: true,
  reqText: true,
  status: true,
  category: true,
  criticality: true,
  reason: true,
  basisType: true,
  basisDetail: true,
  resumeEvidence: true,
  evidenceRefs: true,
  isInference: true,
  needsUserConfirmation: true,
  confidence: true,
  suggestion: true,
} as const;

type MatchItemRow = {
  requirementId: string | null;
  reqText: string;
  status: string;
  category: string;
  criticality: string;
  reason: string;
  basisType: string;
  basisDetail: string;
  resumeEvidence: string | null;
  evidenceRefs: unknown;
  isInference: boolean;
  needsUserConfirmation: boolean;
  confidence: string;
  suggestion: string | null;
};

function toMatchItemOutput(row: MatchItemRow): MatchItemOutput {
  return {
    requirementId: row.requirementId,
    requirement: row.reqText,
    category: row.category as MatchItemOutput['category'],
    criticality: row.criticality as MatchItemOutput['criticality'],
    status: row.status as MatchItemOutput['status'],
    reason: row.reason,
    basis: { type: row.basisType as MatchItemOutput['basis']['type'], detail: row.basisDetail },
    evidenceRefs: (row.evidenceRefs ?? []) as MatchItemOutput['evidenceRefs'],
    resumeEvidence: row.resumeEvidence,
    isInference: row.isInference,
    needsUserConfirmation: row.needsUserConfirmation,
    confidence: row.confidence as MatchItemOutput['confidence'],
    suggestion: row.suggestion,
  };
}

export function createPrismaRepositories(client: PrismaClient): Repositories {
  const users: UserRepository = {
    async findByEmail(email) {
      const row = await client.user.findUnique({ where: { email } });
      return row ? (row as UserRecord) : null;
    },
    async findById(id) {
      const row = await client.user.findUnique({ where: { id } });
      return row ? (row as UserRecord) : null;
    },
    async create(input) {
      const row = await client.user.create({
        data: {
          email: input.email,
          passwordHash: input.passwordHash,
          displayName: input.displayName ?? null,
        },
      });
      return row as UserRecord;
    },
    async updateAvatarUrl(id, avatarUrl) {
      // 仅更新单列 avatarUrl；归属由调用方传入服务端 session 推导的 id（不接受 body 的 id）
      const row = await client.user.update({ where: { id }, data: { avatarUrl } });
      return row as UserRecord;
    },
  };

  const llmSecrets: LlmSecretRepository = {
    async findForUser(userId) {
      const row = await client.user.findUnique({
        where: { id: userId },
        select: { llmApiKeyCipher: true, llmApiKeyLast4: true },
      });
      if (!row || row.llmApiKeyCipher === null || row.llmApiKeyLast4 === null) return null;
      return { cipher: row.llmApiKeyCipher, last4: row.llmApiKeyLast4 } satisfies LlmSecretRecord;
    },
    async saveForUser(userId, input) {
      // 单条 UPDATE 同时覆盖两列（原子）：写失败即整体失败，旧 Key 保持不变
      await client.user.update({
        where: { id: userId },
        data: { llmApiKeyCipher: input.cipher, llmApiKeyLast4: input.last4 },
      });
    },
    async deleteForUser(userId) {
      await client.user.update({
        where: { id: userId },
        data: { llmApiKeyCipher: null, llmApiKeyLast4: null },
      });
    },
  };

  const sessions: SessionRepository = {
    async create(input) {
      const row = await client.session.create({
        data: { userId: input.userId, tokenHash: input.tokenHash, expiresAt: input.expiresAt },
      });
      return { id: row.id, userId: row.userId, expiresAt: row.expiresAt } as SessionRecord;
    },
    async findByTokenHash(tokenHash) {
      const row = await client.session.findUnique({ where: { tokenHash } });
      return row ? ({ id: row.id, userId: row.userId, expiresAt: row.expiresAt } as SessionRecord) : null;
    },
    async deleteByTokenHash(tokenHash) {
      await client.session.deleteMany({ where: { tokenHash } });
    },
    async deleteExpired(now) {
      const res = await client.session.deleteMany({ where: { expiresAt: { lte: now } } });
      return res.count;
    },
  };

  const jds: JdRepository = {
    // JD 与其要求条目必须原子写入：要么全成功，要么全不写（不产生半成品）
    async createWithRequirements(input: JobDescriptionCreateInput) {
      const created = await client.$transaction(async (tx) =>
        tx.jobDescription.create({
          data: {
            userId: input.userId,
            rawText: input.rawText,
            title: input.title,
            company: input.company,
            contentHash: input.contentHash ?? null,
            reqs: { create: input.reqs.create },
          },
          select: { id: true, userId: true, title: true, company: true, reqs: { select: { id: true } } },
        }),
      );
      return toJdRecord(created);
    },

    // 数据隔离：查询强制带 userId；非本人数据等同于不存在
    async findByIdForUser(id, userId) {
      const row = await client.jobDescription.findFirst({
        where: { id, userId },
        select: { id: true, userId: true, title: true, company: true, reqs: { select: { id: true } } },
      });
      return row ? toJdRecord(row) : null;
    },

    async findByContentHash(userId, contentHash) {
      const row = await client.jobDescription.findFirst({
        where: { userId, contentHash },
        select: { id: true, userId: true, title: true, company: true, reqs: { select: { id: true } } },
      });
      return row ? toJdRecord(row) : null;
    },

    // T4：带要求条目读取。同样强制 userId，非本人 JD 返回 null
    async findByIdForUserWithRequirements(id, userId) {
      const row = await client.jobDescription.findFirst({
        where: { id, userId },
        select: {
          id: true,
          userId: true,
          reqs: { select: { id: true, text: true, category: true, criticality: true } },
        },
      });
      return row ? ({ id: row.id, userId: row.userId, requirements: row.reqs } as JdWithRequirements)         : null;
    },

    // 前端列表/下拉：仅本人数据，倒序。复用 JD_SELECT 同款投影。
    async listForUser(userId) {
      const rows = await client.jobDescription.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, title: true, company: true, createdAt: true, reqs: { select: { id: true } } },
      });
      return rows.map((r): JdListItem => ({
        id: r.id,
        title: r.title,
        company: r.company,
        requirementCount: r.reqs.length,
        createdAt: r.createdAt,
      }));
    },

    // Interview V2-A（D-1）：只读、user-scoped 的 JD 原文读取。
    // 非本人 / 不存在 → null（调用方以 null = prompt 无 JD；跨用户 JD 绝不进入 prompt）。
    async findRawTextForUser(id, userId) {
      const row = await client.jobDescription.findFirst({
        where: { id, userId },
        select: { rawText: true },
      });
      return row ? row.rawText : null;
    },

    // 仅更新 title；userId 谓词保证归属，非本人 / 不存在不写入。
    async updateTitle(id, userId, title) {
      const owned = await client.jobDescription.findFirst({
        where: { id, userId },
        select: { id: true, reqs: { select: { id: true } } },
      });
      if (!owned) return null;
      const updated = await client.jobDescription.update({
        where: { id },
        data: { title },
        select: { id: true, userId: true, title: true, company: true, reqs: { select: { id: true } } },
      });
      return toJdRecord(updated);
    },

  };

  const resumeFacts: ResumeFactsRepository = {
    // 数据隔离：查询强制带 userId；非本人简历返回 null（API 层映射为 404）
    async findFactsForResume(resumeId, userId) {
      const row = await client.resume.findFirst({
        where: { id: resumeId, userId },
        select: {
          skills: {
            select: {
              key: true,
              label: true,
              status: true,
              evidence: { select: { source: true, locator: true, excerpt: true } },
            },
          },
          resumeProjects: {
            select: {
              name: true,
              role: true,
              status: true,
              evidence: { select: { source: true, locator: true, excerpt: true } },
            },
          },
          educations: {
            select: {
              school: true,
              major: true,
              status: true,
              evidence: { select: { source: true, locator: true, excerpt: true } },
            },
          },
          experiences: {
            select: {
              org: true,
              title: true,
              status: true,
              evidence: { select: { source: true, locator: true, excerpt: true } },
            },
          },
        },
      });
      return row ? buildFactsFromResume(row) : null;
    },
  };

  const matches: MatchRepository = {
    // 原子写入：MatchRun 与其全部 MatchItem 在同一事务内完成，杜绝半成品
    async createRunWithItems(input: MatchRunCreateInput) {
      const created = await client.$transaction(async (tx) =>
        tx.matchRun.create({
          data: {
            userId: input.userId,
            resumeId: input.resumeId,
            jdId: input.jdId,
            matcherVersion: input.matcherVersion,
            summary: input.summary as unknown as Prisma.InputJsonValue,
            items: {
              create: input.items.create.map((item) => ({
                requirementId: item.requirementId,
                reqText: item.reqText,
                status: item.status,
                category: item.category,
                criticality: item.criticality,
                reason: item.reason,
                basisType: item.basisType,
                basisDetail: item.basisDetail,
                resumeEvidence: item.resumeEvidence,
                evidenceRefs: item.evidenceRefs as Prisma.InputJsonValue,
                isInference: item.isInference,
                needsUserConfirmation: item.needsUserConfirmation,
                confidence: item.confidence,
                suggestion: item.suggestion,
              })),
            },
          },
          select: {
            id: true,
            userId: true,
            resumeId: true,
            jdId: true,
            summary: true,
            createdAt: true,
            items: { select: { id: true } },
          },
        }),
      );
      const record: MatchRunRecord = {
        id: created.id,
        userId: created.userId,
        resumeId: created.resumeId,
        jdId: created.jdId,
        itemCount: created.items.length,
        summary: created.summary,
        createdAt: created.createdAt,
      };
      return record;
    },

    async findRunForUser(runId, userId) {
      const row = await client.matchRun.findFirst({
        where: { id: runId, userId },
        select: {
          id: true,
          userId: true,
          resumeId: true,
          jdId: true,
          summary: true,
          createdAt: true,
          items: { select: { id: true } },
        },
      });
      return row
        ? {
            id: row.id,
            userId: row.userId,
            resumeId: row.resumeId,
            jdId: row.jdId,
            itemCount: row.items.length,
            summary: row.summary,
            createdAt: row.createdAt,
          }
        : null;
    },

    // T6 输入：一次 run 的全部 MatchItem
    async findRunWithItemsForUser(runId, userId): Promise<MatchRunWithItems | null> {
      const row = await client.matchRun.findFirst({
        where: { id: runId, userId },
        select: {
          id: true,
          userId: true,
          resumeId: true,
          jdId: true,
          summary: true,
          items: { select: MATCH_ITEM_SELECT },
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        userId: row.userId,
        resumeId: row.resumeId,
        jdId: row.jdId,
        summary: row.summary as MatchRunWithItems['summary'],
        items: row.items.map((i) => toMatchItemOutput(i as MatchItemRow)),
      };
    },
  };

  const resumeEntries: ResumeEntriesRepository = {
    async findEntriesForResume(resumeId, userId) {
      const row = await client.resume.findFirst({
        where: { id: resumeId, userId },
        select: {
          skills: {
            select: {
              id: true,
              label: true,
              level: true,
              status: true,
              evidence: { select: { source: true, locator: true, excerpt: true } },
            },
          },
          resumeProjects: {
            select: {
              id: true,
              name: true,
              outcome: true,
              status: true,
              evidence: { select: { source: true, locator: true, excerpt: true } },
            },
          },
        },
      });
      return row ? buildResumeEntries(row) : null;
    },
  };

  const suggestions: SuggestionRepository = {
    async createMany(inputs) {
      const created = await client.$transaction(async (tx) =>
        Promise.all(
          inputs.map((input) =>
            tx.resumeSuggestion.create({
              data: {
                resumeId: input.resumeId,
                matchRunId: input.matchRunId,
                matchItemRef: input.matchItemRef,
                requirement: input.requirement,
                kind: input.kind,
                targetField: input.targetField,
                before: input.before,
                after: input.after,
                reason: input.reason,
                verdict: input.verdict,
                verdictReason: input.verdictReason,
                evidenceRefs: input.evidenceRefs as Prisma.InputJsonValue,
              },
              select: { id: true, kind: true },
            }),
          ),
        ),
      );
      return created;
    },

    async findForUser(id, userId) {
      const row = await client.resumeSuggestion.findFirst({
        where: { id, resume: { userId } },
        select: {
          id: true,
          resumeId: true,
          kind: true,
          targetField: true,
          before: true,
          after: true,
          status: true,
          resume: { select: { userId: true } },
        },
      });
      return row
        ? {
            id: row.id,
            resumeId: row.resumeId,
            userId: row.resume.userId,
            kind: row.kind,
            targetField: row.targetField,
            before: row.before,
            after: row.after,
            status: row.status,
          }
        : null;
    },

    async updateStatus(id, status) {
      await client.resumeSuggestion.updateMany({ where: { id }, data: { status } });
    },

    // 只支持 Skill.level 与 ResumeProject.outcome 两个目标字段，且强制 userId 归属
    async applyTextChange(resumeId, userId, targetField, text) {
      const target = parseTargetField(targetField);
      if (!target) return false;

      if (target.model === 'Skill' && target.field === 'level') {
        const res = await client.skill.updateMany({
          where: { id: target.id, resumeId, resume: { userId } },
          data: { level: text },
        });
        return res.count > 0;
      }

      if (target.model === 'ResumeProject' && target.field === 'outcome') {
        const res = await client.resumeProject.updateMany({
          where: { id: target.id, resumeId, resume: { userId } },
          data: { outcome: text },
        });
        return res.count > 0;
      }

      return false;
    },
  };

  const resumeVersions: ResumeVersionRepository = {
    // 版本号分配与写入在同一事务内完成；[resumeId, versionNo] 唯一约束兜底并发
    async createVersion(input) {
      const created = await client.$transaction(async (tx) => {
        const owner = await tx.resume.findFirst({
          where: { id: input.resumeId, userId: input.userId },
          select: { id: true },
        });
        if (!owner) return null;

        const last = await tx.resumeVersion.findFirst({
          where: { resumeId: input.resumeId },
          orderBy: { versionNo: 'desc' },
          select: { versionNo: true },
        });
        const versionNo = (last?.versionNo ?? 0) + 1;

        const row = await tx.resumeVersion.create({
          data: {
            resumeId: input.resumeId,
            jdId: input.jdId,
            versionNo,
            snapshot: input.buildSnapshot(versionNo) as Prisma.InputJsonValue,
            pdfUrl: null,
          },
          select: { id: true, resumeId: true, versionNo: true, createdAt: true },
        });

        // pdfUrl 由 id 派生，属创建的一部分；快照本身保持不可变
        const pdfUrl = `/api/resumes/${row.resumeId}/versions/${row.id}/pdf`;
        await tx.resumeVersion.update({ where: { id: row.id }, data: { pdfUrl } });

        return { row, pdfUrl };
      });

      if (created === null) return null;
      return {
        id: created.row.id,
        resumeId: created.row.resumeId,
        userId: input.userId,
        versionNo: created.row.versionNo,
        jdId: input.jdId,
        snapshot: input.buildSnapshot(created.row.versionNo),
        pdfUrl: created.pdfUrl,
        createdAt: created.row.createdAt,
      };
    },

    async findForUser(versionId, userId) {
      const row = await client.resumeVersion.findFirst({
        where: { id: versionId, resume: { userId } },
        select: {
          id: true,
          resumeId: true,
          jdId: true,
          versionNo: true,
          snapshot: true,
          pdfUrl: true,
          createdAt: true,
          resume: { select: { userId: true } },
        },
      });
      return row
        ? {
            id: row.id,
            resumeId: row.resumeId,
            userId: row.resume.userId,
            versionNo: row.versionNo,
            jdId: row.jdId,
            snapshot: row.snapshot,
            pdfUrl: row.pdfUrl,
            createdAt: row.createdAt,
          }
        : null;
    },

    async listForResume(resumeId, userId) {
      const rows = await client.resumeVersion.findMany({
        where: { resumeId, resume: { userId } },
        orderBy: { versionNo: 'desc' },
        select: { id: true, resumeId: true, jdId: true, versionNo: true, snapshot: true, pdfUrl: true, createdAt: true },
      });
      return rows.map((r) => ({
        id: r.id,
        resumeId: r.resumeId,
        userId,
        versionNo: r.versionNo,
        jdId: r.jdId,
        snapshot: r.snapshot,
        pdfUrl: r.pdfUrl,
        createdAt: r.createdAt,
      }));
    },
  };

    // ─── T6-2：Application Tracker 仓储（重写 applications 块）──────────────
  // 所有读写强制 userId；筛选与 counts 共用同一 where（计数不受分页影响）；
  // stage 为 String + DB CHECK（Migration #16），不再使用 Prisma enum。

  const APP_SELECT = {
    id: true,
    company: true,
    jdId: true,
    careerGoalId: true,
    resumeVersionId: true,
    position: true,
    appliedAt: true,
    stage: true,
    notes: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  function applicationWhere(
    userId: string,
    filter?: {
      careerGoalId?: string; stage?: string; jdId?: string; company?: string;
      appliedAfter?: Date; appliedBefore?: Date; updatedBefore?: Date; stageNotIn?: string[];
    },
  ) {
    return {
      userId,
      ...(filter?.careerGoalId ? { careerGoalId: filter.careerGoalId } : {}),
      ...(filter?.stage ? { stage: filter.stage } : {}),
      ...(filter?.jdId ? { jdId: filter.jdId } : {}),
      ...(filter?.company ? { company: { contains: filter.company, mode: 'insensitive' as const } } : {}),
      ...(filter?.appliedAfter || filter?.appliedBefore
        ? {
            appliedAt: {
              ...(filter?.appliedAfter ? { gte: filter.appliedAfter } : {}),
              ...(filter?.appliedBefore ? { lte: filter.appliedBefore } : {}),
            },
          }
        : {}),
      ...(filter?.updatedBefore ? { updatedAt: { lt: filter.updatedBefore } } : {}),
      // stageNotIn 与 stage 等值筛选互斥使用（T6-3-C stale 口径排除 REJECTED/WITHDRAWN）
      ...(filter?.stageNotIn && filter.stageNotIn.length > 0 ? { stage: { notIn: filter.stageNotIn } } : {}),
    };
  }

  function toApplicationRecord(row: {
    id: string; company: string; jdId: string | null; careerGoalId: string | null;
    resumeVersionId: string | null; position: string | null; appliedAt: Date;
    stage: string; notes: string | null; createdAt: Date; updatedAt: Date;
  }): ApplicationRecord {
    return {
      id: row.id,
      company: row.company,
      jdId: row.jdId,
      careerGoalId: row.careerGoalId,
      resumeVersionId: row.resumeVersionId,
      position: row.position,
      appliedAt: row.appliedAt,
      stage: row.stage,
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  const applications: ApplicationRepository = {
    async listForUser(userId, query = {}) {
      const where = applicationWhere(userId, query);
      return client.jobApplication.findMany({
        where,
        // T6-3-C：appliedAt DESC + updatedAt DESC 次级稳定排序（授权书 §八）
        orderBy: [{ appliedAt: 'desc' }, { updatedAt: 'desc' }],
        ...(query.limit === undefined ? {} : { take: query.limit }),
        ...(query.offset === undefined ? {} : { skip: query.offset }),
        select: APP_SELECT,
      });
    },

    // 计数走 groupBy 而非当前页，保证 counts 不随分页漂移；筛选条件与列表一致。
    async countStagesForUser(userId, filter) {
      const rows = await client.jobApplication.groupBy({
        by: ['stage'],
        where: applicationWhere(userId, filter),
        _count: { _all: true },
      });
      const counts: ApplicationCounts = {
        total: 0, applied: 0, screening: 0, interviewing: 0, offer: 0, rejected: 0, withdrawn: 0,
      };
      for (const row of rows) {
        const n = row._count._all;
        counts.total += n;
        if (row.stage === 'APPLIED') counts.applied += n;
        else if (row.stage === 'SCREENING') counts.screening += n;
        else if (row.stage === 'INTERVIEWING') counts.interviewing += n;
        else if (row.stage === 'OFFER') counts.offer += n;
        else if (row.stage === 'REJECTED') counts.rejected += n;
        else if (row.stage === 'WITHDRAWN') counts.withdrawn += n;
      }
      return counts;
    },

    async findForUser(id, userId) {
      const row = await client.jobApplication.findFirst({ where: { id, userId }, select: APP_SELECT });
      return row === null ? null : toApplicationRecord(row);
    },

    async create(input) {
      const row = await client.jobApplication.create({
        data: {
          userId: input.userId,
          company: input.company,
          jdId: input.jdId,
          careerGoalId: input.careerGoalId,
          resumeVersionId: input.resumeVersionId,
          position: input.position,
          appliedAt: input.appliedAt,
          stage: input.stage,
          notes: input.notes,
        },
        select: APP_SELECT,
      });
      return toApplicationRecord(row);
    },

    // updateMany：where 带 userId，跨用户天然不命中
    async update(id, userId, patch) {
      const res = await client.jobApplication.updateMany({
        where: { id, userId },
        data: {
          ...(patch.stage === undefined ? {} : { stage: patch.stage }),
          ...(patch.company === undefined ? {} : { company: patch.company }),
          ...(patch.notes === undefined ? {} : { notes: patch.notes }),
          ...(patch.position === undefined ? {} : { position: patch.position }),
          ...(patch.jdId === undefined ? {} : { jdId: patch.jdId }),
          ...(patch.careerGoalId === undefined ? {} : { careerGoalId: patch.careerGoalId }),
          ...(patch.resumeVersionId === undefined ? {} : { resumeVersionId: patch.resumeVersionId }),
          ...(patch.appliedAt === undefined ? {} : { appliedAt: patch.appliedAt }),
        },
      });
      if (res.count === 0) return null;
      const row = await client.jobApplication.findFirst({ where: { id, userId }, select: APP_SELECT });
      return row === null ? null : toApplicationRecord(row);
    },
  };


  const resumes: ResumeRepository = {
    // 事务边界：Resume + 四类条目 + Evidence 一次嵌套写入，任一步失败整体回滚
    async createWithItems(input) {
      if (!input.userId || input.userId.trim().length === 0) {
        throw new Error('userId 必须来自会话');
      }
      if (input.items.length === 0) {
        throw new Error('拒绝写入：没有任何条目');
      }

      const ev = (i: ResumeCreateInput['items'][number]) => ({
        create: [{ source: i.source as PrismaEvidenceSource, locator: i.locator, excerpt: i.excerpt }],
      });
      const bySection = (s: string) => input.items.filter((i) => i.section === s);

      const created = await client.$transaction(async (tx) =>
        tx.resume.create({
          data: {
            userId: input.userId,
            rawText: input.rawText,
            sourceType: input.sourceType as 'TEXT' | 'PDF' | 'DOCX',
            skills: {
              create: bySection('SKILL').map((i) => ({
                key: normalizeForMatch(i.title),
                label: i.title,
                level: i.detail,
                status: i.status as PrismaFactStatus,
                evidence: ev(i),
              })),
            },
            resumeProjects: {
              create: bySection('PROJECT').map((i) => ({
                name: i.title,
                outcome: i.detail,
                status: i.status as PrismaFactStatus,
                evidence: ev(i),
              })),
            },
            educations: {
              create: bySection('EDUCATION').map((i) => ({
                school: i.title,
                major: i.detail,
                status: i.status as PrismaFactStatus,
                evidence: ev(i),
              })),
            },
            experiences: {
              create: bySection('EXPERIENCE').map((i) => ({
                org: i.title,
                title: i.detail,
                status: i.status as PrismaFactStatus,
                evidence: ev(i),
              })),
            },
          },
          select: {
            id: true,
            skills: { select: { id: true, evidence: { select: { id: true } } } },
            resumeProjects: { select: { id: true, evidence: { select: { id: true } } } },
            educations: { select: { id: true, evidence: { select: { id: true } } } },
            experiences: { select: { id: true, evidence: { select: { id: true } } } },
          },
        }),
      );

      const groups = [created.skills, created.resumeProjects, created.educations, created.experiences];
      const itemCount = groups.reduce((n, g) => n + g.length, 0);
      const evidenceCount = groups.reduce(
        (n, g) => n + g.reduce((m, r) => m + r.evidence.length, 0),
        0,
      );

      return {
        id: created.id,
        itemCount,
        evidenceCount,
        unconfirmedCount: input.items.filter((i) => i.status === 'UNCONFIRMED').length,
        inferredCount: input.items.filter((i) => i.status === 'INFERRED').length,
      };
    },

    async findForUser(resumeId, userId) {
      const row = await client.resume.findFirst({
        where: { id: resumeId, userId },
        select: { id: true, userId: true },
      });
      return row ?? null;
    },

    // 前端「我的简历」列表：仅本人数据 + 四态计数
    async listForUser(userId) {
      const rows = await client.resume.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          sourceType: true,
          createdAt: true,
          skills: { select: { status: true } },
          resumeProjects: { select: { status: true } },
          educations: { select: { status: true } },
          experiences: { select: { status: true } },
        },
      });
      const count = (arr: Array<{ status: string }>, s: string) => arr.filter((x) => x.status === s).length;
      return rows.map((r): ResumeListItem => {
        const all = [...r.skills, ...r.resumeProjects, ...r.educations, ...r.experiences];
        return {
          id: r.id,
          sourceType: r.sourceType,
          createdAt: r.createdAt,
          itemCount: all.length,
          statusSummary: {
            confirmed: count(all, 'CONFIRMED'),
            inferred: count(all, 'INFERRED'),
            unconfirmed: count(all, 'UNCONFIRMED'),
          },
        };
      });
    },

    // 前端「解析确认」详情：条目带 id 与证据，非本人返回 null
    async findDetailForUser(resumeId, userId) {
      const ev = (rows: Array<{ source: string; locator: string; excerpt: string | null }>) =>
        rows.map((e) => ({ source: e.source as ResumeItemView['evidence'][number]['source'], locator: e.locator, excerpt: e.excerpt ?? undefined }));
      const sel = {
        skills: { select: { id: true, label: true, level: true, status: true, evidence: { select: { source: true, locator: true, excerpt: true } } } },
        resumeProjects: { select: { id: true, name: true, outcome: true, status: true, evidence: { select: { source: true, locator: true, excerpt: true } } } },
        educations: { select: { id: true, school: true, major: true, status: true, evidence: { select: { source: true, locator: true, excerpt: true } } } },
        experiences: { select: { id: true, org: true, title: true, status: true, evidence: { select: { source: true, locator: true, excerpt: true } } } },
      } as const;
      const row = await client.resume.findFirst({
        where: { id: resumeId, userId },
        select: { id: true, sourceType: true, createdAt: true, ...sel },
      });
      if (!row) return null;

      const items: ResumeItemView[] = [
        ...row.skills.map((s): ResumeItemView => ({ id: s.id, section: 'SKILL' as ResumeSection, title: s.label, detail: s.level, status: s.status, evidence: ev(s.evidence) })),
        ...row.resumeProjects.map((p): ResumeItemView => ({ id: p.id, section: 'PROJECT' as ResumeSection, title: p.name, detail: p.outcome, status: p.status, evidence: ev(p.evidence) })),
        ...row.educations.map((e): ResumeItemView => ({ id: e.id, section: 'EDUCATION' as ResumeSection, title: e.school, detail: e.major, status: e.status, evidence: ev(e.evidence) })),
        ...row.experiences.map((x): ResumeItemView => ({ id: x.id, section: 'EXPERIENCE' as ResumeSection, title: x.org, detail: x.title, status: x.status, evidence: ev(x.evidence) })),
      ];

      return { id: row.id, sourceType: row.sourceType, createdAt: row.createdAt, items };
    },

    // 人工确认：UNCONFIRMED / INFERRED → CONFIRMED，且必须有完整 Evidence
    async confirmItem(resumeId, userId, kind, itemId) {
      type Row = { id: string; status: string; evidence: Array<{ locator: string; excerpt: string | null }> };
      const sel = { id: true, status: true, evidence: { select: { locator: true, excerpt: true } } };

      const load = async (fn: () => Promise<Row | null>): Promise<Row | null> => fn();
      const find = {
        SKILL: () => client.skill.findFirst({ where: { id: itemId, resumeId, resume: { userId } }, select: sel }),
        PROJECT: () => client.resumeProject.findFirst({ where: { id: itemId, resumeId, resume: { userId } }, select: sel }),
        EDUCATION: () => client.education.findFirst({ where: { id: itemId, resumeId, resume: { userId } }, select: sel }),
        EXPERIENCE: () => client.experience.findFirst({ where: { id: itemId, resumeId, resume: { userId } }, select: sel }),
      } as const;

      const row = await load(find[kind]);
      if (!row) return 'NOT_FOUND';
      if (row.status === 'CONFIRMED') return 'INVALID_TRANSITION';
      if (row.status !== 'UNCONFIRMED' && row.status !== 'INFERRED') return 'INVALID_TRANSITION';

      const usable = row.evidence.some((r) => r.locator.trim().length > 0 && (r.excerpt ?? '').trim().length > 0);
      if (!usable) return 'NO_EVIDENCE';

      const upd = {
        SKILL: () => client.skill.updateMany({ where: { id: itemId, resumeId, resume: { userId } }, data: { status: 'CONFIRMED' } }),
        PROJECT: () => client.resumeProject.updateMany({ where: { id: itemId, resumeId, resume: { userId } }, data: { status: 'CONFIRMED' } }),
        EDUCATION: () => client.education.updateMany({ where: { id: itemId, resumeId, resume: { userId } }, data: { status: 'CONFIRMED' } }),
        EXPERIENCE: () => client.experience.updateMany({ where: { id: itemId, resumeId, resume: { userId } }, data: { status: 'CONFIRMED' } }),
      } as const;

      await upd[kind]();
      return 'CONFIRMED';
    },
  };

  const capabilities: CapabilityRepository = {
    async listForUser(userId) {
      return client.capability.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, userId: true, key: true, label: true, level: true, status: true, source: true, createdAt: true },
      });
    },

    async findForUser(id, userId) {
      const row = await client.capability.findFirst({
        where: { id, userId },
        select: {
          id: true,
          userId: true,
          key: true,
          label: true,
          level: true,
          status: true,
          source: true,
          createdAt: true,
          evidence: { select: { id: true, type: true, source: true, url: true, excerpt: true } },
        },
      });
      return row ? (row as unknown as CapabilityDetail) : null;
    },

    /**
     * 事实安全铁律：CONFIRMED 的唯一路径。
     *
     * T3-A2-1 / R3 **来源分域**闸门：
     *   - 存在 PROJECT_RESULT_EVIDENCE → 至少一条「artifact.url 非空 且 所属 ProjectResult 未 revoke」
     *   - 不存在 → 沿用既有 Resume 判据「url ∥ excerpt 非空」（与本改动前语义完全一致）
     *
     * 并发（§十九）：锁序统一为 **ProjectResult → Capability**，加锁后**重新计算**闸门，
     * 使「confirm 判定通过 → 成果被 revoke → 仍写 CONFIRMED」不可能发生。
     */
    async confirm(id, userId): Promise<ConfirmCapabilityOutcome> {
      return client.$transaction(async (tx): Promise<ConfirmCapabilityOutcome> => {
        // 1) 先探明 PROJECT_RESULT_EVIDENCE 指向哪些成果（不加锁，仅用于确定锁目标）
        const pointing = await tx.capabilityEvidence.findMany({
          where: { capabilityId: id, type: PROJECT_RESULT_EVIDENCE_TYPE },
          select: { resultArtifact: { select: { resultId: true } } },
        });
        const resultIds = [
          ...new Set(
            pointing.map((e) => e.resultArtifact?.resultId).filter((v): v is string => typeof v === 'string'),
          ),
        ].sort();

        // 2) 锁序：ProjectResult（id 升序）→ Capability
        for (const rid of resultIds) {
          await tx.$queryRaw`SELECT 1 FROM "ProjectResult" WHERE id = ${rid} FOR UPDATE`;
        }
        await tx.$queryRaw`SELECT 1 FROM "Capability" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;

        // 3) 加锁后重新读取，闸门实时计算
        const row = await tx.capability.findFirst({
          where: { id, userId },
          select: {
            id: true,
            evidence: {
              select: {
                type: true,
                url: true,
                excerpt: true,
                resultArtifact: { select: { url: true, result: { select: { revokedAt: true } } } },
              },
            },
          },
        });
        if (!row) return 'NOT_FOUND';

        const gate = row.evidence.map((e) => ({
          type: e.type,
          url: e.url,
          excerpt: e.excerpt,
          artifactUrl: e.resultArtifact?.url ?? null,
          resultRevokedAt: e.resultArtifact?.result?.revokedAt ?? null,
        }));
        if (!evaluateConfirmGate(gate)) return 'NO_EVIDENCE';

        await tx.capability.updateMany({ where: { id, userId }, data: { status: 'CONFIRMED' } });
        return 'CONFIRMED';
      });
    },

    /**
     * T3-A2-1：确定性回流（ProjectResult → Candidate Capability）。
     *
     * **M6 不变式**：新 Capability 只在**不存在**时创建（`UNCONFIRMED` + `source=PROJECT_RESULT`）；
     * 已存在的 Capability **只读** —— 本方法对其**根本不执行 UPDATE**，
     * 因此不可能降级已有 CONFIRMED，也不可能覆盖已有 level / source。
     *
     * **并发**：Capability 用 raw `ON CONFLICT ("userId", key) DO NOTHING`（避免 P2002 中止事务）；
     * Evidence 由 partial unique index + **带谓词**的 `ON CONFLICT`（§十七）兜底。
     * 本方法**不新增**任何锁 / 事务 / 隔离级别（沿用 ProjectResult FOR UPDATE 与唯一约束）。
     *
     * **T3-A2-3 契约收紧（ChatGPT 批准的 A2-3 范围）**：
     * - 入参 `key` 由 A2-1 的「非空字符串」收紧为「**可归一为合法 canonical key**」。
     * - 写边界强制调用 `validateCapabilityKey`（§6.1 唯一来源）；不合法 → `INVALID_KEY` 且零写入。
     * - 归一化后 `Docker` / `DOCKER` / ` Docker ` 收敛为同一行 `docker`。
     *
     * **零 LLM**：不接触任何 provider。
     */
    async declareFromProjectArtifact(
      input: DeclareProjectEvidenceInput,
    ): Promise<DeclareProjectEvidenceOutcome> {
      const { userId, resultId, artifactId, key, label } = input;

      return client.$transaction(async (tx): Promise<DeclareProjectEvidenceOutcome> => {
        // ① 归属校验 + 锁定；跨用户 / 不存在一律 NOT_FOUND（不泄露存在性）
        const owned = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "ProjectResult" WHERE id = ${resultId} AND "userId" = ${userId} FOR UPDATE`;
        if (owned.length === 0) return { kind: 'NOT_FOUND' };

        // ② 状态必须允许：仅 SUBMITTED
        const result = await tx.projectResult.findUnique({
          where: { id: resultId },
          select: { submittedAt: true, revokedAt: true },
        });
        if (!result) return { kind: 'NOT_FOUND' };
        if (!canDeclareFromStatus(inferStatus({ submittedAt: result.submittedAt, revokedAt: result.revokedAt }))) {
          return { kind: 'NOT_SUBMITTED' };
        }

        // ③ 凭据必须属于该成果（否则与「不存在」同响应）
        const artifact = await tx.resultArtifact.findFirst({
          where: { id: artifactId, resultId },
          select: { id: true, url: true },
        });
        if (!artifact) return { kind: 'NOT_FOUND' };

        // ④ 凭据必须可验证（非空 URL）；不能仅凭 excerpt
        if (!isUrlBacked(artifact.url)) return { kind: 'ARTIFACT_URL_REQUIRED' };

        // ④.5 T3-A2-3 / §6.1 —— **Capability 写边界强制**：
        //      任何 writer 写入的 key 必须是合法 canonical key。
        //      归一 + 校验一律复用 key.ts（本文件的唯一 §6.1 来源），失败即拒绝且**零写入**。
        const keyCheck = validateCapabilityKey(key);
        if (!keyCheck.ok) return { kind: 'INVALID_KEY', reason: keyCheck.reason };
        const canonicalKey = keyCheck.key;

        // ⑤ Capability(userId, key)：不存在才创建；已存在**只读**
        const readCap = () =>
          tx.capability.findUnique({
            where: { userId_key: { userId, key: canonicalKey } },
            select: { id: true, status: true, source: true },
          });

        await tx.$queryRaw`
          INSERT INTO "Capability" (id, "userId", key, label, level, status, source, "createdAt")
          VALUES (${randomUUID()}, ${userId}, ${canonicalKey}, ${label}, NULL, 'UNCONFIRMED', ${PROJECT_RESULT_SOURCE}, NOW())
          ON CONFLICT ("userId", key) DO NOTHING`;
        const capability = await readCap();
        if (!capability) throw new Error('Capability ON CONFLICT 后仍找不到行');

        // ⑥ Evidence：唯一身份 (capabilityId, resultArtifactId)，partial index 兜底并发
        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "CapabilityEvidence" (id, "capabilityId", type, source, url, excerpt, "resultArtifactId", "createdAt")
          VALUES (${randomUUID()}, ${capability.id}, ${PROJECT_RESULT_EVIDENCE_TYPE}, ${PROJECT_RESULT_SOURCE}, ${artifact.url}, NULL, ${artifactId}, NOW())
          ON CONFLICT ("capabilityId", "resultArtifactId") WHERE "resultArtifactId" IS NOT NULL DO NOTHING
          RETURNING id`;

        let evidenceId: string;
        let evidenceCreated: boolean;
        if (inserted.length > 0) {
          evidenceId = inserted[0].id;
          evidenceCreated = true;
        } else {
          const existing = await tx.capabilityEvidence.findFirst({
            where: { capabilityId: capability.id, resultArtifactId: artifactId },
            select: { id: true },
          });
          if (!existing) throw new Error('Evidence ON CONFLICT 后仍找不到行');
          evidenceId = existing.id;
          evidenceCreated = false;
        }

        return {
          kind: 'DECLARED',
          capabilityId: capability.id,
          capabilityStatus: capability.status,
          capabilitySource: capability.source,
          evidenceId,
          evidenceCreated,
        };
      });
    },

    /**
     * 幂等投影：CONFIRMED 简历技能 → Capability（对应验收 B7）。
     * fail closed：非 CONFIRMED 或缺可用证据的条目**直接跳过**，绝不制造 CONFIRMED 事实。
     * 重复调用不产生重复数据；无变化时不写库（返回 unchanged）。
     *
     * T3-A2-3 / §6.1：**Capability 写边界强制** —— 投影 key 同样必须经 key.ts
     * 归一 + 校验；无法归一为合法 canonical key 的源条目一并计入 `skipped`（不投影）。
     */
    async projectConfirmedSkills(userId) {
      const skills = await client.skill.findMany({
        where: { status: 'CONFIRMED', resume: { userId } },
        select: {
          key: true,
          label: true,
          level: true,
          status: true,
          evidence: { select: { id: true, source: true, locator: true, excerpt: true } },
        },
      });

      let created = 0;
      let updated = 0;
      let unchanged = 0;
      let skipped = 0;

      for (const skill of skills) {
        const projection = buildCapabilityProjection(skill);
        if (!projection) {
          // fail closed：不是 CONFIRMED，或证据不可核验 → 不投影
          skipped += 1;
          continue;
        }

        /**
         * T3-A2-3 / §6.1 —— **Capability 写边界强制（第三 writer）**。
         *
         * 源 key 来自 `Skill.key = normalizeForMatch(title)`（本文件 resume 创建路径），
         * 该函数**不含 NFKC**、**不保证字符集白名单与长度上限**，实测可产出
         * `ｐｙｔｈｏｎ`（NFKC 未归一）或 `r&d` / `saas&paas` / emoji / `>64` 字符等
         * **不可归一为合法 canonical key** 的输入。
         *
         * 因此与 A2-1 写边界保持同一契约：归一 + 校验一律复用 key.ts；
         * 无法归一为合法 canonical key 的源条目**不投影**（fail closed，与「证据不可核验即跳过」同向），
         * 以免产生与 A2-1 判定不一致的 Capability 行。
         * 除 key 之外，Resume Projection 的任何业务语义（状态 / level / source / 证据收敛）均不变。
         */
        const keyCheck = validateCapabilityKey(projection.key);
        if (!keyCheck.ok) {
          skipped += 1;
          continue;
        }
        const canonicalKey = keyCheck.key;

        const existing = await client.capability.findUnique({
          where: { userId_key: { userId, key: canonicalKey } },
          select: {
            id: true,
            label: true,
            level: true,
            status: true,
            source: true,
            evidence: { select: { type: true, source: true, excerpt: true } },
          },
        });

        if (!existing) {
          await client.capability.create({
            data: {
              userId,
              key: canonicalKey,
              label: projection.label,
              level: projection.level,
              status: projection.status,
              source: projection.source,
              evidence: { create: projection.evidence },
            },
          });
          created += 1;
          continue;
        }

        const sameMeta =
          existing.label === projection.label &&
          existing.level === projection.level &&
          existing.status === projection.status &&
          existing.source === projection.source;
        const nextKeys = projection.evidence.map((e) => evidenceKey(e)).sort();
        const currentKeys = existing.evidence
          .filter((e) => e.type === PROJECTION_EVIDENCE_TYPE)
          .map((e) => evidenceKey(e))
          .sort();
        const sameEvidence = nextKeys.length === currentKeys.length && nextKeys.every((k, i) => k === currentKeys[i]);

        if (sameMeta && sameEvidence) {
          unchanged += 1;
          continue;
        }

        await client.capability.update({
          where: { id: existing.id },
          data: {
            label: projection.label,
            level: projection.level,
            status: projection.status,
            source: projection.source,
            // source-scoped reconciliation（Q-1 / DMD §4.4）：
            // 只删除本来源（RESUME_EVIDENCE）自己拥有的证据，绝不触碰 PROJECT_RESULT_EVIDENCE。
            evidence: { deleteMany: { type: PROJECTION_EVIDENCE_TYPE }, create: projection.evidence },
          },
        });
        updated += 1;
      }

      return { created, updated, unchanged, skipped };
    },
  };

  const llmUsage: LlmUsageRepository = {
    async record(input) {
      await client.llmUsage.create({
        data: {
          userId: input.userId,
          feature: input.feature,
          requestCount: input.requestCount,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          totalTokens: input.totalTokens,
          cost: input.cost,
          status: input.status,
        },
      });
    },

    // 只统计「真实发生 provider 调用」的记录；QUOTA_REJECTED 属配额事件，不占额度
    async countSince(userId, feature, since) {
      const agg = await client.llmUsage.aggregate({
        where: {
          userId,
          feature,
          status: { in: [LLM_USAGE_STATUS.OK, LLM_USAGE_STATUS.FAILED] },
          createdAt: { gte: since },
        },
        _count: { _all: true },
        _min: { createdAt: true },
      });
      return { count: agg._count._all, oldest: agg._min.createdAt ?? null };
    },
  };

  const ACTION_PLAN_STEP_INCLUDE = { steps: { orderBy: { order: 'asc' } } } as const;

  type PlanRow = {
    id: string;
    userId: string;
    matchRunId: string;
    jdId: string | null;
    goal: string;
    have: unknown;
    gaps: unknown;
    createdAt: Date;
    steps: Array<{ id: string; order: number; title: string; desc: string; status: string; targetRequirement: string | null }>;
  };

  function toStepRecord(row: { id: string; order: number; title: string; desc: string; status: string; targetRequirement: string | null }): ActionStepRecord {
    return { id: row.id, order: row.order, title: row.title, desc: row.desc, status: row.status, targetRequirement: row.targetRequirement };
  }

  function toPlanRecord(row: PlanRow): ActionPlanRecord {
    return {
      id: row.id,
      userId: row.userId,
      matchRunId: row.matchRunId,
      jdId: row.jdId,
      goal: row.goal,
      have: Array.isArray(row.have) ? (row.have as unknown[]) : [],
      gaps: Array.isArray(row.gaps) ? (row.gaps as unknown[]) : [],
      createdAt: row.createdAt,
      steps: row.steps.map(toStepRecord),
    };
  }

  async function readPlan(db: Prisma.TransactionClient, planId: string): Promise<ActionPlanRecord> {
    const row = await db.actionPlan.findUnique({ where: { id: planId }, include: ACTION_PLAN_STEP_INCLUDE });
    if (!row) throw new Error(`ActionPlan ${planId} 不存在`);
    return toPlanRecord(row as unknown as PlanRow);
  }

  const actionPlans: ActionPlanRepository = {
    async createPlanWithSteps(input: ActionPlanCreateInput): Promise<ActionPlanRecord> {
      return client.$transaction(async (tx) => {
        const plan = await tx.actionPlan.create({
          data: {
            userId: input.userId,
            matchRunId: input.matchRunId,
            jdId: input.jdId,
            goal: input.goal,
            have: input.have as object,
            gaps: input.gaps as object,
          },
        });
        if (input.steps.length > 0) {
          await tx.actionStep.createMany({
            data: input.steps.map((s) => ({
              planId: plan.id,
              order: s.order,
              title: s.title,
              desc: s.desc,
              targetRequirement: s.targetRequirement,
            })),
          });
        }
        return readPlan(tx, plan.id);
      });
    },

    async listForUser(userId: string): Promise<ActionPlanRecord[]> {
      const rows = await client.actionPlan.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        include: ACTION_PLAN_STEP_INCLUDE,
      });
      return rows.map(toPlanRecord);
    },

    async findForUser(planId: string, userId: string): Promise<ActionPlanRecord | null> {
      const row = await client.actionPlan.findFirst({
        where: { id: planId, userId },
        include: ACTION_PLAN_STEP_INCLUDE,
      });
      return row ? toPlanRecord(row) : null;
    },

    async replacePlanContent(planId, userId, input) {
      const existing = await client.actionPlan.findFirst({ where: { id: planId, userId }, select: { id: true } });
      if (!existing) return null;
      return client.$transaction(async (tx) => {
        await tx.actionStep.deleteMany({ where: { planId } });
        await tx.actionPlan.update({
          where: { id: planId },
          data: { goal: input.goal, have: input.have as object, gaps: input.gaps as object },
        });
        if (input.steps.length > 0) {
          await tx.actionStep.createMany({
            data: input.steps.map((s) => ({
              planId,
              order: s.order,
              title: s.title,
              desc: s.desc,
              targetRequirement: s.targetRequirement,
            })),
          });
        }
        return readPlan(tx, planId);
      });
    },

    async updateStepStatus(stepId: string, userId: string, status: string): Promise<ActionStepRecord | null> {
      const step = await client.actionStep.findFirst({
        where: { id: stepId },
        include: { plan: { select: { userId: true } } },
      });
      if (!step || step.plan.userId !== userId) return null;
      const updated = await client.actionStep.update({ where: { id: stepId }, data: { status } });
      return toStepRecord(updated);
    },
  };

  type ProjectResultRow = {
    id: string;
    userId: string;
    planId: string;
    sourceStepId: string;
    sourceStepTitle: string;
    sourceStepTargetRequirement: string | null;
    title: string;
    summary: string;
    contentFingerprint: string | null;
    createdAt: Date;
    submittedAt: Date | null;
    revokedAt: Date | null;
  };

  type ResultArtifactRow = {
    id: string;
    resultId: string;
    kind: ResultArtifactKind;
    url: string | null;
    excerpt: string | null;
    dedupeKey: string;
    createdAt: Date;
  };

  function toArtifactRecord(row: ResultArtifactRow): ResultArtifactRecord {
    return {
      id: row.id,
      resultId: row.resultId,
      kind: row.kind as string,
      url: row.url,
      excerpt: row.excerpt,
      dedupeKey: row.dedupeKey,
      createdAt: row.createdAt,
    };
  }

  function toProjectResultRecord(row: ProjectResultRow & { artifacts: ResultArtifactRow[] }): ProjectResultRecord {
    return {
      id: row.id,
      userId: row.userId,
      planId: row.planId,
      sourceStepId: row.sourceStepId,
      sourceStepTitle: row.sourceStepTitle,
      sourceStepTargetRequirement: row.sourceStepTargetRequirement,
      title: row.title,
      summary: row.summary,
      contentFingerprint: row.contentFingerprint,
      status: inferStatus(row),
      createdAt: row.createdAt,
      submittedAt: row.submittedAt,
      revokedAt: row.revokedAt,
      artifacts: row.artifacts.map(toArtifactRecord),
    };
  }

  function toListItem(row: ProjectResultRow & { _count: { artifacts: number } }): ProjectResultListItem {
    return {
      id: row.id,
      userId: row.userId,
      planId: row.planId,
      sourceStepId: row.sourceStepId,
      sourceStepTitle: row.sourceStepTitle,
      sourceStepTargetRequirement: row.sourceStepTargetRequirement,
      title: row.title,
      summary: row.summary,
      status: inferStatus(row),
      artifactCount: row._count.artifacts,
      createdAt: row.createdAt,
      submittedAt: row.submittedAt,
      revokedAt: row.revokedAt,
    };
  }

  function isPrismaUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 'P2002';
  }

  const projectResults: ProjectResultRepository = {
    async createDraft(input) {
      const created = await client.projectResult.create({
        data: {
          userId: input.userId,
          planId: input.planId,
          sourceStepId: input.sourceStepId,
          sourceStepTitle: input.sourceStepTitle,
          sourceStepTargetRequirement: input.sourceStepTargetRequirement,
          title: input.title,
          summary: input.summary,
        },
        include: { artifacts: true },
      });
      return toProjectResultRecord(created as unknown as ProjectResultRow & { artifacts: ResultArtifactRow[] });
    },

    async listForUser(userId) {
      const rows = await client.projectResult.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { artifacts: true } } },
      });
      return rows.map((r) => toListItem(r as unknown as ProjectResultRow & { _count: { artifacts: number } }));
    },

    async findForUser(id, userId) {
      const row = await client.projectResult.findFirst({
        where: { id, userId },
        include: { artifacts: true },
      });
      return row ? toProjectResultRecord(row as unknown as ProjectResultRow & { artifacts: ResultArtifactRow[] }) : null;
    },

    async addArtifact(resultId, userId, input) {
      const dedupeKey = computeArtifactDedupeKey(input.kind, { url: input.url, excerpt: input.excerpt });
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "ProjectResult" WHERE id = ${resultId} AND "userId" = ${userId} FOR UPDATE`;
        const row = await tx.projectResult.findUnique({
          where: { id: resultId },
          select: { id: true, userId: true, submittedAt: true, revokedAt: true },
        });
        if (!row || row.userId !== userId) throw appError(ERROR_CODE.NOT_FOUND, '未找到该成果');
        if (row.submittedAt || row.revokedAt) throw appError(ERROR_CODE.RESULT_NOT_EDITABLE, '成果当前状态不可编辑');

        // 使用 PostgreSQL ON CONFLICT DO NOTHING 避免唯一冲突把事务标记为 aborted，
        // 冲突时返回已存在行（Q11：重复 artifact → 200 返回 existing）。
        const inserted = await tx.$queryRaw<ResultArtifactRow[]>`
          INSERT INTO "ResultArtifact" (id, "resultId", kind, url, excerpt, "dedupeKey", "createdAt")
          VALUES (${randomUUID()}, ${resultId}, ${input.kind}::"ResultArtifactKind", ${input.url ?? null}, ${input.excerpt ?? null}, ${dedupeKey}, NOW())
          ON CONFLICT ("resultId", "dedupeKey") DO NOTHING
          RETURNING *;
        `;
        if (inserted.length > 0) return toArtifactRecord(inserted[0]);

        const existing = await tx.resultArtifact.findFirst({
          where: { resultId, dedupeKey },
        });
        if (!existing) throw new Error('ON CONFLICT 后未找到已存在凭据');
        return toArtifactRecord(existing as unknown as ResultArtifactRow);
      });
    },

    async removeDraftArtifact(resultId, userId, artifactId) {
      await client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "ProjectResult" WHERE id = ${resultId} AND "userId" = ${userId} FOR UPDATE`;
        const row = await tx.projectResult.findUnique({
          where: { id: resultId },
          include: { artifacts: { where: { id: artifactId } } },
        });
        if (!row || row.userId !== userId) throw appError(ERROR_CODE.NOT_FOUND, '未找到该成果');
        if (row.submittedAt || row.revokedAt) throw appError(ERROR_CODE.RESULT_NOT_EDITABLE, '成果当前状态不可编辑');
        if (row.artifacts.length === 0) throw appError(ERROR_CODE.NOT_FOUND, '未找到该凭据');
        await tx.resultArtifact.delete({ where: { id: artifactId } });
      });
    },

    async submit(resultId, userId, now) {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "ProjectResult" WHERE id = ${resultId} AND "userId" = ${userId} FOR UPDATE`;
        const row = await tx.projectResult.findUnique({
          where: { id: resultId },
          include: { artifacts: true },
        });
        if (!row || row.userId !== userId) throw appError(ERROR_CODE.NOT_FOUND, '未找到该成果');
        if (row.submittedAt || row.revokedAt) throw appError(ERROR_CODE.RESULT_NOT_TRANSITIONABLE, '成果当前状态不允许提交');
        if (row.artifacts.length === 0) throw appError(ERROR_CODE.RESULT_HAS_NO_ARTIFACT, '提交前至少需要一个凭据');
        const fingerprint = computeContentFingerprint(row.sourceStepId, row.title, row.summary);
        try {
          const updated = await tx.projectResult.update({
            where: { id: resultId },
            data: { submittedAt: now, contentFingerprint: fingerprint },
            include: { artifacts: true },
          });
          return toProjectResultRecord(updated as unknown as ProjectResultRow & { artifacts: ResultArtifactRow[] });
        } catch (err) {
          if (isPrismaUniqueViolation(err)) {
            throw appError(ERROR_CODE.RESULT_DUPLICATE, '相同内容的成果已提交');
          }
          throw err;
        }
      });
    },

    async revoke(resultId, userId, now) {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "ProjectResult" WHERE id = ${resultId} AND "userId" = ${userId} FOR UPDATE`;
        const row = await tx.projectResult.findUnique({
          where: { id: resultId },
          include: { artifacts: true },
        });
        if (!row || row.userId !== userId) throw appError(ERROR_CODE.NOT_FOUND, '未找到该成果');
        if (!row.submittedAt || row.revokedAt) throw appError(ERROR_CODE.RESULT_NOT_TRANSITIONABLE, '成果当前状态不允许撤销');
        const updated = await tx.projectResult.update({
          where: { id: resultId },
          data: { revokedAt: now },
          include: { artifacts: true },
        });
        return toProjectResultRecord(updated as unknown as ProjectResultRow & { artifacts: ResultArtifactRow[] });
      });
    },
  };

  type LearningTaskRow = {
    id: string;
    userId: string;
    actionPlanId: string;
    sourceStepId: string;
    sourceStepTitle: string;
    sourceStepTargetRequirement: string | null;
    content: string | null;
    status: string;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };

  function toLearningTaskRecord(row: LearningTaskRow): LearningTaskRecord {
    return {
      id: row.id,
      userId: row.userId,
      actionPlanId: row.actionPlanId,
      sourceStepId: row.sourceStepId,
      sourceStepTitle: row.sourceStepTitle,
      sourceStepTargetRequirement: row.sourceStepTargetRequirement,
      content: row.content,
      status: row.status as LearningTaskRecord['status'],
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  const learningTasks: LearningTaskRepository = {
    async create(input: LearningTaskCreateInput): Promise<LearningTaskCreateOutcome> {
      // 归属校验：actionPlan 必须存在且属于该用户（跨用户 → NOT_FOUND，不泄露存在性）
      const plan = await client.actionPlan.findFirst({
        where: { id: input.actionPlanId, userId: input.userId },
        select: { id: true },
      });
      if (!plan) return { kind: 'ACTION_PLAN_NOT_FOUND' };

      try {
        const created = await client.learningTask.create({
          data: {
            userId: input.userId,
            actionPlanId: input.actionPlanId,
            sourceStepId: input.sourceStepId,
            sourceStepTitle: input.sourceStepTitle,
            sourceStepTargetRequirement: input.sourceStepTargetRequirement,
            content: input.content,
          },
        });
        return { kind: 'CREATED', task: toLearningTaskRecord(created as LearningTaskRow) };
      } catch (err) {
        // P2002 → 重读已有记录（不返回 500）；禁止 find → create 作为唯一性保证
        if (isPrismaUniqueViolation(err)) {
          const existing = await client.learningTask.findUnique({
            where: {
              userId_actionPlanId_sourceStepId: {
                userId: input.userId,
                actionPlanId: input.actionPlanId,
                sourceStepId: input.sourceStepId,
              },
            },
          });
          if (!existing) throw err;
          if (existing.archivedAt) return { kind: 'ARCHIVED_DUPLICATE' };
          return { kind: 'ACTIVE_DUPLICATE', task: toLearningTaskRecord(existing as LearningTaskRow) };
        }
        throw err;
      }
    },

    async listForUser(userId: string): Promise<LearningTaskRecord[]> {
      const rows = await client.learningTask.findMany({
        where: { userId, archivedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => toLearningTaskRecord(r as LearningTaskRow));
    },

    async findForUser(id: string, userId: string): Promise<LearningTaskRecord | null> {
      const row = await client.learningTask.findFirst({ where: { id, userId } });
      return row ? toLearningTaskRecord(row as LearningTaskRow) : null;
    },

    async update(id: string, userId: string, input: LearningTaskUpdateInput): Promise<LearningTaskUpdateOutcome> {
      const row = await client.learningTask.findFirst({ where: { id, userId } });
      if (!row) return { kind: 'NOT_FOUND' };
      if (row.archivedAt) return { kind: 'ARCHIVED' };

      const data: { status?: LearningTaskRecord['status']; content?: string | null } = {};

      if (input.status !== undefined) {
        if (!isLearningTaskStatus(input.status)) {
          return { kind: 'INVALID_STATUS' };
        }
        // Phase 3 冻结矩阵：让 domain 迁移契约真正参与 update
        const transition = evaluateLearningTaskTransition(
          row.status as LearningTaskRecord['status'],
          input.status,
        );
        if (transition === 'FORBIDDEN') {
          return { kind: 'FORBIDDEN_TRANSITION' };
        }
        // ALLOWED 与 NOOP 都写入（NOOP 同值，update 语义幂等，返回 200）
        data.status = input.status;
      }
      if (input.content !== undefined) data.content = input.content;

      const updated = await client.learningTask.update({ where: { id }, data });
      return { kind: 'UPDATED', task: toLearningTaskRecord(updated as LearningTaskRow) };
    },

    async archive(id: string, userId: string, now: Date): Promise<LearningTaskArchiveOutcome> {
      const row = await client.learningTask.findFirst({ where: { id, userId } });
      if (!row) return { kind: 'NOT_FOUND' };
      // 幂等：已归档返回当前记录（不重复改时间戳）
      if (row.archivedAt) return { kind: 'ARCHIVED', task: toLearningTaskRecord(row as LearningTaskRow) };
      const updated = await client.learningTask.update({ where: { id }, data: { archivedAt: now } });
      return { kind: 'ARCHIVED', task: toLearningTaskRecord(updated as LearningTaskRow) };
    },
  };

  type PortfolioProjectRow = {
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

  type PortfolioMemberRow = {
    id: string;
    portfolioProjectId: string;
    projectResultId: string;
    displayOrder: number;
    createdAt: Date;
    submittedAt: Date | null;
    revokedAt: Date | null;
  };

  function toPortfolioProjectRecord(row: PortfolioProjectRow): PortfolioProjectRecord {
    return {
      id: row.id,
      userId: row.userId,
      title: row.title,
      description: row.description,
      displayOrder: row.displayOrder,
      featured: row.featured,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function toPortfolioMemberRecord(row: PortfolioMemberRow): PortfolioMemberRecord {
    return {
      id: row.id,
      portfolioProjectId: row.portfolioProjectId,
      projectResultId: row.projectResultId,
      displayOrder: row.displayOrder,
      createdAt: row.createdAt,
      submittedAt: row.submittedAt,
      revokedAt: row.revokedAt,
    };
  }

  /** 加载 detail 的成员并二分 active/revoked（穷尽性依赖 P-1：无 DRAFT 成员）。 */
  async function loadPortfolioDetail(
    project: PortfolioProjectRow,
  ): Promise<PortfolioProjectDetail> {
    const links = await client.portfolioProjectResult.findMany({
      where: { portfolioProjectId: project.id },
      select: {
        id: true,
        portfolioProjectId: true,
        projectResultId: true,
        displayOrder: true,
        createdAt: true,
        projectResult: { select: { submittedAt: true, revokedAt: true } },
      },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const members: PortfolioMemberRow[] = links.map((l) => ({
      id: l.id,
      portfolioProjectId: l.portfolioProjectId,
      projectResultId: l.projectResultId,
      displayOrder: l.displayOrder,
      createdAt: l.createdAt,
      submittedAt: l.projectResult.submittedAt,
      revokedAt: l.projectResult.revokedAt,
    }));
    const results: PortfolioMemberRecord[] = [];
    const revokedResults: PortfolioMemberRecord[] = [];
    for (const m of members) {
      const rec = toPortfolioMemberRecord(m);
      if (m.revokedAt !== null) revokedResults.push(rec);
      else results.push(rec);
    }
    return {
      project: toPortfolioProjectRecord(project),
      results,
      revokedResults,
      activeResultCount: results.length,
    };
  }

  const portfolioProjects: PortfolioProjectRepository = {
    async create(input: PortfolioProjectCreateInput): Promise<PortfolioProjectCreateOutcome> {
      const created = await client.portfolioProject.create({
        data: {
          userId: input.userId,
          title: input.title,
          description: normalizeDescription(input.description),
        },
      });
      return { kind: 'CREATED', project: toPortfolioProjectRecord(created as PortfolioProjectRow) };
    },

    async listForUser(userId: string): Promise<PortfolioProjectRecord[]> {
      const rows = await client.portfolioProject.findMany({
        where: { userId, archivedAt: null },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map((r) => toPortfolioProjectRecord(r as PortfolioProjectRow));
    },

    async findForUser(id: string, userId: string): Promise<PortfolioProjectDetail | null> {
      const row = await client.portfolioProject.findFirst({ where: { id, userId } });
      if (!row) return null;
      return loadPortfolioDetail(row as PortfolioProjectRow);
    },

    async update(
      id: string,
      userId: string,
      input: PortfolioProjectUpdateInput,
    ): Promise<PortfolioProjectUpdateOutcome> {
      return client.$transaction(async (tx) => {
        // G-1c：PATCH 使用与 ADD 相同的 PortfolioProject 行级窄锁
        await tx.$queryRaw`SELECT 1 FROM "PortfolioProject" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
        const row = await tx.portfolioProject.findFirst({ where: { id, userId } });
        if (!row) return { kind: 'NOT_FOUND' as const };
        if (row.archivedAt) return { kind: 'ARCHIVED' as const };

        const data: {
          title?: string;
          description?: string | null;
          displayOrder?: number;
          featured?: boolean;
        } = {};
        if (input.title !== undefined) data.title = input.title;
        if (input.description !== undefined) data.description = normalizeDescription(input.description);
        if (input.displayOrder !== undefined) data.displayOrder = input.displayOrder;
        if (input.featured !== undefined) data.featured = input.featured;

        const updated = await tx.portfolioProject.update({ where: { id }, data });
        return { kind: 'UPDATED' as const, project: toPortfolioProjectRecord(updated as PortfolioProjectRow) };
      });
    },

    async archive(id: string, userId: string, now: Date): Promise<PortfolioProjectArchiveOutcome> {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "PortfolioProject" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
        const row = await tx.portfolioProject.findFirst({ where: { id, userId } });
        if (!row) return { kind: 'NOT_FOUND' as const };
        // 幂等：已归档返回当前记录，不改变 archivedAt
        if (row.archivedAt) {
          return { kind: 'ARCHIVED' as const, project: toPortfolioProjectRecord(row as PortfolioProjectRow) };
        }
        const updated = await tx.portfolioProject.update({ where: { id }, data: { archivedAt: now } });
        return { kind: 'ARCHIVED' as const, project: toPortfolioProjectRecord(updated as PortfolioProjectRow) };
      });
    },

    async addResult(
      id: string,
      userId: string,
      input: PortfolioProjectAddResultInput,
    ): Promise<PortfolioProjectAddResultOutcome> {
      return client.$transaction(async (tx) => {
        // G-1a：先取得 PortfolioProject 行锁，再在事务内重新读取 archivedAt
        await tx.$queryRaw`SELECT 1 FROM "PortfolioProject" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
        const project = await tx.portfolioProject.findFirst({ where: { id, userId } });
        if (!project) return { kind: 'NOT_FOUND' as const };
        if (project.archivedAt) return { kind: 'ARCHIVED' as const };

        // ISSUE-1：先判断是否已存在 relation。已存在 → 200 existing（不管 ProjectResult 当前是否 revoked）。
        // 只有「首次加入」才执行 submittedAt != null && revokedAt == null 的 eligibility 检查。
        const existingLink = await tx.portfolioProjectResult.findUnique({
          where: {
            portfolioProjectId_projectResultId: {
              portfolioProjectId: id,
              projectResultId: input.projectResultId,
            },
          },
          select: {
            id: true,
            portfolioProjectId: true,
            projectResultId: true,
            displayOrder: true,
            createdAt: true,
            projectResult: { select: { submittedAt: true, revokedAt: true } },
          },
        });
        if (existingLink) {
          const rec: PortfolioMemberRow = {
            id: existingLink.id,
            portfolioProjectId: existingLink.portfolioProjectId,
            projectResultId: existingLink.projectResultId,
            displayOrder: existingLink.displayOrder,
            createdAt: existingLink.createdAt,
            submittedAt: existingLink.projectResult.submittedAt,
            revokedAt: existingLink.projectResult.revokedAt,
          };
          return { kind: 'DUPLICATE' as const, member: toPortfolioMemberRecord(rec) };
        }

        // P-1：ProjectResult 必须存在、同用户、且 submittedAt != null && revokedAt == null
        const pr = await tx.projectResult.findFirst({
          where: { id: input.projectResultId, userId },
          select: { id: true, submittedAt: true, revokedAt: true },
        });
        if (!pr) return { kind: 'PROJECT_RESULT_NOT_FOUND' as const };
        const eligibility = evaluateProjectResultEligibility({
          submittedAt: pr.submittedAt,
          revokedAt: pr.revokedAt,
        });
        if (eligibility !== 'ELIGIBLE') return { kind: 'NOT_ELIGIBLE' as const };

        // G-1b：ON CONFLICT DO NOTHING（不触发 P2002 中止事务）
        const inserted = await tx.$queryRaw<PortfolioMemberRow[]>`
          INSERT INTO "PortfolioProjectResult" (id, "portfolioProjectId", "projectResultId", "displayOrder", "createdAt")
          VALUES (${randomUUID()}, ${id}, ${input.projectResultId}, ${input.displayOrder}, NOW())
          ON CONFLICT ("portfolioProjectId", "projectResultId") DO NOTHING
          RETURNING id, "portfolioProjectId", "projectResultId", "displayOrder", "createdAt";
        `;
        if (inserted.length > 0) {
          const row = inserted[0];
          const member = await tx.portfolioProjectResult.findUnique({
            where: { id: row.id },
            select: {
              id: true,
              portfolioProjectId: true,
              projectResultId: true,
              displayOrder: true,
              createdAt: true,
              projectResult: { select: { submittedAt: true, revokedAt: true } },
            },
          });
          const rec: PortfolioMemberRow = {
            id: row.id,
            portfolioProjectId: row.portfolioProjectId,
            projectResultId: row.projectResultId,
            displayOrder: row.displayOrder,
            createdAt: row.createdAt,
            submittedAt: member?.projectResult.submittedAt ?? null,
            revokedAt: member?.projectResult.revokedAt ?? null,
          };
          return { kind: 'ADDED' as const, member: toPortfolioMemberRecord(rec) };
        }

        // 并发兜底：极端情况下 ON CONFLICT DO NOTHING 后仍无行（理论上已由前置 existingLink 覆盖）
        throw new Error('ON CONFLICT 后未找到已存在关系');
      });
    },

    async removeResult(
      id: string,
      userId: string,
      resultId: string,
    ): Promise<PortfolioProjectRemoveResultOutcome> {
      return client.$transaction(async (tx) => {
        // G-1c：REMOVE 使用与 ADD 相同的行级窄锁
        await tx.$queryRaw`SELECT 1 FROM "PortfolioProject" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
        const project = await tx.portfolioProject.findFirst({ where: { id, userId } });
        if (!project) return { kind: 'NOT_FOUND' as const };
        if (project.archivedAt) return { kind: 'ARCHIVED' as const };

        const link = await tx.portfolioProjectResult.findFirst({
          where: { portfolioProjectId: id, projectResultId: resultId },
          select: { id: true },
        });
        if (!link) return { kind: 'NOT_FOUND' as const };

        await tx.portfolioProjectResult.delete({ where: { id: link.id } });
        return { kind: 'REMOVED' as const };
      });
    },
  };

  type InterviewSessionRow = {
    id: string;
    userId: string;
    jdId: string | null;
    topic: string;
    endedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };

  type InterviewTurnRow = {
    id: string;
    sessionId: string;
    turnOrder: number;
    question: string;
    answer: string | null;
    feedback: unknown;
    createdAt: Date;
    updatedAt: Date;
  };

  function toInterviewSessionRecord(row: InterviewSessionRow): InterviewSessionRecord {
    return {
      id: row.id,
      userId: row.userId,
      jdId: row.jdId,
      topic: row.topic,
      endedAt: row.endedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function toInterviewTurnRecord(row: InterviewTurnRow): InterviewTurnRecord {
    return {
      id: row.id,
      sessionId: row.sessionId,
      turnOrder: row.turnOrder,
      question: row.question,
      answer: row.answer,
      feedback: row.feedback,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  const interviews: InterviewRepository = {
    async createSession(input: InterviewCreateSessionInput): Promise<InterviewCreateSessionOutcome> {
      const created = await client.interviewSession.create({
        data: { userId: input.userId, jdId: input.jdId, topic: input.topic },
      });
      return { kind: 'CREATED', session: toInterviewSessionRecord(created as InterviewSessionRow) };
    },

    async listForUser(userId: string): Promise<InterviewSessionRecord[]> {
      const rows = await client.interviewSession.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return rows.map((r) => toInterviewSessionRecord(r as InterviewSessionRow));
    },

    async findForUser(id: string, userId: string): Promise<InterviewSessionDetail | null> {
      const row = await client.interviewSession.findFirst({ where: { id, userId } });
      if (!row) return null;
      const turns = await client.interviewTurn.findMany({
        where: { sessionId: id },
        orderBy: [{ turnOrder: 'asc' }],
      });
      return {
        session: toInterviewSessionRecord(row as InterviewSessionRow),
        turns: turns.map((t) => toInterviewTurnRecord(t as InterviewTurnRow)),
      };
    },

    async end(id: string, userId: string, now: Date): Promise<InterviewEndOutcome> {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "InterviewSession" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
        const row = await tx.interviewSession.findFirst({ where: { id, userId } });
        if (!row) return { kind: 'NOT_FOUND' as const };
        // 幂等：已结束返回当前记录，不改变 endedAt
        if (row.endedAt) return { kind: 'ENDED' as const, session: toInterviewSessionRecord(row as InterviewSessionRow) };
        const updated = await tx.interviewSession.update({ where: { id }, data: { endedAt: now } });
        return { kind: 'ENDED' as const, session: toInterviewSessionRecord(updated as InterviewSessionRow) };
      });
    },

    async checkTurnEligibility(id: string, userId: string): Promise<InterviewCheckTurnOutcome> {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "InterviewSession" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
        const session = await tx.interviewSession.findFirst({ where: { id, userId } });
        if (!session) return { kind: 'NOT_FOUND' as const };
        if (session.endedAt) return { kind: 'SESSION_ENDED' as const };

        // 检查是否存在未回答 Turn（answer IS NULL）
        const unanswered = await tx.interviewTurn.findFirst({
          where: { sessionId: id, answer: null },
          select: { id: true },
        });
        if (unanswered) return { kind: 'TURN_PENDING' as const };

        // Interview V2-A（D-2）：8 轮上限 —— 在 provider 调用之前拒绝第 9 轮
        const turnCount = await tx.interviewTurn.count({ where: { sessionId: id } });
        if (turnCount >= MAX_INTERVIEW_TURNS) return { kind: 'TURN_LIMIT_REACHED' as const };

        return { kind: 'OK' as const };
      });
    },

    async createTurn(id: string, userId: string, question: string): Promise<InterviewCreateTurnOutcome> {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "InterviewSession" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
        const session = await tx.interviewSession.findFirst({ where: { id, userId } });
        if (!session) return { kind: 'NOT_FOUND' as const };
        if (session.endedAt) return { kind: 'SESSION_ENDED' as const };

        // 检查是否存在未回答 Turn（answer IS NULL）
        const unanswered = await tx.interviewTurn.findFirst({
          where: { sessionId: id, answer: null },
          select: { id: true },
        });
        if (unanswered) return { kind: 'TURN_PENDING' as const };

        // 计算下一个 turnOrder
        const maxRow = await tx.interviewTurn.aggregate({ where: { sessionId: id }, _max: { turnOrder: true } });
        const nextOrder = (maxRow._max.turnOrder ?? 0) + 1;

        // Interview V2-A（D-2）：锁内并发兜底 —— nextOrder 超过 8 轮上限时拒绝建行
        if (nextOrder > MAX_INTERVIEW_TURNS) return { kind: 'TURN_LIMIT_REACHED' as const };

        // V-6：Session 行锁（FOR UPDATE）已串行化同一 session 的 turn 创建，
        // COALESCE(MAX)+1 不会产生 (sessionId, turnOrder) 冲突；移除事务内 P2002 catch
        // （catch 后 PostgreSQL 事务已 aborted，无法恢复）。
        const created = await tx.interviewTurn.create({
          data: { sessionId: id, turnOrder: nextOrder, question },
        });
        return { kind: 'CREATED' as const, turn: toInterviewTurnRecord(created as InterviewTurnRow) };
      });
    },

    async saveAnswer(userId: string, input: InterviewSaveAnswerInput): Promise<InterviewSaveAnswerOutcome> {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "InterviewSession" WHERE id = ${input.sessionId} AND "userId" = ${userId} FOR UPDATE`;
        const session = await tx.interviewSession.findFirst({
          where: { id: input.sessionId, userId },
          select: { id: true, endedAt: true },
        });
        if (!session) return { kind: 'TURN_NOT_FOUND' as const };
        if (session.endedAt) return { kind: 'SESSION_ENDED' as const };

        const turn = await tx.interviewTurn.findFirst({
          where: { id: input.turnId, sessionId: input.sessionId },
        });
        if (!turn) return { kind: 'TURN_NOT_FOUND' as const };

        const state = inferTurnState({ answer: turn.answer, feedback: turn.feedback });

        if (state === 'UNANSWERED') {
          // 写入 answer（原样保存，不 trim）
          const updated = await tx.interviewTurn.update({
            where: { id: input.turnId },
            data: { answer: input.answer },
          });
          return { kind: 'SAVED' as const, turn: toInterviewTurnRecord(updated as InterviewTurnRow) };
        }

        if (state === 'EVALUATION_PENDING') {
          if (isSameAnswer(turn.answer as string, input.answer)) {
            return { kind: 'PENDING_RETRY' as const, turn: toInterviewTurnRecord(turn as InterviewTurnRow) };
          }
          return { kind: 'ANSWER_IMMUTABLE' as const };
        }

        // COMPLETED
        if (isSameAnswer(turn.answer as string, input.answer)) {
          return { kind: 'COMPLETED_SAME' as const, turn: toInterviewTurnRecord(turn as InterviewTurnRow) };
        }
        return { kind: 'ANSWER_IMMUTABLE' as const };
      });
    },

    async commitFeedback(userId: string, input: InterviewCommitFeedbackInput): Promise<InterviewCommitFeedbackOutcome> {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "InterviewSession" WHERE id = ${input.sessionId} AND "userId" = ${userId} FOR UPDATE`;
        const session = await tx.interviewSession.findFirst({
          where: { id: input.sessionId, userId },
          select: { id: true, endedAt: true },
        });
        if (!session) return { kind: 'TURN_NOT_FOUND' as const };
        // Stage 2 期间被 end → 不写 feedback，409
        if (session.endedAt) return { kind: 'SESSION_ENDED' as const };

        const turn = await tx.interviewTurn.findFirst({
          where: { id: input.turnId, sessionId: input.sessionId },
        });
        if (!turn) return { kind: 'TURN_NOT_FOUND' as const };

        // 确认仍为 EVALUATION_PENDING（answer 非空 且 feedback 为 NULL）
        if (turn.answer === null || turn.feedback !== null) return { kind: 'NOT_PENDING' as const };
        // 确认 answer 与 Stage 1 保存值完全一致
        if (!isSameAnswer(turn.answer, input.answer)) return { kind: 'ANSWER_MISMATCH' as const };

        // feedback 写入与 pending 检查原子完成
        const updated = await tx.interviewTurn.update({
          where: { id: input.turnId },
          data: { feedback: input.feedback as Prisma.InputJsonValue },
        });
        return { kind: 'COMMITTED' as const, turn: toInterviewTurnRecord(updated as InterviewTurnRow) };
      });
    },
  };

  // ─── T5-A RAG-Lite：检索（**只读**；参数绑定 raw SQL；tsvector + GIN）──────
  //
  // 硬约束：
  //   - `KnowledgeChunk.searchVector` 为 `Unsupported("tsvector")` → **禁止** `SELECT *`
  //     / `RETURNING *`，必须显式列名（与项目既有 raw SQL 惯例一致）；
  //   - 参数一律经 Prisma tagged template 绑定（`${...}`），绝不拼接 SQL（T5A-F-44）；
  //   - 排序 `rank DESC, documentId ASC, chunkOrder ASC`（T5A-F-41，确定性）；
  //   - 只读 `enabled` 的 source + document（T5A-F-43）；
  //   - 只 JOIN 3 张 RAG 表，**零**用户表 / Frozen Zone 引用（T5A-F-75 / T5A-F-79）；
  //   - config 固定 `simple`，不引入任何 extension（T5A-F-37 / T5A-F-45）。
  const ragRetrieval: RagRetrievalRepository = {
    async listEnabledSources(): Promise<KnowledgeSourceSummary[]> {
      const rows = await client.knowledgeSource.findMany({
        where: { enabled: true },
        select: { key: true, title: true, sourceType: true, enabled: true },
        orderBy: [{ key: 'asc' }],
      });
      return rows.map((r) => ({
        key: r.key,
        title: r.title,
        sourceType: r.sourceType,
        enabled: r.enabled,
      }));
    },

    async retrieve(query: RagRetrievalQuery): Promise<RagRetrievalResult> {
      const { searchText, limit } = query;

      // 命中总数（不受 limit 影响）；`::int` 避免 BigInt 泄漏到 JSON。
      const counted = await client.$queryRaw<Array<{ total: number }>>`
        SELECT COUNT(*)::int AS "total"
        FROM "KnowledgeChunk" c
        JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
        JOIN "KnowledgeSource"   s ON s."id" = d."sourceId"
        WHERE s."enabled" = true
          AND d."enabled" = true
          AND c."searchVector" @@ plainto_tsquery('simple', ${searchText})
      `;
      const total = counted[0]?.total ?? 0;

      // 显式列名：绝不触碰 searchVector（Unsupported 列不可映射）。
      const hits = await client.$queryRaw<RagRetrievalHit[]>`
        SELECT
          c."id"            AS "chunkId",
          c."documentId"    AS "documentId",
          c."chunkOrder"    AS "chunkOrder",
          c."content"       AS "content",
          d."title"         AS "title",
          s."id"            AS "sourceId",
          s."key"           AS "sourceKey",
          s."sourceType"    AS "sourceType",
          ts_rank_cd(c."searchVector", plainto_tsquery('simple', ${searchText})) AS "rank"
        FROM "KnowledgeChunk" c
        JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
        JOIN "KnowledgeSource"   s ON s."id" = d."sourceId"
        WHERE s."enabled" = true
          AND d."enabled" = true
          AND c."searchVector" @@ plainto_tsquery('simple', ${searchText})
        ORDER BY
          ts_rank_cd(c."searchVector", plainto_tsquery('simple', ${searchText})) DESC,
          c."documentId" ASC,
          c."chunkOrder" ASC
        LIMIT ${limit}::int
      `;

      return { hits, total };
    },
  };

  // ─── T5-A：受控 ingest（**仅脚本 / fixture**；无 HTTP 入口）──────────────
  //
  // 硬约束：
  //   - 只写 3 张 RAG 表；**零** Capability / CapabilityEvidence / Evidence / CONFIRMED 写入；
  //   - 幂等：同 (sourceId, contentFingerprint) → DUPLICATE（不新增、不 500，T5A-F-63）；
  //   - 内容变化：新增 Document（新指纹）+ 旧 Document 置 `enabled=false`（T5A-F-17）；
  //   - 事务性：整体成功或整体回滚（T5A-F-64）。
  const knowledgeIngest: KnowledgeIngestRepository = {
    async upsertSource(input: KnowledgeSourceWriteInput): Promise<{ id: string }> {
      const row = await client.knowledgeSource.upsert({
        where: { key: input.key },
        create: {
          key: input.key,
          title: input.title,
          sourceType: input.sourceType,
          description: input.description,
          provenance: input.provenance as Prisma.InputJsonValue,
          enabled: true,
        },
        update: {
          title: input.title,
          sourceType: input.sourceType,
          description: input.description,
          provenance: input.provenance as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { id: row.id };
    },

    async ingestDocument(input: KnowledgeDocumentWriteInput): Promise<KnowledgeIngestOutcome> {
      return client.$transaction(async (tx) => {
        const source = await tx.knowledgeSource.findUnique({
          where: { key: input.sourceKey },
          select: { id: true },
        });
        if (!source) return { kind: 'SOURCE_NOT_FOUND' as const };

        const existing = await tx.knowledgeDocument.findUnique({
          where: {
            sourceId_contentFingerprint: {
              sourceId: source.id,
              contentFingerprint: input.contentFingerprint,
            },
          },
          select: { id: true, _count: { select: { chunks: true } } },
        });
        if (existing) {
          return {
            kind: 'DUPLICATE' as const,
            documentId: existing.id,
            chunkCount: existing._count.chunks,
          };
        }

        await tx.knowledgeDocument.updateMany({
          where: { sourceId: source.id, enabled: true },
          data: { enabled: false },
        });

        const created = await tx.knowledgeDocument.create({
          data: {
            sourceId: source.id,
            title: input.title,
            content: input.content,
            contentFingerprint: input.contentFingerprint,
            language: input.language,
            enabled: true,
          },
          select: { id: true },
        });

        // FACT：`KnowledgeChunk.searchVector` 为 required `Unsupported("tsvector")`，
        // Prisma 对该模型**不生成任何 mutation 方法**（delegate 仅 find*）。
        // 故 chunk 写入走参数绑定 `$executeRaw`（tagged template，非字符串拼接）；
        // `searchVector` 为生成列，**不得**出现在 INSERT 列清单中。
        for (const c of input.chunks) {
          await tx.$executeRaw`
            INSERT INTO "KnowledgeChunk"
              ("id", "documentId", "chunkOrder", "content", "searchText", "chunkHash", "metadata", "createdAt", "updatedAt")
            VALUES (
              ${randomUUID()},
              ${created.id},
              ${c.chunkOrder},
              ${c.content},
              ${c.searchText},
              ${c.chunkHash},
              ${c.metadata === null ? null : JSON.stringify(c.metadata)}::jsonb,
              NOW(),
              NOW()
            )
          `;
        }

        return { kind: 'CREATED' as const, documentId: created.id, chunkCount: input.chunks.length };
      });
    },
  };

  // ─── T5-B-1：Agent row 类型与映射 ────────────────────────────────────────
  type AgentRunRow = {
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

  type AgentProposalRow = {
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

  function toAgentRunRecord(row: AgentRunRow): AgentRunRecord {
    return {
      id: row.id,
      userId: row.userId,
      goalKind: row.goalKind,
      status: row.status,
      modelVersion: row.modelVersion,
      semanticVersions: row.semanticVersions,
      promptTemplateVersion: row.promptTemplateVersion,
      quotaUsage: row.quotaUsage,
      providerRequestId: row.providerRequestId,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      endedAt: row.endedAt,
    };
  }

  function toAgentProposalRecord(row: AgentProposalRow): AgentProposalRecord {
    return {
      id: row.id,
      runId: row.runId,
      revision: row.revision,
      kind: row.kind,
      payload: row.payload,
      basedOnRefs: row.basedOnRefs,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ─── T5-B-1：Agent Domain Persistence（**只持久化 + 归属隔离**）──────────────
  //
  // 硬约束：
  //   - 状态机判定在 Domain（`src/domain/agent/agent-run.ts`），本层只做**状态条件更新**；
  //   - Proposal 归属**只**经 `run.userId` 校验（不在 proposal 冗余 userId）；
  //   - `createProposal` 以 DB 唯一约束为最终防线：P2002 → 重读 → DUPLICATE（不返回 500）；
  //   - 零 API / 零 Handler / 零 Tool / 零 LLM / 零 quota；不写任何事实层。
  const agentRuns: AgentRunRepository = {
    async createRun(input: AgentRunCreateInput): Promise<AgentRunRecord> {
      const created = await client.agentRun.create({
        data: {
          userId: input.userId,
          goalKind: input.goalKind,
          promptTemplateVersion: input.promptTemplateVersion,
          semanticVersions: input.semanticVersions as Prisma.InputJsonValue,
          quotaUsage: input.quotaUsage as Prisma.InputJsonValue,
          modelVersion: input.modelVersion ?? null,
        },
      });
      return toAgentRunRecord(created as AgentRunRow);
    },

    async findRunForUser(id: string, userId: string): Promise<AgentRunRecord | null> {
      const row = await client.agentRun.findFirst({ where: { id, userId } });
      return row ? toAgentRunRecord(row as AgentRunRow) : null;
    },

    async listRunsForUser(userId: string): Promise<AgentRunRecord[]> {
      const rows = await client.agentRun.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return rows.map((r) => toAgentRunRecord(r as AgentRunRow));
    },

    async transitionRun(
      id: string,
      userId: string,
      to: string,
      now: Date,
    ): Promise<AgentRunTransitionOutcome> {
      if (!isAgentRunStatus(to)) return { kind: 'INVALID_STATUS' as const };

      const current = await client.agentRun.findFirst({ where: { id, userId } });
      if (!current) return { kind: 'NOT_FOUND' as const };
      if (!isAgentRunStatus(current.status)) return { kind: 'INVALID_STATUS' as const };

      // 状态机判定（Domain 唯一权威；NOOP 与 ALLOWED 均可继续）
      if (evaluateAgentRunTransition(current.status, to) === 'FORBIDDEN') {
        return { kind: 'FORBIDDEN_TRANSITION' as const };
      }

      const endedAt = resolveAgentRunEndedAt(current.endedAt, to, now);
      // 带**当前状态条件**的更新：并发下只有一个请求能命中（防止重复成功）
      const written = await client.agentRun.updateMany({
        where: { id, userId, status: current.status },
        data: { status: to, endedAt },
      });
      if (written.count !== 1) return { kind: 'CONFLICT' as const };

      const row = await client.agentRun.findFirst({ where: { id, userId } });
      if (!row) return { kind: 'NOT_FOUND' as const };
      return { kind: 'UPDATED' as const, run: toAgentRunRecord(row as AgentRunRow) };
    },

    async createProposal(
      userId: string,
      input: AgentProposalCreateInput,
    ): Promise<AgentProposalCreateOutcome> {
      // ownership：proposal 归属只经 run
      const owned = await client.agentRun.findFirst({
        where: { id: input.runId, userId },
        select: { id: true },
      });
      if (!owned) return { kind: 'RUN_NOT_FOUND' as const };

      try {
        const created = await client.agentProposal.create({
          data: {
            runId: input.runId,
            revision: input.revision,
            kind: input.kind,
            payload: input.payload as Prisma.InputJsonValue,
            basedOnRefs: input.basedOnRefs as Prisma.InputJsonValue,
          },
        });
        return { kind: 'CREATED' as const, proposal: toAgentProposalRecord(created as AgentProposalRow) };
      } catch (err) {
        // 唯一约束兜底：(runId, revision) 并发命中 → 重读既有（不返回 500）
        if (isPrismaUniqueViolation(err)) {
          const existing = await client.agentProposal.findUnique({
            where: { runId_revision: { runId: input.runId, revision: input.revision } },
          });
          if (!existing) throw err;
          return { kind: 'DUPLICATE' as const, proposal: toAgentProposalRecord(existing as AgentProposalRow) };
        }
        throw err;
      }
    },

    async findProposalForUser(proposalId: string, userId: string): Promise<AgentProposalRecord | null> {
      // 归属经关系过滤：run.userId 必须匹配
      const row = await client.agentProposal.findFirst({
        where: { id: proposalId, run: { userId } },
      });
      return row ? toAgentProposalRecord(row as AgentProposalRow) : null;
    },

    async listProposalsForRun(runId: string, userId: string): Promise<AgentProposalRecord[] | null> {
      const owned = await client.agentRun.findFirst({
        where: { id: runId, userId },
        select: { id: true },
      });
      if (!owned) return null;

      const rows = await client.agentProposal.findMany({
        where: { runId },
        orderBy: [{ revision: 'asc' }, { id: 'asc' }],
      });
      return rows.map((r) => toAgentProposalRecord(r as AgentProposalRow));
    },

      /**
       * T5-B-2B：**单事务**提交计划终态（本阶段唯一新增的仓储方法）。
       *
       * 事务内顺序：① 行级窄锁 + 归属 → ② 源状态判定（Domain 状态机为唯一权威）→
       * ③ 带**当前状态条件**的更新（并发取消竞态下只有一个能命中）→
       * ④ 成功路径在同一事务内创建唯一有效 proposal。
       *
       * 源状态：`PROPOSED` 仅允许 `PLANNING`；`FAILED` 允许 `PLANNING` 或 `CREATED`
       * （D-1：配额预检在进入 `PLANNING` 之前，因此拒绝时为 `CREATED → FAILED`）。
       *
       * 任一步异常 → 整体回滚；**状态更新之后的异常一律抛出**（D-4），
       * 因此不会留下「PROPOSED 无 proposal」或「proposal 无 PROPOSED」。
       */
    async commitPlanOutcome(
      userId: string,
      input: AgentPlanCommitInput,
      now: Date,
    ): Promise<AgentPlanCommitOutcome> {
      return client.$transaction(async (tx): Promise<AgentPlanCommitOutcome> => {
        // ① 归属校验 + 行级窄锁（跨用户 / 不存在一律 NOT_FOUND，不泄露存在性）
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "AgentRun" WHERE id = ${input.runId} AND "userId" = ${userId} FOR UPDATE`;
        if (locked.length === 0) return { kind: 'NOT_FOUND' as const };

        const current = await tx.agentRun.findUnique({ where: { id: input.runId } });
        if (!current) return { kind: 'NOT_FOUND' as const };

        // ② 允许的源状态：
        //    - `PROPOSED`：**仅** `PLANNING`（成功路径语义不变）；
        //    - `FAILED`：`PLANNING` 或 `CREATED`（D-1：配额预检在进入 PLANNING **之前**，
        //      拒绝时 Run 仍是 `CREATED`，须支持 `CREATED → FAILED`）。
        //    终态再次转移 / 已取消 → 一律 `CONFLICT`（写之前判定，合法非提交路径）。
        const to = input.kind === 'PROPOSED' ? 'PROPOSED' : 'FAILED';
        if (!isAgentRunStatus(current.status)) return { kind: 'CONFLICT' as const };
        const allowedFrom: readonly string[] =
          input.kind === 'PROPOSED' ? ['PLANNING'] : ['CREATED', 'PLANNING'];
        if (!allowedFrom.includes(current.status)) return { kind: 'CONFLICT' as const };
        if (evaluateAgentRunTransition(current.status, to) === 'FORBIDDEN') {
          return { kind: 'CONFLICT' as const };
        }
        const endedAt = resolveAgentRunEndedAt(current.endedAt, to, now);

        // ③ 带状态条件的更新：并发下只有一个请求能命中
        const written = await tx.agentRun.updateMany({
          where: { id: input.runId, userId, status: current.status },
          data: {
            status: to,
            endedAt,
            ...(input.kind === 'FAILED' ? { errorCode: input.errorCode } : {}),
          },
        });
        // ⚠️ D-4：状态更新**已执行**，此处不得 `return`（return 会提交事务）→ 必须抛出以整体回滚。
        if (written.count !== 1) {
          throw new AgentPlanCommitInvariantError(
            'AgentRun 状态条件更新未命中：事务内不变量被破坏（状态已变更，须回滚）',
          );
        }

        // ④ 同一事务内创建唯一有效 proposal（仅成功路径）
        let proposal: AgentProposalRecord | null = null;
        if (input.kind === 'PROPOSED') {
          const existing = await tx.agentProposal.findUnique({
            where: { runId_revision: { runId: input.runId, revision: input.proposal.revision } },
            select: { id: true },
          });
          // ⚠️ D-4：同上——状态更新已执行，不得 `return`，必须抛出以整体回滚。
          if (existing) {
            throw new AgentPlanCommitInvariantError(
              'AgentProposal(revision=1) 已存在：事务内不变量被破坏（状态已变更，须回滚）',
            );
          }

          const created = await tx.agentProposal.create({
            data: {
              runId: input.runId,
              revision: input.proposal.revision,
              kind: input.proposal.kind,
              payload: input.proposal.payload as Prisma.InputJsonValue,
              basedOnRefs: input.proposal.basedOnRefs as Prisma.InputJsonValue,
            },
          });
          proposal = toAgentProposalRecord(created as AgentProposalRow);
        }

        const fresh = await tx.agentRun.findUnique({ where: { id: input.runId } });
        if (!fresh) return { kind: 'NOT_FOUND' as const };
        return { kind: 'COMMITTED' as const, run: toAgentRunRecord(fresh as AgentRunRow), proposal };
      });
    },
  };

  type CareerGoalRow = {
    id: string; userId: string; name: string; position: string; location: string | null;
    employmentType: string; status: string; isCurrent: boolean; createdAt: Date; updatedAt: Date;
  };

  // ─── T6-1：CareerGoal 求职目标仓储（用户自著资源；ownership 全强制）────────
  // 边界：跨用户与不存在同形（404 无 oracle）；jdIds 为 replace-set 且逐项校验
  // JD ownership；status 离开 ACTIVE 时同一事务清除 isCurrent（§十一）；
  // **isCurrent 不可经 update 修改**（只能走 setCurrent，单事务 + FOR UPDATE，
  // 部分唯一索引 `CareerGoal_userId_current_key` 为最终防线，P2002 → 409 可重试）。
  const careerGoalLinkInclude = { jds: { select: { jdId: true }, orderBy: { createdAt: 'asc' as const } } };

  function toCareerGoalRecord(row: CareerGoalRow, links: Array<{ jdId: string }>): CareerGoalRecord {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      position: row.position,
      location: row.location,
      employmentType: row.employmentType,
      status: row.status,
      isCurrent: row.isCurrent,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      jdIds: links.map((l) => l.jdId),
    };
  }

  async function filterOwnedJdIdsInTx(tx: Prisma.TransactionClient, userId: string, jdIds: string[]): Promise<string[]> {
    const unique = [...new Set(jdIds)];
    const owned = await tx.jobDescription.findMany({
      where: { id: { in: unique }, userId },
      select: { id: true },
    });
    if (owned.length !== unique.length) return [];
    return unique;
  }

  const careerGoals: CareerGoalRepository = {
    async create(userId, input) {
      const created = await client.careerGoal.create({
        data: {
          userId,
          name: input.name,
          position: input.position,
          ...(input.location === undefined ? {} : { location: input.location }),
          employmentType: input.employmentType,
          status: input.status,
        },
      });
      if (input.jdIds && input.jdIds.length > 0) {
        const owned = await filterOwnedJdIdsInTx(client, userId, input.jdIds);
        if (owned.length === 0) {
          // 关联了不属于该用户的 JD → 不保留孤儿 goal（跨用户探测不泄露具体哪个）
          await client.careerGoal.delete({ where: { id: created.id } });
          return { kind: 'JD_NOT_FOUND' };
        }
        await client.careerGoalJobDescription.createMany({
          data: owned.map((jdId) => ({ careerGoalId: created.id, jdId })),
        });
      }
      const links = await client.careerGoalJobDescription.findMany({
        where: { careerGoalId: created.id },
        select: { jdId: true },
        orderBy: { createdAt: 'asc' },
      });
      return { kind: 'CREATED', goal: toCareerGoalRecord(created as CareerGoalRow, links) };
    },

    async listForUser(userId, filter) {
      const rows = await client.careerGoal.findMany({
        where: {
          userId,
          ...(filter?.status ? { status: filter.status } : {}),
          ...(filter?.current ? { isCurrent: true } : {}),
        },
        include: careerGoalLinkInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      return rows.map((r) => toCareerGoalRecord(r as CareerGoalRow, (r as unknown as { jds: Array<{ jdId: string }> }).jds));
    },

    async findForUser(id, userId) {
      const row = await client.careerGoal.findFirst({ where: { id, userId }, include: careerGoalLinkInclude });
      if (!row) return null;
      return toCareerGoalRecord(row as CareerGoalRow, (row as unknown as { jds: Array<{ jdId: string }> }).jds);
    },

    async update(userId, id, patch) {
      return client.$transaction(async (tx) => {
        const goal = await tx.careerGoal.findFirst({ where: { id, userId }, select: { id: true } });
        if (!goal) return { kind: 'NOT_FOUND' };

        const data: Record<string, unknown> = {};
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.position !== undefined) data.position = patch.position;
        if (patch.location !== undefined) data.location = patch.location;
        if (patch.employmentType !== undefined) data.employmentType = patch.employmentType;
        if (patch.status !== undefined) {
          data.status = patch.status;
          // §十一：离开 ACTIVE → 同一事务清除 isCurrent（CHECK `current_active_check` 为 DB 兜底）
          if (patch.status !== CAREER_GOAL_STATUS.ACTIVE) data.isCurrent = false;
        }

        if (patch.jdIds !== undefined) {
          const owned = await filterOwnedJdIdsInTx(tx, userId, patch.jdIds);
          if (owned.length === 0) return { kind: 'JD_NOT_FOUND' };
          await tx.careerGoalJobDescription.deleteMany({ where: { careerGoalId: goal.id } });
          if (owned.length > 0) {
            await tx.careerGoalJobDescription.createMany({
              data: owned.map((jdId) => ({ careerGoalId: goal.id, jdId })),
            });
          }
        }

        const updated = await tx.careerGoal.update({
          where: { id: goal.id },
          data,
          include: careerGoalLinkInclude,
        });
        if (!isCurrentCompatible(updated.status, updated.isCurrent)) {
          // 构造上不可达（清除在同事务内）；一旦出现必须整体回滚而非返回错误状态
          throw new Error('CAREER_GOAL_CURRENT_INVARIANT_VIOLATED');
        }
        return {
          kind: 'UPDATED',
          goal: toCareerGoalRecord(updated as CareerGoalRow, (updated as unknown as { jds: Array<{ jdId: string }> }).jds),
        };
      });
    },

    async hasJobDescriptionLink(careerGoalId, jdId) {
      const link = await client.careerGoalJobDescription.findFirst({
        where: { careerGoalId, jdId },
        select: { id: true },
      });
      return link !== null;
    },

    async setCurrent(userId, id) {
      return client.$transaction(async (tx) => {
        // 行级窄锁：同一目标上的并发切换在此串行化
        const locked = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "CareerGoal" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE`,
        );
        if (locked.length === 0) return { kind: 'NOT_FOUND' };
        const goal = await tx.careerGoal.findFirst({ where: { id, userId }, include: careerGoalLinkInclude });
        if (!goal) return { kind: 'NOT_FOUND' };
        if (goal.isCurrent) {
          // 幂等：已是当前目标
          return { kind: 'NOOP', goal: toCareerGoalRecord(goal as CareerGoalRow, (goal as unknown as { jds: Array<{ jdId: string }> }).jds) };
        }
        if (goal.status !== CAREER_GOAL_STATUS.ACTIVE) {
          return { kind: 'CONFLICT', reason: 'GOAL_NOT_ACTIVE' };
        }
        // 清除该用户旧 Current（同事务）
        await tx.careerGoal.updateMany({ where: { userId, isCurrent: true }, data: { isCurrent: false } });
        let updated: CareerGoalRow & { jds: Array<{ jdId: string }> };
        try {
          updated = (await tx.careerGoal.update({
            where: { id: goal.id },
            data: { isCurrent: true },
            include: careerGoalLinkInclude,
          })) as unknown as CareerGoalRow & { jds: Array<{ jdId: string }> };
        } catch (err) {
          // 跨目标并发切换的唯一索引竞争 → 409 可重试，不 500
          if (isPrismaUniqueViolation(err)) {
            return { kind: 'CONFLICT', reason: 'CURRENT_SWITCH_RACE' };
          }
          throw err;
        }
        return { kind: 'SET', goal: toCareerGoalRecord(updated, updated.jds) };
      });
    },
  };



  const agentActions: AgentActionRepository = {
    async create(input) {
      const row = await client.agentAction.create({
        data: {
          userId: input.userId,
          runId: input.runId,
          proposalId: input.proposalId,
          toolName: input.toolName,
          payload: input.payload as object,
          status: input.status,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return toAgentActionRecord(row);
    },
    async findForUser(id, userId) {
      const row = await client.agentAction.findFirst({ where: { id, userId } });
      return row ? toAgentActionRecord(row) : null;
    },
    async findByIdempotencyKey(key) {
      const row = await client.agentAction.findUnique({ where: { idempotencyKey: key } });
      return row ? toAgentActionRecord(row) : null;
    },
    async findByProposalId(proposalId) {
      const row = await client.agentAction.findUnique({ where: { proposalId } });
      return row ? toAgentActionRecord(row) : null;
    },
    async updateStatus(id, userId, patch) {
      const row = await client.agentAction.updateMany({
        where: { id, userId, status: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED'] } },
        data: {
          status: patch.status,
          ...(patch.result === undefined ? {} : { result: patch.result as object }),
          ...(patch.errorCode === undefined ? {} : { errorCode: patch.errorCode }),
          ...(patch.errorMessage === undefined ? {} : { errorMessage: patch.errorMessage }),
        },
      });
      if (row.count === 0) return null;
      const fresh = await client.agentAction.findFirst({ where: { id, userId } });
      return fresh ? toAgentActionRecord(fresh) : null;
    },
  };

  return {
    users,
    sessions,
    llmSecrets,
    jds,
    resumeFacts,
    matches,
    resumeEntries,
    suggestions,
    resumeVersions,
    applications,
    resumes,
    capabilities,
    llmUsage,
    actionPlans,
    projectResults,
    learningTasks,
    portfolioProjects,
    interviews,
    ragRetrieval,
    knowledgeIngest,
    agentRuns,
    agentActions,
    careerGoals,
  };
}




type AgentActionRow = {
  id: string; userId: string; runId: string | null; proposalId: string | null;
  toolName: string; payload: unknown; status: string; idempotencyKey: string;
  result: unknown; errorCode: string | null; errorMessage: string | null;
  createdAt: Date; updatedAt: Date;
};

function toAgentActionRecord(row: AgentActionRow) {
  return {
    id: row.id,
    userId: row.userId,
    runId: row.runId,
    proposalId: row.proposalId,
    toolName: row.toolName,
    payload: row.payload,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    result: row.result,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
