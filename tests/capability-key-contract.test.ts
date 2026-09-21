/**
 * T3-A2-3 —— Capability key §6.1 canonical contract（纯 Domain，无需数据库）
 *
 * 覆盖指令 §六.1–§六.4：
 *   1. normalization idempotency：f(f(x)) === f(x)
 *   2. canonicalization：Docker → docker；ＰＹＴＨＯＮ → python；
 *      machine   learning → machine learning；C＃ → c#
 *   3. rejection：空 / 纯空白 / >64 / 控制字符 / 引号 / 斜杠 / emoji
 *   4. non-equivalence：node.js !== nodejs；.net !== net；c# !== c
 *
 * 另含 §6.1 第 6/7 条的**反向守卫**：Capability key **不得**套用 Match 的
 * `normalizeForMatch`（该函数会删标点，实测 `.net` → `net`、`C#` → `c`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_KEY_MAX_LENGTH,
  normalizeCapabilityKey,
  validateCapabilityKey,
} from '../src/domain/capability/key.ts';
import { normalizeForMatch } from '../src/domain/jd/preprocess.ts';

// ─── §六.1 idempotency ────────────────────────────────────────────────

test('[§六.1] normalization 幂等：f(f(x)) === f(x)', () => {
  const inputs = [
    'Docker',
    '  DOCKER  ',
    'ＰＹＴＨＯＮ',
    'C＃',
    'machine   learning',
    'Node.js',
    '.NET',
    'C++',
    '中文技能',
    'mysql 8.0',
    'a\u0009b',
    'a\u00a0b',
    '',
    '   ',
    'r&d',
    '😀',
  ];
  for (const raw of inputs) {
    const once = normalizeCapabilityKey(raw);
    const twice = normalizeCapabilityKey(once);
    assert.equal(twice, once, `幂等失败：${JSON.stringify(raw)} → ${JSON.stringify(once)} → ${JSON.stringify(twice)}`);
  }
});

// ─── §六.2 canonicalization ───────────────────────────────────────────

test('[§六.2] canonicalization：Docker / 全角 / 连续空白 / 全角井号', () => {
  const cases: Array<[string, string]> = [
    ['Docker', 'docker'],
    ['Ｄｏｃｋｅｒ', 'docker'],
    ['ＰＹＴＨＯＮ', 'python'],
    ['machine   learning', 'machine learning'],
    ['C＃', 'c#'],
    ['  Docker  ', 'docker'],
    ['C++', 'c++'],
    ['Node.js', 'node.js'],
  ];
  for (const [raw, expected] of cases) {
    const v = validateCapabilityKey(raw);
    assert.equal(v.ok, true, `${JSON.stringify(raw)} 应合法`);
    if (v.ok) assert.equal(v.key, expected, `${JSON.stringify(raw)} 应归一为 ${expected}`);
  }
});

// ─── §六.3 rejection ──────────────────────────────────────────────────

test('[§六.3] rejection：空 / 纯空白 / 超长 / 控制字符 / 引号 / 斜杠 / emoji', () => {
  const rejected: Array<[string, unknown]> = [
    ['空字符串', ''],
    ['纯空白', '   '],
    ['制表与换行组成纯空白', '\t\n  \r\n'],
    ['超长（65）', 'x'.repeat(CAPABILITY_KEY_MAX_LENGTH + 1)],
    ['控制字符', 'a\u0000b'],
    ['双引号', 'a"b'],
    ['单引号', "a'b"],
    ['斜杠', 'ci/cd'],
    ['emoji', '😀'],
    ['emoji 混排', 'emoji 😀 skill'],
    ['尖括号', '<b>html</b>'],
    ['百分号', '100%'],
    ['和号', 'r&d'],
    ['非字符串', 123],
    ['null', null],
  ];
  for (const [label, raw] of rejected) {
    const v = validateCapabilityKey(raw);
    assert.equal(v.ok, false, `${label} ${JSON.stringify(raw)} 必须被拒绝`);
  }
});

test('[§六.3] 长度边界：恰好 64 合法，65 拒绝（长度按归一后判定）', () => {
  const atLimit = 'a'.repeat(CAPABILITY_KEY_MAX_LENGTH);
  const overLimit = 'b'.repeat(CAPABILITY_KEY_MAX_LENGTH + 1);

  const ok = validateCapabilityKey(atLimit);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.key.length, CAPABILITY_KEY_MAX_LENGTH);

  assert.equal(validateCapabilityKey(overLimit).ok, false);
});

/**
 * §六.3 与 C-1.5 / §6.1 第 4 条存在张力，此处**按冻结契约的实测真值**断言并显式标注：
 *   - §6.1 第 4 条要求「规范连续空白（折叠为单个空格）」⇒ 换行属空白，被折叠，而非被拒绝；
 *   - C-1.5 的非法清单未包含「换行」；
 *   - 指令 §六.3 的测试清单把「换行」列为 rejection。
 * key.ts 是 A2-2 已 CLOSED 的 §6.1 唯一来源，本阶段**不得改动**，
 * 故按真值断言，并把该张力登记为待裁决项（见最终报告 OBSERVATION）。
 */
test('[§六.3/张力] 换行：纯空白换行被拒绝；夹在字符间的换行按 §6.1 第 4 条折叠为空格', () => {
  // 纯空白（仅换行）→ 归一后为空 → 拒绝
  assert.equal(validateCapabilityKey('\n\n\r\n').ok, false);

  // 字符之间的换行属「连续空白」，按 §6.1 第 4 条折叠为单空格 → 合法
  const v = validateCapabilityKey('machine\nlearning');
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.key, 'machine learning');
});

// ─── §六.4 non-equivalence ────────────────────────────────────────────

test('[§六.4] 非等价：node.js ≠ nodejs；.net ≠ net；c# ≠ c', () => {
  const k = (s: string) => normalizeCapabilityKey(s);

  assert.notEqual(k('node.js'), k('nodejs'));
  assert.notEqual(k('.net'), k('net'));
  assert.notEqual(k('c#'), k('c'));
  assert.notEqual(k('C++'), k('C'));
});

test('[§六.4] 大小写不构成区别（§6.1 第 2 条：大小写统一）', () => {
  assert.equal(normalizeCapabilityKey('Docker'), normalizeCapabilityKey('docker'));
  assert.equal(normalizeCapabilityKey('PYTHON'), normalizeCapabilityKey('python'));
});

// ─── §6.1 第 6/7 条反向守卫：Capability key 独立于 Match normalization ──

test('[§6.1 第6/7条] Capability key 不得套用 normalizeForMatch（二者规则域不同）', () => {
  // Match 规则会删除 `.` 等标点 → 产生 false merge；实测：
  assert.equal(normalizeForMatch('.NET'), 'net');
  assert.equal(normalizeForMatch('Node.js'), 'nodejs');
  // 且它保留 `&` / emoji 等 §6.1 白名单外字符 → 产出无法作为 Capability key 的值
  assert.equal(normalizeForMatch('R&D'), 'r&d');
  assert.equal(validateCapabilityKey(normalizeForMatch('R&D')).ok, false);
  assert.equal(validateCapabilityKey(normalizeForMatch('emoji 😀')).ok, false);

  // Capability 规则必须保留 `.`，因此结果与 Match **不同**
  assert.equal(normalizeCapabilityKey('.NET'), '.net');
  assert.equal(normalizeCapabilityKey('Node.js'), 'node.js');
  assert.notEqual(normalizeCapabilityKey('.NET'), normalizeForMatch('.NET'));
  assert.notEqual(normalizeCapabilityKey('Node.js'), normalizeForMatch('Node.js'));

  // FACT：`#` 不在 normalizeForMatch 的删除集中，故 `C#` 两条路径恰好同值（不代表二者契约相同）
  assert.equal(normalizeForMatch('C#'), 'c#');
  assert.equal(normalizeCapabilityKey('C#'), 'c#');
});

test('常量：长度上限被显式导出（禁止散落硬编码）', () => {
  assert.equal(typeof CAPABILITY_KEY_MAX_LENGTH, 'number');
  assert.ok(CAPABILITY_KEY_MAX_LENGTH > 0);
});
