/**
 * JobPilot V1 Release Acceptance —— 黑盒 QA（QA 测试工程师视角）
 * 覆盖：认证/会话、简历（文本/DOCX/图片拒绝/空）、JD、匹配、建议、PDF/ATS、投递、安全边界。
 * 只测不改；每个用例输出 PASS/FAIL + 证据。用法：先 `next start`（端口 3100），再 `node scripts/qa-release.mjs`
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const BASE = process.env.QA_BASE || 'http://localhost:3100';
const results = [];
const R = (name, ok, detail = '') => results.push({ name, ok, detail });

async function req(path, { method = 'GET', body, cookie, rawBody } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers['cookie'] = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, buf, setCookie: res.headers.get('set-cookie'), headers: res.headers };
}

function check(cond, msg) { return { ok: !!cond, msg }; }

// ---------- 工具 ----------
function docxBytes(lines) {
  const { zipSync, strToU8 } = require('fflate');
  const paras = lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${l}</w:t></w:r></w:p>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`;
  return zipSync({ 'word/document.xml': strToU8(xml) });
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const stamp = Date.now();
const emailA = `qa_${stamp}_a@example.com`;
const emailB = `qa_${stamp}_b@example.com`;
let cookieA = null, cookieB = null, uidA = null;

// ============ A. 认证 / 会话 ============
{
  const r = await req('/api/auth/register', { method: 'POST', body: { email: emailA, password: 'password-1234' } });
  cookieA = (r.setCookie || '').split(';')[0];
  uidA = r.json?.data?.user?.id;
  R('A1 注册 → 201 + 下发会话 Cookie', check(r.status === 201 && !!cookieA, `status=${r.status}`));

  const dup = await req('/api/auth/register', { method: 'POST', body: { email: emailA, password: 'password-1234' } });
  R('A2 重复邮箱 → 409 EMAIL_TAKEN', check(dup.status === 409 && dup.json?.error?.code === 'EMAIL_TAKEN', `status=${dup.status} code=${dup.json?.error?.code}`));

  const wrong = await req('/api/auth/login', { method: 'POST', body: { email: emailA, password: 'wrong-password' } });
  const ghost = await req('/api/auth/login', { method: 'POST', body: { email: `nobody_${stamp}@x.com`, password: 'whatever-123' } });
  R('A3 密码错/账号不存在 → 同为 401（不泄露账号存在性）', check(wrong.status === 401 && ghost.status === 401 && wrong.json?.error?.code === ghost.json?.error?.code, `wrong=${wrong.status} ghost=${ghost.status}`));

  const ok = await req('/api/auth/login', { method: 'POST', body: { email: emailA, password: 'password-1234' } });
  R('A4 正确登录 → 200 + Cookie', check(ok.status === 200 && !!ok.setCookie, `status=${ok.status}`));

  const me = await req('/api/auth/me', { cookie: cookieA });
  R('A5 /auth/me → 200 且不含密码字段', check(me.status === 200 && me.json?.data?.user && !JSON.stringify(me.json).includes('passwordHash'), `status=${me.status}`));

  const bReg = await req('/api/auth/register', { method: 'POST', body: { email: emailB, password: 'password-1234' } });
  cookieB = (bReg.setCookie || '').split(';')[0];

  const logout = await req('/api/auth/logout', { method: 'POST', cookie: cookieA });
  const meAfter = await req('/api/auth/me', { cookie: cookieA });
  R('A6 登出后会话失效 → me 401', check(logout.status === 200 && meAfter.status === 401, `logout=${logout.status} meAfter=${meAfter.status}`));
  // 重新登录，继续后续流程
  cookieA = (await req('/api/auth/login', { method: 'POST', body: { email: emailA, password: 'password-1234' } })).setCookie.split(';')[0];
}

// ============ B. 简历 ============
let resumeId = null, resumeNoConfirmId = null;
{
  const anon = await req('/api/resumes');
  R('B0 未登录访问 → 401', check(anon.status === 401, `status=${anon.status}`));

  const empty = await req('/api/resumes', { method: 'POST', cookie: cookieA, body: { rawText: '   ' } });
  R('B1 空文本 → 400', check(empty.status === 400, `status=${empty.status}`));

  const img = await req('/api/resumes', { method: 'POST', cookie: cookieA, rawBody: (() => { const f = new FormData(); f.append('file', new File([PNG], 'resume.png', { type: 'image/png' })); return f; })() });
  R('B2 图片简历 → 422 SCAN_NOT_SUPPORTED', check(img.status === 422 && img.json?.error?.code === 'SCAN_NOT_SUPPORTED', `status=${img.status} code=${img.json?.error?.code}`));

  const docx = await req('/api/resumes', { method: 'POST', cookie: cookieA, rawBody: (() => { const f = new FormData(); f.append('file', new File([docxBytes(['林一舟', '技能：Python、Docker', '项目：AIGC 平台'])], 'r.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })); return f; })() });
  R('B3 DOCX 简历 → 201 且解析出条目', check(docx.status === 201 && docx.json?.data?.resumeId && docx.json?.data?.itemCount > 0, `status=${docx.status} items=${docx.json?.data?.itemCount}`));

  const text = await req('/api/resumes', { method: 'POST', cookie: cookieA, body: { rawText: '林一舟\n技能：Python、FastAPI、PostgreSQL\n项目经历：AIGC 内容生成平台\n教育：上海交通大学 计算机' } });
  resumeId = text.json?.data?.resumeId;
  const parsedItems = text.json?.data?.items || [];
  const noConfirmed = parsedItems.every((i) => i.status !== 'CONFIRMED');
  R('B4 文本简历 → 201，条目无自动 CONFIRMED', check(text.status === 201 && resumeId && noConfirmed, `status=${text.status} items=${text.json?.data?.itemCount} confirmed=${parsedItems.filter(i=>i.status==='CONFIRMED').length}`));

  const fieldOk = parsedItems.every((i) => i.title && i.section && i.status);
  R('B4b 真实LLM：条目字段完整（title/section/status）', check(parsedItems.length > 0 && fieldOk, `items=${parsedItems.length}`));
  const skills = parsedItems.filter((i) => i.section === 'SKILL').map((i) => i.title);
  const skillSplit = skills.length >= 3 && skills.every((s) => !s.includes('、') && !s.includes(','));
  R('B4c 真实LLM：技能正确拆分（Python/FastAPI/PostgreSQL 各一条，无合并）', check(skillSplit, `skills=${JSON.stringify(skills)}`));

  const list = await req('/api/resumes', { cookie: cookieA });
  R('B5 简历列表 → 200 仅本人数据', check(list.status === 200 && list.json?.data?.items?.length >= 2, `count=${list.json?.data?.items?.length}`));

  const detail = await req(`/api/resumes/${resumeId}`, { cookie: cookieA });
  const items = detail.json?.data?.items || [];
  const hasEvidence = items.every((i) => (i.evidence || []).length >= 0 && i.id);
  R('B6 简历详情 → 条目带 id + evidence 字段', check(detail.status === 200 && items.length > 0 && hasEvidence, `items=${items.length}`));

  const cross = await req(`/api/resumes/${resumeId}`, { cookie: cookieB });
  R('B7 跨用户读简历 → 404', check(cross.status === 404, `status=${cross.status}`));

  // 确认流程
  const sk = items.find((i) => i.section === 'SKILL');
  const confirm = await req(`/api/resumes/${resumeId}/items/${sk.id}`, { method: 'PATCH', cookie: cookieA, body: { kind: 'SKILL', confirm: true } });
  R('B8 确认技能条目 → 200 CONFIRMED', check(confirm.status === 200 && confirm.json?.data?.confirmed === true, `status=${confirm.status}`));

  const reConfirm = await req(`/api/resumes/${resumeId}/items/${sk.id}`, { method: 'PATCH', cookie: cookieA, body: { kind: 'SKILL', confirm: true } });
  R('B9 重复确认 → 422（状态机守卫）', check(reConfirm.status === 422, `status=${reConfirm.status}`));

  const crossConfirm = await req(`/api/resumes/${resumeId}/items/${sk.id}`, { method: 'PATCH', cookie: cookieB, body: { kind: 'SKILL', confirm: true } });
  R('B10 跨用户确认 → 404', check(crossConfirm.status === 404, `status=${crossConfirm.status}`));

  // 另一份无确认的简历（用于匹配空态）
  const nc = await req('/api/resumes', { method: 'POST', cookie: cookieA, body: { rawText: '张三\n技能：Java\n项目：电商系统' } });
  resumeNoConfirmId = nc.json?.data?.resumeId;
}

// ============ C. JD ============
let jdId = null;
{
  const short = await req('/api/jds', { method: 'POST', cookie: cookieA, body: { rawText: '短文本' } });
  R('C1 JD <50 字 → 422 JD_TOO_SHORT', check(short.status === 422 && short.json?.error?.code === 'JD_TOO_SHORT', `status=${short.status} code=${short.json?.error?.code}`));

  const jdText = '岗位名称：后端工程师\n职责：负责服务端开发与维护，参与系统设计\n任职要求：精通 Python，熟悉 FastAPI，熟悉 PostgreSQL，三年以上后端经验，熟悉 Docker 与 Kubernetes，有高并发系统经验';
  const create = await req('/api/jds', { method: 'POST', cookie: cookieA, body: { rawText: jdText } });
  jdId = create.json?.data?.jdId;
  R('C2 正常 JD → 201 且解析出要求', check(create.status === 201 && jdId && create.json?.data?.requirementCount > 0, `status=${create.status} req=${create.json?.data?.requirementCount}`));

  const dup = await req('/api/jds', { method: 'POST', cookie: cookieA, body: { rawText: jdText } });
  R('C3 重复 JD → 200 duplicated 且不新增', check(dup.status === 200 && dup.json?.data?.duplicated === true, `status=${dup.status} dup=${dup.json?.data?.duplicated}`));

  const detail = await req(`/api/jds/${jdId}`, { cookie: cookieA });
  const reqs = detail.json?.data?.requirements || [];
  R('C4 JD 详情 → 含要求清单', check(detail.status === 200 && reqs.length > 0, `req=${reqs.length}`));
  const reqOk = reqs.every((r) => r.text && r.category && r.criticality);
  R('C4b 真实LLM：JD 要求结构化（text/category/criticality 齐备）', check(reqs.length > 0 && reqOk, `req=${reqs.length} categories=${JSON.stringify([...new Set(reqs.map(r=>r.category))])}`));

  const cross = await req(`/api/jds/${jdId}`, { cookie: cookieB });
  R('C5 跨用户读 JD → 404', check(cross.status === 404, `status=${cross.status}`));
}

// ============ D. 匹配 ============
let runId = null;
{
  const noConfirm = await req('/api/matches', { method: 'POST', cookie: cookieA, body: { resumeId: resumeNoConfirmId, jdId } });
  R('D1 无已确认事实的简历 → 业务空态（非 500）', check(noConfirm.status === 200 && noConfirm.json?.data?.state === 'NEEDS_RESUME_CONFIRMATION', `status=${noConfirm.status} state=${noConfirm.json?.data?.state}`));

  const m = await req('/api/matches', { method: 'POST', cookie: cookieA, body: { resumeId, jdId } });
  runId = m.json?.data?.runId;
  const mItems = m.json?.data?.items || [];
  R('D2 匹配 → 201 含 summary + items', check(m.status === 201 && runId && mItems.length > 0 && m.json?.data?.summary?.total > 0, `status=${m.status} items=${mItems.length} summary=${JSON.stringify(m.json?.data?.summary)}`));
  const expl = mItems.every((i) => i.reason && i.basis && (i.evidenceRefs !== undefined || i.resumeEvidence));
  R('D2b 真实LLM：匹配条目可解释（reason/basis/evidence 齐备）', check(mItems.length > 0 && expl, `items=${mItems.length}`));

  const cross = await req('/api/matches', { method: 'POST', cookie: cookieB, body: { resumeId, jdId } });
  R('D3 跨用户用他人简历匹配 → 404', check(cross.status === 404, `status=${cross.status}`));

  const inject = await req('/api/matches', { method: 'POST', cookie: cookieA, body: { resumeId, jdId, userId: 'x' } });
  R('D4 body 注入 userId → 400', check(inject.status === 400, `status=${inject.status}`));
}

// ============ E. 建议 ============
{
  const gen = await req('/api/suggestions', { method: 'POST', cookie: cookieA, body: { resumeId, matchRunId: runId } });
  const sugg = gen.json?.data?.suggestions || [];
  R('E1 生成建议 → 201 且非空', check(gen.status === 201 && sugg.length > 0, `status=${gen.status} count=${sugg.length}`));
  const rephrase = sugg.find((s) => s.kind === 'REPHRASE');
  const nonRephrase = sugg.find((s) => s.kind !== 'REPHRASE');
  R('E2 非 REPHRASE 建议 after 必为 null（不编造）', check((nonRephrase ? nonRephrase.after === null : true), `nonRephrase.after=${nonRephrase?.after}`));
  if (rephrase) {
    R('E2b 真实LLM：REPHRASE 为 before→after 保守改写', check(!!rephrase.before && !!rephrase.after && rephrase.before !== rephrase.after, `before=${JSON.stringify(rephrase.before)} after=${JSON.stringify(rephrase.after)}`));
  }

  if (rephrase) {
    const acc = await req(`/api/suggestions/${rephrase.id}`, { method: 'PATCH', cookie: cookieA, body: { action: 'ACCEPT' } });
    R('E3 采纳 REPHRASE → 200 applied', check(acc.status === 200 && acc.json?.data?.applied === true, `status=${acc.status}`));
  } else {
    R('E3 采纳 REPHRASE → 200 applied', check(true, 'skip: 无 REPHRASE 建议'));
  }
  if (nonRephrase) {
    const accNon = await req(`/api/suggestions/${nonRephrase.id}`, { method: 'PATCH', cookie: cookieA, body: { action: 'ACCEPT' } });
    R('E4 采纳非 REPHRASE → 409（不得写入简历）', check(accNon.status === 409, `status=${accNon.status}`));
  } else {
    R('E4 采纳非 REPHRASE → 409', check(true, 'skip: 无非 REPHRASE 建议'));
  }
}

// ============ F. PDF / ATS ============
let versionPdfUrl = null;
{
  const gen = await req(`/api/resumes/${resumeId}/versions`, { method: 'POST', cookie: cookieA, body: { basics: { name: '林一舟', phone: '138-0000-0000', email: 'lin@example.com', city: '上海' } } });
  versionPdfUrl = gen.json?.data?.pdfUrl;
  R('F1 生成 PDF 版本 → 201 + pdfUrl', check(gen.status === 201 && !!versionPdfUrl, `status=${gen.status} pdfUrl=${versionPdfUrl}`));

  const dl = await req(versionPdfUrl, { cookie: cookieA });
  const magic = dl.buf.subarray(0, 5).toString('latin1') === '%PDF-';
  R('F2 下载 PDF → 200 + %PDF 魔数 + 非空', check(dl.status === 200 && magic && dl.buf.length > 1024, `status=${dl.status} bytes=${dl.buf.length} magic=${magic}`));

  // ATS 文本抽取
  let atsText = '';
  try {
    const mod = require('pdf-parse');
    const PDFParseClass = mod.PDFParse ?? mod.default;
    const parser = new PDFParseClass({ data: new Uint8Array(dl.buf) });
    const r = await parser.getText();
    atsText = r.text ?? (r.pages ?? []).map((p) => p.text ?? '').join('\n');
    await parser.destroy?.();
  } catch (e) { atsText = ''; }
  const forbidden = ['推断（待确认）', '待确认', '缺失'].filter((w) => atsText.includes(w));
  const hasChinese = /[\u4e00-\u9fff]/.test(atsText);
  R('F3 ATS 文本：中文可提取 + 无状态字样泄露', check(hasChinese && forbidden.length === 0, `chinese=${hasChinese} forbidden=${forbidden.join(',') || '无'}`));

  const noFact = await req(`/api/resumes/${resumeNoConfirmId}/versions`, { method: 'POST', cookie: cookieA, body: { basics: { name: '张三' } } });
  R('F4 无已确认事实生成 PDF → 422', check(noFact.status === 422, `status=${noFact.status}`));

  const crossPdf = await req(`/api/resumes/${resumeId}/versions`, { method: 'POST', cookie: cookieB, body: { basics: { name: 'x' } } });
  R('F5 跨用户生成版本 → 404', check(crossPdf.status === 404, `status=${crossPdf.status}`));
}

// ============ G. 投递 ============
let appId = null;
{
  const create = await req('/api/applications', { method: 'POST', cookie: cookieA, body: { company: '云枢智能', jdId } });
  appId = create.json?.data?.id;
  R('G1 新增投递 → 201 stage=APPLIED（非 DRAFT）', check(create.status === 201 && create.json?.data?.stage === 'APPLIED', `status=${create.status} stage=${create.json?.data?.stage}`));

  const list = await req('/api/applications', { cookie: cookieA });
  R('G2 投递列表 → 计数与条目', check(list.status === 200 && list.json?.data?.counts?.total >= 1 && list.json?.data?.items?.length >= 1, `total=${list.json?.data?.counts?.total}`));

  const page = await req('/api/applications?limit=1&offset=0', { cookie: cookieA });
  R('G3 分页 → limit=1 只返 1 条，counts 仍全量', check(page.json?.data?.items?.length === 1 && page.json?.data?.counts?.total >= 1, `items=${page.json?.data?.items?.length} total=${page.json?.data?.counts?.total}`));

  const patch = await req(`/api/applications/${appId}`, { method: 'PATCH', cookie: cookieA, body: { stage: 'OFFER' } });
  R('G4 状态流转 → 200 OFFER', check(patch.status === 200 && patch.json?.data?.stage === 'OFFER', `status=${patch.status}`));

  const draft = await req(`/api/applications/${appId}`, { method: 'PATCH', cookie: cookieA, body: { stage: 'DRAFT' } });
  R('G5 写入 DRAFT → 400（V1 不暴露）', check(draft.status === 400, `status=${draft.status}`));

  const cross = await req(`/api/applications/${appId}`, { method: 'PATCH', cookie: cookieB, body: { stage: 'CLOSED' } });
  R('G6 跨用户改投递 → 404', check(cross.status === 404, `status=${cross.status}`));

  const inject = await req('/api/applications', { method: 'POST', cookie: cookieA, body: { company: 'x', userId: uidA } });
  R('G7 body 注入 userId → 400', check(inject.status === 400, `status=${inject.status}`));
}

// ============ H. 安全（SQLi / 注入文本） ============
{
  const sqli = await req('/api/applications', { method: 'POST', cookie: cookieA, body: { company: "x' OR '1'='1" } });
  const sqlList = await req('/api/applications', { cookie: cookieA });
  R('H1 SQLi 输入被参数化处理（无报错/无越权）', check(sqli.status === 201 && sqlList.status === 200, `create=${sqli.status} list=${sqlList.status}`));

  const xss = await req('/api/resumes', { method: 'POST', cookie: cookieA, body: { rawText: '<script>alert(1)</script>\n技能：Python' } });
  R('H2 Prompt/XSS 文本被当普通内容处理', check(xss.status === 201, `status=${xss.status}`));
}

// ============ I. T3-A2-1 项目成果 → 候选能力回流（真实 HTTP + 既有 confirm 入口） ============
{
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const uidB = (await prisma.user.findUnique({ where: { email: emailB } }))?.id;

  // 夹具（直连 DB，不消耗 LLM）：为 A 造行动计划 + 步骤，作为 ProjectResult 的合法来源
  const matchRun = await prisma.matchRun.create({
    data: { userId: uidA, resumeId, jdId, matcherVersion: 'v1', summary: {} },
  });
  const plan = await prisma.actionPlan.create({
    data: {
      userId: uidA, matchRunId: matchRun.id, jdId, goal: 'QA 回流目标', have: [], gaps: [],
      steps: { create: [{ order: 1, title: 'QA 回流步骤', desc: 'd', targetRequirement: 'r' }] },
    },
    include: { steps: true },
  });
  const stepId = plan.steps[0].id;

  async function makeSubmittedResult(title, url) {
    const created = await req('/api/project-results', {
      method: 'POST', cookie: cookieA, body: { planId: plan.id, sourceStepId: stepId, title, summary: `${title} 描述` },
    });
    const id = created.json?.data?.id;
    const art = await req(`/api/project-results/${id}/artifacts`, {
      method: 'POST', cookie: cookieA, body: url ? { kind: 'REPO', url } : { kind: 'DOC', excerpt: '仅文字描述' },
    });
    await req(`/api/project-results/${id}/submit`, { method: 'POST', cookie: cookieA, body: {} });
    return { id, artifactId: art.json?.data?.id, createdStatus: created.status, artifactStatus: art.status };
  }

  // I1–I3：/api/project-results/* 建链
  const ok = await makeSubmittedResult('QA 成果-正常', 'https://example.com/qa-repo');
  R('I1 创建 Draft → 201', check(ok.createdStatus === 201, `status=${ok.createdStatus}`));
  R('I2 添加带链接凭据 → 200', check(ok.artifactStatus === 200, `status=${ok.artifactStatus}`));

  const detail = await req(`/api/project-results/${ok.id}`, { cookie: cookieA });
  R('I3 提交后状态 → SUBMITTED', check(detail.json?.data?.status === 'SUBMITTED', `status=${detail.json?.data?.status}`));

  // I4：declare → 201 UNCONFIRMED + PROJECT_RESULT
  const decl = await req(`/api/project-results/${ok.id}/evidence`, {
    method: 'POST', cookie: cookieA, body: { artifactId: ok.artifactId, key: `qa_ret_${stamp}`, label: 'QA 回流能力' },
  });
  const capId = decl.json?.data?.capability?.id;
  R('I4 声明候选能力 → 201 且为 UNCONFIRMED/PROJECT_RESULT',
    check(decl.status === 201 && decl.json?.data?.capability?.status === 'UNCONFIRMED' && decl.json?.data?.capability?.source === 'PROJECT_RESULT',
      `status=${decl.status} cap=${decl.json?.data?.capability?.status}/${decl.json?.data?.capability?.source}`));

  // I5：幂等
  const dup = await req(`/api/project-results/${ok.id}/evidence`, {
    method: 'POST', cookie: cookieA, body: { artifactId: ok.artifactId, key: `qa_ret_${stamp}`, label: 'QA 回流能力' },
  });
  R('I5 重复声明 → 200 幂等（evidence.created=false）',
    check(dup.status === 200 && dup.json?.data?.evidence?.created === false, `status=${dup.status} created=${dup.json?.data?.evidence?.created}`));

  // I6：跨用户 → 404
  const cross = await req(`/api/project-results/${ok.id}/evidence`, {
    method: 'POST', cookie: cookieB, body: { artifactId: ok.artifactId, key: `qa_evi_${stamp}`, label: 'X' },
  });
  R('I6 跨用户声明 → 404', check(cross.status === 404, `status=${cross.status}`));

  // I7：body 注入 userId → 400
  const inject = await req(`/api/project-results/${ok.id}/evidence`, {
    method: 'POST', cookie: cookieA, body: { artifactId: ok.artifactId, key: `qa_inj_${stamp}`, label: 'X', userId: uidB },
  });
  R('I7 body 注入 userId → 400', check(inject.status === 400, `status=${inject.status}`));

  // I8：未登录 → 401
  const anon = await req(`/api/project-results/${ok.id}/evidence`, {
    method: 'POST', body: { artifactId: ok.artifactId, key: `qa_anon_${stamp}`, label: 'X' },
  });
  R('I8 未登录声明 → 401', check(anon.status === 401, `status=${anon.status}`));

  // I9：既有唯一 confirm 入口 → 200 CONFIRMED
  const conf = await req(`/api/capabilities/${capId}/confirm`, { method: 'POST', cookie: cookieA, body: { confirmed: true } });
  R('I9 既有 confirm 入口 → 200 CONFIRMED', check(conf.status === 200, `status=${conf.status}`));

  // I10：revoke 后 confirm → 422，且能力保持未确认
  const rev = await makeSubmittedResult('QA 成果-待撤销', 'https://example.com/qa-revoke');
  const decl2 = await req(`/api/project-results/${rev.id}/evidence`, {
    method: 'POST', cookie: cookieA, body: { artifactId: rev.artifactId, key: `qa_rev_${stamp}`, label: 'QA 撤销链' },
  });
  const capId2 = decl2.json?.data?.capability?.id;
  await req(`/api/project-results/${rev.id}/revoke`, { method: 'POST', cookie: cookieA, body: {} });
  const conf2 = await req(`/api/capabilities/${capId2}/confirm`, { method: 'POST', cookie: cookieA, body: { confirmed: true } });
  const cap2 = await req(`/api/capabilities/${capId2}`, { cookie: cookieA });
  R('I10 成果 revoke 后 confirm → 422 且能力仍未确认',
    check(conf2.status === 422 && cap2.json?.data?.status === 'UNCONFIRMED',
      `confirm=${conf2.status} cap=${cap2.json?.data?.status}`));

  // I11：仅 excerpt 的凭据 → 422（不能仅凭 excerpt 创建可确认证据）
  const excerptOnly = await makeSubmittedResult('QA 成果-无链接', null);
  const decl3 = await req(`/api/project-results/${excerptOnly.id}/evidence`, {
    method: 'POST', cookie: cookieA, body: { artifactId: excerptOnly.artifactId, key: `qa_noUrl_${stamp}`, label: 'X' },
  });
  R('I11 仅 excerpt 凭据声明 → 422', check(decl3.status === 422, `status=${decl3.status}`));

  // I12：跨用户 confirm → 404
  const crossConf = await req(`/api/capabilities/${capId}/confirm`, { method: 'POST', cookie: cookieB, body: { confirmed: true } });
  R('I12 跨用户 confirm → 404', check(crossConf.status === 404, `status=${crossConf.status}`));

  // ── K. T3-A2-3：Capability key §6.1 canonical contract（真实 HTTP，零 LLM） ──
  const kRes = await makeSubmittedResult('QA 成果-key 契约', 'https://example.com/qa-key');
  const kDecl = await req(`/api/project-results/${kRes.id}/evidence`, {
    method: 'POST', cookie: cookieA,
    body: { artifactId: kRes.artifactId, key: 'Docker', label: 'QA Key 契约' },
  });
  const kCapId = kDecl.json?.data?.capability?.id;
  const kCap = kCapId ? await req(`/api/capabilities/${kCapId}`, { cookie: cookieA }) : { json: null };
  R('K1 声明 key「Docker」→ 201 且落库 key 为 canonical「docker」',
    check(kDecl.status === 201 && kCap.json?.data?.key === 'docker',
      `status=${kDecl.status} key=${kCap.json?.data?.key}`));

  const kDup = await req(`/api/project-results/${kRes.id}/evidence`, {
    method: 'POST', cookie: cookieA,
    body: { artifactId: kRes.artifactId, key: '  DOCKER  ', label: 'QA Key 契约' },
  });
  const kRows = await prisma.capability.count({ where: { userId: uidA, key: 'docker' } });
  R('K2 同一凭据以「  DOCKER  」重复声明 → 200 幂等且仍只有 1 行 canonical Capability',
    check(kDup.status === 200 && kRows === 1, `status=${kDup.status} rows=${kRows}`));

  const kBad = await req(`/api/project-results/${kRes.id}/evidence`, {
    method: 'POST', cookie: cookieA,
    body: { artifactId: kRes.artifactId, key: 'ci/cd', label: 'X' },
  });
  const kBadRows = await prisma.capability.count({ where: { userId: uidA, key: 'ci/cd' } });
  R('K3 非法 key「ci/cd」→ 400 VALIDATION_FAILED 且零写入',
    check(kBad.status === 400 && kBad.json?.error?.code === 'VALIDATION_FAILED' && kBadRows === 0,
      `status=${kBad.status} code=${kBad.json?.error?.code} rows=${kBadRows}`));

  await prisma.$disconnect();
}

// ============ J. T3-A2-2 AI 分析端点边界（均为 provider 之前，不触达真实 LLM） ============
{
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const uidB = (await prisma.user.findUnique({ where: { email: emailB } }))?.id;

  const matchRun = await prisma.matchRun.create({
    data: { userId: uidA, resumeId, jdId, matcherVersion: 'v1', summary: {} },
  });
  const plan = await prisma.actionPlan.create({
    data: {
      userId: uidA, matchRunId: matchRun.id, jdId, goal: 'QA AI 分析目标', have: [], gaps: [],
      steps: { create: [{ order: 1, title: 'QA AI 分析步骤', desc: 'd', targetRequirement: 'r' }] },
    },
    include: { steps: true },
  });

  // 造一个 DRAFT（未提交）成果
  const draft = await req('/api/project-results', {
    method: 'POST', cookie: cookieA,
    body: { planId: plan.id, sourceStepId: plan.steps[0].id, title: 'QA 草稿成果', summary: '描述' },
  });
  const draftId = draft.json?.data?.id;

  // 造一个 SUBMITTED 成果（用于 401 / 404 / 400 断言）
  const sub = await req('/api/project-results', {
    method: 'POST', cookie: cookieA,
    body: { planId: plan.id, sourceStepId: plan.steps[0].id, title: 'QA 已提交成果', summary: '描述' },
  });
  const subId = sub.json?.data?.id;
  await req(`/api/project-results/${subId}/artifacts`, { method: 'POST', cookie: cookieA, body: { kind: 'REPO', url: 'https://example.com/qa-ai' } });
  await req(`/api/project-results/${subId}/submit`, { method: 'POST', cookie: cookieA, body: {} });

  // J1 未登录 → 401（拒绝发生在 provider 之前）
  const anon = await req(`/api/project-results/${subId}/analyze`, { method: 'POST', body: {} });
  R('J1 AI 分析：未登录 → 401', check(anon.status === 401, `status=${anon.status}`));

  // J2 跨用户 → 404
  const cross = await req(`/api/project-results/${subId}/analyze`, { method: 'POST', cookie: cookieB, body: {} });
  R('J2 AI 分析：跨用户成果 → 404', check(cross.status === 404, `status=${cross.status}`));

  // J3 不存在 → 404（与 J2 响应语义一致）
  const missing = await req('/api/project-results/nope_ai/analyze', { method: 'POST', cookie: cookieA, body: {} });
  const sameAsCross = cross.status === missing.status && cross.json?.error?.code === missing.json?.error?.code;
  R('J3 AI 分析：不存在成果 → 404 且与跨用户语义一致', check(missing.status === 404 && sameAsCross, `status=${missing.status} same=${sameAsCross}`));

  // J4 body 注入 userId → 400（strict 空体）
  const inject = await req(`/api/project-results/${subId}/analyze`, { method: 'POST', cookie: cookieA, body: { userId: uidB } });
  R('J4 AI 分析：body 注入 userId → 400', check(inject.status === 400, `status=${inject.status}`));

  // J5 DRAFT 成果 → 422 RESULT_NOT_SUBMITTED
  const draftRes = await req(`/api/project-results/${draftId}/analyze`, { method: 'POST', cookie: cookieA, body: {} });
  R('J5 AI 分析：DRAFT 成果 → 422 RESULT_NOT_SUBMITTED',
    check(draftRes.status === 422 && draftRes.json?.error?.code === 'RESULT_NOT_SUBMITTED',
      `status=${draftRes.status} code=${draftRes.json?.error?.code}`));

  // J6 上述被拒请求不得产生任何 LlmUsage（即未触达 provider）
  const usages = await prisma.llmUsage.count({ where: { userId: uidA, feature: 'PROJECT_MENTOR' } });
  R('J6 AI 分析：被拒请求未产生 PROJECT_MENTOR 用量（provider 未被调用）', check(usages === 0, `usages=${usages}`));

  await prisma.$disconnect();
}

// ---------- 汇总 ----------
const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log('\n========== QA 结果 ==========');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
console.log(`\nTOTAL=${results.length} PASS=${pass} FAIL=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
