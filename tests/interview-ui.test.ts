/**
 * Interview V2-A —— UI 层守卫 + 视图逻辑纯函数测试（无 DB）。
 *
 * 覆盖授权 §十五 UI 可测部分：
 *  - app/_lib/interview.ts 纯函数（pending 派生 / 8 轮 / 状态标签 / 校验 / 429 归类 / task key）
 *  - 源码守卫：无 dangerouslySetInnerHTML、不 import src/、只调用既有 API、
 *    写方法只指向 interview-sessions、429 quota 语义、task key 含 userId、
 *    SideNav/首页入口已开放（无 v2 占位）、无 Agent Tool / Fact 写语义
 * （API 行为层由 tests/interview-api.test.ts / tests/interview-isolation.test.ts 覆盖）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  INTERVIEW_ANSWER_MAX,
  INTERVIEW_MAX_TURNS,
  INTERVIEW_TOPIC_MAX,
  canAskNextQuestion,
  classifyInterviewQuotaError,
  findPendingTurn,
  interviewJdOptionLabel,
  interviewTaskKey,
  interviewTurnState,
  INTERVIEW_TURN_STATE_LABEL,
  isInterviewEnded,
  isValidInterviewAnswer,
  isValidInterviewTopic,
  lastInterviewTurn,
  type InterviewDetail,
  type InterviewTurnView,
} from '../app/_lib/interview.ts';

function strip(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

// ─── 纯函数：派生与常量 ───────────────────────────────────────────────

test('[常量] 8 轮上限 / topic 200 / answer 4000（与后端复刻一致）', () => {
  assert.equal(INTERVIEW_MAX_TURNS, 8);
  assert.equal(INTERVIEW_TOPIC_MAX, 200);
  assert.equal(INTERVIEW_ANSWER_MAX, 4000);
});

const TURN = (over: Partial<InterviewTurnView>): InterviewTurnView => ({
  id: 't',
  turnOrder: 1,
  question: 'q',
  answer: null,
  feedback: null,
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-09-20T00:00:00.000Z',
  ...over,
});

const DONE_FEEDBACK = { schemaVersion: 'interview-feedback/v1', summary: 's', strengths: [], improvements: [] };

test('[pending] findPendingTurn / lastInterviewTurn / interviewTurnState', () => {
  assert.equal(findPendingTurn([]), null);
  assert.equal(lastInterviewTurn([]), null);
  const unanswered = TURN({ id: 'a', answer: null });
  assert.equal(findPendingTurn([unanswered])?.id, 'a');
  assert.equal(interviewTurnState(unanswered), 'UNANSWERED');
  // 最后一轮已完成 → 无 pending
  assert.equal(findPendingTurn([TURN({ id: 'z', answer: 'y', feedback: DONE_FEEDBACK })]), null);
  // 上一轮已完成、最后一轮待回答 → pending = 最后一轮
  assert.equal(findPendingTurn([TURN({ id: 'z', answer: 'y', feedback: DONE_FEEDBACK }), TURN({ id: 'b', answer: null })])?.id, 'b');
  // 最后一轮已回答但点评中（EVALUATION_PENDING）→ 不可再作答
  const pendingEval = TURN({ id: 'b', answer: 'x', feedback: null });
  assert.equal(findPendingTurn([pendingEval]), null);
  assert.equal(interviewTurnState(pendingEval), 'EVALUATION_PENDING');
  assert.equal(interviewTurnState(TURN({ answer: 'x', feedback: DONE_FEEDBACK })), 'COMPLETED');
  assert.equal(INTERVIEW_TURN_STATE_LABEL.UNANSWERED, '待回答');
  assert.equal(INTERVIEW_TURN_STATE_LABEL.EVALUATION_PENDING, '评估中');
  assert.equal(INTERVIEW_TURN_STATE_LABEL.COMPLETED, '已点评');
});

test('[8轮] canAskNextQuestion：ended / pending / 达 8 轮均不可继续', () => {
  const base = { id: 's', jdId: null, topic: 't', createdAt: '', updatedAt: '' };
  const turns8 = Array.from({ length: 8 }, (_, i) => TURN({ id: `t${i}`, turnOrder: i + 1, answer: 'a', feedback: DONE_FEEDBACK }));
  const mk = (over: Partial<InterviewDetail>): InterviewDetail =>
    ({ ...base, endedAt: null, turns: turns8, ...over }) as InterviewDetail;

  assert.equal(canAskNextQuestion(mk({ turns: [] })), true, '0 轮可出第一题');
  assert.equal(canAskNextQuestion(mk({ endedAt: '2026-09-20T01:00:00.000Z' })), false, '已结束不可继续');
  assert.equal(canAskNextQuestion(mk({ turns: [TURN({ answer: null })] })), false, '有待回答轮不可继续');
  assert.equal(canAskNextQuestion(mk({ turns: turns8 })), false, '8 轮已满不可继续');
  assert.equal(canAskNextQuestion(mk({ turns: turns8.slice(0, 7) })), true, '7 轮仍可继续');
});

test('[ended] isInterviewEnded 以服务端 endedAt 为准', () => {
  assert.equal(isInterviewEnded({ endedAt: null }), false);
  assert.equal(isInterviewEnded({ endedAt: '2026-09-20T00:00:00.000Z' }), true);
});

test('[校验] topic trim 后 1–200；answer 不 trim、1–4000', () => {
  assert.equal(isValidInterviewTopic(''), false);
  assert.equal(isValidInterviewTopic('   '), false);
  assert.equal(isValidInterviewTopic('x'.repeat(200)), true);
  assert.equal(isValidInterviewTopic(' ' + 'x'.repeat(201)), false, 'trim 后超长');
  assert.equal(isValidInterviewAnswer(''), false);
  assert.equal(isValidInterviewAnswer('   '), true, 'answer 不 trim（与服务端精确比较一致）');
  assert.equal(isValidInterviewAnswer('x'.repeat(4000)), true);
  assert.equal(isValidInterviewAnswer('x'.repeat(4001)), false);
});

test('[429] classifyInterviewQuotaError：仅 LLM_QUOTA_EXCEEDED 归类为 quota；其余 null', () => {
  const quotaErr = { status: 429, code: 'LLM_QUOTA_EXCEEDED', retryAfterSeconds: 120, message: 'x' };
  const q = classifyInterviewQuotaError(quotaErr);
  assert.notEqual(q, null);
  assert.equal(q!.kind, 'quota');
  assert.equal(q!.retryAfterSeconds, 120);
  assert.ok(q!.message.includes('上限'), 'quota 语义文案');

  assert.equal(classifyInterviewQuotaError({ status: 429, code: 'RATE_LIMITED' }), null, '非 INTERVIEW quota 不归类');
  assert.equal(classifyInterviewQuotaError({ status: 409, code: 'LLM_QUOTA_EXCEEDED' }), null, '非 429 不归类');
  assert.equal(classifyInterviewQuotaError(new Error('boom')), null);
  const noRetry = classifyInterviewQuotaError({ status: 429, code: 'LLM_QUOTA_EXCEEDED' });
  assert.equal(noRetry!.retryAfterSeconds, null, '无 Retry-After 时为 null（文案给兜底提示）');
});

test('[task key] interviewTaskKey 含 userId 与上下文（G-4）', () => {
  assert.equal(interviewTaskKey('answer', 'u1', 's1:t9'), 'iv-answer:u1:s1:t9');
  assert.notEqual(interviewTaskKey('answer', 'u1', 's1:t9'), interviewTaskKey('answer', 'u2', 's1:t9'));
});

test('[JD 下拉] interviewJdOptionLabel：title/company 缺省兜底', () => {
  assert.equal(interviewJdOptionLabel({ id: 'j', title: '后端', company: 'ACME', requirementCount: 3, createdAt: '' }), '后端 · ACME');
  assert.equal(interviewJdOptionLabel({ id: 'j', title: null, company: null, requirementCount: 0, createdAt: '' }), '未命名岗位');
  assert.equal(interviewJdOptionLabel({ id: 'j', title: '  ', company: 'ACME', requirementCount: 0, createdAt: '' }), '未命名岗位 · ACME');
});

// ─── 源码守卫 ───────────────────────────────────────────────────────

const UI_FILES = ['app/_lib/interview.ts', 'app/interview/page.tsx', 'app/interview/[id]/page.tsx'];

test('[XSS] 全部 Interview UI 文件禁用 dangerouslySetInnerHTML（React 默认 escaping）', () => {
  for (const rel of UI_FILES) {
    assert.ok(!read(rel).includes('dangerouslySetInnerHTML'), `${rel} 不得使用 dangerouslySetInnerHTML`);
  }
});

test('[隔离] Interview UI 不 import src/、不 import node:（Next 15 webpack 限制）', () => {
  for (const rel of UI_FILES) {
    const code = strip(read(rel));
    assert.ok(!code.includes("from '../src/") && !code.includes("from '../../src/") && !code.includes("from 'src/"), `${rel} 不得 import src/`);
    for (const m of code.matchAll(/from '([^']+)'/g)) {
      assert.ok(!m[1].startsWith('node:'), `${rel} 不得 import node: scheme`);
    }
  }
});

test('[API] 只消费既有 5 route/6 method；写请求仅指向 interview-sessions API', () => {
  for (const rel of ['app/interview/page.tsx', 'app/interview/[id]/page.tsx']) {
    const lines = strip(read(rel)).split('\n');
    const writeMethods = ["'POST'", "'PATCH'", "'DELETE'", "'PUT'"];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (writeMethods.some((m) => line.includes(m))) {
        // 窗口匹配：写方法所在行及其前后 3 行内应出现 interview-sessions API 路径（多行调用）
        const window = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
        assert.ok(window.includes('/api/interview-sessions'), `写方法只允许用于 interview-sessions API，违规行：${line.trim().slice(0, 80)}`);
      }
      if (line.includes('/api/jds')) {
        for (const m of writeMethods) assert.ok(!lines.slice(i, i + 5).join('\n').includes(m), `JD API 必须只读，违规行：${line.trim().slice(0, 80)}`);
      }
    }
  }
  const all = UI_FILES.map((r) => strip(read(r))).join('\n');
  assert.ok(all.includes('/api/interview-sessions'), '使用既有 interview-sessions API');
  assert.ok(all.includes('/api/jds'), 'JD 下拉使用既有 /api/jds');
  // 路由名是 interview-sessions；不得调用不存在的 /api/interview（负向前瞻排除 -sessions）
  assert.ok(!/\/api\/interview(?!-sessions)/.test(all), '不得出现 /api/interview 等不存在路由');
});

test('[Agent/Act 边界] Interview UI 无 Agent Tool / Fact 写语义', () => {
  const all = UI_FILES.map((r) => strip(read(r))).join('\n');
  for (const banned of ['AgentTool', 'agentTool', 'tool-call', 'toolCall', 'ACT_TOOL_NAMES', 'CapabilityRepository', 'CapabilityEvidence', 'ResumeRepository', 'confirmCapability']) {
    assert.ok(!all.includes(banned), `Interview UI 不得出现 ${banned}`);
  }
});

test('[入口开放] SideNav 与首页的模拟面试不再是 V2 占位', () => {
  const sidenav = strip(read('app/_components/SideNav.tsx'));
  assert.ok(sidenav.includes("href: '/interview', label: '模拟面试' }"), 'SideNav 保留模拟面试入口');
  assert.ok(!sidenav.includes("/interview', label: '模拟面试', v2: true"), 'SideNav 不再灰显模拟面试');
  const home = strip(read('app/page.tsx'));
  assert.ok(!home.includes("title: '模拟面试', desc: '基于 JD 动态追问，练真实表达', v2: true"), '首页入口卡不再灰显');
  assert.ok(home.includes('overview.interviews.total'), '首页展示真实 Interview 统计');
});

test('[8轮展示] 详情页展示 x/8 轮与上限提示；429 使用 banner-warn 且不自动重试', () => {
  const detail = strip(read('app/interview/[id]/page.tsx'));
  assert.ok(detail.includes('INTERVIEW_MAX_TURNS'), '轮次展示使用复刻常量');
  assert.ok(detail.includes('banner-warn'), '429 使用警示样式（区别普通错误）');
  assert.ok(!detail.includes("code === 'LLM_QUOTA_EXCEEDED'"), '页面不硬判错误码（交给 classifyInterviewQuotaError）');
  assert.ok(!detail.includes('setInterval'), '不得自动轮询重试');
  assert.ok(detail.includes('结束面试'), '提供结束面试入口');
  assert.ok(detail.includes('AI 点评'), 'feedback 展示（suggestion 语义）');
});
