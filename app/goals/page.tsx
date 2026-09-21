'use client';

/**
 * T6-1 —— 求职目标（/goals，纯前端消费 5 个 CareerGoal API，零 Agent 耦合）。
 *
 * CareerGoal 是**用户自著资源**：创建 / 编辑 / 设为当前都由用户主动操作，
 * 不是 AI 建议的落地，也不触碰 Fact Authority。
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { api, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { PageHeader } from '../_components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../_components/StatePanel';
import {
  CAREER_GOAL_EMPLOYMENT_TYPE,
  CAREER_GOAL_EMPLOYMENT_TYPE_LABEL,
  CAREER_GOAL_STATUS,
  CAREER_GOAL_STATUS_LABEL,
} from '../../src/domain/career-goal/career-goal.ts';

type Goal = {
  id: string;
  name: string;
  position: string;
  location: string | null;
  employmentType: string;
  status: string;
  isCurrent: boolean;
  createdAt: string;
  jdIds: string[];
};

type JdItem = { id: string; title: string | null; company: string | null };

const EMPLOYMENT_OPTIONS = Object.values(CAREER_GOAL_EMPLOYMENT_TYPE);

export default function GoalsPage() {
  const { user, loading } = useAuth();
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [jds, setJds] = useState<JdItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [position, setPosition] = useState('');
  const [location, setLocation] = useState('');
  const [employmentType, setEmploymentType] = useState<string>(CAREER_GOAL_EMPLOYMENT_TYPE.FULL_TIME);

  const refresh = useCallback(() => {
    if (!user) return;
    api<{ data: { items: Goal[] } }>('/api/career-goals')
      .then((r) => setGoals(r.data.items))
      .catch((e) => setErr(errorText(e)));
    api<{ data: { items: JdItem[] } }>('/api/jds')
      .then((r) => setJds(r.data.items))
      .catch(() => setJds([]));
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function createGoal() {
    if (!name.trim() || !position.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api('/api/career-goals', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          position: position.trim(),
          ...(location.trim() ? { location: location.trim() } : {}),
          employmentType,
        }),
      });
      setName('');
      setPosition('');
      setLocation('');
      refresh();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function setCurrent(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/career-goals/${id}/current`, { method: 'POST' });
      refresh();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(id: string, status: string) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/career-goals/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      refresh();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;

  const jdTitle = (jdId: string) => {
    const j = jds.find((x) => x.id === jdId);
    return j ? `${j.title || '未命名岗位'}${j.company ? ` · ${j.company}` : ''}` : null;
  };

  return (
    <div className="content-wrap">
      <PageHeader
        title="求职目标"
        description="定义你的求职方向，并关联相关岗位。同一时间只能有一个「当前目标」。"
      />

      {err && <div className="banner banner-error mt-16" role="alert">{err}</div>}

      {/* 创建表单 */}
      <div className="card mb-16">
        <h2 className="mb-16" style={{ fontSize: 15 }}>新建求职目标</h2>
        <div className="field">
          <label htmlFor="goal-name">目标名称</label>
          <input id="goal-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="例如：2026 秋招 AI 方向" />
        </div>
        <div className="field">
          <label htmlFor="goal-position">目标岗位</label>
          <input id="goal-position" className="input" value={position} maxLength={80} onChange={(e) => setPosition(e.target.value)} placeholder="例如：AI 应用工程师" />
        </div>
        <div className="field">
          <label htmlFor="goal-location">期望地点（可选）</label>
          <input id="goal-location" className="input" value={location} maxLength={80} onChange={(e) => setLocation(e.target.value)} placeholder="例如：北京 / 远程" />
        </div>
        <div className="field">
          <label htmlFor="goal-type">雇佣类型</label>
          <select id="goal-type" className="select" value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
            {EMPLOYMENT_OPTIONS.map((v) => (
              <option key={v} value={v}>{CAREER_GOAL_EMPLOYMENT_TYPE_LABEL[v]}</option>
            ))}
          </select>
        </div>
        <button className="btn btn-primary" onClick={() => void createGoal()} disabled={busy || !name.trim() || !position.trim()}>
          创建目标
        </button>
      </div>

      {/* 目标列表 */}
      {goals === null ? (
        <LoadingState rows={2} />
      ) : goals.length === 0 ? (
        <EmptyState
          title="还没有求职目标。先创建一个，再关联岗位上手分析。"
          action={
            <button
              className="btn btn-primary"
              onClick={() => (document.getElementById('goal-name') as HTMLInputElement | null)?.focus()}
            >
              创建求职目标 →
            </button>
          }
        />
      ) : (
        goals.map((g) => (
          <div key={g.id} className="card mb-16">
            <div className="row-between mb-8">
              <div>
                <div style={{ fontWeight: 500 }}>{g.name}</div>
                <div className="muted small">
                  {g.position}
                  {g.location ? ` · ${g.location}` : ''} · {CAREER_GOAL_EMPLOYMENT_TYPE_LABEL[g.employmentType as keyof typeof CAREER_GOAL_EMPLOYMENT_TYPE_LABEL] ?? g.employmentType}
                </div>
              </div>
              <div className="row">
                {/* V1 修订 P2：中性 chip——避免与事实确认/能力 CONFIRMED 的绿色视觉语义混淆 */}
                {g.isCurrent && <span className="chip">当前目标</span>}
                <select
                  aria-label="目标状态"
                  className="select"
                  style={{ width: 110 }}
                  value={g.status}
                  disabled={busy}
                  onChange={(e) => void changeStatus(g.id, e.target.value)}
                >
                  {Object.values(CAREER_GOAL_STATUS).map((s) => (
                    <option key={s} value={s}>{CAREER_GOAL_STATUS_LABEL[s]}</option>
                  ))}
                </select>
                {!g.isCurrent && g.status === 'ACTIVE' && (
                  <button className="btn btn-secondary" disabled={busy} onClick={() => void setCurrent(g.id)}>
                    设为当前
                  </button>
                )}
              </div>
            </div>
            {g.jdIds.length > 0 && (
              <div className="small mt-8">
                已关联岗位：
                {g.jdIds.map((id) => {
                  const t = jdTitle(id);
                  return t ? (
                    <Link key={id} href="/jds" className="chip chip-unconfirmed" style={{ textDecoration: 'none', margin: '0 6px 6px 0' }}>
                      {t} →
                    </Link>
                  ) : (
                    <span key={id} className="muted small" style={{ marginRight: 6 }}>（岗位已删除）</span>
                  );
                })}
                <Link href="/jds" className="muted small">去分析岗位 →</Link>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
