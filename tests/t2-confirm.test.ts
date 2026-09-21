import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock } from '../src/ports/index.ts';
import { createConfirmItemHandler } from '../src/http/handlers/resume-items.ts';
import { createCreateMatchHandler } from '../src/http/handlers/matches.ts';
import { extractText } from '../src/domain/resume/extract.ts';
import { renderPdf } from '../src/domain/pdf/render.ts';
import { buildPdfModel } from '../src/domain/pdf/build.ts';
import { EVIDENCE_SOURCE, FACT_STATUS } from '../src/domain/types.ts';
import { postJson, bodyOf } from './fakes.ts';

const dbUp = await (async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();
const skip = dbUp ? false : 'PostgreSQL 不可达';
// 文件级唯一标记：仅含 Date.now() 会在并行加载时与其他文件撞号，导致清理误删他人 fixture
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const repos = createPrismaRepositories(prisma);
const auth = () =>
  createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });

async function signUp(tag: string) {
  const r = await auth().register({ email: `t2c_${tag}_${stamp}@example.com`, password: 'password-1234' });
  return { token: r.token, userId: r.user.id };
}

/* ═══════════ ① PDF 真实 fixture：生成 → 提取 → 断言文本 round-trip ═══════════ */

test('T2C-01 PDF 真实 fixture：@react-pdf 生成 → pdf-parse 提取出中文文本', { skip }, async () => {
  const model = buildPdfModel({
    resumeId: 'fixture',
    versionNo: 1,
    basics: { name: '林一舟' },
    facts: [
      {
        key: 'python',
        label: 'Python',
        status: FACT_STATUS.CONFIRMED,
        category: 'SKILL',
        evidence: [{ source: EVIDENCE_SOURCE.RESUME_TEXT, locator: 'resume:line:2', excerpt: '使用 Python 完成数据处理' }],
      },
    ],
  }).model;

  const pdfBytes = await renderPdf(model);
  assert.equal(Buffer.from(pdfBytes.subarray(0, 5)).toString('latin1'), '%PDF-', '生成物必须是合法 PDF');

  const extracted = await extractText({ bytes: new Uint8Array(pdfBytes), declaredName: 'resume.pdf' });
  assert.equal(extracted.sourceType, 'PDF');
  // pdf-parse 提取出的文本应与渲染内容一致（含中文与技能词）
  assert.ok(extracted.text.includes('Python'), 'PDF 提取必须能取回文本层内容');
  assert.ok(extracted.text.includes('林一舟'), '中文字符必须可被提取');
});

/* ═══════════ ② 人工确认接口 ═══════════ */

test('T2C-02 确认流程：UNCONFIRMED 条目经 API 变为 CONFIRMED，再被 T4 认定为 HAVE', { skip }, async () => {
  const a = await signUp('confirm');

  // 落一条 UNCONFIRMED 的 skill（含完整 evidence）
  const resume = await prisma.resume.create({
    data: {
      userId: a.userId,
      rawText: '技能：Python',
      sourceType: 'TEXT',
      skills: { create: [{ key: 'python', label: 'Python', status: 'UNCONFIRMED' }] },
    },
    select: { id: true, skills: { select: { id: true } } },
  });
  await prisma.evidence.create({
    data: {
      source: 'RESUME_TEXT',
      locator: 'resume:line:2',
      excerpt: 'Python、FastAPI、Docker',
      skillId: resume.skills[0].id,
    },
  });

  const patch = createConfirmItemHandler({ auth: auth(), resumes: repos.resumes, capabilities: repos.capabilities });
  const res = await patch(
    postJson(`http://t/api/resumes/${resume.id}/items/${resume.skills[0].id}`, { kind: 'SKILL', confirm: true }, a.token),
    resume.id,
    resume.skills[0].id,
  );
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { status: string; confirmed: boolean } };
  assert.equal(body.data.status, 'CONFIRMED');
  assert.equal(body.data.confirmed, true);

  const row = await prisma.skill.findUniqueOrThrow({ where: { id: resume.skills[0].id } });
  assert.equal(row.status, 'CONFIRMED');

  // T4 现在能读到 CONFIRMED → HAVE（闭环）
  const jd = await repos.jds.createWithRequirements({
    userId: a.userId,
    rawText: 'JD',
    title: 'AI 工程师',
    company: '云枢智能',
    contentHash: `t2c_${stamp}`,
    reqs: { create: [{ text: '精通 Python', category: 'TECH', criticality: 'MUST' }] },
  });
  const match = createCreateMatchHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    jdRepo: repos.jds,
    matchRepo: repos.matches,
  });
  const mres = await match(postJson('http://t/api/matches', { resumeId: resume.id, jdId: jd.id }, a.token));
  const mbody = (await bodyOf(mres)) as { data: { items: Array<{ status: string }> } };
  assert.equal(mbody.data.items[0].status, 'HAVE');
});

test('T2C-03 确认接口的安全约束：跨用户 404 / 无证据拒绝 / 重复确认拒绝', { skip }, async () => {
  const a = await signUp('c1');
  const b = await signUp('c2');
  const patch = createConfirmItemHandler({ auth: auth(), resumes: repos.resumes, capabilities: repos.capabilities });

  // 有证据的 skill（属于 A）
  const resume = await prisma.resume.create({
    data: {
      userId: a.userId,
      rawText: '技能：Python',
      sourceType: 'TEXT',
      skills: { create: [{ key: 'python', label: 'Python', status: 'UNCONFIRMED' }] },
    },
    select: { id: true, skills: { select: { id: true } } },
  });
  await prisma.evidence.create({
    data: { source: 'RESUME_TEXT', locator: 'resume:line:2', excerpt: 'Python、FastAPI', skillId: resume.skills[0].id },
  });

  // 跨用户
  const cross = await patch(
    postJson(`http://t/api/resumes/${resume.id}/items/${resume.skills[0].id}`, { kind: 'SKILL', confirm: true }, b.token),
    resume.id,
    resume.skills[0].id,
  );
  assert.equal(cross.status, 404);

  // 无证据的条目（属于 A，但没有 evidence）
  const noEv = await prisma.resume.create({
    data: {
      userId: a.userId,
      rawText: '技能：Docker',
      sourceType: 'TEXT',
      skills: { create: [{ key: 'docker', label: 'Docker', status: 'UNCONFIRMED' }] },
    },
    select: { id: true, skills: { select: { id: true } } },
  });
  const noEvRes = await patch(
    postJson(`http://t/api/resumes/${noEv.id}/items/${noEv.skills[0].id}`, { kind: 'SKILL', confirm: true }, a.token),
    noEv.id,
    noEv.skills[0].id,
  );
  assert.equal(noEvRes.status, 422, '无证据的条目不得被确认');
  const noEvRow = await prisma.skill.findUniqueOrThrow({ where: { id: noEv.skills[0].id } });
  assert.equal(noEvRow.status, 'UNCONFIRMED', '无证据确认必须保持原状态');

  // 重复确认（先确认一次，再确认第二次）
  await patch(
    postJson(`http://t/api/resumes/${resume.id}/items/${resume.skills[0].id}`, { kind: 'SKILL', confirm: true }, a.token),
    resume.id,
    resume.skills[0].id,
  );
  const again = await patch(
    postJson(`http://t/api/resumes/${resume.id}/items/${resume.skills[0].id}`, { kind: 'SKILL', confirm: true }, a.token),
    resume.id,
    resume.skills[0].id,
  );
  assert.equal(again.status, 422, '已确认的条目不得重复确认');
});

test('T2C-99 清理', { skip }, async () => {
  // 只清理本文件自己的数据
  const users = await prisma.user.findMany({ where: { email: { contains: `_${stamp}@example.com` } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.jobDescription.deleteMany({ where: { contentHash: { contains: `_${stamp}` } } });
  await prisma.$disconnect();
});
