/**
 * 主题令牌平价校验
 *
 * 逐块抽取 `--token: value` 声明的集合，比较：
 *   [root 浅色]  vs  [data-theme='dark']  vs  [media prefers-color-scheme: dark]
 *
 * 目的：确认深色模式不是"部分覆盖"，而是逐项镜像 —— 任何只存在于浅色、
 * 在深色中缺失的令牌，都会导致该处回退到浅色值（典型深色模式 bug）。
 *
 * 用法：node scripts/theme-parity.mjs
 */

import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

/** 抽取从 `startIdx` 起、配对花括号内的声明块 */
function extractBlock(startIdx) {
  let depth = 0;
  let i = css.indexOf('{', startIdx);
  if (i === -1) return null;
  const open = i;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/** 从声明块中取出所有自定义属性名 → 原始值 */
function tokenMap(block) {
  const map = new Map();
  if (!block) return map;
  for (const m of block.matchAll(/(^|[\s;{])--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[2], m[3].trim());
  }
  return map;
}

/**
 * 主题无关令牌：间距 / 字号 / 行高 / 字重 / 字距 / 圆角 / 层级 /
 * 时长 / 缓动 / 尺寸 / 字体栈。这些在深色下无需重复声明 —— 继承即可，
 * 且"缺失"不构成缺陷。用前缀白名单而非具体名单，避免日后新增令牌漏判。
 */
const THEME_INVARIANT = [
  /^sp-/,
  /^fs-/,
  /^lh-/,
  /^fw-/,
  /^ls-/,
  /^radius-/,
  /^z-/,
  /^dur-/,
  /^ease-/,
  /^font-stack$/,
  /^mono$/,
  /^sidebar-w/,
  /^topbar-h$/,
  /^content-max$/,
  /^control-h/,
  /^row-h$/,
];
const isInvariant = (name) => THEME_INVARIANT.some((re) => re.test(name));
// 别名令牌：值为 var(--其他令牌)。深色只需重定义被指向的目标即可。
const isAlias = (value) => /^var\(--/.test(value);

/**
 * 已知死令牌：在 globals.css 中只声明、从未被任何规则引用。
 *
 * `--focus-ring-inset` 属此类（全文仅出现 1 次，即其声明行）。
 * 死令牌不需要在深色块镜像 —— 它不产生任何视觉效果。
 * 若日后该令牌被启用，必须从此名单移除并在深色块补上重定义。
 * 记录为技术债，见实施报告"风险"章节。
 */
const KNOWN_DEAD_TOKENS = new Set(['focus-ring-inset']);

const rootIdx = css.indexOf(':root');
const darkIdx = css.indexOf("[data-theme='dark']");
const mediaIdx = css.indexOf('@media (prefers-color-scheme: dark)');

const light = tokenMap(extractBlock(rootIdx));
const dark = tokenMap(extractBlock(darkIdx));
const mediaBody = extractBlock(mediaIdx);
const mediaInner = mediaBody ? extractBlock(mediaBody.indexOf(':root')) : null;
const media = tokenMap(mediaInner);

/**
 * 真正需要在深色块中重定义的令牌 = 浅色块里、非主题无关、非别名。
 * 这些若在深色块中缺失，才是真正的深色模式缺陷。
 */
const mustMirror = [...light.keys()].filter(
  (t) => !isInvariant(t) && !isAlias(light.get(t)) && !KNOWN_DEAD_TOKENS.has(t),
);

const unresolvedInDark = mustMirror.filter((t) => !dark.has(t));
const unresolvedInMedia = mustMirror.filter((t) => !media.has(t));

const invariantCount = [...light.keys()].filter(isInvariant).length;
const aliasCount = [...light.keys()].filter((t) => isAlias(light.get(t))).length;

const out = [];
out.push('# 主题令牌平价校验');
out.push('');
out.push(`- 浅色 \`:root\` 令牌总数：**${light.size}**`);
out.push(`- \`[data-theme='dark']\` 令牌数：**${dark.size}**`);
out.push(`- \`@media (prefers-color-scheme: dark)\` 令牌数：**${media.size}**`);
out.push('');
out.push('分类说明：');
out.push('');
out.push(`- 主题无关令牌（间距/字号/圆角/层级/时长等）：**${invariantCount}** 个，深色下继承即可，不计缺失`);
out.push(`- 别名令牌（值为 \`var(--其他令牌)\`）：**${aliasCount}** 个，深色只需重定义被指向的目标`);
out.push(`- 已知死令牌（声明但全文未引用）：**${KNOWN_DEAD_TOKENS.size}** 个，无需镜像`);
out.push(`- **需在深色块重定义的令牌**：**${mustMirror.length}** 个 ← 这是判定基准`);
out.push('');
out.push('## 深色块（`data-theme=dark`）缺失的"需重定义"令牌');
out.push('');
out.push(
  unresolvedInDark.length === 0
    ? '**无** ✓ 深色模式完整镜像'
    : unresolvedInDark
        .map((t) => `- \`--${t}\`（浅色值 \`${light.get(t)}\`）`)
        .join('\n'),
);
out.push('');
out.push('## 媒体查询块（`prefers-color-scheme: dark`）缺失的"需重定义"令牌');
out.push('');
out.push(
  unresolvedInMedia.length === 0
    ? '**无** ✓ 系统跟随模式完整镜像'
    : unresolvedInMedia
        .map((t) => `- \`--${t}\`（浅色值 \`${light.get(t)}\`）`)
        .join('\n'),
);

const report = out.join('\n');
console.log(report);

const ok = unresolvedInDark.length === 0 && unresolvedInMedia.length === 0;
process.exit(ok ? 0 : 2);

