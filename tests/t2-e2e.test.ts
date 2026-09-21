import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock } from '../src/ports/index.ts';
import { createCreateResumeHandler } from '../src/http/handlers/resumes.ts';
import { createCreateMatchHandler } from '../src/http/handlers/matches.ts';
import { extractText, docxXmlToText, readDocxXml } from '../src/domain/resume/extract.ts';
import { chunkByBoundary } from '../src/domain/resume/parse-resume.ts';
import { IntakeError } from '../src/domain/resume/types.ts';
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
  const r = await auth().register({ email: `t2_${tag}_${stamp}@example.com`, password: 'password-1234' });
  return { token: r.token, userId: r.user.id };
}

const RESUME_TEXT = [
  '林一舟',
  '技能：Python、FastAPI、Docker',
  '项目经历：AIGC 内容生成平台',
  '使用 Python 完成数据处理',
].join('\n');

/** 模型只返回 evidenceQuote，绝不返回行号 */
const FAKE_PARSER = async () => [
  { section: 'SKILL' as const, title: 'Python', detail: '使用 Python 完成数据处理', evidenceQuote: '使用 Python 完成数据处理' },
  { section: 'SKILL' as const, title: 'FastAPI', detail: null, evidenceQuote: 'Python、FastAPI、Docker' },
  { section: 'PROJECT' as const, title: 'AIGC 内容生成平台', detail: null, evidenceQuote: '项目经历：AIGC 内容生成平台' },
  // 这条的 quote 不在原文里 → 必须被丢弃，不得编造位置
  { section: 'SKILL' as const, title: 'Kubernetes', detail: null, evidenceQuote: '精通 Kubernetes 集群治理' },
];

/* ═════════ 阶段 1：提取 ═════════ */

test('T2E-01 纯文本直读；图片被拒；内容为空被拒', { skip }, async () => {
  const r = await extractText({ bytes: new TextEncoder().encode(RESUME_TEXT), declaredName: 'r.txt' });
  assert.equal(r.sourceType, 'TEXT');
  assert.ok(r.text.includes('Python'));

  await assert.rejects(
    () => extractText({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), declaredName: 'a.pdf' }),
    (e: unknown) => (e as IntakeError).code === 'SCAN_NOT_SUPPORTED',
  );
  await assert.rejects(
    () => extractText({ bytes: new TextEncoder().encode('   \n  '), declaredName: 'e.txt' }),
    (e: unknown) => (e as IntakeError).code === 'EXTRACT_EMPTY',
  );
});

test('T2E-02 DOCX：解压前挡 zip bomb，xml 转文本正确', { skip }, async () => {
  const xml =
    '<w:document><w:body><w:p><w:r><w:t>技能：Python &amp; FastAPI</w:t></w:r></w:p><w:p><w:r><w:t>项目：AIGC</w:t></w:r></w:p></w:body></w:document>';
  const text = docxXmlToText(xml);
  assert.ok(text.includes('技能：Python & FastAPI'), '实体必须还原');
  assert.ok(text.includes('\n'), '段落必须转换成换行');

  // 缺少 document.xml 的 zip 必须明确报错，而不是产出空文本
  const { zipSync, strToU8 } = await import('fflate');
  const bogus = zipSync({ 'word/other.xml': strToU8('<x/>') });
  assert.throws(
    () => readDocxXml(bogus),
    (e: unknown) => (e as IntakeError).code === 'DOCX_INVALID',
  );
});

/* ═════════ 阶段 3：分段不破坏语义边界 ═════════ */

test('T2E-03 分段：优先在段落边界切，不留半截行', { skip }, () => {
  const block = '项目经历：AIGC 内容生成平台\n使用 Python 完成数据处理\n\n';
  const long = block.repeat(50);
  const chunks = chunkByBoundary(long, 500);

  assert.ok(chunks.length > 1, '超长必须分段');
  assert.equal(chunks[0].offset, 0);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].offset, chunks[i - 1].offset + chunks[i - 1].text.length, 'offset 必须连续可追溯');
  }
  // 每段都不应以半个字结尾（这里以换行为切点）
  assert.ok(chunks.slice(0, -1).every((c) => c.text.endsWith('\n')));
  assert.equal(chunks.map((c) => c.text).join(''), long, '分段不得丢字');
});

/* ═════════ 阶段 4 + T2 必过门槛：真实 DB 串到 T4 ═════════ */

test('T2E-04 落库：Resume + 四类条目 + Evidence（locator 与 excerpt 均非空）', { skip }, async () => {
  const a = await signUp('save');
  const handler = createCreateResumeHandler({ auth: auth(), resumes: repos.resumes, parse: FAKE_PARSER });

  const res = await handler(postJson('http://t/api/resumes', { rawText: RESUME_TEXT }, a.token));
  assert.equal(res.status, 201, `期望 201，实际 ${res.status}`);
  const body = (await bodyOf(res)) as {
    data: {
      resumeId: string;
      itemCount: number;
      evidenceCount: number;
      statusSummary: { unconfirmed: number; inferred: number; confirmed: number };
      rejected: Array<{ title: string }>;
      items: Array<{ locator: string; excerpt: string; status: string }>;
    };
  };

  assert.equal(body.data.statusSummary.confirmed, 0, 'T2 绝不能产出 CONFIRMED');
  assert.equal(body.data.itemCount, 3, 'Kubernetes 那条无法定位，必须被丢弃');
  assert.equal(body.data.rejected.length, 1);
  assert.equal(body.data.rejected[0].title, 'Kubernetes');
  assert.equal(body.data.evidenceCount, 3);
  assert.ok(body.data.items.every((i) => i.locator.startsWith('resume:line:')));
  assert.ok(body.data.items.every((i) => i.excerpt.length > 0));

  // 真实库核对：每条 Evidence 的 locator 与 excerpt 都不为空
  const evidences = await prisma.evidence.findMany({
    where: { OR: [{ skill: { resumeId: body.data.resumeId } }, { resumeProject: { resumeId: body.data.resumeId } }] },
  });
  assert.equal(evidences.length, 3);
  assert.ok(evidences.every((e) => e.locator.startsWith('resume:line:') && (e.excerpt ?? '').length > 0));
  assert.ok(evidences.every((e) => e.source === 'RESUME_TEXT'));

  // 行号必须与原文真实行一致
  const python = body.data.items.find((i) => i.excerpt.includes('使用 Python 完成数据处理'));
  assert.equal(python?.locator, 'resume:line:4');
});

test('T2E-05 【必过门槛·正向】T2 产出的事实能被 T4 正确识别为 HAVE', { skip }, async () => {
  const a = await signUp('gate');
  const save = createCreateResumeHandler({ auth: auth(), resumes: repos.resumes, parse: FAKE_PARSER });
  const saved = await save(postJson('http://t/api/resumes', { rawText: RESUME_TEXT }, a.token));
  const resumeId = ((await bodyOf(saved)) as { data: { resumeId: string } }).data.resumeId;

  // 用户确认后事实才能成为 CONFIRMED —— 这里模拟确认动作
  await prisma.skill.updateMany({ where: { resumeId, key: 'python' }, data: { status: 'CONFIRMED' } });

  const jd = await repos.jds.createWithRequirements({
    userId: a.userId,
    rawText: 'JD',
    title: 'AI 工程师',
    company: '云枢智能',
    contentHash: `t2gate_${stamp}`,
    reqs: { create: [{ text: '精通 Python', category: 'TECH', criticality: 'MUST' }] },
  });

  const match = createCreateMatchHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    jdRepo: repos.jds,
    matchRepo: repos.matches,
  });
  const res = await match(postJson('http://t/api/matches', { resumeId, jdId: jd.id }, a.token));
  assert.equal(res.status, 201);
  const body = (await bodyOf(res)) as {
    data: { items: Array<{ status: string; evidenceRefs: Array<{ locator: string; excerpt?: string }>; resumeEvidence: string | null }> };
  };

  const item = body.data.items[0];
  assert.equal(item.status, 'HAVE', 'T2 产出的 Evidence 必须能让 T4 认定 HAVE');
  assert.ok(item.evidenceRefs.length > 0);
  assert.match(item.evidenceRefs[0].locator, /^resume:line:/);
  assert.ok((item.evidenceRefs[0].excerpt ?? '').length > 0, 'Evidence.excerpt 必须能一路传到 T4');
  assert.equal(item.resumeEvidence, 'Python');
});

test('T2E-06 【必过门槛·反向】Evidence.excerpt 缺失时 T4 绝不能认定 HAVE', { skip }, async () => {
  const a = await signUp('gate2');
  const resume = await prisma.resume.create({
    data: {
      userId: a.userId,
      rawText: '技能：Python',
      sourceType: 'TEXT',
      skills: { create: [{ key: 'python', label: 'Python', status: 'CONFIRMED' }] },
    },
    select: { id: true, skills: { select: { id: true } } },
  });
  // 关键：excerpt 为 null
  await prisma.evidence.create({
    data: { source: 'RESUME_TEXT', locator: 'resume:line:2', excerpt: null, skillId: resume.skills[0].id },
  });

  const jd = await repos.jds.createWithRequirements({
    userId: a.userId,
    rawText: 'JD',
    title: 'AI 工程师',
    company: '云枢智能',
    contentHash: `t2gate2_${stamp}`,
    reqs: { create: [{ text: '精通 Python', category: 'TECH', criticality: 'MUST' }] },
  });

  const match = createCreateMatchHandler({
    auth: auth(),
    resumeFacts: repos.resumeFacts,
    jdRepo: repos.jds,
    matchRepo: repos.matches,
  });
  const res = await match(postJson('http://t/api/matches', { resumeId: resume.id, jdId: jd.id }, a.token));
  const body = (await bodyOf(res)) as { data: { items: Array<{ status: string }> } };

  assert.notEqual(
    body.data.items[0].status,
    'HAVE',
    'excerpt 缺失的证据不得支撑 HAVE —— 这就是 T2→T4 数据契约的闭环证明',
  );
  assert.equal(body.data.items[0].status, 'MISSING');
});

test('T2E-07 原子性：嵌套写入失败时整体回滚，不留半份简历', { skip }, async () => {
  const a = await signUp('atomic');
  const before = await prisma.resume.count({ where: { userId: a.userId } });

  const item = {
    section: 'SKILL' as const,
    title: 'Python',
    detail: null,
    status: 'UNCONFIRMED',
    source: 'RESUME_TEXT',
    locator: 'resume:line:2',
    excerpt: 'Python、FastAPI、Docker',
  };

  // 两个同 key 的 SKILL 会触发 (resumeId, key) 唯一约束，让嵌套写入在中途失败。
  // 注意：必须绕过 parseResume 的去重（那是上层职责），直接打仓库层才测得到事务边界。
  await assert.rejects(
    () =>
      repos.resumes.createWithItems({
        userId: a.userId,
        rawText: '技能：Python',
        sourceType: 'TEXT',
        items: [item, { ...item }],
      }),
    /unique|constraint|violat/i,
  );

  const after = await prisma.resume.count({ where: { userId: a.userId } });
  assert.equal(after, before, 'Resume 不得留下');

  // 另外确认：上层去重是生效的（同义 skill 不会走到仓库层触发约束）
  const { parseResume } = await import('../src/domain/resume/parse-resume.ts');
  const dedup = await parseResume(
    { extracted: { text: '技能：Python、python、PYTHON', sourceType: 'TEXT', warnings: [] } },
    {
      parse: async () => [
        { section: 'SKILL', title: 'Python', detail: null, evidenceQuote: 'Python' },
        { section: 'SKILL', title: 'python', detail: null, evidenceQuote: 'python' },
        { section: 'SKILL', title: 'PYTHON', detail: null, evidenceQuote: 'PYTHON' },
      ],
    },
  );
  assert.ok(dedup.ok);
  assert.equal(dedup.parsed.items.length, 1, '同义 skill 必须合并为一条');
  assert.equal(dedup.parsed.rejected.length, 0);
});

test('T2E-99 清理', { skip }, async () => {
  // 只清理本文件自己的数据：前缀 't2_' 会命中 qa_t2_* ，并行时把别人的用户删掉
  const users = await prisma.user.findMany({ where: { email: { contains: `_${stamp}@example.com` } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.jobDescription.deleteMany({ where: { contentHash: { contains: `_${stamp}` } } });
  await prisma.$disconnect();
});

