/**
 * 头像上传 · 领域层（纯函数 / 无 IO / 无 DB / 无 HTTP）。
 *
 * 职责边界：
 *   - 判定「这张字节流真的是不是一张受支持的图片」——**只信魔数，不信 MIME，不信扩展名**；
 *   - 大小上限校验；
 *   - 生成**服务端自有的安全文件名**（绝不采用用户原始文件名）；
 *   - 生成对外的公开 URL，并**保证该 URL 一定能被自身解析回来**（防「写入即 404」）。
 *
 * 安全前提（调用方必须满足）：
 *   - `userId` 必须来自**服务端 session**，绝不可来自请求体（见 handlers/avatar.ts）；
 *   - 本层不含任何路径拼接风险：文件名由本层按白名单字符集生成，扩展名由魔数决定。
 */

/** 允许的最大上传字节数：5 MB。与 V1 简历接收上限取值一致，但**语义独立**（各自演进，不共享常量）。 */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** 头像对外 URL 前缀（Next.js `public/` 下的静态资源路径）。 */
export const AVATAR_PUBLIC_PREFIX = '/uploads/avatars/';

/** 头像在磁盘上的相对目录（相对仓库根 / process.cwd()）。 */
export const AVATAR_STORAGE_DIR = 'public/uploads/avatars';

/** 受支持的图片类型 → 规范扩展名 与 HTTP Content-Type。 */
export const AVATAR_MIME_BY_EXT = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

export type AvatarExt = keyof typeof AVATAR_MIME_BY_EXT;

/**
 * 支持的入参 MIME 白名单。
 *
 * 容忍三种写法（真实浏览器 / 各平台对 jpeg 的写法不统一）：
 *   `image/jpeg`、`image/jpg`、`image/pjpeg`。**均映射到 jpg 扩展名**。
 * 注意：白名单只是**第一道**过滤；最终类型以魔数为准（见 `sniffAvatarType`）。
 */
const MIME_TO_EXT: Record<string, AvatarExt> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function normalizeMime(mime: string): string {
  return mime.trim().toLowerCase().split(';')[0]!.trim();
}

/** MIME 是否在允许集合内（不等于「文件真的是图片」，后者须经魔数校验） */
export function isAllowedAvatarMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(MIME_TO_EXT, normalizeMime(mime));
}

export function extForMime(mime: string): AvatarExt | null {
  return MIME_TO_EXT[normalizeMime(mime)] ?? null;
}

export function mimeForExt(ext: string): string | null {
  return (AVATAR_MIME_BY_EXT as Record<string, string>)[ext] ?? null;
}

// ─── 魔数嗅探 ────────────────────────────────────────────────────────────

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG 文件必须以 IEND 数据块结尾：`00 00 00 00 49 45 4e 44 <crc32> 00 00 00 00`（16 字节） */
const PNG_IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

function startsWith(buf: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) if (buf[offset + i] !== sig[i]) return false;
  return true;
}

function endsWith(buf: Uint8Array, sig: readonly number[]): boolean {
  if (buf.length < sig.length) return false;
  const offset = buf.length - sig.length;
  for (let i = 0; i < sig.length; i += 1) if (buf[offset + i] !== sig[i]) return false;
  return true;
}

/**
 * PNG 数据块结构遍历：从 8 字节签名后开始，逐块读 `[length(4)] [type(4)] [data(length)] [crc(4)]`，
 * 直到读到 `IEND`。要求**恰好用完整个文件**（不允许尾部有未声明字节）。
 *
 * 这是对「合法 PNG 头 + 任意追加载荷」这类 polyglot 构造的结构性防御：
 * 仅检查「以 IEND 结尾」可以被 `...IEND<payload>` 绕过，而「恰好用完文件」不能。
 */
function pngConsumesExactly(bytes: Uint8Array): boolean {
  let pos = 8;
  for (;;) {
    if (pos + 8 > bytes.length) return false;
    const length = ((bytes[pos]! << 24) | (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!) >>> 0;
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    const next = pos + 12 + length; // 4 length + 4 type + data + 4 crc
    if (next > bytes.length) return false;
    if (type === 'IEND') {
      // IEND 必须正好是最后一块
      return next === bytes.length && length === 0;
    }
    pos = next;
  }
}

export type AvatarSniffResult =
  | { kind: 'OK'; ext: AvatarExt }
  | { kind: 'UNSUPPORTED' }
  | { kind: 'SUSPICIOUS'; reason: string };

/**
 * 以魔数（文件头字节）判定真实图片类型。**这是唯一的类型权威**。
 *
 * 额外强化：这里刻意不采用「有魔数即通过」的松口径 ——
 *   1. JPEG 要求以 `FF D8 FF` 开头，且必须以 `FF D9`（EOI）**结尾**；
 *   2. PNG 要求 8 字节完整签名；
 *   3. WebP 要求 `RIFF....WEBP`，且容器声明的 RIFF 大小与实际字节数**完全一致**。
 *
 * 目的是挡住「合法图片头 + 附加载荷」这类 polyglot 构造：即便攻击者让浏览器把它当图片渲染，
 * 我们也不落盘；同时因为扩展名由魔数决定、URL 由服务端生成，不存在扩展名双写导致的解析歧义。
 * 合法图片（含 EXIF 的相机原图）不满足上述任一严格条件时才会被拒 —— 对头像场景影响可忽略。
 */
export function sniffAvatarType(bytes: Uint8Array): AvatarSniffResult {
  if (bytes.length === 0) return { kind: 'SUSPICIOUS', reason: '文件为空' };

  if (startsWith(bytes, PNG_MAGIC)) {
    if (!pngConsumesExactly(bytes)) {
      return { kind: 'SUSPICIOUS', reason: 'PNG 数据块结构与文件长度不一致' };
    }
    if (!endsWith(bytes, PNG_IEND)) {
      return { kind: 'SUSPICIOUS', reason: 'PNG 文件缺少 IEND 结尾标记' };
    }
    return { kind: 'OK', ext: 'png' };
  }

  if (startsWith(bytes, JPEG_MAGIC)) {
    if (bytes.length < 4) return { kind: 'SUSPICIOUS', reason: 'JPEG 文件不完整' };
    const isEoi = bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    if (!isEoi) return { kind: 'SUSPICIOUS', reason: 'JPEG 文件尾部标记缺失' };
    return { kind: 'OK', ext: 'jpg' };
  }

  if (
    bytes.length >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && // 'RIFF'
    String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP'
  ) {
    // RIFF 容器：bytes[4..7] = 小端 size = 文件总长 - 8
    const declared =
      bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16) | (bytes[7]! << 24);
    if (declared >>> 0 !== bytes.length - 8) {
      return { kind: 'SUSPICIOUS', reason: 'WebP 容器长度与实际字节数不一致' };
    }
    return { kind: 'OK', ext: 'webp' };
  }

  return { kind: 'UNSUPPORTED' };
}

// ─── 大小校验 ────────────────────────────────────────────────────────────

export type AvatarSizeVerdict = { ok: true } | { ok: false; reason: string; maxBytes: number };

export function checkAvatarSize(bytes: Uint8Array, maxBytes: number = AVATAR_MAX_BYTES): AvatarSizeVerdict {
  if (bytes.length > maxBytes) {
    return { ok: false, reason: `头像文件不能超过 ${Math.floor(maxBytes / (1024 * 1024))}MB`, maxBytes };
  }
  return { ok: true };
}

// ─── 服务端安全文件名 ────────────────────────────────────────────────────

/**
 * userId 字符白名单：只允许 `[A-Za-z0-9_-]`，长度 1..64。
 *
 * 为什么必须校验：`userId` 会被拼进文件名。cuid 天然只含 `[a-z0-9]`，但
 * **绝不能假设上游永远给 cuid** —— 一旦混入 `/`、`\`、`.`、`..`，即可构造路径穿越
 * （例如 userId = `../../etc`）。故此处 fail closed：不合规 → 抛错，绝不落盘。
 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeUserIdSegment(userId: string): boolean {
  return typeof userId === 'string' && SAFE_ID_RE.test(userId);
}

/** 生成 [0, n) 内的密码学安全随机整数 */
function randomIntBelow(n: number): number {
  const g = globalThis.crypto;
  if (!g || typeof g.getRandomValues !== 'function') {
    throw new Error('AVATAR_RNG_UNAVAILABLE');
  }
  // 拒绝采样，消除取模偏差
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    g.getRandomValues(buf);
    const v = buf[0]!;
    if (v < limit) return v % n;
  }
}

const RANDOM_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const RANDOM_LENGTH = 16;

/** 生成 16 位 base36 随机串（≈83 bit 熵，防枚举 / 防覆盖） */
export function randomToken(length: number = RANDOM_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += RANDOM_ALPHABET[randomIntBelow(RANDOM_ALPHABET.length)]!;
  }
  return out;
}

/**
 * 生成安全文件名：`{userId}-{randomId}.{ext}`。
 *
 * - `userId` 来自服务端 session（调用方保证），且此处**再次校验**字符集；
 * - `randomId` 为服务端密码学随机串，与用户原始文件名**完全无关**；
 * - `ext` 由魔数决定（`jpg|png|webp`），不接受客户端声明。
 *
 * 由于字母表与校验都排除了 `/ \ .`，函数**不可能**产出含目录分隔符或 `..` 的名字。
 */
export function buildAvatarFileName(userId: string, ext: AvatarExt, token?: string): string {
  if (!isSafeUserIdSegment(userId)) {
    throw new Error('AVATAR_UNSAFE_USER_ID');
  }
  if (!Object.prototype.hasOwnProperty.call(AVATAR_MIME_BY_EXT, ext)) {
    throw new Error('AVATAR_UNSUPPORTED_EXT');
  }
  const randomId = token ?? randomToken();
  if (!/^[a-z0-9]{8,64}$/.test(randomId)) {
    throw new Error('AVATAR_UNSAFE_RANDOM_ID');
  }
  return `${userId}-${randomId}.${ext}`;
}

/**
 * 由文件名生成对外 URL —— **并且立刻校验它一定能被 `avatarFileNameFromUrl` 解析回来**。
 *
 * 这一步是对 `AVATAR_PUBLIC_PREFIX` 与实际存储目录可能不一致（Next.js basePath 等）
 * 的 fail-closed 防护：宁可 500，也不让用户看到「上传成功但图片 404」。
 */
export function buildAvatarUrl(fileName: string): string {
  const url = `${AVATAR_PUBLIC_PREFIX}${fileName}`;
  if (parseAvatarUrl(url) === null) {
    throw new Error('AVATAR_URL_ROUNDTRIP_FAILED');
  }
  return url;
}

/**
 * 把 `avatarUrl` 解析回文件名；**任何不合规一律返回 null**。
 *
 * 这道校验同时服务于两处安全目的：
 *   1. 维护接口（清旧文件）—— 保证只会去操作本目录下的、符合本服务命名规范的文件，
 *      旧版本遗留值 / 手工写入的畸形值 / 指向外部站点的值都**不会被当作路径使用**；
 *   2. 前端展示前的兜底 —— 非本前缀的值不渲染（避免把外部 URL 当头像加载）。
 */
export function parseAvatarUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  if (!url.startsWith(AVATAR_PUBLIC_PREFIX)) return null;
  const fileName = url.slice(AVATAR_PUBLIC_PREFIX.length);
  if (fileName.length === 0 || fileName.length > 200) return null;
  // 文件名只允许「安全 userId 段」+ '-' + 随机串 + '.' + 白名单扩展名
  if (!/^[A-Za-z0-9_-]{1,64}-[a-z0-9]{8,64}\.(jpg|png|webp)$/.test(fileName)) return null;
  return fileName;
}
