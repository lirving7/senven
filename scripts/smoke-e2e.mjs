const base = 'http://localhost:3100';
const email = `smoke3_${Date.now()}@example.com`;

let prisma = null;
try {
  const mod = await import('@prisma/client');
  prisma = new mod.PrismaClient();
} catch {
  prisma = null;
}

async function req(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers['cookie'] = cookie;
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

const out = [];
const log = (s) => { out.push(s); console.log(s); };

let cookie = null;

const r1 = await req('/api/auth/register', { method: 'POST', body: { email, password: 'password-1234' } });
cookie = (r1.setCookie || '').split(';')[0];
log(`register => ${r1.status} cookie=${cookie}`);

const r2 = await req('/api/auth/me', { cookie });
log(`me => ${r2.status} ${r2.json?.data?.user?.email ?? ''}`);

const r3 = await req('/api/resumes', { method: 'POST', cookie, body: { rawText: '林一舟\n技能：Python、FastAPI、PostgreSQL\n项目经历：AIGC 内容生成平台' } });
log(`create resume => ${r3.status} resumeId=${r3.json?.data?.resumeId} itemCount=${r3.json?.data?.itemCount}`);
const resumeId = r3.json?.data?.resumeId;

const r4 = await req('/api/resumes', { cookie });
log(`list resumes => ${r4.status} count=${r4.json?.data?.items?.length}`);

const r5 = await req(`/api/resumes/${resumeId}`, { cookie });
log(`detail => ${r5.status} items=${r5.json?.data?.items?.length}`);
const itemId = r5.json?.data?.items?.[0]?.id;

const r6 = await req(`/api/resumes/${resumeId}/items/${itemId}`, { method: 'PATCH', cookie, body: { kind: 'SKILL', confirm: true } });
log(`confirm => ${r6.status} ${r6.json?.data?.status ?? r6.json?.error?.code ?? ''}`);

const jdText = '岗位名称：后端工程师\n职责：负责服务端开发与维护\n任职要求：精通 Python、熟悉 FastAPI、熟悉 PostgreSQL、三年以上后端经验、熟悉 Docker';
const r7 = await req('/api/jds', { method: 'POST', cookie, body: { rawText: jdText } });
log(`create jd => ${r7.status} jdId=${r7.json?.data?.jdId} req=${r7.json?.data?.requirementCount}`);
const jdId = r7.json?.data?.jdId;

const r8 = await req(`/api/jds/${jdId}`, { cookie });
log(`jd detail => ${r8.status} requirements=${r8.json?.data?.requirements?.length}`);

const r9 = await req('/api/matches', { method: 'POST', cookie, body: { resumeId, jdId } });
log(`match => ${r9.status} state=${r9.json?.data?.state ?? ''} items=${r9.json?.data?.items?.length ?? 0} summary=${JSON.stringify(r9.json?.data?.summary ?? {})}`);
const runId = r9.json?.data?.runId;

if (runId) {
  const r10 = await req('/api/suggestions', { method: 'POST', cookie, body: { resumeId, matchRunId: runId } });
  log(`suggest => ${r10.status} count=${r10.json?.data?.suggestions?.length ?? 0} state=${r10.json?.data?.state ?? ''}`);
}

const r11 = await req('/api/applications', { method: 'POST', cookie, body: { company: '云枢智能', jdId } });
log(`add application => ${r11.status} stage=${r11.json?.data?.stage}`);

const r12 = await req('/api/applications', { cookie });
log(`list applications => ${r12.status} total=${r12.json?.data?.counts?.total}`);

// ═══════════ T3-A2-6 Phase 4：LearningTask Smoke ═══════════
// 使用 Prisma fixture 确定性创建 [学习] ActionStep（不依赖 LLM），
// 通过真实 HTTP route 验证 LearningTask 闭环。
let ltFail = 0;
function ltCheck(ok, msg) {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) ltFail += 1;
}

log('--- LearningTask Smoke 开始 ---');

const meResp = await req('/api/auth/me', { cookie });
const ltUserId = meResp.json?.data?.user?.id;

let ltPlanId = null;
let ltStepId = null;
const ltStepTitle = '[学习] 掌握 Python 异步编程';

if (prisma && ltUserId) {
  try {
    const ltResume = await prisma.resume.create({ data: { userId: ltUserId, rawText: '技能：Python', sourceType: 'TEXT' } });
    const ltJd = await prisma.jobDescription.create({
      data: { userId: ltUserId, rawText: 'JD', title: '后端工程师', reqs: { create: [{ text: '精通 Python', category: 'TECH', criticality: 'MUST' }] } },
    });
    const ltMatch = await prisma.matchRun.create({
      data: {
        userId: ltUserId, resumeId: ltResume.id, jdId: ltJd.id, matcherVersion: 'v1', summary: {},
        items: { create: [{ reqText: '精通 Python', status: 'MISSING', category: 'TECH', criticality: 'MUST', reason: 'r', basisType: 'INFERENCE', basisDetail: 'd' }] },
      },
    });
    const ltPlan = await prisma.actionPlan.create({
      data: {
        userId: ltUserId, matchRunId: ltMatch.id, jdId: ltJd.id, goal: '后端工程师', have: [], gaps: [],
        steps: { create: [{ order: 1, title: ltStepTitle, desc: '学习 Python 异步编程', targetRequirement: '精通 Python' }] },
      },
      include: { steps: true },
    });
    ltPlanId = ltPlan.id;
    ltStepId = ltPlan.steps[0]?.id ?? null;
  } catch (e) {
    log(`  FAIL  fixture 创建失败: ${e.message}`);
    ltFail += 1;
  }
} else {
  log(`  FAIL  prisma=${!!prisma} userId=${ltUserId}`);
  ltFail += 1;
}

// create
const ltCreate = await req('/api/learning-tasks', { method: 'POST', cookie, body: { actionPlanId: ltPlanId, sourceStepId: ltStepId } });
const ltTaskId = ltCreate.json?.data?.id;
ltCheck(ltCreate.status === 201 && !!ltTaskId, `LearningTask create => ${ltCreate.status} id=${ltTaskId}`);

// list
const ltList = await req('/api/learning-tasks', { cookie });
ltCheck(ltList.status === 200 && (ltList.json?.data?.items ?? []).some((i) => i.id === ltTaskId), `LearningTask list => ${ltList.status} contains=${(ltList.json?.data?.items ?? []).some((i) => i.id === ltTaskId)}`);

// detail
const ltDetail = await req(`/api/learning-tasks/${ltTaskId}`, { cookie });
ltCheck(ltDetail.status === 200 && ltDetail.json?.data?.sourceStepTitle === ltStepTitle, `LearningTask detail => ${ltDetail.status} title=${ltDetail.json?.data?.sourceStepTitle}`);

// patch status（正向迁移）
const ltPatch = await req(`/api/learning-tasks/${ltTaskId}`, { method: 'PATCH', cookie, body: { status: 'IN_PROGRESS' } });
ltCheck(ltPatch.status === 200 && ltPatch.json?.data?.status === 'IN_PROGRESS', `LearningTask patch IN_PROGRESS => ${ltPatch.status}`);

// archive
const ltArchive = await req(`/api/learning-tasks/${ltTaskId}/archive`, { method: 'POST', cookie, body: {} });
ltCheck(ltArchive.status === 200 && !!ltArchive.json?.data?.archivedAt, `LearningTask archive => ${ltArchive.status}`);

// archived restriction（改 status → 422）
const ltRestrict = await req(`/api/learning-tasks/${ltTaskId}`, { method: 'PATCH', cookie, body: { status: 'PAUSED' } });
ltCheck(ltRestrict.status === 422, `LearningTask archived restriction => ${ltRestrict.status}`);

// cross-user（注册另一用户 → 读 404）
const ltOther = await req('/api/auth/register', { method: 'POST', body: { email: `smoke_lt_other_${Date.now()}@example.com`, password: 'password-1234' } });
const ltOtherCookie = (ltOther.setCookie || '').split(';')[0];
const ltCross = await req(`/api/learning-tasks/${ltTaskId}`, { cookie: ltOtherCookie });
ltCheck(ltCross.status === 404, `LearningTask cross-user read => ${ltCross.status}`);

// 清理
if (prisma && ltUserId) {
  try {
    await prisma.learningTask.deleteMany({ where: { userId: ltUserId } });
    await prisma.actionPlan.deleteMany({ where: { userId: ltUserId } });
    await prisma.matchRun.deleteMany({ where: { userId: ltUserId } });
    await prisma.jobDescription.deleteMany({ where: { userId: ltUserId } });
    await prisma.resume.deleteMany({ where: { userId: ltUserId } });
  } catch { /* ignore cleanup */ }
}
if (prisma) await prisma.$disconnect();

log(`--- LearningTask Smoke 完成 ${ltFail === 0 ? '(全部 PASS)' : `(${ltFail} FAIL)`} ---`);

log('SMOKE DONE');

process.exit(ltFail === 0 ? 0 : 1);
