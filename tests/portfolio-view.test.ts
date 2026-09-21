/**
 * Portfolio V2-A/B（ADR-018）测试：
 *  - 视图逻辑层（app/_lib/portfolio-view.ts）的纯函数行为（展示 + 策展操作）；
 *  - 页面源码守卫（写方法白名单 / 不判 userId / 指标真实性 / 零 AI）。
 *
 * 对应授权 §十三 测试矩阵：
 *  1 正常展示  2 多成果  3 Artifact kind/URL/excerpt 真实性  4 无 Artifact 无虚假凭据
 *  5 REVOKED  6 Capability 仅 CONFIRMED  7 Ownership（前端不判归属）  8 Zero write（写方法仅限 portfolio API）
 *  UI 层：创建/编辑/归档/添加/移除/资格规则/task key；loading/error。
 *  创建/编辑/archive/添加/移除/多成果/重复添加/REVOKED/ownership 的 **API 层行为**
 *  由 tests/portfolio-api.test.ts 既有 13 用例覆盖（401/404/409/422/200-existing 等真实语义）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  PORTFOLIO_ARTIFACT_KIND_LABEL,
  PORTFOLIO_ARCHIVE_CONFIRM,
  PORTFOLIO_JOIN_GROUP_LABELS,
  PORTFOLIO_REMOVE_CONFIRM,
  PORTFOLIO_RESULT_STATUS_LABEL,
  PORTFOLIO_REVOKED_NOTICE,
  PORTFOLIO_SOURCE_LABELS,
  countEffectiveResults,
  derivePortfolioResultStatus,
  filterConfirmedCapabilities,
  isPortfolioResultRevoked,
  portfolioTaskKey,
  resultJoinEligibility,
  toPortfolioArtifactView,
  toPortfolioResultView,
  validatePortfolioForm,
  type PortfolioMemberRef,
  type PortfolioProjectResultPayload,
} from '../app/_lib/portfolio-view.ts';

function member(id: string, resultId: string, displayOrder = 0): PortfolioMemberRef {
  return { id, projectResultId: resultId, displayOrder, createdAt: '2026-09-20T00:00:00.000Z' };
}

function result(overrides: Partial<PortfolioProjectResultPayload> = {}): PortfolioProjectResultPayload {
  return {
    id: 'res1',
    title: '商品分析工具',
    summary: '完成了商品数据分析流程',
    sourceStepTitle: '实现分析脚本',
    sourceStepTargetRequirement: '数据清洗与分析',
    status: 'SUBMITTED',
    submittedAt: '2026-09-20T01:00:00.000Z',
    revokedAt: null,
    artifacts: [],
    ...overrides,
  };
}

function strip(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

// ─── 1 正常展示：来源矩阵字段全部映射 ───────────────────────────────────

test('[展示] 成员 + 成果详情 → 视图：成果标题/摘要/步骤/提交时间/状态 全部来自真实数据', () => {
  const v = toPortfolioResultView(member('m1', 'res1', 2), result());
  assert.equal(v.memberId, 'm1');
  assert.equal(v.resultId, 'res1');
  assert.equal(v.displayOrder, 2);
  assert.equal(v.title, '商品分析工具');
  assert.equal(v.summary, '完成了商品数据分析流程');
  assert.equal(v.sourceStepTitle, '实现分析脚本');
  assert.equal(v.sourceStepTargetRequirement, '数据清洗与分析');
  assert.equal(v.submittedAt, '2026-09-20T01:00:00.000Z');
  assert.equal(v.status, 'SUBMITTED');
  assert.equal(v.revoked, false);
  assert.deepEqual(v.artifacts, []);
});

test('[展示] 三种状态可区分（DRAFT / SUBMITTED / REVOKED 各有展示文案）', () => {
  assert.equal(derivePortfolioResultStatus({ status: 'DRAFT', revokedAt: null }), 'DRAFT');
  assert.equal(derivePortfolioResultStatus({ status: 'SUBMITTED', revokedAt: null }), 'SUBMITTED');
  assert.equal(derivePortfolioResultStatus({ status: 'REVOKED', revokedAt: null }), 'REVOKED');
  assert.equal(PORTFOLIO_RESULT_STATUS_LABEL.DRAFT, '草稿');
  assert.equal(PORTFOLIO_RESULT_STATUS_LABEL.SUBMITTED, '已提交');
  assert.equal(PORTFOLIO_RESULT_STATUS_LABEL.REVOKED, '已撤销');
});

// ─── 2 多成果：全部映射、顺序保持、不重复 ───────────────────────────────

test('[多成果] 多个成员全部映射且顺序保持（按 detail 已排序数组）', () => {
  const members = [member('m1', 'r1', 0), member('m2', 'r2', 1), member('m3', 'r3', 2)];
  const views = members.map((m) => toPortfolioResultView(m, result({ id: m.projectResultId })));
  assert.equal(views.length, 3);
  assert.deepEqual(views.map((v) => v.memberId), ['m1', 'm2', 'm3']);
  assert.equal(new Set(views.map((v) => v.memberId)).size, 3, '不重复');
});

// ─── 3 Artifact：kind 映射 + URL/excerpt 只来自真实 Artifact ────────────

test('[凭据] REPO / DEPLOY / SCREENSHOT kind 友好展示', () => {
  assert.equal(toPortfolioArtifactView({ id: 'a', kind: 'REPO', url: 'https://r', excerpt: null }).kindLabel, '代码仓库');
  assert.equal(toPortfolioArtifactView({ id: 'b', kind: 'DEPLOY', url: 'https://d', excerpt: null }).kindLabel, '在线 Demo');
  assert.equal(toPortfolioArtifactView({ id: 'c', kind: 'SCREENSHOT', url: null, excerpt: '截图描述' }).kindLabel, '截图');
  assert.equal(PORTFOLIO_ARTIFACT_KIND_LABEL.DOC, '文档');
  assert.equal(PORTFOLIO_ARTIFACT_KIND_LABEL.OTHER, '其他凭据');
});

test('[凭据] URL / excerpt 只来自真实 Artifact：空白值归一为 null（不渲染），未知 kind 归入其他凭据', () => {
  const v = toPortfolioArtifactView({ id: 'a', kind: 'MYSTERY', url: '   ', excerpt: '' });
  assert.equal(v.kindLabel, '其他凭据');
  assert.equal(v.url, null);
  assert.equal(v.excerpt, null);

  const real = toPortfolioArtifactView({ id: 'b', kind: 'DOC', url: 'https://example.com/doc', excerpt: 'README 摘要' });
  assert.equal(real.url, 'https://example.com/doc');
  assert.equal(real.excerpt, 'README 摘要');
});

// ─── 4 无 Artifact：不产生任何虚假凭据或指标 ────────────────────────────

test('[无凭据] 空 artifacts → 视图无凭据、无 metrics 字段（指标不存在的直接不展示）', () => {
  const v = toPortfolioResultView(member('m1', 'r1'), result({ artifacts: [] }));
  assert.deepEqual(v.artifacts, []);
  assert.equal('metrics' in v, false);
  assert.equal('metrics' in toPortfolioArtifactView({ id: 'a', kind: 'REPO', url: null, excerpt: null }), false);
});

// ─── 5 REVOKED：保留展示 + 派生标记 + 不计入有效统计 ────────────────────

test('[REVOKED] revokedAt 非空 → REVOKED（判据优先于 status）', () => {
  assert.equal(derivePortfolioResultStatus({ status: 'SUBMITTED', revokedAt: '2026-09-20T02:00:00.000Z' }), 'REVOKED');
  assert.equal(isPortfolioResultRevoked({ status: 'SUBMITTED', revokedAt: '2026-09-20T02:00:00.000Z' }), true);
  assert.equal(isPortfolioResultRevoked({ status: 'SUBMITTED', revokedAt: null }), false);
});

test('[REVOKED] 已撤销成员保留视图但不计入有效成果统计；警示文案存在', () => {
  const active = toPortfolioResultView(member('m1', 'r1'), result({ id: 'r1' }));
  const revoked = toPortfolioResultView(
    member('m2', 'r2'),
    result({ id: 'r2', status: 'REVOKED', revokedAt: '2026-09-20T02:00:00.000Z' }),
  );
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.status, 'REVOKED');
  assert.equal(countEffectiveResults([active, revoked]), 1, '仅未撤销成员计入有效统计');
  assert.ok(PORTFOLIO_REVOKED_NOTICE.includes('已撤销'));
});

// ─── 6 Capability：仅 CONFIRMED 可展示 ─────────────────────────────────

test('[能力] filterConfirmedCapabilities 只保留 CONFIRMED；UNCONFIRMED / INFERRED 不得伪装', () => {
  const caps = [
    { id: 'c1', key: 'docker', label: 'Docker', level: null, status: 'CONFIRMED' },
    { id: 'c2', key: 'k8s', label: 'K8s', level: null, status: 'UNCONFIRMED' },
    { id: 'c3', key: 'sql', label: 'SQL', level: null, status: 'INFERRED' },
  ];
  const confirmed = filterConfirmedCapabilities(caps);
  assert.deepEqual(confirmed.map((c) => c.id), ['c1']);
  assert.equal(filterConfirmedCapabilities(undefined as never).length, 0, '防御非数组输入');
});

// ─── 7 Ownership：前端不判归属（由 API 404 语义保证） ───────────────────

test('[Ownership] 前端不做归属判断（userId 等值比较不得出现；task key 拼接除外）', () => {
  for (const rel of ['app/portfolio/page.tsx', 'app/_lib/portfolio-view.ts']) {
    const code = strip(read(rel));
    for (const banned of ['userId ===', '=== userId', 'user.id ===', '=== user.id']) {
      assert.ok(!code.includes(banned), `${rel} 不得包含归属判断 ${banned}`);
    }
  }
});

// ─── 8 写方法白名单：写请求只允许指向 portfolio-projects API ────────────

test('[写白名单] POST/PATCH/DELETE 仅用于 portfolio-projects API；成果/能力 API 只读', () => {
  const code = strip(read('app/portfolio/page.tsx'));
  const writeMethods = ["'POST'", "'PATCH'", "'DELETE'", "'PUT'"];

  // 每个写方法出现点的前方窗口内必须是 portfolio API 调用（URL 与 method 可跨行）
  const wm = /'POST'|'PATCH'|'DELETE'|'PUT'/g;
  let m: RegExpExecArray | null;
  while ((m = wm.exec(code))) {
    const before = code.slice(Math.max(0, m.index - 160), m.index);
    assert.ok(
      before.includes('/api/portfolio-projects'),
      `写方法只允许用于 portfolio API，违规上下文：…${code.slice(Math.max(0, m.index - 60), m.index + 20)}`,
    );
  }

  // 成果 / 能力 API 出现点之后的窗口内不得出现写方法（保持只读）
  const ro = /\/api\/(project-results|capabilities)/g;
  while ((m = ro.exec(code))) {
    const after = code.slice(m.index, m.index + 200);
    for (const method of writeMethods) {
      assert.ok(!after.includes(method), `成果/能力 API 必须只读，违规上下文：${after.slice(0, 80)}`);
    }
  }
});

test('[零写] 视图逻辑层不发请求、不写库（无 fetch / localStorage / 动态 import）', () => {
  const lib = strip(read('app/_lib/portfolio-view.ts'));
  for (const banned of ['fetch(', 'localStorage', 'import(', 'XMLHttpRequest']) {
    assert.ok(!lib.includes(banned), `视图层不得包含 ${banned}`);
  }
});

// ─── 指标真实性（ADR-018 §7 硬约束）：无指标模板 / 推导 ─────────────────

test('[指标真实性] 页面与视图层无任何指标模板词或推导函数', () => {
  for (const rel of ['app/portfolio/page.tsx', 'app/_lib/portfolio-view.ts']) {
    const code = strip(read(rel));
    for (const banned of ['转化率', '提升了', '播放量', '万播放', '1000用户', '用户数达', '20小时', '30%']) {
      assert.ok(!code.includes(banned), `${rel} 不得包含指标模板词「${banned}」`);
    }
  }
});

// ─── V2-B：表单校验（与后端 P-4/G-3 边界一致） ──────────────────────────

test('[表单] validatePortfolioForm：合法 / 空标题 / 超长标题 / 超长描述 / 空白描述归 null', () => {
  assert.deepEqual(validatePortfolioForm({ title: ' 跨境运营作品集 ', description: '  ' }), {
    ok: true,
    title: '跨境运营作品集',
    description: null,
  });
  const tooLongTitle = { title: 'x'.repeat(121), description: '' };
  assert.equal(validatePortfolioForm(tooLongTitle).ok, false);
  assert.match((validatePortfolioForm(tooLongTitle) as { error: string }).error, /120/);
  const tooLongDesc = { title: 'ok', description: 'y'.repeat(2001) };
  assert.equal(validatePortfolioForm(tooLongDesc).ok, false);
  assert.match((validatePortfolioForm(tooLongDesc) as { error: string }).error, /2000/);
  const empty = validatePortfolioForm({ title: '   ', description: '' });
  assert.equal(empty.ok, false);
});

// ─── V2-B：加入资格 = 真实规则（P-1），不创造新规则 ─────────────────────

test('[资格] resultJoinEligibility：仅 SUBMITTED 可加入；DRAFT/REVOKED 禁选', () => {
  assert.equal(resultJoinEligibility('SUBMITTED'), 'ELIGIBLE');
  assert.equal(resultJoinEligibility('DRAFT'), 'DRAFT_NOT_ELIGIBLE');
  assert.equal(resultJoinEligibility('REVOKED'), 'REVOKED_NOT_ELIGIBLE');
  assert.equal(resultJoinEligibility(null), 'DRAFT_NOT_ELIGIBLE', '未知状态按不可加入处理');
  assert.ok(PORTFOLIO_JOIN_GROUP_LABELS.eligible.includes('可加入'));
  assert.ok(PORTFOLIO_JOIN_GROUP_LABELS.draft.includes('须先提交'));
  assert.ok(PORTFOLIO_JOIN_GROUP_LABELS.revoked.includes('不可加入'));
});

// ─── V2-B：task key（G-4：含 userId 防换号串数据）+ 确认文案 ─────────────

test('[task key] portfolioTaskKey 按 kind:userId:context 隔离', () => {
  const k = portfolioTaskKey('add', 'u1', 'p1:r2');
  assert.equal(k, 'pf-add:u1:p1:r2');
  assert.notEqual(portfolioTaskKey('add', 'u2', 'p1:r2'), k, '换账号不串任务');
  assert.notEqual(portfolioTaskKey('remove', 'u1', 'p1:r2'), k, '换操作不串任务');
});

test('[确认文案] 归档=终态无恢复；移除=仅解除引用不删事实', () => {
  assert.ok(PORTFOLIO_ARCHIVE_CONFIRM.includes('无恢复入口'));
  assert.ok(PORTFOLIO_REMOVE_CONFIRM.includes('不会删除'));
  assert.ok(PORTFOLIO_REMOVE_CONFIRM.includes('能力'));
});

// ─── V2-B：页面守卫 —— 零 AI / 零 Agent Tool / loading-error 状态存在 ────

test('[AI 边界] 页面与视图层零 LLM（无 PROJECT_MENTOR / provider / prompt / analyze 调用）', () => {
  for (const rel of ['app/portfolio/page.tsx', 'app/_lib/portfolio-view.ts']) {
    const code = strip(read(rel));
    for (const banned of ['PROJECT_MENTOR', 'provider', 'analyze', 'generateJson', '/api/agent']) {
      assert.ok(!code.includes(banned), `${rel} 不得包含 AI 相关 ${banned}`);
    }
  }
});

test('[Act 边界] 页面与视图层不新增 Agent Tool（无 ACT_TOOL / publish_portfolio / add_to_portfolio）', () => {
  for (const rel of ['app/portfolio/page.tsx', 'app/_lib/portfolio-view.ts']) {
    const code = strip(read(rel));
    for (const banned of ['ACT_TOOL', 'publish_portfolio', 'add_to_portfolio', 'AgentTool', 'agentTool']) {
      assert.ok(!code.includes(banned), `${rel} 不得包含 ${banned}`);
    }
  }
});

test('[状态反馈] 页面使用 loading / error / busy / task-session 防重（复用既有范式）', () => {
  const page = strip(read('app/portfolio/page.tsx'));
  for (const required of ['LoadingState', 'ErrorState', 'startTask', 'portfolioTaskKey', 'setActionBusy', 'setCreateBusy']) {
    assert.ok(page.includes(required), `页面缺少状态反馈要素 ${required}`);
  }
  // 写操作确认：归档/移除须经 confirm
  assert.ok(page.includes('window.confirm'), '破坏性操作（归档/移除）须用户确认');
});

// ─── 来源矩阵文案：UI 不暴露字段名但保持追溯语义 ────────────────────────

test('[来源矩阵] 来源标签语义完整（成果 / 凭据 / 已确认能力）', () => {
  assert.equal(PORTFOLIO_SOURCE_LABELS.result, '来源：项目成果');
  assert.equal(PORTFOLIO_SOURCE_LABELS.artifact, '来源：提交凭据');
  assert.equal(PORTFOLIO_SOURCE_LABELS.capability, '来源：已确认能力');
});
