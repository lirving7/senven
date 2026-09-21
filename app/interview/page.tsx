'use client';

/**
 * Interview V2-A —— 模拟面试列表页（§三）。
 *
 * 只消费既有 API：
 *   GET  /api/interview-sessions       列表（active + ended）
 *   GET  /api/jds                      JD 下拉（只读本人数据）
 *   POST /api/interview-sessions       创建（topic + 可选 jdId）
 *
 * 防重：startTask 同 key 去重（G-4，key 含 userId）；
 * ownership：前端不判 userId，全部交给后端 401/404 语义。
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { api, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { PageHeader } from '../_components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../_components/StatePanel';
import { startTask } from '../_lib/task-session';
import {
  INTERVIEW_MAX_TURNS,
  INTERVIEW_TOPIC_MAX,
  interviewTaskKey,
  isInterviewEnded,
  isValidInterviewTopic,
  type InterviewJdOption,
  type InterviewSessionItem,
  interviewJdOptionLabel,
} from '../_lib/interview';

type ListPayload = { data: { items: InterviewSessionItem[] } };
type JdListPayload = { data: { items: InterviewJdOption[] } };
type CreatePayload = { data: InterviewSessionItem };

export default function InterviewListPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [items, setItems] = useState<InterviewSessionItem[] | null>(null);
  const [jds, setJds] = useState<InterviewJdOption[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listRequestId, setListRequestId] = useState<string | undefined>(undefined);

  // 创建表单
  const [topic, setTopic] = useState('');
  const [jdId, setJdId] = useState('');
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [quota, setQuota] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const userId = user?.id ?? 'anon';

  const loadList = useCallback(async () => {
    setListErr(null);
    try {
      const res = await api<ListPayload>('/api/interview-sessions');
      setItems(res.data.items);
    } catch (e) {
      const err = e as { requestId?: string };
      setListRequestId(err.requestId);
      setListErr(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadList();
    void (async () => {
      try {
        const res = await api<JdListPayload>('/api/jds');
        setJds(res.data.items);
      } catch {
        // JD 下拉加载失败不阻塞主流程：仍可无 JD 创建面试
      }
    })();
  }, [user, loadList]);

  async function createSession() {
    if (creating) return;
    if (!isValidInterviewTopic(topic)) {
      setCreateErr(`topic 长度须为 1–${INTERVIEW_TOPIC_MAX} 字`);
      return;
    }
    setCreating(true);
    setCreateErr(null);
    setQuota(null);
    const outcome = await startTask<InterviewSessionItem>(
      interviewTaskKey('create', userId, topic.trim()),
      async () => {
        try {
          const res = await api<CreatePayload>('/api/interview-sessions', {
            method: 'POST',
            body: JSON.stringify({ topic: topic.trim(), ...(jdId !== '' ? { jdId } : {}) }),
          });
          return { kind: 'result' as const, data: res.data };
        } catch (e) {
          return { kind: 'error' as const, message: errorText(e) };
        }
      },
    );
    setCreating(false);
    if (outcome.kind === 'result') {
      router.push(`/interview/${outcome.data.id}`);
      return;
    }
    setCreateErr(outcome.message);
  }

  if (authLoading || (user !== null && items === null && listErr === null)) {
    return (
      <main className="content-wrap">
        <PageHeader title="模拟面试" />
        <LoadingState />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="content-wrap">
        <PageHeader title="模拟面试" />
        <ErrorState message="请先登录后使用模拟面试" />
      </main>
    );
  }

  return (
    <main className="content-wrap">
      <PageHeader
        title="模拟面试"
        description={`基于岗位 JD 与主题动态追问，最多 ${INTERVIEW_MAX_TURNS} 轮；每轮提供 AI 点评（仅供练习参考）。`}
      />

      <section className="card" style={{ marginTop: 16 }}>
        <h2>新建面试</h2>
        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
          <label>
            <span className="muted">面试主题（必填，1–200 字）</span>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={200}
              placeholder="例如：后端工程师 · 系统设计"
            />
          </label>
          <label>
            <span className="muted">关联岗位 JD（可选，仅能选择你自己上传的 JD）</span>
            <select value={jdId} onChange={(e) => setJdId(e.target.value)}>
              <option value="">不关联 JD（纯主题面试）</option>
              {jds.map((jd) => (
                <option key={jd.id} value={jd.id}>
                  {interviewJdOptionLabel(jd)}
                </option>
              ))}
            </select>
          </label>
          {createErr && <div role="alert" className="field-error">{createErr}</div>}
          {quota && <div role="status" className="banner banner-warn">{quota}</div>}
          <div>
            <button className="btn btn-primary" disabled={creating} onClick={() => void createSession()}>
              {creating ? '创建中…' : '开始面试'}
            </button>
          </div>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>历史面试</h2>
        {listErr && <ErrorState message={listErr} requestId={listRequestId} onRetry={() => void loadList()} />}
        {!listErr && items !== null && items.length === 0 && (
          <EmptyState title="还没有面试记录。填写上方主题，创建你的第一场模拟面试。" />
        )}
        {!listErr && items !== null && items.length > 0 && (
          <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
            {items.map((s) => (
              <Link key={s.id} href={`/interview/${s.id}`} className="card row-between" style={{ textDecoration: 'none' }}>
                <span>
                  <strong>{s.topic}</strong>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    {isInterviewEnded(s) ? '已结束' : '进行中'} · {new Date(s.createdAt).toLocaleString()}
                  </span>
                </span>
                <span className="muted">进入 →</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
