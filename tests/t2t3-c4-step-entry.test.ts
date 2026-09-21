import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSearchUrl,
  parseStepKind,
  SEARCH_ENGINE,
  STEP_KIND_GUIDANCE,
  STEP_KIND_LABEL,
  type StepKind,
} from '../app/_lib/step-entry.ts';

/**
 * V2 · T2→T3 桥接 · C4 —— ActionStep 学习 / 项目入口（聚焦验证）
 *
 * C4 是纯前端改动，风险集中在两处**可机械验证**的逻辑：
 *   1. 类型前缀识别与**降级**（前缀缺失/未知时必须 GENERIC，不得漏渲染）
 *   2. **事实安全文案**（只描述"要做什么"，不得断言用户已掌握/已完成）
 * 另加一条接线守卫，防止"逻辑写了但页面没接"。
 *
 * DOM 级渲染不在本测试范围（C4 无新增 API/数据，验收标准为"构建通过 + 逻辑可测"）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, '..', rel), 'utf8');

const ALL_KINDS: StepKind[] = ['LEARN', 'PRACTICE', 'PROJECT', 'GENERIC'];

/* ═══════════ 类型识别与降级 ═══════════ */

test('C4-a 标题前缀识别：三类前缀正确映射', () => {
  assert.equal(parseStepKind('[学习] 完成 K8s 课程'), 'LEARN');
  assert.equal(parseStepKind('[实践] 部署一个 demo'), 'PRACTICE');
  assert.equal(parseStepKind('[项目] 做一个 RAG 应用'), 'PROJECT');
});

test('C4-b 降级：无前缀 / 未知前缀 / 空标题 / 前导空格 一律 GENERIC，且不抛错', () => {
  assert.equal(parseStepKind('补 Kubernetes'), 'GENERIC', '无前缀必须降级');
  assert.equal(parseStepKind('[未知] 某动作'), 'GENERIC', '未知前缀必须降级');
  assert.equal(parseStepKind(''), 'GENERIC', '空标题必须降级');
  assert.equal(parseStepKind('   '), 'GENERIC');
  assert.equal(parseStepKind('[学习]'), 'LEARN', '仅前缀也应可识别');
  assert.equal(parseStepKind('  [实践] 有前导空格'), 'PRACTICE', '容忍前导空格');
});

/* ═══════════ 文案事实安全（核心） ═══════════ */

test('C4-c 每个类型的标签与指引都必须齐备', () => {
  for (const kind of ALL_KINDS) {
    assert.ok(STEP_KIND_LABEL[kind]?.length > 0, `${kind} 缺标签`);
    assert.ok(STEP_KIND_GUIDANCE[kind]?.length > 0, `${kind} 缺指引`);
  }
});

test('C4-d 事实安全：指引与标签不得断言用户已具备 / 已完成', () => {
  // 这些词一旦出现，就等于把"建议学习"写成了"用户已掌握"
  const FORBIDDEN = ['已掌握', '已具备', '已完成', '你已经', '已学会', '熟练掌握', '精通'];

  for (const kind of ALL_KINDS) {
    const text = `${STEP_KIND_LABEL[kind]} ${STEP_KIND_GUIDANCE[kind]}`;
    for (const word of FORBIDDEN) {
      assert.equal(text.includes(word), false, `文案出现事实断言「${word}」：${kind} → ${text}`);
    }
  }
});

test('C4-e 指引必须是行动建议（含"建议"措辞），不得是完成态陈述', () => {
  for (const kind of ALL_KINDS) {
    assert.ok(STEP_KIND_GUIDANCE[kind].includes('建议'), `${kind} 指引应以建议措辞表达`);
  }
});

test('C4-f 站外入口标注为"辅助"，避免被误读为能力来源', () => {
  const component = read('app/_components/StepEntry.tsx');
  assert.ok(component.includes('辅助'), '外部检索入口必须标注为辅助');
  assert.ok(component.includes('rel="noopener noreferrer"'), '外链必须带 noopener/noreferrer');
  assert.ok(component.includes('target="_blank"'), '外链应新窗口打开');

  // 组件自身文案同样不得作事实断言
  for (const word of ['已掌握', '已具备', '已完成', '你已经']) {
    assert.equal(component.includes(word), false, `组件文案出现事实断言「${word}」`);
  }
});

/* ═══════════ 检索链接构造 ═══════════ */

test('C4-g buildSearchUrl：无有效要求时返回 null（不渲染空入口）', () => {
  assert.equal(buildSearchUrl(null), null);
  assert.equal(buildSearchUrl(undefined), null);
  assert.equal(buildSearchUrl(''), null);
  assert.equal(buildSearchUrl('   '), null);
});

test('C4-h buildSearchUrl：中文要求被正确编码，且指向站外搜索引擎', () => {
  const url = buildSearchUrl('熟悉 Kubernetes');
  assert.ok(url);
  assert.ok(url!.startsWith(SEARCH_ENGINE));
  assert.equal(url!.includes(' '), false, '查询串不得含未编码空格');
  assert.ok(url!.includes(encodeURIComponent('熟悉 Kubernetes')));
  // 只做链接拼接，不涉及任何业务数据
  assert.ok(url!.startsWith('https://'));
});

/* ═══════════ 接线守卫 ═══════════ */

test('C4-i 接线：ActionPlan 页面确实渲染了 StepEntry（防止"逻辑写了但没接"）', () => {
  const page = read('app/action-plans/[id]/page.tsx');
  assert.ok(page.includes("from '../../_components/StepEntry'"), '页面应导入 StepEntry');
  assert.ok(page.includes('<StepEntry'), '页面应渲染 StepEntry');
  assert.ok(page.includes('title={s.title}'), 'StepEntry 应接收步骤标题');
  assert.ok(page.includes('targetRequirement={s.targetRequirement}'), 'StepEntry 应接收岗位要求');
});

test('C4-j C4 未触碰既有渲染与数据：步骤卡片的原有字段仍在', () => {
  const page = read('app/action-plans/[id]/page.tsx');
  // 既有行为保持不变
  assert.ok(page.includes('<strong>{s.title}</strong>'), '标题仍原样渲染（含前缀）');
  assert.ok(page.includes('{s.desc}'), '建议动作仍渲染');
  assert.ok(page.includes('对应要求：{s.targetRequirement}'), '对应要求仍渲染');
  assert.ok(page.includes('标记完成'), '单步推进按钮仍在');

  /**
   * 原断言为「页面中 StepEntry 附近 400 字符内不得出现写操作」。
   * T3-A2-4 §四 已**授权**在该页为 [学习] / [项目] 步骤新增「提交成果」写入入口，
   * 故该邻近性断言不再成立；改为把「C4 展示组件零写操作」的不变量收敛到组件文件本身，
   * 并要求新增写入口必须是**独立组件**（与纯展示的 StepEntry 分离）。
   */
  const stepEntry = read('app/_components/StepEntry.tsx');
  assert.equal(
    /fetch\(|api<|method: 'POST'|method: 'PATCH'|method: 'DELETE'/.test(stepEntry),
    false,
    'C4 展示组件必须保持零写操作',
  );
  assert.ok(
    page.includes("from '../../_components/StepResultEntry'"),
    'A2-4 的写入入口应为独立组件（StepResultEntry），不得混入 StepEntry',
  );
  assert.equal(
    /StepEntry(?![\w])[\s\S]{0,200}method: 'POST'/.test(stepEntry),
    false,
    'StepEntry 内不得出现任何 POST',
  );
});
