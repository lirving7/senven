import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPdfModel, pdfPlainText, usableEvidence, assertPdfModelSafe } from '../src/domain/pdf/build.ts';
import { PdfContractError } from '../src/domain/pdf/types.ts';
import type { PdfDocumentModel } from '../src/domain/pdf/types.ts';
import { snapshotOf, versionPdfPath } from '../src/domain/pdf/persistence.ts';
import { renderPdf, resolveFontPath } from '../src/domain/pdf/render.ts';
import { EVIDENCE_SOURCE, FACT_STATUS } from '../src/domain/types.ts';
import type { Fact } from '../src/domain/types.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import {
  createCreateVersionHandler,
  createDownloadVersionPdfHandler,
} from '../src/http/handlers/resume-versions.ts';
import {
  FixedClock,
  InMemoryJdRepository,
  InMemoryResumeFactsRepository,
  InMemoryResumeVersionRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  bodyOf,
  extractSessionToken,
  postJson,
  getJson,
} from './fakes.ts';

const RT = EVIDENCE_SOURCE.RESUME_TEXT;

function fact(key: string, label: string, over: Partial<Fact> = {}): Fact {
  return {
    key,
    label,
    status: FACT_STATUS.CONFIRMED,
    category: 'SKILL',
    evidence: [{ source: RT, locator: `resume:line:${key.length + 10}`, excerpt: `${label} 的原文证据` }],
    ...over,
  };
}

const BASICS = { name: '林一舟', phone: '138-0000-0000', email: 'lin@example.com' };

const PYTHON = fact('python', 'Python');
const KOTLIN_UNCONFIRMED = fact('kotlin', 'Kotlin', { status: FACT_STATUS.UNCONFIRMED });
const AGENT_INFERRED = fact('agent', 'Agent', { status: FACT_STATUS.INFERRED, category: 'PROJECT' });
const RAG_MISSING = fact('rag', 'RAG', { status: FACT_STATUS.MISSING, evidence: [] });
const SCAN_OCR = fact('excel', 'Excel', {
  evidence: [{ source: EVIDENCE_SOURCE.OCR, locator: 'resume:page:2', excerpt: 'Excel（OCR 识别）' }],
});
const NO_EXCERPT = fact('docker', 'Docker', {
  evidence: [{ source: RT, locator: 'resume:line:55' }],
});
const PROJECT = fact('jobpilot', 'JobPilot 求职工作台', { category: 'PROJECT' });

function build(facts: readonly Fact[]) {
  return buildPdfModel({ resumeId: 'res_1', versionNo: 1, basics: BASICS, facts });
}

/* ------------------------------ 三道闸门 ------------------------------ */

test('T7-01 只有 CONFIRMED + 可信证据 + verifyClaim 放行的条目进入 PDF', () => {
  const { model } = build([PYTHON, PROJECT]);
  assert.equal(model.meta.confirmedCount, 2);
  assert.equal(model.sections.SKILL.length, 1);
  assert.equal(model.sections.PROJECT.length, 1);
  assert.equal(model.excluded.length, 0);
});

test('T7-02 UNCONFIRMED 被排除，并给出原因', () => {
  const { model } = build([PYTHON, KOTLIN_UNCONFIRMED]);
  assert.equal(model.sections.SKILL.length, 1);
  assert.equal(model.excluded.length, 1);
  assert.equal(model.excluded[0].text, 'Kotlin');
  assert.match(model.excluded[0].reason, /尚未经你确认/);
});

test('T7-03 INFERRED 被排除（PDF 中不得出现推断内容）', () => {
  const { model } = build([PYTHON, AGENT_INFERRED]);
  assert.equal(model.sections.PROJECT.length, 0);
  assert.match(model.excluded[0].reason, /推断/);
});

test('T7-04 MISSING 被排除', () => {
  const { model } = build([PYTHON, RAG_MISSING]);
  assert.equal(model.excluded.some((e) => e.text === 'RAG'), true);
});

test('T7-05 仅 OCR 来源的 CONFIRMED 被排除（第 ② ③ 道闸门）', () => {
  const { model } = build([PYTHON, SCAN_OCR]);
  assert.equal(model.sections.SKILL.length, 1);
  assert.match(model.excluded[0].reason, /缺少可核验的原文位置|待核验|OCR/);
});

test('T7-06 缺 excerpt 的 CONFIRMED 被排除', () => {
  const { model } = build([PYTHON, NO_EXCERPT]);
  assert.equal(model.excluded.some((e) => e.text === 'Docker'), true);
  assert.equal(usableEvidence(NO_EXCERPT).length, 0);
});

test('T7-07 同 key 混杂时 verifyClaim 会拦下（证明第 ③ 道闸门不是冗余）', () => {
  // 同 key=python：首个是 UNCONFIRMED（verifyClaim.findFact 取首个 → 判定为待确认）
  const dupUnconfirmed: Fact = fact('python', 'Python', { status: FACT_STATUS.UNCONFIRMED });
  const dupConfirmed: Fact = fact('python', 'Python（重复项）');
  const { model } = build([dupUnconfirmed, dupConfirmed]);
  // 第 ① 道闸门会放行 dupConfirmed，但第 ③ 道闸门必须拦下它
  assert.equal(model.excluded.some((e) => e.text === 'Python（重复项）'), true);
});

/* ------------------------------ 契约与输出 ------------------------------ */

test('T7-08 姓名为空 → 拒绝生成', () => {
  assert.throws(
    () => buildPdfModel({ resumeId: 'r', versionNo: 1, basics: { name: '  ' }, facts: [PYTHON] }),
    PdfContractError,
  );
});

test('T7-09 章节顺序与分组固定', () => {
  const { model } = build([PYTHON, PROJECT]);
  const lines = pdfPlainText(model);
  const idxSkill = lines.indexOf('SKILL');
  const idxProject = lines.indexOf('PROJECT');
  assert.ok(idxSkill > 0 && idxProject > idxSkill, '技能章节应在项目经历之前');
});

test('T7-10 PDF 纯文本中不出现状态字样', () => {
  const { model } = build([PYTHON, KOTLIN_UNCONFIRMED, AGENT_INFERRED, RAG_MISSING, SCAN_OCR]);
  const text = pdfPlainText(model).join('\n');
  for (const forbidden of ['推断', '待确认', '缺失', 'UNCONFIRMED', 'INFERRED', 'MISSING']) {
    assert.ok(!text.includes(forbidden), `PDF 文本不得包含状态字样：${forbidden}`);
  }
});

test('T7-11 确定性：同一输入两次构建得到完全相同的渲染文本', () => {
  const facts = [PYTHON, PROJECT, KOTLIN_UNCONFIRMED];
  const a = pdfPlainText(build(facts).model);
  const b = pdfPlainText(build(facts).model);
  assert.deepEqual(a, b);
});

test('T7-12 独立复核能抓出被篡改的模型', () => {
  const { model } = build([PYTHON]);
  const tampered: PdfDocumentModel = {
    ...model,
    sections: {
      ...model.sections,
      SKILL: [...model.sections.SKILL, { category: 'SKILL', text: '凭空出现的技能', evidenceRefs: [] }],
    },
  };
  assert.throws(() => assertPdfModelSafe(tampered, [PYTHON]), PdfContractError);
});

test('T7-13 快照与下载路径映射', () => {
  const { model } = build([PYTHON]);
  const snap = snapshotOf(model);
  assert.equal(snap.templateVersion, 'single-column-a4-v1');
  assert.equal(snap.model.meta.confirmedCount, 1);
  assert.equal(versionPdfPath('res_1', 'ver_9'), '/api/resumes/res_1/versions/ver_9/pdf');
});

/* ------------------------------ 渲染器 ------------------------------ */

test('T7-14 真实渲染出合法 PDF（含中文字体注册）', async () => {
  const { model } = build([PYTHON, PROJECT]);
  const pdf = await renderPdf(model);
  assert.ok(pdf.length > 1000, `PDF 体积异常：${pdf.length}`);
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(resolveFontPath().length > 0);
});

/* ------------------------------ API ------------------------------ */

function apiHarness() {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const failures = createInMemoryFailureLimiter(clock, 5, 15 * 60 * 1000);
  const auth = createAuthService({ users, sessions, failures, clock });
  const register = createRegisterHandler({ auth, secureCookies: false });

  const resumeFacts = new InMemoryResumeFactsRepository();
  const resumeVersions = new InMemoryResumeVersionRepository();
  const jdRepo = new InMemoryJdRepository();

  const deps = { auth, resumeFacts, resumeVersions, jdRepo };
  return {
    users,
    resumeFacts,
    resumeVersions,
    post: createCreateVersionHandler(deps),
    get: createDownloadVersionPdfHandler(deps),
    async signUp(email: string): Promise<{ token: string; userId: string }> {
      const res = await register(postJson('http://t/api/auth/register', { email, password: 'password-1234' }));
      const token = extractSessionToken(res);
      return { token: token as string, userId: users.rows[users.rows.length - 1].id };
    },
  };
}

test('T7-15 未登录 → 401', async () => {
  const h = apiHarness();
  const res = await h.post(postJson('http://t/api/resumes/res_1/versions', { basics: BASICS }), 'res_1');
  assert.equal(res.status, 401);
  assert.equal(h.resumeVersions.rows.length, 0);
});

test('T7-16 没有任何已确认事实 → 422，不生成空 PDF', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  h.resumeFacts.put('res_1', a.userId, [KOTLIN_UNCONFIRMED]);
  h.resumeVersions.own('res_1', a.userId);

  const res = await h.post(postJson('http://t/api/resumes/res_1/versions', { basics: BASICS }, a.token), 'res_1');
  assert.equal(res.status, 422);
  const body = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(body.error.code, 'PDF_CONTENT_INVALID');
  assert.equal(h.resumeVersions.rows.length, 0);
});

test('T7-17 缺少姓名 → 400', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  h.resumeFacts.put('res_1', a.userId, [PYTHON]);
  const res = await h.post(postJson('http://t/api/resumes/res_1/versions', { basics: { name: '' } }, a.token), 'res_1');
  assert.equal(res.status, 400);
});

test('T7-18 正常生成 → 201，返回版本号、下载路径与被排除项', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  h.resumeFacts.put('res_1', a.userId, [PYTHON, KOTLIN_UNCONFIRMED]);
  h.resumeVersions.own('res_1', a.userId);

  const res = await h.post(postJson('http://t/api/resumes/res_1/versions', { basics: BASICS }, a.token), 'res_1');
  assert.equal(res.status, 201);
  const body = (await bodyOf(res)) as {
    data: { versionNo: number; confirmedCount: number; pdfUrl: string; excluded: unknown[] };
  };
  assert.equal(body.data.versionNo, 1);
  assert.equal(body.data.confirmedCount, 1);
  assert.match(body.data.pdfUrl, /\/pdf$/);
  assert.equal(body.data.excluded.length, 1, '被排除项必须如实返回');
  assert.equal(h.resumeVersions.rows.length, 1);
});

test('T7-19 每次生成创建新版本，历史保留（不可覆盖）', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  h.resumeFacts.put('res_1', a.userId, [PYTHON]);
  h.resumeVersions.own('res_1', a.userId);

  for (let i = 0; i < 3; i++) {
    const res = await h.post(postJson('http://t/api/resumes/res_1/versions', { basics: BASICS }, a.token), 'res_1');
    assert.equal(res.status, 201);
  }
  assert.equal(h.resumeVersions.rows.length, 3);
  assert.deepEqual(
    h.resumeVersions.rows.map((r) => r.versionNo),
    [1, 2, 3],
  );
});

test('T7-20 跨用户简历 → 404', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  h.resumeFacts.put('res_a', a.userId, [PYTHON]);
  h.resumeVersions.own('res_a', a.userId);

  const res = await h.post(postJson('http://t/api/resumes/res_a/versions', { basics: BASICS }, b.token), 'res_a');
  assert.equal(res.status, 404);
});

test('T7-21 请求体携带 userId → 400', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  h.resumeFacts.put('res_1', a.userId, [PYTHON]);
  h.resumeVersions.own('res_1', a.userId);

  const res = await h.post(
    postJson('http://t/api/resumes/res_1/versions', { basics: BASICS, userId: a.userId }, a.token),
    'res_1',
  );
  assert.equal(res.status, 400);
});

test('T7-22 下载 PDF → 200 + application/pdf + %PDF- 魔术字节', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  h.resumeFacts.put('res_1', a.userId, [PYTHON, PROJECT]);
  h.resumeVersions.own('res_1', a.userId);

  const created = await h.post(postJson('http://t/api/resumes/res_1/versions', { basics: BASICS }, a.token), 'res_1');
  const createdBody = (await bodyOf(created)) as { data: { versionId: string } };

  const res = await h.get(getJson('http://t/x', a.token), 'res_1', createdBody.data.versionId);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition') ?? '', /resume-v1\.pdf/);

  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
});

test('T7-23 下载跨用户版本 → 404', async () => {
  const h = apiHarness();
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  h.resumeFacts.put('res_1', a.userId, [PYTHON]);
  h.resumeVersions.own('res_1', a.userId);
  await h.post(postJson('http://t/api/resumes/res_1/versions', { basics: BASICS }, a.token), 'res_1');

  const res = await h.get(getJson('http://t/x', b.token), 'res_1', h.resumeVersions.rows[0].id);
  assert.equal(res.status, 404);
});
