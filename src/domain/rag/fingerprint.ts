/**
 * T5-A RAG-Lite —— contentFingerprint 与 chunkHash（FROZEN 算法）
 *
 * 依据：`JobPilot_ADR_T5-A_RAG_Freeze.md` §3.2 / §3.3。
 *
 * contentFingerprint（T5A-F-18，FROZEN）：
 *   NFKC → CRLF/CR → LF → trim 外层 whitespace → UTF-8 SHA-256 → lowercase hex。
 *   **不得添加其它 normalization。**
 *
 * chunkHash（T5A-F-22，FROZEN）：
 *   SHA-256(contentFingerprint + chunkOrder + normalized chunk content)
 *   —— 拼接形式（本模块 Domain Contract，确定性、可复现）：
 *      `contentFingerprint + ":" + decimal(chunkOrder) + ":" + normalizedContent`
 *   - `contentFingerprint` 为固定 64 位 lowercase hex；
 *   - `chunkOrder` 为十进制整数（无前导零、无负号）；
 *   - `normalizedContent` 为 chunker 已归一化（NFKC + CRLF/CR→LF）的切片文本。
 *   输出为 lowercase hex。
 *
 * 治理（T5A-F-22 附则）：
 *   - `chunkHash` 作为**稳定外部引用**；
 *   - **不得**成为 Evidence / Fact Authority；
 *   - **不得**写入 Capability / CapabilityEvidence；
 *   - **不得**触发 CONFIRMED。
 */

import { createHash } from 'node:crypto';

/** chunkHash 拼接分隔符（Domain Contract：确定性、稳定） */
export const CHUNK_HASH_SEPARATOR = ':';

/** UTF-8 字符串的 SHA-256，输出 lowercase hex */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 指纹归一化：NFKC → CRLF/CR → LF → trim 外层 whitespace。
 * 仅用于 contentFingerprint；不得在其它 fingerprint 语义间复用。
 */
export function normalizeTextForFingerprint(raw: string): string {
  return raw.normalize('NFKC').replace(/\r\n|\r/g, '\n').trim();
}

/**
 * contentFingerprint（T5A-F-18）：归一化后取 UTF-8 SHA-256，lowercase hex。
 */
export function contentFingerprint(raw: string): string {
  return sha256Hex(normalizeTextForFingerprint(raw));
}

/**
 * chunkHash（T5A-F-22）：`SHA-256(fingerprint:chunkOrder:normalizedContent)` → lowercase hex。
 *
 * @param fingerprint `contentFingerprint` 的输出（64 位 lowercase hex）
 * @param chunkOrder  切片序号（从 0 递增的十进制整数）
 * @param normalizedChunkContent 已由 chunker 归一化（NFKC + CRLF/CR→LF）的切片文本
 */
export function chunkHash(
  fingerprint: string,
  chunkOrder: number,
  normalizedChunkContent: string,
): string {
  const joined = `${fingerprint}${CHUNK_HASH_SEPARATOR}${chunkOrder}${CHUNK_HASH_SEPARATOR}${normalizedChunkContent}`;
  return sha256Hex(joined);
}
