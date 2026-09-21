import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Criticality, JdLanguage, RequirementCategory } from './types.ts';

export type PreviewTokenPayload = {
  /** rawText 归一化后的 sha256，用于 create 时校验内容未被篡改 */
  rawTextHash: string;
  title: string | null;
  company: string | null;
  language: JdLanguage;
  requirements: Array<{
    text: string;
    category: RequirementCategory;
    criticality: Criticality;
    verbatim: boolean;
  }>;
  degraded: boolean;
  multiPosting: boolean;
  warnings: string[];
  /** Unix timestamp (ms)，默认 10 分钟有效期 */
  exp: number;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;

let cachedSecret: Buffer | null = null;

function getSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const env = process.env.JD_PREVIEW_SECRET;
  cachedSecret = env ? Buffer.from(env, 'hex') : randomBytes(32);
  return cachedSecret;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64UrlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/**
 * 签名 preview token。
 * payload 可被客户端读取（方便前端展示解析结果），但不可伪造。
 */
export function signPreview(
  payload: Omit<PreviewTokenPayload, 'exp'>,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  const full: PreviewTokenPayload = { ...payload, exp: Date.now() + ttlMs };
  const header = base64UrlEncode(Buffer.from(JSON.stringify(full), 'utf8'));
  const sig = createHmac('sha256', getSecret()).update(header).digest();
  return `${header}.${base64UrlEncode(sig)}`;
}

/**
 * 验证并解码 preview token。
 * 失败时抛出 Error（由 HTTP 层映射为 400）。
 */
export function verifyPreview(token: string): PreviewTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new Error('preview token 格式错误');
  }
  const [headerB64, sigB64] = parts;
  const expectedSig = createHmac('sha256', getSecret()).update(headerB64).digest();
  const actualSig = base64UrlDecode(sigB64);
  if (actualSig.length !== expectedSig.length) {
    throw new Error('preview token 签名长度错误');
  }
  if (!timingSafeEqual(actualSig, expectedSig)) {
    throw new Error('preview token 签名无效');
  }

  let payload: PreviewTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as PreviewTokenPayload;
  } catch {
    throw new Error('preview token payload 无法解析');
  }

  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    throw new Error('preview token 已过期');
  }

  return payload;
}

export function previewTokenMaxAgeMs(): number {
  return DEFAULT_TTL_MS;
}
