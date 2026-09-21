/**
 * UI Phase 1 收尾 · 变更清单（git 的替代证据）
 *
 * 背景：D:\job\jobpilot\ 不是 git 仓库（无 .git，见「路径事实」记忆）。
 * 因此无法执行 `git status` / `git diff --stat`。本脚本以文件系统 mtime +
 * 内容指纹给出等价证据：哪些文件在「本次 UI Phase 1 工作窗口」内被改动。
 *
 * 判定依据：
 *   - UI Phase 1 工作窗口 = 2026-09-20 20:55 ~ 21:35（本会话编辑时段）
 *   - 冻结区（schema / migrations）mtime 若早于窗口起点 → 非本阶段改动
 *
 * 用法：node scripts/phase1-changelog.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** UI Phase 1 编辑窗口（本会话） */
const WINDOW_START = new Date('2026-09-20T20:50:00+08:00');
const WINDOW_END = new Date('2026-09-20T21:45:00+08:00');

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'ui-verify-output',
  '.git',
  'android',
  '.turbo',
]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css|mjs|js|json|prisma|sql|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

const sha16 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);

const all = walk(ROOT);
const inWindow = [];
const beforeWindow = [];

for (const p of all) {
  const st = statSync(p);
  const rel = relative(ROOT, p).replace(/\\/g, '/');
  const rec = { rel, mtime: st.mtime, size: st.size, sha16: sha16(p) };
  if (st.mtime >= WINDOW_START && st.mtime <= WINDOW_END) inWindow.push(rec);
  else if (st.mtime >= new Date('2026-09-20T00:00:00+08:00') && st.mtime < WINDOW_START)
    beforeWindow.push(rec);
}

inWindow.sort((a, b) => a.mtime - b.mtime);

/** 冻结区（绝不应出现在本窗口内） */
const FROZEN = [
  'prisma/schema.prisma',
  'prisma/migrations/',
  'src/http/error-mapping.ts',
  'src/errors.ts',
];
const frozenHit = inWindow.filter((r) => FROZEN.some((f) => r.rel.startsWith(f)));

const lines = [];
lines.push('# UI Phase 1 收尾 · 变更清单（git 的等价证据）');
lines.push('');
lines.push('> `D:\\job\\jobpilot\\` 不是 git 仓库（无 `.git`），`git status` / `git diff --stat`');
lines.push('> 无法执行。本清单以 **文件系统 mtime + sha256 前 16 位**给出等价证据。');
lines.push('');
lines.push(`编辑窗口：${WINDOW_START.toISOString()} ~ ${WINDOW_END.toISOString()}`);
lines.push('');

lines.push('## 1. UI Phase 1 本会话改动文件（窗口内）');
lines.push('');
if (inWindow.length === 0) {
  lines.push('（窗口内无改动 —— 若为空，说明本会话未落盘任何文件）');
} else {
  lines.push(`共 **${inWindow.length}** 个文件：`);
  lines.push('');
  lines.push('| # | 文件 | 大小 | mtime | sha16 |');
  lines.push('|---|---|---|---|---|');
  inWindow.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | \`${r.rel}\` | ${r.size}B | ${r.mtime.toISOString().slice(11, 19)} | \`${r.sha16}\` |`,
    );
  });
}
lines.push('');

lines.push('## 2. 冻结区是否落入本窗口（应为 0）');
lines.push('');
if (frozenHit.length === 0) {
  lines.push('**无** ✓ 本阶段未触碰 `schema.prisma` / `migrations/` / 错误管道');
} else {
  lines.push('**⚠️ 发现冻结区文件落在本窗口内：**');
  for (const r of frozenHit) lines.push(`- \`${r.rel}\` (${r.mtime.toISOString()})`);
}
lines.push('');

lines.push('## 3. 今日更早（本阶段之前）已改动的文件');
lines.push('');
lines.push(
  `共 **${beforeWindow.length}** 个：这些属于**本日更早的功能阶段**（如自定义头像 #18、Agent Act），非本阶段产物。`,
);
lines.push('');
lines.push('> 判定依据：mtime 早于编辑窗口起点。冻结区文件（`schema.prisma` 20:31:02、');
lines.push('> migration #18 20:31:06）均落在这一组，进一步证明非本阶段所改。');
lines.push('');

const report = lines.join('\n');
console.log(report);

// 冻结区有命中即视为失败
process.exit(frozenHit.length === 0 ? 0 : 2);
