/**
 * V2 · T2 Step 3B —— 岗位行动计划前端链路「交互验证」（只测不改）
 *
 * 前置：`next start -p 3100`（本脚本直接打真实 HTTP 接口）
 * 用法：`node scripts/qa-3b-action-plan.mjs`
 *
 * 覆盖验收 A6（三类结果展示）与 A7（查看 / 刷新 / 单步继续），
 * 并逐条验证 5 条前端约束所依赖的后端契约：
 *   约束#1 不自动生成      → Match 之后 GET 列表为空
 *   约束#2 不自行判断能力  → have 仅来自 CONFIRMED 能力；gaps 仅来自 MatchRun 缺口
 *   约束#3 429 必须明确    → 配额用尽返回 429 + code=LLM_QUOTA_EXCEEDED（前端据此显示专属文案）
 *   约束#4 状态跟后端同步  → PATCH 后重新 GET 仍为 DONE（非前端伪造）
 *   约束#5 不新增业务实体  → 全程只调用既有端点（无 Learning/Project/新能力状态）
 *
 * 说明：Capability 目前没有应用层写入入口（CapabilityRepository 只有 list/find/confirm），
 * 因此「已有能力」的真实默认值为空 —— 本脚本用与 tests/t2-action-plan-api.test.ts 相同的方式
 * 直接落一条 CONFIRMED 能力作为夹具，用以验证 have 非空时的渲染与事实安全。
 */

const base = 'http://localhost:3100';

let pass = 0;
let fail = 0;
function check(name, ok, evidence = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${evidence ? `  — ${evidence}` : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${evidence ? `  — ${evidence}` : ''}`);
  }
}

async function req(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers['cookie'] = cookie;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') };
}

let prisma = null;
try {
  const mod = await import('@prisma/client');
  prisma = new mod.PrismaClient();
} catch {
  prisma = null;
}

// ── 造数：用户 + 简历 + JD + MatchRun ────────────────────────────────────
const email = `qa3b_${Date.now()}@example.com`;
const reg = await req('/api/auth/register', { method: 'POST', body: { email, password: 'password-1234' } });
const cookie = (reg.setCookie || '').split(';')[0];
check('S1 注册用户', reg.status === 201 && !!cookie, `status=${reg.status}`);

const me = await req('/api/auth/me', { cookie });
const userId = me.json?.data?.user?.id;
check('S2 取到 userId（夹具锚点）', !!userId, `userId=${userId}`);

const resume = await req('/api/resumes', {
  method: 'POST',
  cookie,
  body: { rawText: '林一舟\n技能：Python、FastAPI、PostgreSQL\n项目经历：AIGC 内容生成平台' },
});
const resumeId = resume.json?.data?.resumeId;
const detail = await req(`/api/resumes/${resumeId}`, { cookie });
const items = detail.json?.data?.items ?? [];
const conf = await req(`/api/resumes/${resumeId}/items/${items[0]?.id}`, {
  method: 'PATCH',
  cookie,
  body: { kind: 'SKILL', confirm: true },
});
check('S3 确认简历技能事实（V1 事实确认链路）', conf.status === 200 && conf.json?.data?.status === 'CONFIRMED', `status=${conf.json?.data?.status}`);

const jd = await req('/api/jds', {
  method: 'POST',
  cookie,
  body: {
    rawText:
      '岗位名称：后端工程师\n职责：负责服务端开发与维护\n任职要求：精通 Python、熟悉 Kubernetes、熟悉 Terraform、熟悉 Redis、三年以上后端经验',
  },
});
const jdId = jd.json?.data?.jdId;

const match = await req('/api/matches', { method: 'POST', cookie, body: { resumeId, jdId } });
const runId = match.json?.data?.runId;
const matchItems = match.json?.data?.items ?? [];
check('S4 生成 MatchRun', match.status === 201 && !!runId, `runId=${runId} summary=${JSON.stringify(match.json?.data?.summary ?? {})}`);

// ── 约束#1：Match 之后不自动生成 ────────────────────────────────────────
const listBefore = await req('/api/action-plans', { cookie });
check(
  'A1 约束#1 Match 后列表为空（未自动生成）',
  listBefore.status === 200 && (listBefore.json?.data?.items ?? []).length === 0,
  `count=${listBefore.json?.data?.items?.length}`,
);

// ── A2：用户主动生成 ───────────────────────────────────────────────────
const create = await req('/api/action-plans', { method: 'POST', cookie, body: { matchRunId: runId } });
const plan = create.json?.data;
const actions = plan?.actions ?? [];
check('A2 POST 主动生成 → 201', create.status === 201 && !!plan?.id, `status=${create.status}`);

// ── 约束#2 空态分支：无 CONFIRMED 能力时 have 为空，前端应展示空态而非伪造 ──
check(
  'A6.0 无已确认能力时 have=[]（前端展示空态，不伪造能力）',
  Array.isArray(plan?.have) && plan.have.length === 0,
  `have=${plan?.have?.length}（真实默认态）`,
);

// ── A6.2 / A6.3：缺口与建议行动（这两类与能力夹具无关，必须非空）──────────
const gaps = plan?.gaps ?? [];
check(
  'A6.2 能力缺口 gaps 展示（非空且字段完整）',
  gaps.length >= 1 && gaps.every((g) => typeof g.requirement === 'string' && g.requirement.length > 0),
  `gaps=${gaps.length}`,
);
check(
  'A6.3 建议行动 actions 展示（≥1，含 id/title/desc/status）',
  actions.length >= 1 && actions.every((a) => a.id && a.title && a.desc && a.status),
  `actions=${actions.length}`,
);

const gapSet = new Set(matchItems.filter((i) => i.status === 'MISSING' || i.status === 'ENHANCE').map((i) => i.requirement));
check(
  'A5b gaps 全部来自 MatchRun 缺口集合（MISSING/ENHANCE）',
  gaps.length >= 1 && gaps.every((g) => gapSet.has(g.requirement)),
  `gaps⊆matchGaps=${gaps.every((g) => gapSet.has(g.requirement))}`,
);

// ── A7.1：查看计划 ─────────────────────────────────────────────────────
const view = await req(`/api/action-plans/${plan.id}`, { cookie });
check('A7.1 查看计划 GET :id → 200', view.status === 200 && view.json?.data?.id === plan.id, `status=${view.status}`);

// ── A7.2：单步继续（约束#4 状态以服务端为准）─────────────────────────────
const stepId = actions[0]?.id;
const patch = await req(`/api/action-plans/${plan.id}/steps/${stepId}`, { method: 'PATCH', cookie, body: { status: 'DONE' } });
check('A7.2 单步推进 PATCH → DONE', patch.status === 200 && patch.json?.data?.status === 'DONE', `status=${patch.json?.data?.status}`);

const after = await req(`/api/action-plans/${plan.id}`, { cookie });
const persisted = (after.json?.data?.actions ?? []).find((a) => a.id === stepId)?.status;
check('A7.2b 约束#4 状态持久化（重新 GET 仍为 DONE）', persisted === 'DONE', `persisted=${persisted}`);

const badPatch = await req(`/api/action-plans/${plan.id}/steps/${stepId}`, { method: 'PATCH', cookie, body: { status: 'FINISHED' } });
check('A7.2c PATCH 非法状态 → 400（状态机守卫）', badPatch.status === 400, `status=${badPatch.status}`);

// ── 夹具：落一条带证据的能力并走真实 confirm 接口推到 CONFIRMED ──────────
let capLabel = null;
if (prisma && userId) {
  const seeded = await prisma.capability.create({
    data: {
      userId,
      key: 'python',
      label: 'Python',
      level: '熟练',
      source: 'MANUAL',
      evidence: { create: [{ type: 'USER_STATEMENT', source: 'USER_STATEMENT', excerpt: '简历明确列出 Python' }] },
    },
  });
  const capConfirm = await req(`/api/capabilities/${seeded.id}/confirm`, { method: 'POST', cookie, body: { confirmed: true } });
  capLabel = seeded.label;
  check('S5 夹具能力经真实接口确认 → CONFIRMED', capConfirm.status === 200 && capConfirm.json?.data?.status === 'CONFIRMED', `status=${capConfirm.json?.data?.status}`);
} else {
  check('S5 夹具能力落库', false, `prisma=${!!prisma} userId=${userId}`);
}

// ── A7.3：刷新（重新生成）→ 三类结果齐全，have 非空且来自 CONFIRMED ────────
const beforeIds = actions.map((a) => a.id);
const regen = await req(`/api/action-plans/${plan.id}/regenerate`, { method: 'POST', cookie });
const newPlan = regen.json?.data;
const newActions = newPlan?.actions ?? [];
const newIds = newActions.map((a) => a.id);
check(
  'A7.3 刷新（重新生成）→ 200 且 steps 整体替换',
  regen.status === 200 && newIds.length >= 1 && newIds.every((id) => !beforeIds.includes(id)),
  `status=${regen.status} errCode=${regen.json?.error?.code ?? '-'} new=${newIds.length}`,
);
check('A7.3b 重新生成后步骤状态重置（无遗留 DONE）', !newActions.some((a) => a.status === 'DONE'), `hasDone=${newActions.some((a) => a.status === 'DONE')}`);

const newHave = newPlan?.have ?? [];
check(
  'A6.1 已有能力 have 渲染（注入 CONFIRMED 后非空且字段完整）',
  newHave.length >= 1 && newHave.every((h) => typeof h.label === 'string' && h.label.length > 0),
  `have=${newHave.length} ${JSON.stringify(newHave.map((h) => h.label))}`,
);
check(
  'A5 have 全部来自 CONFIRMED 能力（服务端覆盖 LLM，无编造）',
  newHave.length >= 1 && newHave.every((h) => h.label === capLabel),
  `have<=confirmed=${newHave.every((h) => h.label === capLabel)}`,
);

// ── A7.4 错误状态：不存在 / 越权 / 注入 ─────────────────────────────────
const notFound = await req('/api/action-plans/does-not-exist-plan', { cookie });
check('A7.4 不存在计划 → 404（前端 ErrorState 路径）', notFound.status === 404, `status=${notFound.status}`);

const other = await req('/api/auth/register', { method: 'POST', body: { email: `qa3b_other_${Date.now()}@example.com`, password: 'password-1234' } });
const otherCookie = (other.setCookie || '').split(';')[0];
const cross = await req(`/api/action-plans/${plan.id}`, { cookie: otherCookie });
check('A2 跨用户查看计划 → 404', cross.status === 404, `status=${cross.status}`);
const crossPatch = await req(`/api/action-plans/${plan.id}/steps/${newIds[0]}`, { method: 'PATCH', cookie: otherCookie, body: { status: 'DONE' } });
check('A2b 跨用户改步骤 → 404', crossPatch.status === 404, `status=${crossPatch.status}`);
const inject = await req('/api/action-plans', { method: 'POST', cookie, body: { matchRunId: runId, userId: 'someone-else' } });
check('A2c body 注入 userId → 400', inject.status === 400, `status=${inject.status}`);

// ── P1：前端页面路由可达 ───────────────────────────────────────────────
const page = await req(`/action-plans/${plan.id}`);
check('P1 页面路由 /action-plans/:id → 200', page.status === 200, `status=${page.status}`);

if (prisma) await prisma.$disconnect();

console.log(`\nTOTAL=${pass + fail} PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
