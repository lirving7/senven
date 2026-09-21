import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJd } from '../src/domain/jd/parse-jd.ts';
import { toJobDescriptionCreateInput } from '../src/domain/jd/persistence.ts';
import { normalizeJdText, detectLanguage, MAX_JD_LENGTH } from '../src/domain/jd/preprocess.ts';
import { JdTooShortError, JdShapeError } from '../src/domain/jd/types.ts';
import { LLMFormatError } from '../src/llm/provider.ts';
import type { JsonRequest, LLMProvider, TextRequest } from '../src/llm/provider.ts';
import { FakeValidProvider, FakeInvalidJsonProvider } from '../src/llm/fake-providers.ts';

const ZH_JD = `岗位名称：AI应用开发工程师
公司：示例科技有限公司

岗位职责：
1. 负责公司AI应用的设计与开发
2. 参与大模型应用落地与效果优化

任职要求：
1. 本科及以上学历，计算机相关专业
2. 精通 Python，熟悉 FastAPI
3. 熟悉 LLM 应用开发，了解 Prompt 工程
加分项：有 RAG 项目经验`;

const EN_JD = `Position: AI Application Engineer
Company: Example Tech

Responsibilities:
- Design and build LLM powered applications
- Collaborate with product teams on prompt engineering

Requirements:
- Bachelor degree in Computer Science
- Proficient in Python
- Experience with LLM application development
Bonus: experience with RAG`;

const MIXED_JD = `岗位名称：AI Engineer
职责：负责 LLM 应用开发与 Prompt 优化，参与 RAG pipeline 建设，与 product team 协作完成 model evaluation。
要求：熟悉 Python、FastAPI、Docker，了解 vector database 与 embedding 技术，具备良好的 communication skill。`;

const MULTI_JD = `岗位名称：前端工程师
岗位职责：负责Web前端开发与维护，熟悉 React 技术栈

岗位名称：后端工程师
岗位职责：负责服务端开发与维护，熟悉 Node.js 技术栈`;

const ZH_OUTPUT = {
  title: 'AI应用开发工程师',
  company: '示例科技有限公司',
  requirements: [
    { text: '本科及以上学历，计算机相关专业', category: 'EDUCATION', criticality: 'MUST' },
    { text: '精通 Python，熟悉 FastAPI', category: 'TECH', criticality: 'MUST' },
    { text: '熟悉 LLM 应用开发，了解 Prompt 工程', category: 'TECH', criticality: 'SHOULD' },
    { text: '有 RAG 项目经验', category: 'PLUS', criticality: 'BONUS' },
  ],
};

class FlakyProvider implements LLMProvider {
  name: string;
  calls: number;
  failTimes: number;
  payload: unknown;
  errorFactory: () => Error;

  constructor(failTimes: number, payload: unknown, errorFactory?: () => Error) {
    this.name = 'flaky';
    this.calls = 0;
    this.failTimes = failTimes;
    this.payload = payload;
    this.errorFactory = errorFactory ?? (() => new LLMFormatError('坏 JSON', 'flaky'));
  }

  async json<T>(_req: JsonRequest): Promise<T> {
    this.calls += 1;
    if (this.calls <= this.failTimes) throw this.errorFactory();
    return this.payload as T;
  }

  async text(_req: TextRequest): Promise<string> {
    return '';
  }
}

test('T3-01 中文 JD 正常解析，标题/公司/要求均产出', async () => {
  const result = await parseJd(ZH_JD, { provider: new FakeValidProvider(ZH_OUTPUT) });
  assert.equal(result.title, 'AI应用开发工程师');
  assert.equal(result.company, '示例科技有限公司');
  assert.equal(result.requirements.length, 4);
  assert.equal(result.language, 'ZH');
  assert.equal(result.degraded, false);
});

test('T3-02 英文 JD 保底解析：模型返回空也必须产出非空要求（OTHER / SHOULD）', async () => {
  const result = await parseJd(EN_JD, {
    provider: new FakeValidProvider({ title: null, company: null, requirements: [] }),
  });
  assert.equal(result.language, 'EN');
  assert.equal(result.degraded, true);
  assert.ok(result.requirements.length > 0, '英文 JD 必须产出非空 Requirement');
  for (const r of result.requirements) {
    assert.equal(r.category, 'OTHER');
    assert.equal(r.criticality, 'SHOULD');
  }
  assert.ok(result.warnings.some((w) => w.includes('保底解析')));
});

test('T3-03 中英混合 JD 可解析', async () => {
  const result = await parseJd(MIXED_JD, {
    provider: new FakeValidProvider({
      title: 'AI Engineer',
      company: null,
      requirements: [{ text: '熟悉 Python、FastAPI、Docker', category: 'TECH', criticality: 'MUST' }],
    }),
  });
  assert.equal(result.language, 'MIXED');
  assert.equal(result.requirements.length, 1);
});

test('T3-04 JD 少于 50 字符 → 拦截，且不调用模型', async () => {
  const provider = new FlakyProvider(0, {});
  await assert.rejects(
    () => parseJd('招人', { provider }),
    (err: unknown) => err instanceof JdTooShortError && err.code === 'TOO_SHORT',
  );
  assert.equal(provider.calls, 0, '长度不足时不应发起模型调用');
});

const CAT7_JD = `岗位名称：分类测试岗位
1. 学历相关要求条目
2. 专业技术要求条目
3. 日常工作职责条目
4. 加分项目要求条目
5. 学历学位要求条目
6. 相关专业要求条目
7. 其他无法归类条目`;

test('T3-05 七类 category 全部可透传', async () => {
  const lines = [
    '学历相关要求条目',
    '专业技术要求条目',
    '日常工作职责条目',
    '加分项目要求条目',
    '学历学位要求条目',
    '相关专业要求条目',
    '其他无法归类条目',
  ];
  const categories = ['HARD', 'TECH', 'DUTY', 'PLUS', 'EDUCATION', 'MAJOR', 'OTHER'];
  const result = await parseJd(CAT7_JD, {
    provider: new FakeValidProvider({
      title: null,
      company: null,
      requirements: lines.map((text, i) => ({ text, category: categories[i], criticality: 'SHOULD' })),
    }),
  });
  assert.equal(result.requirements.length, 7);
  assert.deepEqual(
    [...new Set(result.requirements.map((r) => r.category))].sort(),
    [...categories].sort(),
  );
  assert.ok(result.requirements.every((r) => r.verbatim), '全部逐字引用原文');
});

test('T3-06 MUST / SHOULD / BONUS 三档透传', async () => {
  const result = await parseJd(ZH_JD, { provider: new FakeValidProvider(ZH_OUTPUT) });
  const levels = result.requirements.map((r) => r.criticality);
  assert.ok(levels.includes('MUST'));
  assert.ok(levels.includes('SHOULD'));
  assert.ok(levels.includes('BONUS'));
});

test('T3-07 原始 wording：逐字命中为 true，被改写则标 false 并告警', async () => {
  const result = await parseJd(ZH_JD, { provider: new FakeValidProvider(ZH_OUTPUT) });
  assert.ok(result.requirements.every((r) => r.verbatim), 'ZH_OUTPUT 全部逐字引用原文');

  const rewritten = await parseJd(ZH_JD, {
    provider: new FakeValidProvider({
      title: null,
      company: null,
      requirements: [{ text: '具备大模型应用开发能力', category: 'TECH', criticality: 'MUST' }],
    }),
  });
  assert.equal(rewritten.requirements[0].verbatim, false);
  assert.ok(rewritten.warnings.some((w) => w.includes('verbatim=false')));
});

test('T3-08 模型返回坏 JSON → LLMFormatError，重试耗尽后抛出，不产出半成品', async () => {
  await assert.rejects(
    () => parseJd(ZH_JD, { provider: new FakeInvalidJsonProvider() }),
    (err: unknown) => err instanceof LLMFormatError && err.code === 'FORMAT',
  );
});

test('T3-09 输出结构不符 schema → JdShapeError', async () => {
  const provider = new FlakyProvider(0, {
    title: null,
    company: null,
    requirements: [{ text: '精通 Python', category: 'NOT_A_CATEGORY', criticality: 'MUST' }],
  });
  await assert.rejects(
    () => parseJd(ZH_JD, { provider, maxAttempts: 1 }),
    (err: unknown) => err instanceof JdShapeError && err.issues.length > 0,
  );
});

test('T3-10 格式错误可重试：失败 2 次后第 3 次成功', async () => {
  const provider = new FlakyProvider(2, ZH_OUTPUT);
  const result = await parseJd(ZH_JD, { provider });
  assert.equal(result.attempts, 3);
  assert.equal(provider.calls, 3);
  assert.equal(result.requirements.length, 4);
});

test('T3-11 重试耗尽（默认 3 次尝试）后抛出，不写入任何数据', async () => {
  const provider = new FlakyProvider(99, ZH_OUTPUT);
  await assert.rejects(() => parseJd(ZH_JD, { provider }), LLMFormatError);
  assert.equal(provider.calls, 3, '默认尝试次数应为 1 + 2 = 3');
});

test('T3-12 多岗位 JD → 检出并告警，仍返回结果', async () => {
  const result = await parseJd(MULTI_JD, { provider: new FakeValidProvider(ZH_OUTPUT) });
  assert.equal(result.multiPosting, true);
  assert.ok(result.warnings.some((w) => w.includes('多岗位')));
});

test('T3-13 重复要求被去重', async () => {
  const result = await parseJd(ZH_JD, {
    provider: new FakeValidProvider({
      title: null,
      company: null,
      requirements: [
        { text: '精通 Python，熟悉 FastAPI', category: 'TECH', criticality: 'MUST' },
        { text: '精通Python，熟悉FastAPI', category: 'TECH', criticality: 'MUST' },
        { text: '精通 Python ，熟悉 FastAPI', category: 'TECH', criticality: 'SHOULD' },
      ],
    }),
  });
  assert.equal(result.requirements.length, 1);
});

test('T3-14 数据隔离：写入映射必须带非空 userId，否则拒绝', async () => {
  const result = await parseJd(ZH_JD, { provider: new FakeValidProvider(ZH_OUTPUT) });
  assert.throws(() => toJobDescriptionCreateInput(result, { userId: '', rawText: ZH_JD }), /userId/);

  const input = toJobDescriptionCreateInput(result, { userId: 'user_1', rawText: ZH_JD });
  assert.equal(input.userId, 'user_1');
  assert.equal(input.reqs.create.length, 4);
  assert.equal(input.title, 'AI应用开发工程师');
});

test('T3-15 预处理：去除零宽字符与控制字符，但不改写措辞', () => {
  const dirty = '岗位名称：\u200B测试\uFEFF工程师\n\n\n\n岗位职责：负责\u0007开发';
  const cleaned = normalizeJdText(dirty);
  assert.ok(!cleaned.includes('\u200B'));
  assert.ok(!cleaned.includes('\uFEFF'));
  assert.ok(!cleaned.includes('\u0007'));
  assert.ok(cleaned.includes('测试工程师'));
  assert.ok(!cleaned.includes('\n\n\n'));
});

test('T3-16 超长 JD 截断并告警', async () => {
  const longText = `${'A'.repeat(MAX_JD_LENGTH + 5)}\npython fastapi docker kubernetes`;
  const result = await parseJd(longText, {
    provider: new FakeValidProvider({ title: null, company: null, requirements: [] }),
  });
  assert.ok(result.warnings.some((w) => w.includes('截断')));
});

test('T3-17 语言判定边界', () => {
  assert.equal(detectLanguage('中文岗位描述，要求熟悉软件开发流程与团队协作'), 'ZH');
  assert.equal(detectLanguage('Position requires python fastapi docker experience'), 'EN');
  assert.equal(detectLanguage(MIXED_JD), 'MIXED');
});
