/**
 * T4-2 —— Portfolio 独立黑盒 QA（只测不改）
 *
 * 前置：`next start -p 3100`（本脚本直接打真实 HTTP 接口）
 * 用法：`node scripts/qa-t4-2-portfolio.mjs`
 *
 * 采用 Prisma fixture 确定性创建 ProjectResult（submitted / draft / revoked 三态），
 * 然后通过**真实 HTTP route** 验证 Portfolio 的 7 个 endpoint。
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
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

let prisma = null;
try {
  const mod = await import('@prisma/client');
  prisma = new mod.PrismaClient();
} catch (e) {
  prisma = null;
}

// ── 注册用户（真实 HTTP）───────────────────────────────────────────
const email = `qapf_${Date.now()}@example.com`;
const reg = await req('/api/auth/register', { method: 'POST', body: { email, password: 'password-1234' } });
const cookie = (reg.setCookie || '').split(';')[0];
check('A0 注册用户', reg.status === 201 && !!cookie, `status=${reg.status}`);

const me = await req('/api/auth/me', { cookie });
const userId = me.json?.data?.user?.id;
check('A0b 取到 userId', !!userId, `userId=${userId}`);

// ── Prisma fixture：三个 ProjectResult（submitted / draft / revoked）──
let submittedId = null;
let draftId = null;
let revokedId = null;

if (prisma && userId) {
  try {
    const resume = await prisma.resume.create({ data: { userId, rawText: '技能：Python', sourceType: 'TEXT' } });
    const jd = await prisma.jobDescription.create({
      data: { userId, rawText: 'JD', title: '岗位', reqs: { create: [{ text: '要求1', category: 'TECH', criticality: 'MUST' }] } },
    });
    const matchRun = await prisma.matchRun.create({
      data: {
        userId, resumeId: resume.id, jdId: jd.id, matcherVersion: 'v1', summary: {},
        items: { create: [{ reqText: '要求1', status: 'MISSING', category: 'TECH', criticality: 'MUST', reason: 'r', basisType: 'INFERENCE', basisDetail: 'd' }] },
      },
    });
    const plan = await prisma.actionPlan.create({
      data: {
        userId, matchRunId: matchRun.id, jdId: jd.id, goal: 'g', have: [], gaps: [],
        steps: { create: [{ order: 1, title: 'step', desc: 'd', targetRequirement: '要求1' }] },
      },
      include: { steps: true },
    });
    const stepId = plan.steps[0].id;
    const mk = (title, submittedAt, revokedAt, fp) => prisma.projectResult.create({
      data: { userId, planId: plan.id, sourceStepId: stepId, sourceStepTitle: 'step', title, summary: 's', submittedAt, revokedAt, contentFingerprint: fp },
    });
    const s = await mk('submitted', new Date('2026-09-16T00:00:00.000Z'), null, 'qapf_fp_s');
    const d = await mk('draft', null, null, 'qapf_fp_d');
    const r = await mk('revoked', new Date('2026-09-16T00:00:00.000Z'), new Date('2026-09-17T00:00:00.000Z'), 'qapf_fp_r');
    submittedId = s.id;
    draftId = d.id;
    revokedId = r.id;
    check('F1 fixture 创建 3 态 ProjectResult', !!submittedId && !!draftId && !!revokedId, `submitted=${submittedId}`);
  } catch (e) {
    check('F1 fixture 创建 3 态 ProjectResult', false, `err=${e.message}`);
  }
} else {
  check('F1 fixture 创建 3 态 ProjectResult', false, `prisma=${!!prisma} userId=${userId}`);
}

// ── A. 未认证 → 401 ────────────────────────────────────────────────
const unauth = await req('/api/portfolio-projects', { method: 'POST', body: { title: 't' } });
check('B1 未认证创建 → 401', unauth.status === 401, `status=${unauth.status}`);

// ── B. 创建 → 201 ──────────────────────────────────────────────────
const created = await req('/api/portfolio-projects', { method: 'POST', cookie, body: { title: '我的作品集', description: 'desc' } });
const projectId = created.json?.data?.id;
check('B2 创建 → 201 返回 id', created.status === 201 && !!projectId, `status=${created.status} id=${projectId}`);
check('B3 默认 displayOrder=0 featured=false', created.json?.data?.displayOrder === 0 && created.json?.data?.featured === false, 'defaults');
check('B4 响应不含 userId', created.json?.data && !('userId' in created.json.data), 'no userId');

// 非法：title 超长 → 400
const longTitle = await req('/api/portfolio-projects', { method: 'POST', cookie, body: { title: 'x'.repeat(121) } });
check('B5 title 超 120 → 400', longTitle.status === 400, `status=${longTitle.status}`);

// 非法：未知字段（displayOrder 不属 POST）→ 400
const unknownField = await req('/api/portfolio-projects', { method: 'POST', cookie, body: { title: 't', displayOrder: 5 } });
check('B6 POST 未知字段 displayOrder → 400', unknownField.status === 400, `status=${unknownField.status}`);

// ── C. 列表 / 详情 ─────────────────────────────────────────────────
const list = await req('/api/portfolio-projects', { cookie });
check('C1 列表 → 200 含刚创建', list.status === 200 && (list.json?.data?.items ?? []).some((i) => i.id === projectId), `count=${list.json?.data?.items?.length}`);

const detail = await req(`/api/portfolio-projects/${projectId}`, { cookie });
check('C2 详情 → 200', detail.status === 200, `status=${detail.status}`);

// ── D. 跨用户 → 404 ────────────────────────────────────────────────
const otherReg = await req('/api/auth/register', { method: 'POST', body: { email: `qapf_other_${Date.now()}@example.com`, password: 'password-1234' } });
const otherCookie = (otherReg.setCookie || '').split(';')[0];
const crossGet = await req(`/api/portfolio-projects/${projectId}`, { cookie: otherCookie });
check('D1 跨用户读 → 404', crossGet.status === 404, `status=${crossGet.status}`);

// ── E. PATCH ───────────────────────────────────────────────────────
const patched = await req(`/api/portfolio-projects/${projectId}`, { method: 'PATCH', cookie, body: { title: '新标题', featured: true } });
check('E1 PATCH title/featured → 200', patched.status === 200 && patched.json?.data?.title === '新标题' && patched.json?.data?.featured === true, `status=${patched.status}`);
const emptyPatch = await req(`/api/portfolio-projects/${projectId}`, { method: 'PATCH', cookie, body: {} });
check('E2 PATCH 空对象 → 400', emptyPatch.status === 400, `status=${emptyPatch.status}`);

// ── F. 加入成员 ────────────────────────────────────────────────────
const addSubmitted = await req(`/api/portfolio-projects/${projectId}/results`, { method: 'POST', cookie, body: { projectResultId: submittedId } });
check('F1 加入 submitted → 201', addSubmitted.status === 201, `status=${addSubmitted.status}`);
const dup = await req(`/api/portfolio-projects/${projectId}/results`, { method: 'POST', cookie, body: { projectResultId: submittedId, displayOrder: 999 } });
check('F2 重复加入 → 200 不改 displayOrder', dup.status === 200 && dup.json?.data?.displayOrder === 0, `status=${dup.status} order=${dup.json?.data?.displayOrder}`);
const addDraft = await req(`/api/portfolio-projects/${projectId}/results`, { method: 'POST', cookie, body: { projectResultId: draftId } });
check('F3 加入 draft → 422', addDraft.status === 422 && addDraft.json?.error?.code === 'PORTFOLIO_RESULT_NOT_ELIGIBLE', `status=${addDraft.status} code=${addDraft.json?.error?.code}`);
const addRevoked = await req(`/api/portfolio-projects/${projectId}/results`, { method: 'POST', cookie, body: { projectResultId: revokedId } });
check('F4 加入 revoked → 422', addRevoked.status === 422 && addRevoked.json?.error?.code === 'PORTFOLIO_RESULT_NOT_ELIGIBLE', `status=${addRevoked.status}`);

// ── G. archive ─────────────────────────────────────────────────────
const archive = await req(`/api/portfolio-projects/${projectId}/archive`, { method: 'POST', cookie, body: {} });
check('G1 archive → 200', archive.status === 200 && !!archive.json?.data?.archivedAt, `status=${archive.status}`);
const archiveAgain = await req(`/api/portfolio-projects/${projectId}/archive`, { method: 'POST', cookie, body: {} });
check('G2 重复 archive → 200 不改 archivedAt', archiveAgain.status === 200 && archiveAgain.json?.data?.archivedAt === archive.json?.data?.archivedAt, `status=${archiveAgain.status}`);

// 归档后 PATCH / ADD / REMOVE → 409
const archivedPatch = await req(`/api/portfolio-projects/${projectId}`, { method: 'PATCH', cookie, body: { title: 'x' } });
check('G3 归档后 PATCH → 409', archivedPatch.status === 409 && archivedPatch.json?.error?.code === 'PORTFOLIO_ARCHIVED', `status=${archivedPatch.status}`);
const archivedAdd = await req(`/api/portfolio-projects/${projectId}/results`, { method: 'POST', cookie, body: { projectResultId: submittedId } });
check('G4 归档后 ADD → 409', archivedAdd.status === 409, `status=${archivedAdd.status}`);
const archivedRemove = await req(`/api/portfolio-projects/${projectId}/results/${submittedId}`, { method: 'DELETE', cookie });
check('G5 归档后 REMOVE → 409', archivedRemove.status === 409, `status=${archivedRemove.status}`);

// 归档后 detail 仍 200，且列表隐藏
const archivedDetail = await req(`/api/portfolio-projects/${projectId}`, { cookie });
check('G6 归档后 detail 仍 200', archivedDetail.status === 200, `status=${archivedDetail.status}`);
const listAfterArchive = await req('/api/portfolio-projects', { cookie });
check('G7 归档后列表隐藏', !(listAfterArchive.json?.data?.items ?? []).some((i) => i.id === projectId), `count=${listAfterArchive.json?.data?.items?.length}`);

// ── H. REMOVE（未归档项目）─────────────────────────────────────────
const p2 = await req('/api/portfolio-projects', { method: 'POST', cookie, body: { title: 'p2' } });
const p2Id = p2.json?.data?.id;
await req(`/api/portfolio-projects/${p2Id}/results`, { method: 'POST', cookie, body: { projectResultId: submittedId } });
const removed = await req(`/api/portfolio-projects/${p2Id}/results/${submittedId}`, { method: 'DELETE', cookie });
check('H1 REMOVE → 200', removed.status === 200, `status=${removed.status}`);
const removedAgain = await req(`/api/portfolio-projects/${p2Id}/results/${submittedId}`, { method: 'DELETE', cookie });
check('H2 再 REMOVE（不存在）→ 404', removedAgain.status === 404, `status=${removedAgain.status}`);

// ── 清理 fixture ────────────────────────────────────────────────────
if (prisma && userId) {
  try {
    await prisma.portfolioProjectResult.deleteMany({ where: { portfolioProject: { userId } } });
    await prisma.portfolioProject.deleteMany({ where: { userId } });
    await prisma.projectResult.deleteMany({ where: { userId } });
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
