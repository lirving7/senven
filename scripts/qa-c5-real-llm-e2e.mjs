/**
 * C5 · T2→T3 桥接「真实 LLM HTTP 端到端」（补充门禁，**不替代** B1~B8 的确定性验收）
 *
 * 前置：`CODEBUDDY_SAFE_DELETE_ENABLED=0 node node_modules/next/dist/bin/next start -p 3100`
 * 用法：`node scripts/qa-c5-real-llm-e2e.mjs`
 *
 * 目的：只验证「真实链路能跑通」——真实 LLM 的解析、ActionStep 类型前缀折叠、C2/C3 在真实
 * HTTP 路径上的投影与 reconcile、以及反向封闭（Step DONE 不产生能力）。
 *
 * 明确边界：**LLM 的随机文案不作为事实安全的证明**；事实安全以 B5 的确定性测试为准。
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
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

let prisma = null;
try {
  const mod = await import('@prisma/client');
  prisma = new mod.PrismaClient();
} catch {
  prisma = null;
}

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const email = `qa_c5_${stamp}@example.com`;
const RECONCILE_KEY = 'qa_c5_reconcile_only';

/* ── 1) 注册 ── */
const reg = await req('/api/auth/register', { method: 'POST', body: { email, password: 'password-1234' } });
const cookie = (reg.setCookie || '').split(';')[0];
check('R1 注册', reg.status === 201 && !!cookie, `status=${reg.status}`);
if (!cookie) {
  console.log(`\nTOTAL=${pass + fail} PASS=${pass} FAIL=${fail}`);
  process.exit(1);
}

const me = await req('/api/auth/me', { cookie });
const userId = me.json?.data?.user?.id;
check('R2 取 userId', !!userId, `userId=${userId}`);

/* ── 2) 真实 LLM 解析简历 ── */
const resume = await req('/api/resumes', {
  method: 'POST',
  cookie,
  body: { rawText: '林一舟\n技能：Python、FastAPI、PostgreSQL\n项目经历：AIGC 内容生成平台\n使用 Python 完成数据处理' },
});
const resumeId = resume.json?.data?.resumeId;
check('E1 真实 LLM 解析简历', resume.status === 201 && !!resumeId, `status=${resume.status} items=${resume.json?.data?.itemCount}`);

const detail = await req(`/api/resumes/${resumeId}`, { cookie });
const items = detail.json?.data?.items ?? [];
// 注意：读接口的 locator/excerpt 位于条目的 evidence[] 内（见 resume-read.ts），不在条目顶层
const usable = (i) =>
  Array.isArray(i.evidence) && i.evidence.some((e) => (e.locator ?? '').trim().length > 0 && (e.excerpt ?? '').trim().length > 0);
check(
  'E2 简历条目带可核验证据',
  items.length > 0 && items.every(usable),
  `items=${items.length} withEvidence=${items.filter(usable).length}`,
);

/* ── 3) 确认一条事实 → C2 主路径投影（真实 HTTP） ── */
let confirmed = false;
for (const item of items.slice(0, 5)) {
  for (const kind of ['SKILL', 'PROJECT']) {
    const r = await req(`/api/resumes/${resumeId}/items/${item.id}`, {
      method: 'PATCH',
      cookie,
      body: { kind, confirm: true },
    });
    if (r.status === 200) {
      confirmed = true;
      break;
    }
  }
  if (confirmed) break;
}
check('E3 确认简历事实（C2 入口）', confirmed, confirmed ? 'confirmed' : '无任何条目可确认');

const capsAfterConfirm = await req('/api/capabilities', { cookie });
const caps = capsAfterConfirm.json?.data?.items ?? [];
const confirmedCaps = caps.filter((c) => c.status === 'CONFIRMED');
check(
  'E4 C2 真实路径投影出生效：确认后能力库出现 CONFIRMED 能力',
  confirmedCaps.length >= 1,
  `confirmed=${confirmedCaps.length}/${caps.length}`,
);
const capKeys = new Set(confirmedCaps.map((c) => c.key));

/* ── 4) 真实 LLM 解析 JD + 匹配 ── */
const jd = await req('/api/jds', {
  method: 'POST',
  cookie,
  body: {
    rawText:
      '岗位名称：后端工程师\n职责：负责服务端开发与维护\n任职要求：精通 Python、熟悉 Kubernetes、熟悉 Terraform、熟悉 Redis、三年以上后端经验',
  },
});
const jdId = jd.json?.data?.jdId;
check('E5 真实 LLM 解析 JD', jd.status === 201 && !!jdId, `status=${jd.status} reqs=${jd.json?.data?.requirementCount}`);

const match = await req('/api/matches', { method: 'POST', cookie, body: { resumeId, jdId } });
const runId = match.json?.data?.runId;
const matchItems = match.json?.data?.items ?? [];
check('E6 真实 LLM 匹配', match.status === 201 && !!runId, `summary=${JSON.stringify(match.json?.data?.summary ?? {})}`);

/* ── 5) 造一条「CONFIRMED 但未投影」的历史事实 → 专测 C3（真实 HTTP） ── */
let c3Seeded = false;
if (prisma && userId && resumeId) {
  const s = await prisma.skill.create({
    data: { resumeId, key: RECONCILE_KEY, label: 'Terraform', level: '了解', status: 'CONFIRMED' },
    select: { id: true },
  });
  await prisma.evidence.create({
    data: { source: 'RESUME_TEXT', locator: 'resume:line:4', excerpt: 'QA：历史已确认但未投影（C5 专用）', skillId: s.id },
  });
  const existing = await prisma.capability.findUnique({
    where: { userId_key: { userId, key: RECONCILE_KEY } },
    select: { id: true },
  });
  c3Seeded = !existing;
}
check('E7 造出「CONFIRMED 未投影」的历史事实（C3 专用夹具）', c3Seeded, `prisma=${!!prisma}`);

/* ── 6) 生成行动计划（真实 LLM）→ 同时验证 C3 reconcile ── */
const create = await req('/api/action-plans', { method: 'POST', cookie, body: { matchRunId: runId } });
const plan = create.json?.data;
check('E8 真实 LLM 生成行动计划', create.status === 201 && !!plan?.id, `status=${create.status} err=${create.json?.error?.code ?? '-'}`);

const have = plan?.have ?? [];
const gaps = plan?.gaps ?? [];
const actions = plan?.actions ?? [];

check('E9 have 非空（真实链路上能力已进入计划）', have.length >= 1, `have=${have.length} ${JSON.stringify(have.map((h) => h.label))}`);
check('E10 gaps 非空', gaps.length >= 1, `gaps=${gaps.length}`);
check('E11 actions 非空且字段完整', actions.length >= 1 && actions.every((a) => a.id && a.title && a.desc && a.status), `actions=${actions.length}`);

/* ── 7) C3 reconcile 在真实 HTTP 路径上确实生效 ── */
const haveKeys = new Set(have.map((h) => h.key));
check(
  'E12 C3 真实路径 reconcile：未投影的历史事实被补入 have',
  haveKeys.has(RECONCILE_KEY),
  `haveKeys=${JSON.stringify([...haveKeys])}`,
);
if (prisma && userId) {
  const cap = await prisma.capability.findUnique({
    where: { userId_key: { userId, key: RECONCILE_KEY } },
    include: { evidence: true },
  });
  check('E13 C3 补出的能力带可核验证据', !!cap && cap.status === 'CONFIRMED' && cap.evidence.length >= 1, `evidence=${cap?.evidence?.length ?? 0}`);
}

/* ── 8) ActionStep 类型前缀（真实 LLM 路径） ── */
const PREFIXES = ['[学习]', '[实践]', '[项目]'];
const prefixed = actions.filter((a) => PREFIXES.some((p) => (a.title ?? '').startsWith(p)));
check(
  'E14 ActionStep 类型前缀在真实 LLM 路径上被折叠进标题',
  prefixed.length >= 1,
  `prefixed=${prefixed.length}/${actions.length} 示例=${JSON.stringify(actions.slice(0, 3).map((a) => a.title))}`,
);

/* ── 9) 刷新（重新生成）真实链路 ── */
const beforeIds = actions.map((a) => a.id);
const regen = await req(`/api/action-plans/${plan.id}/regenerate`, { method: 'POST', cookie });
const regenActions = regen.json?.data?.actions ?? [];
check(
  'E15 真实链路 regenerate 成功且 steps 整体替换',
  regen.status === 200 && regenActions.length >= 1 && regenActions.every((a) => !beforeIds.includes(a.id)),
  `status=${regen.status} err=${regen.json?.error?.code ?? '-'} new=${regenActions.length}`,
);

/* ── 10) 单步推进 + 反向不变量（真实链路） ── */
const capsBeforeSteps = (await req('/api/capabilities', { cookie })).json?.data?.items?.length ?? -1;
const stepId = regenActions[0]?.id;
const patched = await req(`/api/action-plans/${plan.id}/steps/${stepId}`, { method: 'PATCH', cookie, body: { status: 'DONE' } });
check('E16 真实链路单步推进 → DONE', patched.status === 200 && patched.json?.data?.status === 'DONE', `status=${patched.json?.data?.status}`);

const reread = await req(`/api/action-plans/${plan.id}`, { cookie });
const persisted = (reread.json?.data?.actions ?? []).find((s) => s.id === stepId)?.status;
check('E17 状态持久化', persisted === 'DONE', `persisted=${persisted}`);

const capsAfterSteps = (await req('/api/capabilities', { cookie })).json?.data?.items?.length ?? -1;
check(
  'E18 反向不变量：步骤置 DONE 不产生新能力（ActionStep ≠ Capability）',
  capsAfterSteps === capsBeforeSteps,
  `before=${capsBeforeSteps} after=${capsAfterSteps}`,
);

/* ── 清理 ── */
if (prisma && userId) {
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
}

console.log(`\nTOTAL=${pass + fail} PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
