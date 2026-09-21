import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 密码哈希：使用 Node 内置 scrypt（内存硬）。
 *
 * 取舍：argon2id 是当前更被推荐的算法，但需要原生依赖（node-gyp 编译），
 * 会给部署与 CI 引入不确定性。scrypt 是 Node 内置、无需额外依赖、
 * 且同样是内存硬函数 —— 在 V1「简单可靠」优先的前提下选它。
 * 参数写入哈希串，未来可平滑迁移到 argon2id 而不破坏存量数据。
 */

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEYLEN);
  return ['scrypt', '16384', '8', '1', salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    if (expected.length === 0) return false;
    const actual = await scryptAsync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
