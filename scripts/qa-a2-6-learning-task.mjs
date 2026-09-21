/**
 * T3-A2-6 Phase 4 —— LearningTask 独立黑盒 QA（只测不改）
 *
 * 前置：`next start -p 3100`（本脚本直接打真实 HTTP 接口）
 * 用法：`node scripts/qa-a2-6-learning-task.mjs`
 *
 * 采用 Prisma fixture 确定性创建 `[学习]` ActionStep（不依赖 LLM 随机生成），
 * 然后通过**真实 HTTP route** 验证 LearningTask 的 5 个 endpoint：
 *   POST /api/learning-tasks        创建
 *   GET  /api/learning-tasks        列表
 *   GET  /api/learning-tasks/:id    详情
 *   PATCH /api/learning-tasks/:id   状态/content 修改
 *   POST /api/learning-tasks/:id/archive  归档
 *
 * 覆盖关键业务约束：401 / 201 / 幂等 / 跨用户 404 / 状态迁移 / 非法回退 422 /
 * archived 后修改 422 / archived 后 content 不变 / archived 可读 / archive 幂等。
 */

const base = process.env.QA_BASE || 'http://localhost:3100';

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
} catch (e) {
  prisma = null;
}

// ── 造数：用户（真实 HTTP 注册）───────────────────────────────────────
const email = `qalt_${Date.now()}@example.com`;
const reg = await req('/api/auth/register', { method: 'POST', body: { email, password: 'password-1234' } });
const cookie = (reg.setCookie || '').split(';')[0];
check('A0 注册用户', reg.status === 201 && !!cookie, `status=${reg.status}`);

const me = await req('/api/auth/me', { cookie });
const userId = me.json?.data?.user?.id;
check('A0b 取到 userId（夹具锚点）', !!userId, `userId=${userId}`);

// ── Prisma fixture：Resume / JD / MatchRun / ActionPlan / ActionStep [学习] ──
let planId = null;
let sourceStepId = null;
let sourceStepTitle = '[学习] 掌握 Python 异步编程';

if (prisma && userId) {
  try {
    const resume = await prisma.resume.create({
      data: { userId, rawText: '技能：Python', sourceType: 'TEXT' },
    });
    const jd = await prisma.jobDescription.create({
      data: {
        userId,
        rawText: 'JD',
        title: '后端工程师',
        reqs: { create: [{ text: '精通 Python', category: 'TECH', criticality: 'MUST' }] },
      },
    });
    const matchRun = await prisma.matchRun.create({
      data: {
        userId,
        resumeId: resume.id,
        jdId: jd.id,
        matcherVersion: 'v1',
        summary: {},
        items: {
          create: [{
            reqText: '精通 Python',
            status: 'MISSING',
            category: 'TECH',
            criticality: 'MUST',
            reason: 'r',
            basisType: 'INFERENCE',
            basisDetail: 'd',
          }],
        },
      },
    });
    const plan = await prisma.actionPlan.create({
      data: {
        userId,
        matchRunId: matchRun.id,
        jdId: jd.id,
        goal: '后端工程师',
        have: [],
        gaps: [{ requirement: '精通 Python', category: 'TECH', criticality: 'MUST' }],
        steps: {
          create: [{
            order: 1,
            title: sourceStepTitle,
            desc: '学习 Python 异步编程',
            targetRequirement: '精通 Python',
          }],
        },
      },
      include: { steps: true },
    });
    planId = plan.id;
    sourceStepId = plan.steps[0]?.id ?? null;
    check('F1 fixture 创建 ActionPlan + [学习] ActionStep', !!planId && !!sourceStepId, `planId=${planId} stepId=${sourceStepId}`);
  } catch (e) {
    check('F1 fixture 创建 ActionPlan + [学习] ActionStep', false, `err=${e.message}`);
  }
} else {
  check('F1 fixture 创建 ActionPlan + [学习] ActionStep', false, `prisma=${!!prisma} userId=${userId}`);
}

// ── A. 未认证 → 401 ────────────────────────────────────────────────
const unauthCreate = await req('/api/learning-tasks', { method: 'POST', body: { actionPlanId: planId, sourceStepId } });
check('B1 未认证创建 → 401', unauthCreate.status === 401, `status=${unauthCreate.status}`);

// ── B. 正常创建 → 201 ──────────────────────────────────────────────
const createBody = { actionPlanId: planId, sourceStepId };
const created = await req('/api/learning-tasks', { method: 'POST', cookie, body: createBody });
const taskId = created.json?.data?.id;
check('B2 正常创建 → 201 且返回 id', created.status === 201 && !!taskId, `status=${created.status} id=${taskId}`);
check('B2b 创建返回 status=PLANNED', created.json?.data?.status === 'PLANNED', `status=${created.json?.data?.status}`);
check('B2c 响应不含 userId', created.json?.data && !('userId' in created.json.data), 'no userId');

// ── C. 重复创建（active duplicate）→ 200 幂等 ────────────────────────
const dup = await req('/api/learning-tasks', { method: 'POST', cookie, body: createBody });
check('C1 重复创建（active）→ 200 返回已有', dup.status === 200 && dup.json?.data?.id === taskId, `status=${dup.status} id=${dup.json?.data?.id}`);

// ── D. 列表 → 200 且含刚创建的 ──────────────────────────────────────
const list = await req('/api/learning-tasks', { cookie });
check('D1 列表 → 200', list.status === 200, `status=${list.status}`);
check('D2 列表含刚创建的 active task', (list.json?.data?.items ?? []).some((i) => i.id === taskId), `count=${list.json?.data?.items?.length}`);

// ── E. 详情 → 200 ──────────────────────────────────────────────────
const detail = await req(`/api/learning-tasks/${taskId}`, { cookie });
check('E1 详情 → 200', detail.status === 200, `status=${detail.status}`);
check('E2 详情 sourceStepTitle 正确', detail.json?.data?.sourceStepTitle === sourceStepTitle, `title=${detail.json?.data?.sourceStepTitle}`);
check('E3 详情不含 userId', detail.json?.data && !('userId' in detail.json.data), 'no userId');

// ── F. 跨用户 → 404 ────────────────────────────────────────────────
const otherReg = await req('/api/auth/register', { method: 'POST', body: { email: `qalt_other_${Date.now()}@example.com`, password: 'password-1234' } });
const otherCookie = (otherReg.setCookie || '').split(';')[0];
const crossGet = await req(`/api/learning-tasks/${taskId}`, { cookie: otherCookie });
check('F1 跨用户读 → 404', crossGet.status === 404, `status=${crossGet.status}`);
const crossPatch = await req(`/api/learning-tasks/${taskId}`, { method: 'PATCH', cookie: otherCookie, body: { status: 'IN_PROGRESS' } });
check('F2 跨用户改 → 404', crossPatch.status === 404, `status=${crossPatch.status}`);

// ── G. 状态迁移矩阵 ────────────────────────────────────────────────
const toInProgress = await req(`/api/learning-tasks/${taskId}`, { method: 'PATCH', cookie, body: { status: 'IN_PROGRESS' } });
check('G1 PLANNED→IN_PROGRESS → 200', toInProgress.status === 200 && toInProgress.json?.data?.status === 'IN_PROGRESS', `status=${toInProgress.json?.data?.status}`);

const toPaused = await req(`/api/learning-tasks/${taskId}`, { method: 'PATCH', cookie, body: { status: 'PAUSED' } });
check('G2 IN_PROGRESS→PAUSED → 200', toPaused.status === 200 && toPaused.json?.data?.status === 'PAUSED', `status=${toPaused.json?.data?.status}`);

const pausedToInProgress = await req(`/api/learning-tasks/${taskId}`, { method: 'PATCH', cookie, body: { status: 'IN_PROGRESS' } });
check('G3 PAUSED→IN_PROGRESS → 200', pausedToInProgress.status === 200 && pausedToInProgress.json?.data?.status === 'IN_PROGRESS', `status=${pausedToInProgress.json?.data?.status}`);

const backToPlanned = await req(`/api/learning-tasks/${taskId}`, { method: 'PATCH', cookie, body: { status: 'PLANNED' } });
check('G4 非法回退 IN_PROGRESS→PLANNED → 422', backToPlanned.status === 422 && backToPlanned.json?.error?.code === 'LEARNING_TASK_NOT_TRANSITIONABLE', `status=${backToPlanned.status} code=${backToPlanned.json?.error?.code}`);

const noop = await req(`/api/learning-tasks/${taskId}`, { method: 'PATCH', cookie, body: { status: 'IN_PROGRESS' } });
check('G5 同值 IN_PROGRESS→IN_PROGRESS → 200 no-op', noop.status === 200, `status=${noop.status}`);

const illegal = await req(`/api/learning-tasks/${taskId}`, { method: 'PATCH', cookie, body: { status: 'DONE' } });
check('G6 非法状态 DONE → 422', illegal.status === 422 && illegal.json?.error?.code === 'LEARNING_TASK_NOT_TRANSITIONABLE', `status=${illegal.status} code=${illegal.json?.error?.code}`);

// ── H. content 修改 ────────────────────────────────────────────────
const setContent = await req(`/api/learning-tasks/${taskId}`, { method: 'PATCH', cookie, body: { content: '学习了 asyncio 与协程' } });
check('H1 修改 content → 200', setContent.status === 200 && setContent.json?.data?.content === '学习了 asyncio 与协程', `status=${setContent.status}`);

// ── I. archive ─────────────────────────────────────────────────────
const archive = await req(`/api/learning-tasks/${taskId}/archive`, { method: 'POST', cookie, body: {} });
check('I1 archive → 200', archive.status === 200 && !!archive.json?.data?.archivedAt, `status=${archive.status}`);
check('I2 archive 不改 status', archive.json?.data?.status === 'IN_PROGRESS', `status=${archive.json?.data?.status}`);

const archiveAgain = await req(`/api/learning-tasks/${taskId}/archive`, { method: 'POST', cookie, body: {} });
check('I3 重复 archive → 200 幂等', archiveAgain.status === 200 && archiveAgain.json?.data?.archivedAt === archive.json?.data?.archivedAt, `status=${archiveAgain.status}`);

// ── J. archived 后约束 ─────────────────────────────────────────────
const archivedDetail = await req(`/api/learning-tasks/${taskId}`, { cookie });
check('J1 archived 后仍可读 → 200', archivedDetail.status === 200 && !!archivedDetail.json?.data?.archivedAt, `status=${archivedDetail.status}`);

const archivedPatch = await req(`/api/learning-tasks/${taskId}`, { method: 'PATCH', cookie, body: { status: 'PAUSED' } });
check('J2 archived 后改 status → 422', archivedPatch.status === 422, `status=${archivedPatch.status}`);

const archivedContentPatch = await req(`/api/learning-tasks/${taskId}`, { method: 'PATCH', cookie, body: { content: '篡改' } });
check('J3 archived 后改 content → 422', archivedContentPatch.status === 422, `status=${archivedContentPatch.status}`);

const archivedContentDetail = await req(`/api/learning-tasks/${taskId}`, { cookie });
check('J4 archived 后 content 不变', archivedContentDetail.json?.data?.content === '学习了 asyncio 与协程', `content=${archivedContentDetail.json?.data?.content}`);

// ── K. archived duplicate（重新创建同三元组）→ 409 ──────────────────
const reCreate = await req('/api/learning-tasks', { method: 'POST', cookie, body: createBody });
check('K1 archived duplicate 重新创建 → 409', reCreate.status === 409 && reCreate.json?.error?.code === 'LEARNING_TASK_ARCHIVED_EXISTS', `status=${reCreate.status} code=${reCreate.json?.error?.code}`);

// ── 清理 fixture ────────────────────────────────────────────────────
if (prisma && userId) {
  try {
    await prisma.learningTask.deleteMany({ where: { userId } });
    await prisma.actionPlan.deleteMany({ where: { userId } });
    await prisma.matchRun.deleteMany({ where: { userId } });
    await prisma.jobDescription.deleteMany({ where: { userId } });
    await prisma.resume.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  } catch (e) {
    // 清理失败不影响 QA 结果
  }
}
if (prisma) await prisma.$disconnect();

console.log(`\nTOTAL=${pass + fail} PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
