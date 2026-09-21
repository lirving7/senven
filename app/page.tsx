'use client';

/**
 * 首页 —— AI 求职工作台（Workbench Home）。
 *
 * 定位：不是数据 Dashboard，是「现在该做什么」的工作台。
 * 结构（自上而下）：
 *   1. PageHeader            —— 页面标题 + 当前求职目标上下文
 *   2. 当前求职任务          —— 一级信息（现况 + 唯一主 CTA）
 *   3. 求职工作流            —— 二级信息（六步，顺序 + 真实状态）
 *   4. 最近工作              —— 三级信息（真实存在的简历 / 岗位 / 计划）
 *   5. 求职概览              —— 补充事实（投递分布 / 待关注 / 模拟面试）
 *
 * 数据来源（**全部为既有只读 GET，零新增后端**）：
 *   - GET /api/dashboard/overview   核心聚合（唯一关键接口）
 *   - GET /api/resumes              「我的简历」列表（四态计数）
 *   - GET /api/jds                  岗位列表
 *   - GET /api/action-plans         行动计划列表
 *   Match 无服务端列表接口：仅以 localStorage `jp_last_match_run_${user.id}`
 *   表达「本机是否跑过匹配分析」这一客户端事实，不推断匹配结果。
 *
 * 失败隔离：overview 失败 → 核心错误态；其余三个接口各自独立降级，
 *           任一失败都不影响首页其余区域，也不显示假数据。
 * 真实优先：无数据一律 EmptyState，不构造 mock。
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from './_lib/api';
import { useAuth } from './_lib/auth';
import { EmptyState, ErrorState, LoadingState } from './_components/StatePanel';
import { PageHeader } from './_components/PageHeader';
import {
  IconAlert,
  IconArrowRight,
  IconChevronRight,
  IconFileSearch,
  IconIdCard,
  IconListChecks,
  IconMic,
  IconScale,
  IconSend,
  IconSparkle,
} from './_components/icons';

/* ══════════════════════════════════════════════════════════════════
   类型：与既有接口响应逐字段对应（不新增、不推断）
   ══════════════════════════════════════════════════════════════════ */

type GoalView = {
  id: string;
  name: string;
  position: string;
  location: string | null;
  employmentType: string;
  status: string;
  isCurrent: boolean;
  jdCount: number;
};

type RecentApplication = {
  id: string;
  company: string;
  position: string | null;
  stage: string;
  appliedAt: string;
  updatedAt: string;
};

type Reminder = {
  kind: 'FACT_REMINDER';
  rule: 'APPLICATION_STALE_7D';
  applicationId: string;
  company: string;
  position: string | null;
  staleDays: number;
  message: string;
};

type Overview = {
  generatedAt: string;
  currentGoal: GoalView | null;
  goals: { total: number; active: number; hasCurrent: boolean };
  funnel: {
    total: number;
    APPLIED: number;
    SCREENING: number;
    INTERVIEWING: number;
    OFFER: number;
    REJECTED: number;
    WITHDRAWN: number;
  };
  goalScoped: { applications: number; interviewing: number; offer: number } | null;
  recentApplications: RecentApplication[];
  activity: {
    appliedLast7Days: number;
    appliedLast30Days: number;
    lastAppliedAt: string | null;
    staleOver7Days: number;
  };
  interviews: { total: number; active: number };
  reminders: Reminder[];
  aiAdvice: null;
};

type ResumeListItem = {
  id: string;
  sourceType: string;
  createdAt: string;
  itemCount: number;
  statusSummary: { confirmed: number; inferred: number; unconfirmed: number };
};

type JdListItem = {
  id: string;
  /** 真实数据中可能为 null（已核实 DB 存在 title/company 为 null 的行） */
  title: string | null;
  company: string | null;
  requirementCount: number;
  createdAt: string;
};

type ActionPlanItem = {
  id: string;
  matchRunId: string;
  jdId: string;
  /** 真实数据中可能为 null */
  goal: string | null;
  have: string;
  gaps: string;
  actions: { id: string; order: number; title: string; desc: string; status: string; targetRequirement: string }[];
  createdAt: string;
};

/** 独立加载的次级数据源状态（与 overview 隔离，任一失败不影响其余区域）。
 *  判别联合：`state === 'ready'` 时 `data` 必为非空，便于类型收窄。 */
type Side<T> =
  | { state: 'loading'; data: null }
  | { state: 'ready'; data: T }
  | { state: 'error'; data: null };

const SIDE_LOADING = { state: 'loading', data: null } as const;

/* ══════════════════════════════════════════════════════════════════
   文案常量
   ══════════════════════════════════════════════════════════════════ */

const STAGE_LABEL: Record<string, string> = {
  APPLIED: '已投递',
  SCREENING: '简历筛选中',
  INTERVIEWING: '面试中',
  OFFER: 'Offer',
  REJECTED: '未通过',
  WITHDRAWN: '已撤回',
};

const EMPLOYMENT_TYPE_LABEL: Record<string, string> = {
  FULL_TIME: '全职',
  PART_TIME: '兼职',
  INTERNSHIP: '实习',
  CONTRACT: '合同制',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 简历来源标签：与既有 /resumes 页保持一致的口径（TEXT → 粘贴文本，其余原样）。
 *  不新增业务判定，仅复用仓库已有映射。 */
function sourceTypeLabel(sourceType: string): string {
  return sourceType === 'TEXT' ? '粘贴文本' : sourceType;
}

/* ══════════════════════════════════════════════════════════════════
   求职工作流：六步定义
   状态口径（全部为保守事实表达，无自造业务判定）：
     done     —— 仓库中已有明确事实依据（如已投递数 > 0）
     progress —— 已开始但未完成（用真实计数描述，不推断「完成」）
     todo     —— 尚未开始
   ══════════════════════════════════════════════════════════════════ */

type StepState = 'done' | 'progress' | 'todo';

type WorkflowStep = {
  key: string;
  label: string;
  href: string;
  icon: (props: { size?: number }) => React.ReactElement;
  state: StepState;
  /** 状态描述：只陈述真实计数 / 事实，不写自造完成条件 */
  detail: string;
};

/* ══════════════════════════════════════════════════════════════════
   页面
   ══════════════════════════════════════════════════════════════════ */

export default function HomePage() {
  const { user, loading } = useAuth();

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewErr, setOverviewErr] = useState<string | null>(null);

  const [resumes, setResumes] = useState<Side<ResumeListItem[]>>(SIDE_LOADING);
  const [jds, setJds] = useState<Side<JdListItem[]>>(SIDE_LOADING);
  const [plans, setPlans] = useState<Side<ActionPlanItem[]>>(SIDE_LOADING);

  /** 本机最近一次 Match Run（客户端事实，非服务端数据，不参与任何结果推断） */
  const [hasLocalMatch, setHasLocalMatch] = useState(false);

  const loadOverview = useCallback(async () => {
    setOverviewErr(null);
    setOverview(null);
    try {
      const r = await api<{ data: Overview }>('/api/dashboard/overview');
      setOverview(r.data);
    } catch (e) {
      setOverviewErr(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadOverview();

    // 三个次级接口各自独立加载与降级：任一失败只影响自身区域
    api<{ data: { items: ResumeListItem[] } }>('/api/resumes')
      .then((r) => setResumes({ state: 'ready', data: r.data.items }))
      .catch(() => setResumes({ state: 'error', data: null }));

    api<{ data: { items: JdListItem[] } }>('/api/jds')
      .then((r) => setJds({ state: 'ready', data: r.data.items }))
      .catch(() => setJds({ state: 'error', data: null }));

    api<{ data: { items: ActionPlanItem[] } }>('/api/action-plans')
      .then((r) => setPlans({ state: 'ready', data: r.data.items }))
      .catch(() => setPlans({ state: 'error', data: null }));

    // localStorage 仅在客户端可得；缺失属于正常状态（= 本机尚未跑过匹配），不是错误
    try {
      setHasLocalMatch(localStorage.getItem(`jp_last_match_run_${user.id}`) !== null);
    } catch {
      setHasLocalMatch(false);
    }
  }, [user, loadOverview]);

  if (loading || !user) {
    return (
      <div className="content-wrap">
        <LoadingState rows={3} />
      </div>
    );
  }

  // overview 是首页核心数据：失败 → 核心错误态（次级区域不渲染，避免半页信息误导）
  if (overviewErr) {
    return (
      <div className="content-wrap">
        <PageHeader title="工作台" description="你的 AI 求职工作台。" />
        <ErrorState message={overviewErr} onRetry={() => void loadOverview()} />
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="content-wrap">
        <LoadingState rows={4} />
      </div>
    );
  }

  const { currentGoal, funnel, recentApplications, activity, reminders } = overview;

  const resumeCount = resumes.state === 'ready' ? resumes.data.length : 0;
  const jdCount = jds.state === 'ready' ? jds.data.length : 0;
  const planCount = plans.state === 'ready' ? plans.data.length : 0;

  /* ── 六步工作流状态推导：只使用真实计数，无自造「完成」判定 ── */
  const steps: WorkflowStep[] = [
    {
      key: 'resume',
      label: '简历',
      href: '/resumes',
      icon: IconIdCard,
      state: resumeCount > 0 ? 'progress' : 'todo',
      detail:
        resumes.state === 'error'
          ? '暂时无法获取'
          : resumes.state === 'loading'
            ? '正在读取'
            : resumeCount > 0
              ? `已添加 ${resumeCount} 份`
              : '尚未开始',
    },
    {
      key: 'jd',
      label: '岗位 JD',
      href: '/jds',
      icon: IconFileSearch,
      state: jdCount > 0 ? 'progress' : 'todo',
      detail:
        jds.state === 'error'
          ? '暂时无法获取'
          : jds.state === 'loading'
            ? '正在读取'
            : jdCount > 0
              ? `已分析 ${jdCount} 个`
              : '尚未开始',
    },
    {
      key: 'match',
      label: '匹配分析',
      href: '/match',
      icon: IconScale,
      // 只表达「本机是否跑过」，不推断匹配结果
      state: hasLocalMatch ? 'progress' : 'todo',
      detail: hasLocalMatch ? '本机已有匹配记录' : '尚未进行匹配分析',
    },
    {
      key: 'suggest',
      label: '修改建议',
      href: '/suggest',
      icon: IconSparkle,
      // 有 Match ≠ 修改建议已完成：无证据表明完成时一律「尚未开始」
      state: 'todo',
      detail: hasLocalMatch ? '待处理' : '尚未开始',
    },
    {
      key: 'plan',
      label: '行动计划',
      href: '/action-plans',
      icon: IconListChecks,
      state: planCount > 0 ? 'progress' : 'todo',
      detail:
        plans.state === 'error'
          ? '暂时无法获取'
          : plans.state === 'loading'
            ? '正在读取'
            : planCount > 0
              ? `已生成 ${planCount} 份`
              : '尚未开始',
    },
    {
      key: 'apply',
      label: '投递',
      href: '/applications',
      icon: IconSend,
      state: funnel.total > 0 ? 'progress' : 'todo',
      detail: funnel.total > 0 ? `已投递 ${funnel.total} 次` : '尚未开始',
    },
  ];

  const doneCount = steps.filter((s) => s.state === 'done').length;
  const startedCount = steps.filter((s) => s.state !== 'todo').length;

  /* ── 下一步行动：由真实状态推导的**单一**主 CTA（不新增业务判断） ── */
  const nextAction: { title: string; desc: string; href: string; label: string } = (() => {
    if (resumeCount === 0) {
      return {
        title: '上传并确认第一份简历',
        desc: '工作流从你的真实经历开始：上传后逐条确认，后续所有分析都基于已确认的事实。',
        href: '/resumes',
        label: '上传简历',
      };
    }
    if (jdCount === 0) {
      return {
        title: '添加一个目标岗位',
        desc: '粘贴岗位描述，解析出分级要求清单，作为与简历对照的依据。',
        href: '/jds',
        label: '分析岗位',
      };
    }
    if (!hasLocalMatch) {
      return {
        title: '把简历与岗位做一次对照',
        desc: '逐条比对已确认经历与岗位要求，得到覆盖情况与缺口清单。',
        href: '/match',
        label: '开始对照',
      };
    }
    if (planCount === 0) {
      return {
        title: '生成行动计划',
        desc: '把对照结果转化为可执行的步骤，明确每一步要补什么。',
        href: '/action-plans',
        label: '生成计划',
      };
    }
    if (funnel.total === 0) {
      return {
        title: '记录你的第一次投递',
        desc: '开始跟踪投递进度，工作台会据此汇总你的求职状态。',
        href: '/applications',
        label: '记录投递',
      };
    }
    return {
      title: '继续跟踪你的求职进度',
      desc: `当前共有 ${funnel.total} 条投递记录，其中 ${funnel.INTERVIEWING} 条进入面试阶段。`,
      href: '/applications',
      label: '查看求职进度',
    };
  })();

  const recentResume = resumes.state === 'ready' ? resumes.data[0] : undefined;
  const recentJd = jds.state === 'ready' ? jds.data[0] : undefined;
  const recentPlan = plans.state === 'ready' ? plans.data[0] : undefined;
  const hasRecent = Boolean(recentResume || recentJd || recentPlan);

  return (
    <div className="content-wrap">
      {/* ─── 1. 页面头部：上下文（当前目标）+ 标题 ─── */}
      <PageHeader
        title="工作台"
        description="从已确认的真实经历出发，对照目标岗位，推进你的求职。"
        eyebrow={
          currentGoal ? (
            <>
              <span>当前目标</span>
              <span aria-hidden="true">·</span>
              <span className="wb-eyebrow-strong">{currentGoal.name}</span>
              <span aria-hidden="true">·</span>
              <span>{currentGoal.position}</span>
            </>
          ) : (
            <span>尚未设置当前求职目标</span>
          )
        }
      />

      {/* ─── 2. 当前求职任务（一级信息） + 3. 求职工作流（二级信息）───
           ≥1280px 时两者并排；窄屏纵向堆叠（见 globals.css §20.4b） */}
      <div className="wb-worktop">
        <section className="wb-task" aria-labelledby="wb-task-title">
          <div className="wb-task-main">
            <p className="wb-task-kicker">推荐下一步</p>
            <h2 className="wb-task-title" id="wb-task-title">
              {nextAction.title}
            </h2>
            <p className="wb-task-desc">{nextAction.desc}</p>
          </div>
          <div className="wb-task-side">
            <div className="wb-task-progress">
              <span className="wb-task-progress-num">
                {startedCount}
                <span className="wb-task-progress-sep">/</span>
                {steps.length}
              </span>
              <span className="wb-task-progress-label">工作流步骤已开始</span>
            </div>
            <Link className="btn btn-primary wb-task-cta" href={nextAction.href}>
              {nextAction.label}
              <IconArrowRight size={16} />
            </Link>
          </div>
        </section>

        {/* ─── 3. 求职工作流（二级信息）：顺序 + 真实状态，非六张相同卡片 ─── */}
        <section className="wb-section" aria-labelledby="wb-flow-title">
          <div className="wb-section-head">
            <h2 className="wb-section-title" id="wb-flow-title">
              求职工作流
            </h2>
            <p className="wb-section-note">
              共 {steps.length} 步，已开始 {startedCount} 步
            </p>
          </div>
          <ol className="wb-flow">
            {steps.map((s, i) => {
              const Icon = s.icon;
              return (
                <li key={s.key} className={`wb-flow-item is-${s.state}`}>
                  <Link className="wb-flow-link" href={s.href}>
                    <span className="wb-flow-marker" aria-hidden="true">
                      <span className="wb-flow-index">{i + 1}</span>
                      <Icon size={18} />
                    </span>
                    <span className="wb-flow-body">
                      <span className="wb-flow-label">
                        {s.label}
                        <span className="wb-flow-state">
                          <StateMark state={s.state} />
                          {STATE_TEXT[s.state]}
                        </span>
                      </span>
                      <span className="wb-flow-detail">{s.detail}</span>
                    </span>
                    <span className="wb-flow-chevron" aria-hidden="true">
                      <IconChevronRight size={16} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      </div>

      {/* ─── 4. 最近工作（三级信息）：只展示真实存在的条目 ─── */}
      <section className="wb-section" aria-labelledby="wb-recent-title">
        <div className="wb-section-head">
          <h2 className="wb-section-title" id="wb-recent-title">
            最近工作
          </h2>
        </div>
        {!hasRecent ? (
          <EmptyState
            title="还没有可继续的内容"
            description="上传简历或添加岗位后，最近的记录会出现在这里。"
            action={
              <Link className="btn btn-secondary" href="/resumes">
                从简历开始
              </Link>
            }
          />
        ) : (
          <ul className="wb-recent">
            {recentResume && (
              <RecentRow
                href={`/resumes/${recentResume.id}`}
                icon={<IconIdCard size={18} />}
                kind="简历"
                title={sourceTypeLabel(recentResume.sourceType)}
                detail={`${recentResume.itemCount} 条经历 · 已确认 ${recentResume.statusSummary.confirmed} 项 · 待确认 ${recentResume.statusSummary.unconfirmed + recentResume.statusSummary.inferred} 项`}
                time={recentResume.createdAt}
              />
            )}
            {recentJd && (
              <RecentRow
                href={`/jds?jdId=${recentJd.id}`}
                icon={<IconFileSearch size={18} />}
                kind="岗位"
                title={recentJd.title?.trim() || '未命名岗位'}
                detail={
                  recentJd.company?.trim()
                    ? `${recentJd.company} · ${recentJd.requirementCount} 条要求`
                    : `${recentJd.requirementCount} 条要求`
                }
                time={recentJd.createdAt}
              />
            )}
            {recentPlan && (
              <RecentRow
                href={`/action-plans/${recentPlan.id}`}
                icon={<IconListChecks size={18} />}
                kind="行动计划"
                title={recentPlan.goal?.trim() || '行动计划'}
                detail={`${recentPlan.actions.length} 个步骤`}
                time={recentPlan.createdAt}
              />
            )}
          </ul>
        )}
      </section>

      {/* ─── 5. 求职概览（补充事实，非一级信息） ─── */}
      <section className="wb-section" aria-labelledby="wb-overview-title">
        <div className="wb-section-head">
          <h2 className="wb-section-title" id="wb-overview-title">
            求职概览
          </h2>
          {currentGoal && (
            <Link className="wb-section-link" href="/goals">
              切换目标
            </Link>
          )}
        </div>

        {!currentGoal && (
          <div className="wb-notice">
            <IconAlert size={18} />
            <div className="wb-notice-body">
              <p className="wb-notice-title">尚未设置当前求职目标</p>
              <p className="wb-notice-desc">
                投递记录会按求职目标汇总。设置目标后，这里会显示对应进展。
              </p>
            </div>
            <Link className="btn btn-secondary" href="/goals">
              设置目标
            </Link>
          </div>
        )}

        <div className="wb-ov-grid">
          {/* 投递分布 */}
          <div className="wb-ov-card">
            <h3 className="wb-ov-title">投递状态</h3>
            {funnel.total === 0 ? (
              <p className="wb-ov-empty">
                还没有投递记录，去 <Link href="/applications">记录第一次投递</Link>。
              </p>
            ) : (
              <dl className="wb-ov-stats">
                <div>
                  <dt>已投递</dt>
                  <dd>{funnel.total}</dd>
                </div>
                <div>
                  <dt>筛选中</dt>
                  <dd>{funnel.SCREENING}</dd>
                </div>
                <div>
                  <dt>面试中</dt>
                  <dd>{funnel.INTERVIEWING}</dd>
                </div>
                <div>
                  <dt>Offer</dt>
                  <dd>{funnel.OFFER}</dd>
                </div>
                <div>
                  <dt>未通过</dt>
                  <dd>{funnel.REJECTED}</dd>
                </div>
                <div>
                  <dt>已撤回</dt>
                  <dd>{funnel.WITHDRAWN}</dd>
                </div>
              </dl>
            )}
          </div>

          {/* 待关注（真实 FACT Reminder，非 AI 建议） */}
          <div className="wb-ov-card">
            <h3 className="wb-ov-title">待关注</h3>
            {reminders.length === 0 ? (
              <p className="wb-ov-empty">暂无需要关注的事项。</p>
            ) : (
              <>
                <p className="wb-ov-lead">
                  有 {activity.staleOver7Days} 个投递超过 7 天未更新
                </p>
                <ul className="wb-ov-list">
                  {reminders.map((r) => (
                    <li key={r.applicationId}>
                      <Link href={`/applications?a=${r.applicationId}`}>{r.message}</Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {/* 模拟面试（真实最小统计） */}
          <div className="wb-ov-card">
            <h3 className="wb-ov-title">模拟面试</h3>
            <dl className="wb-ov-stats">
              <div>
                <dt>累计场次</dt>
                <dd>{overview.interviews.total}</dd>
              </div>
              <div>
                <dt>进行中</dt>
                <dd>{overview.interviews.active}</dd>
              </div>
            </dl>
            <p className="wb-ov-foot">
              <Link href="/interview">
                进入模拟面试
                <IconMic size={14} />
              </Link>
            </p>
          </div>
        </div>
      </section>

      {/* ─── 6. 全部功能入口（保持既有达链，含 /agent） ─── */}
      <section className="wb-section" aria-labelledby="wb-all-title">
        <div className="wb-section-head">
          <h2 className="wb-section-title" id="wb-all-title">
            全部功能
          </h2>
        </div>
        <div className="entry-grid">
          {ENTRIES.map((e) => (
            <Link key={e.href} href={e.href} className="entry-card">
              <span className="entry-icon" aria-hidden="true">
                <e.icon size={18} />
              </span>
              <span className="entry-title">{e.title}</span>
              <span className="entry-desc">{e.desc}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════
   子组件
   ══════════════════════════════════════════════════════════════════ */

const STATE_TEXT: Record<StepState, string> = {
  done: '已完成',
  progress: '进行中',
  todo: '未开始',
};

/**
 * 状态标记：形状 + 文字双编码（不依赖颜色）。
 * done     —— 实心圆 + 勾
 * progress —— 半环（进行中）
 * todo     —— 空心圆
 */
function StateMark({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <circle cx="6" cy="6" r="5" fill="var(--fill-confirmed)" />
        <path
          d="M3.5 6.2l1.8 1.8 3.2-3.4"
          stroke="#fff"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (state === 'progress') {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6 1 a5 5 0 0 1 0 10 z" fill="var(--fill-inferred)" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function RecentRow({
  href,
  icon,
  kind,
  title,
  detail,
  time,
}: {
  href: string;
  icon: React.ReactNode;
  kind: string;
  title: string;
  detail: string;
  time: string;
}) {
  return (
    <li className="wb-recent-item">
      <Link className="wb-recent-link" href={href}>
        <span className="wb-recent-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="wb-recent-body">
          <span className="wb-recent-kind">{kind}</span>
          <span className="wb-recent-title">{title}</span>
          <span className="wb-recent-detail">{detail}</span>
        </span>
        <span className="wb-recent-time">{formatDate(time)}</span>
        <span className="wb-flow-chevron" aria-hidden="true">
          <IconChevronRight size={16} />
        </span>
      </Link>
    </li>
  );
}

/* ── 全部功能入口（含 /agent：为既有 UI contract 保留） ── */
const ENTRIES: { href: string; title: string; desc: string; icon: (p: { size?: number }) => React.ReactElement }[] = [
  { href: '/resumes', title: '我的简历', desc: '上传并管理简历，逐条确认真实经历', icon: IconIdCard },
  { href: '/jds', title: '分析岗位', desc: '粘贴 JD，解析出分级要求清单', icon: IconFileSearch },
  { href: '/match', title: '岗位对照', desc: '简历与 JD 逐条比对，生成行动计划', icon: IconScale },
  { href: '/applications', title: '我的求职', desc: '跟踪投递进度与状态流转', icon: IconSend },
  { href: '/agent', title: 'AI 求职助手', desc: '基于简历、岗位与对照结果，生成 AI 行动建议', icon: IconSparkle },
  { href: '/projects', title: '制作项目', desc: '把能力缺口变成可写进简历的项目', icon: IconListChecks },
  { href: '/learn', title: '学习提升', desc: '记录学习任务进度，把学习过程变成可追溯记录', icon: IconListChecks },
  { href: '/interview', title: '模拟面试', desc: '基于 JD 动态追问，练真实表达', icon: IconMic },
];
