/**
 * Capability key normalization contract —— `docs/t3-data-model-design-v1.md` §6.1 的落地实现。
 *
 * §6.1 契约（7 条）：
 *   1. Unicode NFKC
 *   2. 大小写统一（lowercase）
 *   3. 去首尾空白
 *   4. 规范连续空白（折叠为单个空格）
 *   5. **保留**技术标识符中的 `.` `+` `#`
 *   6. **不使用** `normalizeForMatch`
 *   7. **不执行** Match 专用的「删除标点」规则
 *
 * 正式接受的行为（§6.2）：
 *   `.net` → `.net`；`net` → `net`；`C#` → `c#`；`C＃` → `c#`；`C++` → `c++`；
 *   `Node.js` → `node.js`；`NodeJS` → `nodejs`
 *   ⇒ 即 `.net ≠ net`、`Node.js ≠ NodeJS`、`C# = C＃`、`C++ = c++`
 *
 * §6.3 取舍原则：**T3 v1 优先避免 false merge**（false split 可后续用别名/语义层处理，
 * false merge 会把两个不同事实压进同一个 Capability）。
 *
 * ⚠️ 本模块**不是** fingerprint canonicalization：
 *   `normalizeFingerprintText`（NFKC + 换行 + trim）与 `normalizeForMatch`（删标点）
 *   **均不得**用于 Capability key。二者的规则域不同（见 §6.1 第 6/7 条）。
 */

/** key 长度上限（实现取值；冻结文本未给数值，见 A2-2 报告 OBSERVATION） */
export const CAPABILITY_KEY_MAX_LENGTH = 64;

/**
 * 字符集白名单：Unicode 字母 / 数字 / 空格 / `.` `+` `#` `_` `-`。
 * 明确拒绝：控制字符、换行、引号、斜杠、分号、冒号、emoji 等。
 * 允许以 `.` `+` `#` 开头（§6.2 正式接受 `.net`）。
 */
const CAPABILITY_KEY_PATTERN = /^[\p{L}\p{N} .+#_-]+$/u;

/** §6.1 归一化（只做规范化，不做合法性判定） */
export function normalizeCapabilityKey(raw: string): string {
  return raw
    .normalize('NFKC') // ①
    .toLowerCase() // ②
    .replace(/\s+/gu, ' ') // ④ 规范连续空白（含 tab / 换行）
    .trim(); // ③
}

export type CapabilityKeyValidation =
  | { ok: true; key: string }
  | { ok: false; reason: string };

/**
 * 服务端最终的 key 规范化 + 校验。
 * 空值 / 超长 / 非法字符一律拒绝（§七）。
 */
export function validateCapabilityKey(raw: unknown): CapabilityKeyValidation {
  if (typeof raw !== 'string') return { ok: false, reason: 'key 必须是字符串' };

  const key = normalizeCapabilityKey(raw);
  if (key.length === 0) return { ok: false, reason: 'key 规范化后为空' };
  if (key.length > CAPABILITY_KEY_MAX_LENGTH) {
    return { ok: false, reason: `key 超过长度上限 ${CAPABILITY_KEY_MAX_LENGTH}` };
  }
  if (!CAPABILITY_KEY_PATTERN.test(key)) return { ok: false, reason: 'key 含不支持的字符' };

  return { ok: true, key };
}
