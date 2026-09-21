'use client';

/**
 * T3-A2-6 Phase 3 —— /learn 学习提升首页。
 *
 * 边界（冻结约束）：
 * - 只调用 `GET /api/learning-tasks` 展示 active LearningTask；
 * - 状态只显示 PLANNED / IN_PROGRESS / PAUSED（不得出现 DONE/COMPLETED/VERIFIED/ARCHIVED 枚举）；
 * - 不直接写事实层；不调用 provider；不新增 API。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { EmptyState, ErrorState, LoadingState } from '../_components/StatePanel';
import { PageHeader } from '../_components/PageHeader';

type LearningTaskItem = {
  id: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
  status: 'PLANNED' | 'IN_PROGRESS' | 'PAUSED';
  updatedAt: string;
};

const STATUS_LABEL: Record<string, string> = { PLANNED: '待开始', IN_PROGRESS: '进行中', PAUSED: '已暂停' };
const STATUS_CHIP: Record<string, string> = {
  PLANNED: 'chip chip-unconfirmed',
  IN_PROGRESS: 'chip chip-inferred',
  PAUSED: 'chip chip-missing',
};

export default function LearnPage() {
  const { user, loading } = useAuth();
  const [items, setItems] = useState<LearningTaskItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api<{ data: { items: LearningTaskItem[] } }>('/api/learning-tasks')
      .then((r) => setItems(r.data.items))
      .catch((e) => setError(errorText(e)));
  }

  useEffect(() => {
    if (!user) return;
    load();
  }, [user]);

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;
  if (error) return <div className="content-wrap"><ErrorState message={error} onRetry={load} /></div>;

  return (
    <div className="content-wrap">
      <PageHeader
        title="学习提升"
        description="这里记录你在行动计划中每个「学习」步骤的推进状态。学习过程本身不构成能力证据，能力确认仍需来自可核验的项目成果。"
      />

      {items && items.length === 0 ? (
        <EmptyState
          title="还没有学习任务。请先到「岗位行动计划」生成包含 [学习] 步骤的计划，再从步骤入口创建学习任务。"
          action={<Link className="btn btn-primary" href="/match">去岗位对照，生成行动计划 →</Link>}
        />
      ) : (
        <section className="card">
          <h2>我的学习任务</h2>
          {items?.map((i) => (
            <div key={i.id} className="row-between" style={{ padding: '8px 0' }}>
              <Link href={`/learn/${i.id}`} className="btn-ghost" style={{ textAlign: 'left' }}>
                {i.sourceStepTitle}
              </Link>
              <span className="row">
                <span className={STATUS_CHIP[i.status] ?? 'chip'}>{STATUS_LABEL[i.status] ?? i.status}</span>
                <span className="muted small">更新于 {new Date(i.updatedAt).toLocaleString()}</span>
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
