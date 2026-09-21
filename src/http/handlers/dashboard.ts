/**
 * T6-3-C —— Dashboard 2.0 Overview handler（**唯一核心聚合接口**：GET /api/dashboard/overview）。
 *
 * 架构冻结（授权书 §二–§十三）：
 *   - Dashboard 是 Read Model / Aggregation Layer，不是 Domain Entity：
 *     零新表 / 零 migration / 零独立 query layer / 零 cache / 零 Agent Tool；
 *   - 纯 FACT 聚合：aiAdvice 固定 null，interviews 固定 null；
 *     **禁止**调用 Agent Runtime / Provider / 创建 AgentRun / 消耗 Agent quota / 调用 LLM；
 *   - 全部数据基于 session.userId；前端不得传 userId；
 *   - 复用既有仓储能力：countStagesForUser（funnel/goalScoped/activity/stale）+
 *     listForUser（recentApplications/lastAppliedAt）+ CareerGoalRepository.listForUser；
 *   - 集合级查询（≤8 个），禁止 N+1；
 *   - currentGoal 只取 CareerGoal.isCurrent，无则 null，**不得自动选择 / setCurrent**。
 */

import { appError, ERROR_CODE } from '../../errors.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId } from '../request.ts';
import type { AuthService } from '../../auth/service.ts';
import type { Clock, ApplicationRepository, CareerGoalRepository, InterviewRepository } from '../../ports/index.ts';

export type DashboardHandlerDeps = {
  auth: AuthService;
  careerGoals: CareerGoalRepository;
  applications: ApplicationRepository;
  /**
   * Interview V2-A（§五）：只读 Interview 统计依赖。
   * 仅调用 listForUser 派生计数 —— 零写入、零 LLM、零新表。
   */
  interviews: InterviewRepository;
  clock: Clock;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** stale 口径：updatedAt 超过 7×24h 未更新且 stage 不是 REJECTED / WITHDRAWN（§十） */
const STALE_AFTER_MS = 7 * DAY_MS;
const STALE_EXCLUDED_STAGES = ['REJECTED', 'WITHDRAWN'] as const;
/** recentApplications 最多 5 条（§八） */
const RECENT_LIMIT = 5;
/** reminders 第一版规则（§十） */
const REMINDER_RULE_APPLICATION_STALE_7D = 'APPLICATION_STALE_7D';
const STALE_LIST_LIMIT = 20;

/** FACT Reminder 结构：kind 明确标识 FACT_DERIVED，不带评分 / AI 措辞 */
export type FactReminder = {
  kind: 'FACT_REMINDER';
  rule: 'APPLICATION_STALE_7D';
  applicationId: string;
  company: string;
  position: string | null;
  /** updatedAt 距今的整天数（向下取整） */
  staleDays: number;
  message: string;
};

async function requireUser(deps: DashboardHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

export function createGetDashboardOverviewHandler(deps: DashboardHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const now = deps.clock.now();
      const userId = user.id;

      // ① 目标集合（1 查询）：total / active / hasCurrent / currentGoal 同源派生
      const goals = await deps.careerGoals.listForUser(userId);
      const currentGoal = goals.find((g) => g.isCurrent) ?? null;
      const goalsView = {
        total: goals.length,
        active: goals.filter((g) => g.status === 'ACTIVE').length,
        hasCurrent: currentGoal !== null,
      };

      // ② funnel（1 查询）：复用 T6-2 countStagesForUser，语义与 /api/applications counts 完全一致
      const counts = await deps.applications.countStagesForUser(userId);
      const funnel = {
        total: counts.total,
        APPLIED: counts.applied,
        SCREENING: counts.screening,
        INTERVIEWING: counts.interviewing,
        OFFER: counts.offer,
        REJECTED: counts.rejected,
        WITHDRAWN: counts.withdrawn,
      };

      // ③ goalScoped（有 currentGoal 时 1 查询）：按 careerGoalId 复用 countStagesForUser
      const goalScoped = currentGoal
        ? await (async () => {
            const c = await deps.applications.countStagesForUser(userId, { careerGoalId: currentGoal.id });
            return { applications: c.total, interviewing: c.interviewing, offer: c.offer };
          })()
        : null;

      // ④ 最近申请（1 查询）：appliedAt DESC + updatedAt 次级稳定排序；同时派生 lastAppliedAt
      const recent = await deps.applications.listForUser(userId, { limit: RECENT_LIMIT });
      const recentApplications = recent.map((r) => ({
        id: r.id,
        company: r.company,
        position: r.position,
        stage: r.stage,
        appliedAt: r.appliedAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));

      // ⑤⑥ 活动（2 查询）：appliedAfter DB 侧过滤，禁止读全量后 JS 过滤
      const last7 = await deps.applications.countStagesForUser(userId, {
        appliedAfter: new Date(now.getTime() - 7 * DAY_MS),
      });
      const last30 = await deps.applications.countStagesForUser(userId, {
        appliedAfter: new Date(now.getTime() - 30 * DAY_MS),
      });

      // ⑦⑧ stale（2 查询）：计数走 countStagesForUser（精确、不受列表上限影响）；
      //     reminders 取前若干条做客观描述（事实派生，非 AI，不持久化）
      const staleFilter = {
        updatedBefore: new Date(now.getTime() - STALE_AFTER_MS),
        stageNotIn: [...STALE_EXCLUDED_STAGES],
      };
      const staleCounts = await deps.applications.countStagesForUser(userId, staleFilter);
      const staleRows = await deps.applications.listForUser(userId, {
        ...staleFilter,
        limit: STALE_LIST_LIMIT,
      });
      const reminders: FactReminder[] = staleRows.map((r) => {
        const staleDays = Math.max(0, Math.floor((now.getTime() - r.updatedAt.getTime()) / DAY_MS));
        return {
          kind: 'FACT_REMINDER',
          rule: REMINDER_RULE_APPLICATION_STALE_7D,
          applicationId: r.id,
          company: r.company,
          position: r.position,
          staleDays,
          message:
            r.position !== null
              ? `「${r.company} · ${r.position}」投递已 ${staleDays} 天未更新`
              : `「${r.company}」投递已 ${staleDays} 天未更新`,
        };
      });

      // ⑨ Interview 最小统计（Interview V2-A §五）：只读 listForUser 派生。
      //     total = 全部 session（active + ended）；active = 未结束（endedAt 为 null）。
      //     不读 Turn 细节、不调 LLM、不新建表。
      const interviewSessions = await deps.interviews.listForUser(userId);
      const interviewsView = {
        total: interviewSessions.length,
        active: interviewSessions.filter((s) => s.endedAt === null).length,
      };

      return jsonResponse(200, {
        data: {
          generatedAt: now.toISOString(),
          currentGoal: currentGoal
            ? {
                id: currentGoal.id,
                name: currentGoal.name,
                position: currentGoal.position,
                location: currentGoal.location,
                employmentType: currentGoal.employmentType,
                status: currentGoal.status,
                isCurrent: currentGoal.isCurrent,
                /** 当前目标绑定的 JD 数（来自 CareerGoalRecord.jdIds，供「当前目标」卡片展示） */
                jdCount: currentGoal.jdIds.length,
              }
            : null,
          goals: goalsView,
          funnel,
          goalScoped,
          recentApplications,
          activity: {
            appliedLast7Days: last7.total,
            appliedLast30Days: last30.total,
            lastAppliedAt: recent.length > 0 ? recent[0]!.appliedAt.toISOString() : null,
            staleOver7Days: staleCounts.total,
          },
          // Interview V2-A（§五）：由恒 null 改为真实最小统计（仅 count 派生，见 ⑨）
          interviews: interviewsView,
          reminders,
          aiAdvice: null,
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
