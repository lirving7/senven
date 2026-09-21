/**
 * T6-4-C —— Agent Act UI 守卫测试。
 *
 * 覆盖（授权书 §三/§四/§六/§七/§八/§九）：
 *   - 5 Tool title/desc 全部有映射；
 *   - payload 防御性校验（含 userId 注入）；UI 二次防御；
 *   - 6 个 Act Action 状态 label + chip；不复用事实 chip；
 *   - canConfirm/canExecute 转移规则（与 §三 状态机一致）；
 *   - storage + task-session key；
 *   - Act UI 文件端点白名单（恰 3 个新增路径，不允许第四个）；
 *   - Act UI 文案守则（禁止 AI 主动确认/执行类语义；允许用户主动确认/执行按钮文案）；
 *   - 与既有全域守卫兼容（agent-tool-guards 黑名单 token）；客户端不可持 userId 判断；
 *   - Result/Error 渲染（4 个常见 result 形状：CREATED / ATTACHED / REUSED_EXISTING / bare id）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ACT_TOOL_TITLE,
  ACT_TOOL_DESC,
  ACT_TOOL_PAYLOAD_FIELDS,
  ACT_API_PATHS,
  ACTION_STATUS_LABEL,
  ACTION_STATUS_CHIP,
  isRenderableActPayload,
  fieldsForTool,
  payloadFieldView,
  canConfirmActView,
  canExecuteActView,
  renderResultSummary,
  renderErrorSummary,
  readLastActionId,
  saveLastActionId,
  clearLastActionId,
  actConfirmTaskKey,
  actExecuteTaskKey,
  isAllowedActApi,
  ALL_ACT_TOOLS,
  toolFromProposal,
  type ActionView,
} from '../app/_lib/agent-act.ts';

const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), 'utf8');

/** 源码扫描前剥离注释（与既有 agent-guards 的 strip 同范式：只判定真实代码，不误伤说明文字） */
const stripComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[^'"`]*\/\/.*$/gm, '');

const readCode = (rel: string): string => stripComments(read(rel));

const ACT_UI_FILES = [
  'app/_lib/agent-act.ts',
  'app/_components/agent/ActActionPanel.tsx',
];

/* ────────────────────── 5 Tool 标识 + 描述 + payload 字段 ────────────────────── */

test('[tool] 5 Tool 与后端 ACT_TOOL_NAMES 完全一致；title/desc/fields 三表均覆盖', () => {
  const tools = Object.keys(ACT_TOOL_TITLE);
  assert.deepEqual(tools, [...ALL_ACT_TOOLS]);
  assert.deepEqual(Object.keys(ACT_TOOL_DESC).sort(), [...ALL_ACT_TOOLS].sort());
  assert.deepEqual(Object.keys(ACT_TOOL_PAYLOAD_FIELDS).sort(), [...ALL_ACT_TOOLS].sort());
  for (const t of ALL_ACT_TOOLS) {
    const fields = ACT_TOOL_PAYLOAD_FIELDS[t];
    assert.ok(fields.length > 0, `${t} 必须至少有一个展示字段`);
    for (const f of fields) {
      assert.ok(f.key.length > 0 && f.label.length > 0, `${t}.${f.key} 字段缺失 key/label`);
    }
  }
});

test('[tool] create_application 描述必须明示「真实申请」（Application 没有 DRAFT 阶段，不允许「保存草稿」语义）', () => {
  const desc = ACT_TOOL_DESC.create_application;
  assert.ok(desc.includes('申请'), '描述必须含「申请」');
  assert.ok(desc.includes('真实'), '描述必须明示非草稿');
  assert.equal(desc.includes('草稿'), false, '描述绝不能含「草稿」——与 Application 既有语义一致');
  // 全 5 Tool 描述均不得暗示「草稿 / 自动执行」
  for (const t of ALL_ACT_TOOLS) {
    const d = ACT_TOOL_DESC[t];
    assert.equal(d.includes('草稿'), false, `${t} 不得暗示草稿`);
    assert.equal(d.includes('自动'), false, `${t} 不得暗示「自动」——AI 不可替代用户动作`);
  }
});

/* ────────────────────── payload 防御性校验（含 userId 注入） ────────────────────── */

test('[payload] userId 注入键一律拒绝展示（前端二次防御）', () => {
  assert.equal(isRenderableActPayload('create_career_goal', { name: 'x', userId: 'injected' }), false);
  assert.equal(isRenderableActPayload('create_career_goal', { name: 'x', user_id: 'injected' }), false);
  assert.equal(isRenderableActPayload('create_application', { jdId: 'a', userId: 'x' }), false);
  // 合法 payload
  assert.equal(
    isRenderableActPayload('create_career_goal', { name: 'x', position: 'p', employmentType: 'FULL_TIME' }),
    true,
  );
  // 非对象 payload
  assert.equal(isRenderableActPayload('create_career_goal', null), false);
  assert.equal(isRenderableActPayload('create_career_goal', 'string'), false);
  // 未知 tool 拒绝
  assert.equal(isRenderableActPayload('hack_me', { x: 1 }), false);
  // 字段类型错误拒绝（如 jdId 应为 string，number 也允许）
  assert.equal(
    isRenderableActPayload('attach_jd_to_goal', { goalId: 'g', jdId: 42 }),
    true,
    '数字 ID 与字段类型规则一致仍允许',
  );
});

test('[payload] payloadFieldView 在非对象 payload 下返回空字符串', () => {
  assert.equal(payloadFieldView(null, 'name'), '');
  assert.equal(payloadFieldView('string', 'name'), '');
  assert.equal(payloadFieldView({ name: 'alice' }, 'name'), 'alice');
  assert.equal(payloadFieldView({ name: 'alice' }, 'absent'), '');
  assert.equal(payloadFieldView({ name: 42 }, 'name'), '42');
});

test('[fields] fieldsForTool 未知工具返回 null', () => {
  assert.equal(fieldsForTool('hack_me'), null);
  assert.ok(fieldsForTool('create_application') !== null);
});

/* ────────────────────── 6 个 Act Action 状态 label + chip ────────────────────── */

test('[status] 6 个状态均有 label 与 chip；chip 严禁复用事实 chip', () => {
  const list = ['PROPOSED', 'CONFIRMED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
  for (const s of list) {
    assert.ok(ACTION_STATUS_LABEL[s], `${s} 缺少 label`);
    assert.ok(ACTION_STATUS_CHIP[s], `${s} 缺少 chip`);
  }
  for (const s of list) {
    const cls = ACTION_STATUS_CHIP[s];
    assert.notEqual(cls, 'chip-confirmed', `${s} 不得复用 chip-confirmed`);
    assert.notEqual(cls, 'chip-inferred', `${s} 不得复用 chip-inferred`);
  }
});

/* ────────────────────── canConfirm / canExecute 转移规则（§三） ────────────────────── */

test('[rule] canConfirmActView：仅当 action=null 且当前 status=PROPOSED 才可 Confirm', () => {
  assert.equal(canConfirmActView(null, 'PROPOSED'), true);
  assert.equal(canConfirmActView(null, null), true, 'initial null 也允许 Confirm');
  assert.equal(canConfirmActView(null, 'CONFIRMED'), false, 'status=CONFIRMED 不允许再次 Confirm');
  assert.equal(canConfirmActView({} as ActionView, 'PROPOSED'), false, '已有 action 禁止 Confirm');
});

test('[rule] canExecuteActView：仅当 action.status=CONFIRMED 才可 Execute', () => {
  assert.equal(canExecuteActView(null), false);
  const base = { id: 'a', runId: null, proposalId: null, toolName: 'create_career_goal', payload: {}, result: null, errorCode: null, errorMessage: null, createdAt: '', updatedAt: '' } as ActionView;
  assert.equal(canExecuteActView({ ...base, status: 'CONFIRMED' }), true);
  assert.equal(canExecuteActView({ ...base, status: 'SUCCEEDED' }), false);
  assert.equal(canExecuteActView({ ...base, status: 'FAILED' }), false);
  assert.equal(canExecuteActView({ ...base, status: 'CANCELLED' }), false);
  assert.equal(canExecuteActView({ ...base, status: 'PROPOSED' }), false, 'PROPOSED→EXECUTING 禁止');
});

/* ────────────────────── result/error 渲染 ────────────────────── */

test('[result] 4 个常见 result 形状均正确渲染', () => {
  assert.equal(renderResultSummary({ status: 'SUCCEEDED', result: { kind: 'CREATED', id: 'g1' } } as never), '已创建，ID：g1');
  assert.equal(
    renderResultSummary({ status: 'SUCCEEDED', result: { kind: 'REUSED_EXISTING', id: 'g1' } } as never),
    '已存在且已生效，未重复创建（ID：g1）',
  );
  assert.equal(
    renderResultSummary({ status: 'SUCCEEDED', result: { kind: 'ATTACHED', id: 'g2', jdIds: ['j1', 'j2', 'j3'] } } as never),
    '已绑定，目标 ID：g2，当前绑定 3 个岗位',
  );
  assert.equal(renderResultSummary({ status: 'SUCCEEDED', result: { id: 'a1' } } as never), '已完成，ID：a1');
  assert.equal(renderResultSummary({ status: 'SUCCEEDED', result: null } as never), '');
  assert.equal(renderResultSummary({ status: 'FAILED', result: {} } as never), '');
});

test('[error] 优先 errorMessage，其次 errorCode', () => {
  assert.equal(
    renderErrorSummary({ status: 'FAILED', errorCode: 'X', errorMessage: 'plan-jd 未关联' } as never),
    'plan-jd 未关联',
  );
  assert.equal(
    renderErrorSummary({ status: 'FAILED', errorCode: 'X', errorMessage: null } as never),
    '错误代码：X',
  );
  assert.equal(
    renderErrorSummary({ status: 'FAILED', errorCode: null, errorMessage: null } as never),
    '执行失败',
  );
});

/* ────────────────────── storage + task-session key ────────────────────── */

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k) : null),
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

test('[storage] read/save/clear LastActionId；空值与异常静默', () => {
  const s = memoryStore() as { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  assert.equal(readLastActionId(s), null);
  saveLastActionId(s, 'action-1');
  assert.equal(readLastActionId(s), 'action-1');
  saveLastActionId(s, 'action-2');
  assert.equal(readLastActionId(s), 'action-2', '再次保存即覆盖（只保留最近）');
  clearLastActionId(s);
  assert.equal(readLastActionId(s), null);
  // 异常静默
  const throwing = {
    getItem: () => { throw new Error('boom'); },
    setItem: () => { throw new Error('boom'); },
    removeItem: () => { throw new Error('boom'); },
  };
  assert.equal(readLastActionId(throwing), null);
  assert.doesNotThrow(() => saveLastActionId(throwing as never, 'a'));
  assert.doesNotThrow(() => clearLastActionId(throwing as never));
});

test('[keys] task-session key 包含 userId（同浏览器换账号不串数据）', () => {
  assert.equal(actConfirmTaskKey('u1', 'p1'), 'agent:act:confirm:u1:p1');
  assert.equal(actExecuteTaskKey('u1', 'a1'), 'agent:act:execute:u1:a1');
  assert.notEqual(actConfirmTaskKey('u1', 'p1'), actConfirmTaskKey('u2', 'p1'), 'userId 不同 → key 不同');
});

/* ────────────────────── endpoint 白名单（§九/不超出授权） ────────────────────── */

test('[api] Act 白名单仅 3 个；前置判断函数可识别', () => {
  assert.equal(ACT_API_PATHS.length, 3);
  assert.equal(isAllowedActApi('POST /api/agent/proposals/p/confirm'), true);
  assert.equal(isAllowedActApi('POST /api/agent/actions/a/execute'), true);
  assert.equal(isAllowedActApi('GET /api/agent/actions/a'), true);
  assert.equal(isAllowedActApi('POST /api/agent/runs'), false, '既有 /api/agent/runs 不在本白名单（Act 不应再调用 Runs）');
  assert.equal(isAllowedActApi('/api/agent/runs/r'), false);
  assert.equal(isAllowedActApi('POST /api/agent/hack'), false);
});

/* ────────────────────── 源码扫描：UI 守则（§七/§九） ────────────────────── */

test('[ui] Act UI 不出现「AI 主动确认/执行」类措辞；只允许用户主动动作', () => {
  for (const rel of ACT_UI_FILES) {
    const code = readCode(rel);
    for (const banned of [
      'AI 已确认',
      'AI 已完成',
      'AI 自动确认',
      'AI 自动执行',
      'AI 自动投递',
      'AI 直接修改',
      'AI 自动发送',
      'AI 已执行',
      '自动投递',
      '自动发送',
    ]) {
      assert.equal(code.includes(banned), false, `${rel} 不得出现 ${banned}（§七/§九 AI 不可代替用户）`);
    }
  }
});

test('[ui] Act UI 不出现「草稿」「Draft」类语义（与 Application 既有语义一致）', () => {
  for (const rel of ACT_UI_FILES) {
    const code = readCode(rel);
    for (const banned of ['Draft', '草稿', '保存草稿', '标记草稿', '草稿申请']) {
      assert.equal(code.includes(banned), false, `${rel} 不得出现 ${banned}（Application 不存在 DRAFT 阶段）`);
    }
  }
});

test('[ui] Act UI 至少包含「确认」与「执行」两类用户主动动作文案（§一/§二）', () => {
  const panel = readCode('app/_components/agent/ActActionPanel.tsx');
  assert.ok(/确认操作/.test(panel), '必须包含「确认操作」按钮文案');
  assert.ok(/执行（开始修改数据）/.test(panel) || /执行（/.test(panel), '必须包含「执行」按钮文案');
});

test('[ui] Act UI 仅允许 3 个新增 path（与 §九 endpoint 白名单一致）；不允许第四个', () => {
  const panel = readCode('app/_components/agent/ActActionPanel.tsx');
  const lib = readCode('app/_lib/agent-act.ts');
  // 逐行扫描：任何包含 /api/agent 子串的源码行必须归并到合法 Act path
  for (const code of [panel, lib]) {
    const lines = code.split('\n');
    for (const line of lines) {
      if (!line.includes('/api/agent')) continue;
      const isProposals = line.includes("/api/agent/proposals/'") && line.includes('/confirm');
      const isExecute = line.includes("/api/agent/actions/'") && line.includes('/execute');
      const isGet = line.includes("/api/agent/actions/'") && !line.includes('/execute') && !line.includes('/cancel');
      const isStaticGuard =
        line.includes("'POST /api/agent/proposals/p/confirm'") ||
        line.includes("'POST /api/agent/actions/a/execute'") ||
        line.includes("'GET /api/agent/actions/a'");
      assert.ok(
        isProposals || isExecute || isGet || isStaticGuard,
        `Act UI 出现未授权 Agent endpoint 行：${line.trim().slice(0, 120)}`,
      );
    }
  }
  // 显式断言：3 个 path 字符串拼接出现在 panel
  assert.ok(
    /'\/api\/agent\/proposals\/'\s*\+\s*\w+\s*\+\s*'\/confirm'/.test(panel),
    'panel 必须出现 POST confirm 路径拼接',
  );
  assert.ok(
    /'\/api\/agent\/actions\/'\s*\+\s*\w+\s*\+\s*'\/execute'/.test(panel),
    'panel 必须出现 POST execute 路径拼接',
  );
  assert.ok(
    /'\/api\/agent\/actions\/'\s*\+\s*\w+\b/.test(panel),
    'panel 必须出现 GET action 路径拼接',
  );
});

test('[ui] Act UI 不出现 EventSource / WebSocket / setInterval 自轮询（与 G-4 SOP 一致 — 任务保持而非轮询）', () => {
  const panel = readCode('app/_components/agent/ActActionPanel.tsx');
  for (const banned of ['EventSource', 'WebSocket', 'new EventSource', 'new WebSocket']) {
    assert.equal(panel.includes(banned), false, `Act UI 不得出现 ${banned}`);
  }
  // setInterval 仅允许 ProcessingState 显示用；新文件自身不应再加 setInterval
  assert.equal(panel.includes('setInterval'), false, 'Act UI 自身不得新增 setInterval（避免重复 Execute）');
});

test('[ui] 与既有全域守卫兼容：Act UI 不触碰 AgentTool*/toolCall 黑名单', () => {
  for (const rel of ACT_UI_FILES) {
    const code = read(rel);
    for (const banned of ['AgentToolCall', 'AgentConfirmation', 'AgentTool', 'agentTool', 'toolCall', 'tool-call']) {
      assert.equal(code.includes(banned), false, `${rel} 不得出现 ${banned}`);
    }
  }
});

test('[ui] Act UI 不裸露 userId 判断；ownership 一律服务端二次校验（§七）', () => {
  for (const rel of ACT_UI_FILES) {
    const code = readCode(rel);
    // 不得出现「比较 userId」「if (userId === ...）」类判断
    for (const banned of ['userId ===', 'userId !==', 'if (userId) auth', '!== currentUser.id', 'currentUser.id ===']) {
      assert.equal(code.includes(banned), false, `${rel} 不得出现 ${banned}——前端不持 userId 判断`);
    }
  }
});

/* ────────────────────── toolFromProposal 决定 Act 入口 ────────────────────── */

test('[tool-from-proposal] proposal.payload.toolName 为白名单 tool 时被识别，否则 null', () => {
  assert.equal(toolFromProposal({ id: 'p1', payload: { toolName: 'create_career_goal', name: 'x' } }), 'create_career_goal');
  assert.equal(toolFromProposal({ id: 'p1', payload: { toolName: 'hack_me' } }), null, '未授权工具 → null');
  assert.equal(toolFromProposal({ id: 'p1', payload: { name: 'x' } }), null, '无 toolName 字段 → null');
  assert.equal(toolFromProposal({ id: 'p1', payload: null }), null);
  assert.equal(toolFromProposal({ id: 'p1', payload: 'string' }), null);
});
