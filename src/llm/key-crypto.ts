import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 用户自带 LLM API Key · 服务端可逆加密（AES-256-GCM）
 *
 * 安全边界（Implementation 授权书 2026-09-21 §三）：
 *  - 主密钥只来自环境变量 LLM_USER_KEY_MASTER_SECRET（32 字节）；缺失/格式错 → fail-fast。
 *    禁止用 randomBytes() 作为永久主密钥（否则重启后全部用户 Key 永久不可解）。
 *  - IV 12 字节，每次加密独立随机生成；Auth Tag 16 字节。
 *  - AAD = 当前 session userId：密文与属主绑定，把 A 的密文列值搬到 B 名下也无法解密。
 *  - 密文格式 `v1.<iv>.<ct>.<tag>`（base64url），版本前缀为将来主密钥轮换留位。
 *  - 解密失败一律按「当前用户没有可用 Key」处理（由调用方回落 env Provider）；
 *    本模块抛出的错误信息**不含**任何 Key 明文/密文内容，也不写日志。
 */

const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type LlmKeyCryptoErrorCode =
  | 'MASTER_KEY_MISSING'
  | 'MASTER_KEY_INVALID'
  | 'CIPHERTEXT_MALFORMED'
  | 'DECRYPT_FAILED';

/** 加解密失败。message 已做脱敏：绝不包含 Key 明文或密文内容。 */
export class LlmKeyCryptoError extends Error {
  readonly code: LlmKeyCryptoErrorCode;

  constructor(code: LlmKeyCryptoErrorCode, message: string) {
    super(message);
    this.name = 'LlmKeyCryptoError';
    this.code = code;
  }
}

function loadMasterKey(): Buffer {
  const raw = process.env.LLM_USER_KEY_MASTER_SECRET?.trim() ?? '';
  if (raw.length === 0) {
    throw new LlmKeyCryptoError(
      'MASTER_KEY_MISSING',
      '缺少环境变量 LLM_USER_KEY_MASTER_SECRET：请在服务端 .env 配置 32 字节主密钥（hex 64 字符或 base64url 43 字符）',
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(raw)) {
    const key = Buffer.from(raw, 'base64url');
    if (key.length === KEY_BYTES) return key;
  }
  throw new LlmKeyCryptoError(
    'MASTER_KEY_INVALID',
    'LLM_USER_KEY_MASTER_SECRET 格式不正确：必须是 32 字节（hex 64 字符或 base64url 43 字符）',
  );
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(value: string): Buffer | null {
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
}

/** 加密用户 API Key。plainKey 由调用方先行校验（非空、长度、无空白）。 */
export function encryptLlmApiKey(plainKey: string, userId: string): string {
  if (typeof plainKey !== 'string' || plainKey.trim().length === 0) {
    throw new LlmKeyCryptoError('DECRYPT_FAILED', 'API Key 明文为空，拒绝加密');
  }
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new LlmKeyCryptoError('DECRYPT_FAILED', 'AAD（userId）为空，拒绝加密');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', loadMasterKey(), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT_VERSION, b64urlEncode(iv), b64urlEncode(ciphertext), b64urlEncode(tag)].join('.');
}

/**
 * 解密用户 API Key。
 * 任何失败（格式 / 认证 / 主密钥不符）都以 LlmKeyCryptoError 抛出，
 * 调用方按「当前用户没有可用 Key」处理（回落 env Provider），不区分具体细节。
 */
export function decryptLlmApiKey(token: string, userId: string): string {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new LlmKeyCryptoError('CIPHERTEXT_MALFORMED', 'API Key 密文格式无法识别，请重新配置 API Key');
  }
  const iv = b64urlDecode(parts[1]);
  const ciphertext = b64urlDecode(parts[2]);
  const tag = b64urlDecode(parts[3]);
  if (!iv || !ciphertext || !tag || iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
    throw new LlmKeyCryptoError('CIPHERTEXT_MALFORMED', 'API Key 密文格式无法识别，请重新配置 API Key');
  }
  const key = loadMasterKey();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(userId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // 认证失败（AAD 不符 / 主密钥变更 / 密文被篡改）→ 不透露任何细节
    throw new LlmKeyCryptoError('DECRYPT_FAILED', 'API Key 密文无法解密（主密钥可能已变更），请重新配置 API Key');
  }
}

/** 从密文中提取展示用 last4 之外的信息是不可能的；last4 由调用方在加密时另行保存。 */
export const LLM_KEY_CIPHER_FORMAT_VERSION = FORMAT_VERSION;
