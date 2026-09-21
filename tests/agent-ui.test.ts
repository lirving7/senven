/**
 * T5-B-3B/3C —— Agent 前端消费层契约 + UI 安全守卫。
 *
 * 覆盖（授权书 §十七）：
 *   - Proposal 映射 / 状态分支 / 错误文案（纯函数，直接导入 app/_lib/agent.ts）；
 *   - basedOnRefs 9 类固定映射；KNOWLEDGE_CHUNK 不跳转、仅计数；
 *   - localStorage runId（注入式 Storage，内存桩）；
 *   - chip-advice 与事实 chip（chip-confirmed/chip-inferred）完全分离；
 *   - 禁止执行/确认类产品文案（仅扫描本轮新增的 Agent UI 文件）；
 *   - 前端 Agent endpoint 白名单（恰 3 个既有 API）；
 *   - Proposal 渲染字段白名单（不得出现扩展字段）；
 *   - 三级入口挂载（SideNav / Dashboard / Match·Resume·JD 上下文入口）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  BASED_ON_REF_TARGET,
  cancelable,
  clearLastRunId,
  ERROR_TEXT,
  errorTextFor,
  groupBasedOnRefs,
  isRenderablePlanPayload,
  LAST_RUN_STORAGE_KEY,
  readLastRunId,
  refTarget,
  RUN_STATUS_CHIP,
  RUN_STATUS_LABEL,
  saveLastRunId,
  type BasedOnRef,
} from '../app/_lib/agent.ts';

const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), 'utf8');

/** 源码扫描前剥离注释（与既有 agent-guards 的 strip 同范式：只判定真实代码，不误伤说明文字） */
const stripComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[^'"`]*\/\/.*$/gm, '');

const readCode = (rel: string): string => stripComments(read(rel));

const AGENT_UI_FILES = [
  'app/agent/page.tsx',
  'app/_components/agent/ProposalView.tsx',
  'app/_lib/agent.ts',
];

/* ────────────────── basedOnRefs 固定映射（授权书 §五） ────────────────── */

test('[refs] 9 类 entityType 全部有映射，且跳转目标与冻结映射逐字一致', () => {
  const mk = (entityType: string, entityId = 'e1'): BasedOnRef => ({ entityType, entityId });
  assert.deepEqual(refTarget(mk('RESUME')), { label: '我的简历', href: '/resumes/e1' });
  assert.deepEqual(refTarget(mk('JD')), { label: '岗位要求', href: '/jds' });
  assert.deepEqual(refTarget(mk('MATCH_RUN')), { label: '能力对照', href: '/match' });
  assert.deepEqual(refTarget(mk('CAPABILITY')), { label: '能力画像', href: '/projects' });
  assert.deepEqual(refTarget(mk('PROJECT_RESULT')), { label: '项目成果', href: '/projects' });
  assert.deepEqual(refTarget(mk('ACTION_PLAN')), { label: '行动计划', href: '/action-plans/e1' });
  assert.deepEqual(refTarget(mk('LEARNING_TASK')), { label: '学习任务', href: '/learn' });
  assert.deepEqual(refTarget(mk('PORTFOLIO')), { label: '作品集项目', href: '/projects' });
  assert.deepEqual(refTarget(mk('KNOWLEDGE_CHUNK')), { label: '外部知识参考', href: null });
  assert.equal(Object.keys(BASED_ON_REF_TARGET).length, 9, '映射表必须恰为 9 类');
});

test('[refs] KNOWLEDGE_CHUNK 不跳转且仅在分组结果中计数（UNTRUSTED，不解析正文）', () => {
  const refs = [
    { entityType: 'RESUME', entityId: 'r1' },
    { entityType: 'KNOWLEDGE_CHUNK', entityId: 'k1' },
    { entityType: 'KNOWLEDGE_CHUNK', entityId: 'k2' },
    { entityType: 'KNOWLEDGE_CHUNK', entityId: 'k3' },
    { entityType: 'UNKNOWN_TYPE', entityId: 'x' },
    { entityType: 'RESUME' }, // 缺 entityId → 丢弃
    'garbage',
  ];
  const g = groupBasedOnRefs(refs);
  assert.equal(g.knowledgeCount, 3, '外部知识仅按条数聚合');
  assert.equal(g.linked.length, 1, '只有带 href 的引用进入跳转列表');
  assert.equal(g.linked[0]!.href, '/resumes/r1');
  // 未知类型不得产生链接（防御性回落）
  assert.equal(refTarget({ entityType: 'UNKNOWN_TYPE', entityId: 'x' }).href, null);
});

/* ────────────────── Run 状态分支（授权书 §八） ────────────────── */

test('[status] cancel 仅允许 CREATED / PLANNING', () => {
  assert.equal(cancelable('CREATED'), true);
  assert.equal(cancelable('PLANNING'), true);
  for (const s of ['PROPOSED', 'CANCELLED', 'FAILED', 'EXPIRED']) {
    assert.equal(cancelable(s), false, `${s} 不可取消`);
  }
});

test('[status] 6 个状态均有标签；chip 映射不复用事实 chip（confirmed/inferred）', () => {
  const statuses = ['CREATED', 'PLANNING', 'PROPOSED', 'CANCELLED', 'FAILED', 'EXPIRED'];
  for (const s of statuses) {
    assert.ok(RUN_STATUS_LABEL[s as keyof typeof RUN_STATUS_LABEL], `${s} 缺少标签`);
    assert.ok(RUN_STATUS_CHIP[s as keyof typeof RUN_STATUS_CHIP], `${s} 缺少 chip 映射`);
  }
  assert.equal(RUN_STATUS_CHIP.PROPOSED, 'chip-advice', '仅 PROPOSED（AI_ADVICE）使用 chip-advice');
  for (const s of statuses) {
    const cls = RUN_STATUS_CHIP[s as keyof typeof RUN_STATUS_CHIP];
    assert.notEqual(cls, 'chip-confirmed', `${s} 不得复用 chip-confirmed`);
    assert.notEqual(cls, 'chip-inferred', `${s} 不得复用 chip-inferred`);
  }
});

/* ────────────────── 错误文案（授权书 §七） ────────────────── */

test('[errors] 5 类核心错误码均有用户可理解文案；未知码回落默认文案', () => {
  for (const code of [
    'LLM_QUOTA_EXCEEDED',
    'LLM_PROVIDER_ERROR',
    'LLM_TIMEOUT',
    'LLM_INVALID_PLAN',
    'AGENT_TOOL_ERROR',
  ]) {
    assert.ok(ERROR_TEXT[code], `${code} 缺少文案`);
    assert.equal(errorTextFor(code), ERROR_TEXT[code]);
  }
  assert.equal(errorTextFor('TOTALLY_UNKNOWN'), errorTextFor(null), '未知码与空码都回落默认文案');
  // 技术错误码不得直接作为主要文案（文案必须是自然语言）
  for (const code of Object.keys(ERROR_TEXT)) {
    assert.notEqual(ERROR_TEXT[code], code);
  }
});

/* ────────────────── PLAN payload 防御性校验（授权书 §三） ────────────────── */

function validPlan() {
  return {
    kind: 'PLAN',
    summary: '先补齐 TypeScript 深度，再沉淀项目证据。',
    steps: [
      { order: 1, title: '学习泛型', action: '完成 3 个练习', rationale: '岗位 MUST 要求' },
      { order: 2, title: '沉淀项目', action: '为订单系统补测试', rationale: '形成可追溯证据' },
    ],
    nextAction: '从第 1 步开始。',
  };
}

test('[plan] 合法 payload 通过；非法结构（kind/steps/order/超长/缺失）全部拒绝', () => {
  assert.equal(isRenderablePlanPayload(validPlan()), true);
  const bad: Array<[string, unknown]> = [
    ['kind 非 PLAN', { ...validPlan(), kind: 'EXECUTE_PLAN' }],
    ['steps 为空', { ...validPlan(), steps: [] }],
    ['steps 超过 8 条', { ...validPlan(), steps: Array.from({ length: 9 }, (_, i) => ({ order: i + 1, title: 't', action: 'a', rationale: 'r' })) }],
    ['order 不连续', { ...validPlan(), steps: [{ order: 2, title: 't', action: 'a', rationale: 'r' }] }],
    ['title 超长', { ...validPlan(), steps: [{ order: 1, title: 'x'.repeat(81), action: 'a', rationale: 'r' }] }],
    ['action 超长', { ...validPlan(), steps: [{ order: 1, title: 't', action: 'x'.repeat(301), rationale: 'r' }] }],
    ['rationale 超长', { ...validPlan(), steps: [{ order: 1, title: 't', action: 'a', rationale: 'x'.repeat(301) }] }],
    ['summary 超长', { ...validPlan(), summary: 'x'.repeat(801) }],
    ['nextAction 超长', { ...validPlan(), nextAction: 'x'.repeat(201) }],
    ['缺 nextAction', { kind: 'PLAN', summary: 's', steps: [{ order: 1, title: 't', action: 'a', rationale: 'r' }] }],
    ['steps 含非对象', { ...validPlan(), steps: ['x'] }],
    ['payload 非对象', 'PLAN'],
    ['payload 为 null', null],
  ];
  for (const [name, payload] of bad) {
    assert.equal(isRenderablePlanPayload(payload), false, `必须拒绝：${name}`);
  }
});

/* ────────────────── localStorage runId（授权书 §十） ────────────────── */

function memoryStorage(): { store: Storage; dump: Map<string, string> } {
  const dump = new Map<string, string>();
  const store = {
    getItem: (k: string) => (dump.has(k) ? dump.get(k)! : null),
    setItem: (k: string, v: string) => void dump.set(k, v),
    removeItem: (k: string) => void dump.delete(k),
  } as unknown as Storage;
  return { store, dump };
}

test('[storage] 仅保存最近一次 runId；读写清除与异常静默', () => {
  const { store, dump } = memoryStorage();
  assert.equal(readLastRunId(store), null, '初始为空');
  saveLastRunId(store, 'run-1');
  assert.equal(readLastRunId(store), 'run-1');
  assert.equal(dump.get(LAST_RUN_STORAGE_KEY), 'run-1', '存储值必须是裸 runId 字符串');
  saveLastRunId(store, 'run-2');
  assert.equal(readLastRunId(store), 'run-2', '再次保存即覆盖（只保留最近一次）');
  clearLastRunId(store);
  assert.equal(readLastRunId(store), null);
  // 非法内容 / 存储抛错均静默
  dump.set(LAST_RUN_STORAGE_KEY, '   ');
  assert.equal(readLastRunId(store), null);
  const throwing = {
    getItem: () => {
      throw new Error('boom');
    },
    setItem: () => {
      throw new Error('boom');
    },
    removeItem: () => {
      throw new Error('boom');
    },
  } as unknown as Storage;
  assert.equal(readLastRunId(throwing), null);
  assert.doesNotThrow(() => saveLastRunId(throwing, 'r'));
  assert.doesNotThrow(() => clearLastRunId(throwing));
});

/* ────────────────── chip 分离与 UI 安全守卫（源码扫描） ────────────────── */

test('[ui] chip-advice / chip-knowledge 已在 CSS 中定义，且与事实 chip 色系独立', () => {
  const css = read('app/globals.css');
  assert.ok(/\.chip-advice \{/.test(css), 'globals.css 必须定义 .chip-advice');
  assert.ok(/\.chip-knowledge \{/.test(css), 'globals.css 必须定义 .chip-knowledge');
  assert.ok(/--fill-advice:/.test(css) && /--text-advice:/.test(css) && /--tint-advice:/.test(css), 'advice 必须使用独立色系变量');
  assert.ok(/--fill-advice: #9d8bef/.test(css), '深色主题必须覆盖 advice 变量');
});

test('[ui] 展示组件不复用事实 chip；不引用 FactChip', () => {
  const view = readCode('app/_components/agent/ProposalView.tsx');
  for (const banned of ['chip-confirmed', 'chip-inferred', 'FactChip']) {
    assert.equal(view.includes(banned), false, `ProposalView.tsx 不得出现 ${banned}（AI_ADVICE 与 SYSTEM_FACT 分离）`);
  }
});

test('[ui] 禁止执行/确认类产品文案与动作 token（仅 Agent 新增 UI 文件）', () => {
  for (const rel of AGENT_UI_FILES) {
    const code = readCode(rel);
    for (const banned of [
      '已确认',
      '已执行',
      '已投递',
      '采纳',
      '一键修改',
      '自动修改',
      '立即执行',
      '确认建议',
      '执行建议',
      'AI 已确认',
      'AI 已完成',
      'Confirm',
      'Execute',
      'Approve',
      'Submit',
      'confirm(',
      'execute(',
      'submit(',
    ]) {
      assert.equal(code.includes(banned), false, `${rel} 不得出现禁止文案/token：${banned}`);
    }
  }
});

test('[ui] Proposal 渲染字段白名单：不得出现扩展字段（matchScore/gap/…）', () => {
  const view = readCode('app/_components/agent/ProposalView.tsx');
  for (const banned of [
    'matchScore',
    'learningPlan',
    'projectAdvice',
    'resumeAdvice',
    'capabilityAssessment',
    'payload.gap',
  ]) {
    assert.equal(view.includes(banned), false, `ProposalView.tsx 不得消费扩展字段：${banned}`);
  }
  // 只消费冻结字段
  for (const required of ['summary', 'steps', 'nextAction', 'basedOnRefs']) {
    assert.ok(view.includes(required), `ProposalView.tsx 必须渲染 ${required}`);
  }
});

test('[ui] 前端仅允许 3 个既有 Agent endpoint，且无第四端点调用', () => {
  const allowed = /^\/api\/agent\/runs(\/\$\{[^}]+\}(\/cancel)?)?$/;
  for (const rel of AGENT_UI_FILES) {
    const code = readCode(rel);
    const matches = [...code.matchAll(/\/api\/agent[^\s'"`)]*/g)].map((m) => m[0]);
    for (const m of matches) {
      assert.ok(allowed.test(m), `${rel} 出现未授权 Agent endpoint：${m}`);
    }
  }
  // 新增 UI 不得出现轮询 / 流式 / 历史
  for (const rel of AGENT_UI_FILES) {
    const code = read(rel);
    for (const banned of ['EventSource', 'WebSocket', '/api/agent/runs?']) {
      assert.equal(code.includes(banned), false, `${rel} 不得出现 ${banned}`);
    }
  }
});

test('[ui] 三级入口已挂载：SideNav / Dashboard / Match·Resume·JD 上下文入口', () => {
  assert.ok(read('app/_components/SideNav.tsx').includes("{ href: '/agent', label: 'AI 求职助手' }"), 'SideNav 缺少 /agent');
  assert.ok(/href: '\/agent'/.test(read('app/page.tsx')), 'Dashboard 缺少 Agent 入口卡');
  assert.ok(read('app/match/page.tsx').includes('/agent?resumeId='), 'Match 缺少上下文入口');
  assert.ok(read('app/resumes/[id]/page.tsx').includes('/agent?resumeId='), 'Resume 详情缺少上下文入口');
  assert.ok(read('app/jds/page.tsx').includes('/agent?jdId='), 'JD 缺少上下文入口');
});

test('[ui] 与既有 app 全域守卫兼容：新文件不触碰 AgentTool*/toolCall 黑名单', () => {
  for (const rel of AGENT_UI_FILES) {
    const code = read(rel);
    for (const banned of ['AgentToolCall', 'AgentConfirmation', 'AgentTool', 'agentTool', 'toolCall', 'tool-call']) {
      assert.equal(code.includes(banned), false, `${rel} 不得出现 ${banned}`);
    }
  }
});
