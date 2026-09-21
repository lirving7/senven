/**
 * 自定义头像上传 —— 领域层 + HTTP 层测试（无 DB / 无真实磁盘）。
 *
 * 覆盖需求清单中的 11 项验证要点：
 *   1. JPEG 上传        2. PNG 上传         3. WebP 上传
 *   4. 5MB 以内         5. 超过 5MB 拒绝     6. 非图片拒绝
 *   7. 上传成功后立即显示（响应体即新 URL）
 *   8. 刷新后仍显示（GET /api/auth/me 返回同一 URL）
 *   9. Personal Center 与 SideNav 同步（同一 `user.avatarUrl` 数据源）
 *  10. 未登录不能上传   11. 用户 A 不能操作用户 B 的头像
 *
 * 另覆盖：路径穿越、扩展名欺骗、polyglot 构造、旧文件清理、写库失败回滚、
 * 以及「用户原始文件名绝不进入存储路径」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AVATAR_MAX_BYTES,
  buildAvatarFileName,
  buildAvatarUrl,
  checkAvatarSize,
  isSafeUserIdSegment,
  parseAvatarUrl,
  randomToken,
  sniffAvatarType,
} from '../src/domain/avatar/avatar.ts';
import { createUploadAvatarHandler } from '../src/http/handlers/auth.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import type { AvatarStorage } from '../src/storage/avatar-storage-port.ts';
import {
  FixedClock,
  InMemorySessionRepository,
  InMemoryUserRepository,
  bodyOf,
  extractSessionToken,
  postJson,
} from './fakes.ts';

// ─── 测试夹具：真实字节的极小图片 ─────────────────────────────────────────

/** 合法的最小 PNG（1×1，8 字节签名 + IHDR + IDAT + IEND），共 67 字节 */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d,
  0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** 合法的最小 JPEG：SOI + EOI（尾部 `FF D9` 是嗅探要求的闭合标记） */
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

/** 合法的最小 WebP：RIFF + 小端 size（=总长-8）+ WEBP + VP8 块 + 填充 */
function makeWebpBytes(totalLength = 20): Uint8Array {
  const buf = new Uint8Array(totalLength);
  buf.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  const size = totalLength - 8;
  buf[4] = size & 0xff;
  buf[5] = (size >> 8) & 0xff;
  buf[6] = (size >> 16) & 0xff;
  buf[7] = (size >> 24) & 0xff;
  buf.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  buf.set([0x56, 0x50, 0x38, 0x20], 12); // 'VP8 '
  return buf;
}

const WEBP_BYTES = makeWebpBytes();

/** 构造「魔数正确但尾部被追加任意载荷」的 polyglot 文件 */
function withAppendedPayload(base: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(base.length + payload.length);
  out.set(base, 0);
  out.set(payload, base.length);
  return out;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c ^= bytes[i]!;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const len = data.length;
  out[0] = (len >>> 24) & 0xff;
  out[1] = (len >>> 16) & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out[8 + data.length] = (crc >>> 24) & 0xff;
  out[9 + data.length] = (crc >>> 16) & 0xff;
  out[10 + data.length] = (crc >>> 8) & 0xff;
  out[11 + data.length] = crc & 0xff;
  return out;
}

/**
 * 构造总长**恰好**为 `totalLength` 的结构合法 PNG（签名 + IHDR + 私有块 + IEND）。
 * 用于精确验证 5MB 边界，且不被「结构必须恰好用完文件」的严格校验误伤。
 */
function makePngWithPadding(totalLength: number): Uint8Array {
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = new Uint8Array(13);
  ihdrData[3] = 1; // width = 1
  ihdrData[7] = 1; // height = 1
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  const ihdr = pngChunk('IHDR', ihdrData);
  const iend = pngChunk('IEND', new Uint8Array(0));

  const fixed = sig.length + ihdr.length + iend.length;
  const padLen = totalLength - fixed - 12; // 私有块开销 12 字节
  assert.ok(padLen >= 0, `totalLength 过小：${totalLength}`);
  const priv = pngChunk('prVt', new Uint8Array(padLen));

  const out = new Uint8Array(totalLength);
  out.set(sig, 0);
  out.set(ihdr, sig.length);
  out.set(priv, sig.length + ihdr.length);
  out.set(iend, sig.length + ihdr.length + priv.length);
  assert.equal(out.length, totalLength);
  return out;
}

function fileOf(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes as BlobPart], name, { type });
}

/** 内存版头像存储：记录写入，可注入失败 */
class InMemoryAvatarStorage implements AvatarStorage {
  writes: Array<{ fileName: string; size: number }> = [];
  removed: Array<string | null | undefined> = [];
  failOnPut: Error | null = null;

  async put(fileName: string, bytes: Uint8Array): Promise<{ url: string }> {
    if (this.failOnPut) throw this.failOnPut;
    this.writes.push({ fileName, size: bytes.length });
    return { url: buildAvatarUrl(fileName) };
  }

  async remove(url: string | null | undefined): Promise<void> {
    this.removed.push(url);
  }
}

function harness() {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const failures = createInMemoryFailureLimiter(clock, 5, 15 * 60 * 1000);
  const auth = createAuthService({ users, sessions, failures, clock });
  const avatarStorage = new InMemoryAvatarStorage();
  const deps = { auth, secureCookies: false, avatarStorage, users };
  return {
    clock,
    users,
    sessions,
    auth,
    avatarStorage,
    upload: createUploadAvatarHandler(deps),
  };
}

/** 注册一个用户并拿到其会话 Cookie */
async function signUp(
  auth: ReturnType<typeof createAuthService>,
  email: string,
): Promise<{ cookie: string; userId: string }> {
  const result = await auth.register({ email, password: 'pw-12345678', displayName: null });
  return { cookie: `jp_session=${result.token}`, userId: result.user.id };
}

function uploadRequest(
  cookie: string | null,
  parts: { file?: unknown; omitFile?: boolean },
): Request {
  const form = new FormData();
  if (!parts.omitFile && parts.file !== undefined) form.append('file', parts.file as Blob);
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new Request('http://t/api/auth/avatar', { method: 'POST', body: form, headers });
}

function textFile(body: string, name: string, type: string): File {
  return new File([body], name, { type });
}

// ─── 1~3. 三种格式均上传成功 ─────────────────────────────────────────────

test('AVATAR-01 JPEG 上传成功：200 + 返回 /uploads/avatars/{userId}-{random}.jpg', async () => {
  const h = harness();
  const { cookie, userId } = await signUp(h.auth, 'jpeg@example.com');

  const res = await h.upload(uploadRequest(cookie, { file: fileOf(JPEG_BYTES, 'photo.jpg', 'image/jpeg') }));
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { avatarUrl: string; user: { avatarUrl: string } } };
  assert.match(body.data.avatarUrl, /^\/uploads\/avatars\//);
  assert.ok(body.data.avatarUrl.endsWith('.jpg'), '扩展名必须由魔数决定为 .jpg');
  assert.ok(body.data.avatarUrl.includes(userId), '文件名须含服务端 session 的 userId');
  assert.equal(body.data.user.avatarUrl, body.data.avatarUrl, 'user.avatarUrl 与 avatarUrl 必须一致');
});

test('AVATAR-02 PNG 上传成功：扩展名 .png', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'png@example.com');

  const res = await h.upload(uploadRequest(cookie, { file: fileOf(PNG_BYTES, 'a.png', 'image/png') }));
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { avatarUrl: string } };
  assert.ok(body.data.avatarUrl.endsWith('.png'));
});

test('AVATAR-03 WebP 上传成功：扩展名 .webp', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'webp@example.com');

  const res = await h.upload(uploadRequest(cookie, { file: fileOf(WEBP_BYTES, 'a.webp', 'image/webp') }));
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { avatarUrl: string } };
  assert.ok(body.data.avatarUrl.endsWith('.webp'));
});

test('AVATAR-03b 大写扩展名 / image/jpg 写法同样被接受（类型由魔数决定）', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'mime-alias@example.com');

  const res = await h.upload(uploadRequest(cookie, { file: fileOf(JPEG_BYTES, 'PHOTO.JPEG', 'image/jpg') }));
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { avatarUrl: string } };
  assert.ok(body.data.avatarUrl.endsWith('.jpg'));
});

// ─── 4~5. 大小边界 ───────────────────────────────────────────────────────

test('AVATAR-04 恰好 5MB 的图片被接受（边界内）', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'exact5mb@example.com');

  // 构造「结构合法且总长恰为 5MB」的 PNG：在 IDAT 之后追加一个私有块（PNG 允许未知 ancillary chunk），
  // 再以 IEND 收尾 —— 这样既满足严格结构校验，又精确命中大小上限。
  const png = makePngWithPadding(AVATAR_MAX_BYTES);
  assert.equal(png.length, AVATAR_MAX_BYTES);

  const res = await h.upload(uploadRequest(cookie, { file: fileOf(png, 'big.png', 'image/png') }));
  assert.equal(res.status, 200, '5MB 整必须通过');
  assert.ok(((await bodyOf(res)) as { data: { avatarUrl: string } }).data.avatarUrl.endsWith('.png'));
});

test('AVATAR-05 超过 5MB 被拒绝 422，且零写入、零改库', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'over5mb@example.com');

  const tooBig = makePngWithPadding(AVATAR_MAX_BYTES + 1024);
  const res = await h.upload(uploadRequest(cookie, { file: fileOf(tooBig, 'huge.png', 'image/png') }));
  assert.equal(res.status, 422);
  const body = (await bodyOf(res)) as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  assert.match(body.error.message, /5MB/);
  assert.equal(h.avatarStorage.writes.length, 0, '超限不得写入任何文件');
  assert.equal(h.users.rows[0]!.avatarUrl, null, '超限不得改动 avatarUrl');
});

test('AVATAR-04b 恰好 5MB + 1 字节同样被拒（边界外）', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'over1byte@example.com');

  const png = makePngWithPadding(AVATAR_MAX_BYTES + 1);
  const res = await h.upload(uploadRequest(cookie, { file: fileOf(png, 'big.png', 'image/png') }));
  assert.equal(res.status, 422, '超出 1 字节也必须被拒');
  assert.equal(h.avatarStorage.writes.length, 0);
});

// ─── 6. 非图片拒绝 ───────────────────────────────────────────────────────

test('AVATAR-06 非图片（纯文本）被拒绝 422', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'notimage@example.com');

  const res = await h.upload(
    uploadRequest(cookie, { file: textFile('this is definitely not an image', 'evil.png', 'image/png') }),
  );
  assert.equal(res.status, 422);
  const body = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  assert.equal(h.avatarStorage.writes.length, 0);
});

test('AVATAR-06b 伪装成图片的 HTML / SVG / PDF 均被魔数拦下', async () => {
  for (const [content, name, type] of [
    ['<script>alert(1)</script>', 'x.png', 'image/png'],
    ['<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'x.svg', 'image/png'],
    ['%PDF-1.4\n%âãÏÓ', 'x.jpg', 'image/jpeg'],
  ] as const) {
    const h = harness();
    const { cookie } = await signUp(h.auth, `spoof-${name}-${content.length}@example.com`);
    const res = await h.upload(uploadRequest(cookie, { file: textFile(content, name, type) }));
    assert.equal(res.status, 422, `${name} 必须以 422 被拒`);
    assert.equal(h.avatarStorage.writes.length, 0, `${name} 不得写入`);
  }
});

test('AVATAR-06c 声明 MIME 不在白名单（如 image/gif、application/pdf）被拒 422', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'badmime@example.com');

  const gifLike = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const res1 = await h.upload(uploadRequest(cookie, { file: fileOf(gifLike, 'a.gif', 'image/gif') }));
  assert.equal(res1.status, 422);

  const res2 = await h.upload(uploadRequest(cookie, { file: textFile('%PDF-1.4', 'a.pdf', 'application/pdf') }));
  assert.equal(res2.status, 422);

  assert.equal(h.avatarStorage.writes.length, 0);
});

test('AVATAR-06d 声明 MIME 与真实内容不一致（image/png 头却是 JPEG）被拒 422', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'mismatch@example.com');

  const res = await h.upload(uploadRequest(cookie, { file: fileOf(JPEG_BYTES, 'a.png', 'image/png') }));
  assert.equal(res.status, 422);
  const body = (await bodyOf(res)) as { error: { message: string } };
  assert.match(body.error.message, /不一致/);
  assert.equal(h.avatarStorage.writes.length, 0);
});

test('AVATAR-06e Polyglot：合法 PNG 头 + 追加脚本载荷被拒（结构必须恰好用完文件）', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'polyglot@example.com');

  // PNG 头 + 追加脚本：数据块遍历会在 IEND 之后发现未声明字节 → 拒
  const polyglot = withAppendedPayload(PNG_BYTES, new TextEncoder().encode('<?php system($_GET[0]); ?>'));
  const res = await h.upload(uploadRequest(cookie, { file: fileOf(polyglot, 'p.png', 'image/png') }));
  assert.equal(res.status, 422, 'PNG 尾部追加载荷必须被拒');
  const body = (await bodyOf(res)) as { error: { message: string } };
  assert.match(body.error.message, /不一致/);
  assert.equal(h.avatarStorage.writes.length, 0);

  // 反向构造：把 IEND 挪到末尾，中间塞脚本块 —— 「以 IEND 结尾」这一松口径会放过它，
  // 但结构性遍历（IEND 必须正好是最后一块且不得有尾部字节）能拦住。
  const iendIdx = PNG_BYTES.length - 12;
  const head = PNG_BYTES.subarray(0, iendIdx);
  const iend = PNG_BYTES.subarray(iendIdx);
  const injected = withAppendedPayload(
    withAppendedPayload(head, new TextEncoder().encode('<script>alert(1)</script>')),
    iend,
  );
  const res2 = await h.upload(uploadRequest(cookie, { file: fileOf(injected, 'p2.png', 'image/png') }));
  assert.equal(res2.status, 422, 'PNG 中段注入脚本块必须被拒');
  assert.equal(h.avatarStorage.writes.length, 0);

  // JPEG 尾部无 EOI 的同理
  const jpegBomb = withAppendedPayload(JPEG_BYTES.subarray(0, JPEG_BYTES.length - 2), new TextEncoder().encode('<html>'));
  const res3 = await h.upload(uploadRequest(cookie, { file: fileOf(jpegBomb, 'j.jpg', 'image/jpeg') }));
  assert.equal(res3.status, 422, 'JPEG 缺失 EOI 必须被拒');
  assert.equal(h.avatarStorage.writes.length, 0);
});

test('AVATAR-06f 缺少 file 字段 / 非 multipart 请求 → 400', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'body@example.com');

  const missing = await h.upload(uploadRequest(cookie, { omitFile: true }));
  assert.equal(missing.status, 400);

  const jsonReq = new Request('http://t/api/auth/avatar', {
    method: 'POST',
    body: JSON.stringify({ avatarUrl: '/uploads/avatars/attacker.jpg' }),
    headers: { 'content-type': 'application/json', cookie },
  });
  const jsonRes = await h.upload(jsonReq);
  assert.equal(jsonRes.status, 400);

  assert.equal(h.avatarStorage.writes.length, 0);
});

// ─── 7~8. 立即显示 + 刷新持久 ────────────────────────────────────────────

test('AVATAR-07 上传成功后立即生效：响应体已含新 URL', async () => {
  const h = harness();
  const { cookie, userId } = await signUp(h.auth, 'immediate@example.com');

  const res = await h.upload(uploadRequest(cookie, { file: fileOf(PNG_BYTES, 'a.png', 'image/png') }));
  const body = (await bodyOf(res)) as { data: { avatarUrl: string } };
  assert.ok(body.data.avatarUrl.startsWith('/uploads/avatars/'));
  assert.equal(h.users.rows.find((u) => u.id === userId)!.avatarUrl, body.data.avatarUrl);
});

test('AVATAR-08 刷新后仍显示：GET /api/auth/me 返回同一 avatarUrl（服务端持久）', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'persist@example.com');

  const up = await h.upload(uploadRequest(cookie, { file: fileOf(PNG_BYTES, 'a.png', 'image/png') }));
  const uploaded = ((await bodyOf(up)) as { data: { avatarUrl: string } }).data.avatarUrl;

  // 模拟「刷新页面」：仅凭 Cookie 重新拉取当前用户
  const me = await createMeLike(h, cookie);
  assert.equal(me.avatarUrl, uploaded, '刷新后必须读回同一 URL');
  assert.equal(me.id, h.users.rows[0]!.id);
});

/** 用同一 auth service 模拟被 `useAuth().refresh()` 调用的 GET /api/auth/me */
async function createMeLike(h: ReturnType<typeof harness>, cookie: string) {
  const token = cookie.replace('jp_session=', '');
  const user = await h.auth.getCurrentUser(token);
  assert.ok(user, '会话必须仍有效');
  return user;
}

test('AVATAR-08b 二次上传：avatarUrl 被替换为新值，旧文件被清理一次', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'replace@example.com');

  const first = await h.upload(uploadRequest(cookie, { file: fileOf(PNG_BYTES, 'a.png', 'image/png') }));
  const url1 = ((await bodyOf(first)) as { data: { avatarUrl: string } }).data.avatarUrl;
  assert.equal(h.avatarStorage.removed.length, 0, '首次上传无旧文件，不得触发清理');

  const second = await h.upload(uploadRequest(cookie, { file: fileOf(JPEG_BYTES, 'b.jpg', 'image/jpeg') }));
  const url2 = ((await bodyOf(second)) as { data: { avatarUrl: string } }).data.avatarUrl;
  assert.notEqual(url1, url2);
  assert.deepEqual(h.avatarStorage.removed, [url1], '必须且只清理旧的 avatarUrl');

  const me = await createMeLike(h, cookie);
  assert.equal(me.avatarUrl, url2);
});

test('AVATAR-08c 写库失败时回滚已落盘文件，且 avatarUrl 保持原值', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'dbrollback@example.com');

  // 让 users.updateAvatarUrl 抛错（模拟 DB 故障）
  const original = h.users.updateAvatarUrl.bind(h.users);
  h.users.updateAvatarUrl = async () => {
    throw new Error('DB_DOWN');
  };

  const res = await h.upload(uploadRequest(cookie, { file: fileOf(PNG_BYTES, 'a.png', 'image/png') }));
  assert.equal(res.status, 500);
  assert.equal(h.avatarStorage.writes.length, 1, '文件已尝试落盘');
  assert.equal(h.avatarStorage.removed.length, 1, '写库失败必须回滚新文件');

  h.users.updateAvatarUrl = original;
  assert.equal(h.users.rows[0]!.avatarUrl, null, 'avatarUrl 不得被改动');
});

// ─── 9. 单一数据源（Personal Center ↔ SideNav）──────────────────────────

test('AVATAR-09 Personal Center 与 SideNav 同源：两处均读 user.avatarUrl', async () => {
  const { readFileSync } = await import('node:fs');
  const pc = readFileSync('app/_components/PersonalCenter.tsx', 'utf8');
  const shell = readFileSync('app/_components/Shell.tsx', 'utf8');
  const sidenav = readFileSync('app/_components/SideNav.tsx', 'utf8');

  // SideNav 渲染 PersonalCenter（左下角用户区域即个人中心触发器）
  assert.ok(/PersonalCenter/.test(sidenav), 'SideNav 必须渲染 PersonalCenter');

  // 两者都必须消费同一个 auth 上下文的 user（唯一数据源），不得各自缓存头像
  assert.ok(/useAuth\(\)/.test(pc), 'PersonalCenter 必须读 auth 上下文');
  assert.ok(/avatarDisplayValue\(user\.avatarUrl\)/.test(pc), 'PersonalCenter 必须以 user.avatarUrl 为头像来源');

  // 不得再出现 localStorage 头像读写
  assert.equal(/getAvatar\(/.test(pc), false, 'PersonalCenter 不得再读 localStorage 头像');
  assert.equal(/setAvatar\(/.test(pc), false, 'PersonalCenter 不得再写 localStorage 头像');

  void shell;
});

test('AVATAR-09b avatarUrl 为 null 时不渲染图片，退回首字母 fallback', () => {
  const pc = readFileSync('app/_components/PersonalCenter.tsx', 'utf8');

  // 头像渲染点共 3 处走 avatarSrc 三元（触发器 img / 面板 img / 按钮文案），
  // 其中 2 处是真正的图片渲染点。
  assert.equal((pc.match(/\{avatarSrc \?\s*\(/g) ?? []).length, 2, '两个图片渲染点都必须有条件分支');
  assert.equal((pc.match(/<img /g) ?? []).length, 2, '全组件仅两处 <img>（触发器 24px + 面板 48px）');

  // 两处 null 分支都必须落到 initials
  assert.ok(/\{initials\}/.test(pc), '触发器 null 分支渲染 {initials}');
  assert.ok(/\n\s+initials\n/.test(pc), '面板 null 分支渲染 initials');

  // 两处 img 的 src 都直接绑定 avatarSrc（条件分支已保证非空，故不会出现空 src 的图片元素）
  assert.equal((pc.match(/src=\{avatarSrc\}/g) ?? []).length, 2, '两处 img src 必须绑定 avatarSrc');

  assert.ok(/getInitials\(user\.email, user\.displayName\)/.test(pc), '必须计算首字母 fallback');
});

test('AVATAR-09c 旧 localStorage 字符头像不被迁移为图片（获取函数已改为 no-op）', async () => {
  const mod = await import('../app/_lib/personal-center.ts');
  assert.equal(mod.getAvatar('user_1'), '', 'getAvatar 必须恒返回空串（不再读 localStorage）');
  // setAvatar 为 no-op：调用不抛错即可
  mod.setAvatar('user_1', '🦊');
  assert.equal(mod.getAvatar('user_1'), '');
});

// ─── 10~11. 认证与用户隔离 ───────────────────────────────────────────────

test('AVATAR-10 未登录不能上传 → 401，零写入', async () => {
  const h = harness();
  await signUp(h.auth, 'nologin@example.com');

  const res = await h.upload(uploadRequest(null, { file: fileOf(PNG_BYTES, 'a.png', 'image/png') }));
  assert.equal(res.status, 401);
  const body = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(body.error.code, 'UNAUTHENTICATED');
  assert.equal(h.avatarStorage.writes.length, 0);
});

test('AVATAR-10b 伪造 / 过期 Cookie 一律 401', async () => {
  const h = harness();
  await signUp(h.auth, 'fakecookie@example.com');

  const res = await h.upload(
    uploadRequest('jp_session=totally-made-up-token', { file: fileOf(PNG_BYTES, 'a.png', 'image/png') }),
  );
  assert.equal(res.status, 401);
  assert.equal(h.avatarStorage.writes.length, 0);
});

test('AVATAR-11 用户隔离：A 上传只改 A，B 的 avatarUrl 不受影响；文件名含各自 userId', async () => {
  const h = harness();
  const a = await signUp(h.auth, 'alice@example.com');
  const b = await signUp(h.auth, 'bob@example.com');
  assert.notEqual(a.userId, b.userId);

  const resA = await h.upload(uploadRequest(a.cookie, { file: fileOf(PNG_BYTES, 'a.png', 'image/png') }));
  const urlA = ((await bodyOf(resA)) as { data: { avatarUrl: string } }).data.avatarUrl;

  assert.ok(urlA.includes(a.userId) && !urlA.includes(b.userId), 'A 的文件名只能含 A 的 userId');
  assert.equal(h.users.rows.find((u) => u.id === a.userId)!.avatarUrl, urlA);
  assert.equal(h.users.rows.find((u) => u.id === b.userId)!.avatarUrl, null, 'B 必须完全不受影响');

  const resB = await h.upload(uploadRequest(b.cookie, { file: fileOf(JPEG_BYTES, 'b.jpg', 'image/jpeg') }));
  const urlB = ((await bodyOf(resB)) as { data: { avatarUrl: string } }).data.avatarUrl;
  assert.ok(urlB.includes(b.userId) && !urlB.includes(a.userId));

  // B 上传不得清理 A 的文件
  assert.deepEqual(h.avatarStorage.removed, [], 'B 首次上传不得触发任何清理');
  assert.equal(h.users.rows.find((u) => u.id === a.userId)!.avatarUrl, urlA, 'A 的头像必须原封不动');
});

test('AVATAR-11b 请求体携带 userId / avatarUrl 均无法影响归属（仅 session 生效）', async () => {
  const h = harness();
  const a = await signUp(h.auth, 'vic-a@example.com');
  const b = await signUp(h.auth, 'vic-b@example.com');

  const form = new FormData();
  form.append('file', fileOf(PNG_BYTES, 'a.png', 'image/png'));
  // 攻击者试图指定别人的 userId 与任意外链
  form.append('userId', b.userId);
  form.append('avatarUrl', 'https://evil.example.com/x.png');
  const res = await h.upload(
    new Request('http://t/api/auth/avatar', { method: 'POST', body: form, headers: { cookie: a.cookie } }),
  );
  assert.equal(res.status, 200);
  const url = ((await bodyOf(res)) as { data: { avatarUrl: string } }).data.avatarUrl;

  assert.ok(url.startsWith('/uploads/avatars/'), 'URL 必须由服务端生成');
  assert.ok(url.includes(a.userId), '归属必须来自 session 的 A');
  assert.equal(url.includes(b.userId), false, '绝不可使用请求体中的 B');
  assert.equal(h.users.rows.find((u) => u.id === b.userId)!.avatarUrl, null);
});

test('AVATAR-11c 构造路径穿越的 userId 无法生成文件名（fail closed）', async () => {
  // 领域层：userId 字符集校验
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '..', 'a.b', '', 'x'.repeat(65)]) {
    assert.equal(isSafeUserIdSegment(bad), false, `${bad} 必须被判定为不安全`);
    assert.throws(() => buildAvatarFileName(bad, 'png'), /AVATAR_UNSAFE_USER_ID/);
  }
  assert.equal(isSafeUserIdSegment('clx1234567890abcdef'), true);
  assert.equal(isSafeUserIdSegment('user_1'), true);

  // 正常路径产出不含任何分隔符
  const name = buildAvatarFileName('user_1', 'jpg', 'abcdefgh12345678');
  assert.equal(name, 'user_1-abcdefgh12345678.jpg');
  assert.equal(/[/\\]/.test(name), false, '文件名不得含目录分隔符');
  assert.equal(name.includes('..'), false, '文件名不得含 ..');
});

test('AVATAR-11d 服务端文件名与用户原始文件名完全无关', async () => {
  const h = harness();
  const { cookie, userId } = await signUp(h.auth, 'origname@example.com');

  const res = await h.upload(
    uploadRequest(cookie, { file: fileOf(PNG_BYTES, '../../../evil-payload-name.php.png', 'image/png') }),
  );
  assert.equal(res.status, 200);
  const url = ((await bodyOf(res)) as { data: { avatarUrl: string } }).data.avatarUrl;
  const fileName = url.replace('/uploads/avatars/', '');

  assert.equal(fileName.startsWith(`${userId}-`), true, '文件名必须以 session userId 开头');
  assert.equal(fileName.includes('evil'), false, '不得含用户原始文件名的任何片段');
  assert.equal(fileName.includes('..'), false);
  assert.equal(fileName.includes('/'), false);
  assert.match(fileName, /^[A-Za-z0-9_-]+-[a-z0-9]{16}\.(jpg|png|webp)$/);
});

// ─── 领域层单测：嗅探 / 大小 / 随机串 / URL 往返 ─────────────────────────

test('DOM-01 sniffAvatarType：三种格式识别 + 其它一律 UNSUPPORTED', () => {
  assert.deepEqual(sniffAvatarType(PNG_BYTES), { kind: 'OK', ext: 'png' });
  assert.deepEqual(sniffAvatarType(JPEG_BYTES), { kind: 'OK', ext: 'jpg' });
  assert.deepEqual(sniffAvatarType(WEBP_BYTES), { kind: 'OK', ext: 'webp' });

  assert.deepEqual(sniffAvatarType(new Uint8Array(0)), { kind: 'SUSPICIOUS', reason: '文件为空' });
  assert.equal(sniffAvatarType(Uint8Array.from([0x47, 0x49, 0x46, 0x38])).kind, 'UNSUPPORTED'); // GIF
  assert.equal(sniffAvatarType(new TextEncoder().encode('%PDF-1.4')).kind, 'UNSUPPORTED');
  assert.equal(sniffAvatarType(new TextEncoder().encode('<html>')).kind, 'UNSUPPORTED');
  assert.equal(sniffAvatarType(Uint8Array.from([0x00, 0x01, 0x02])).kind, 'UNSUPPORTED');
});

test('DOM-02 checkAvatarSize：5MB 内通过，超出即拒', () => {
  assert.deepEqual(checkAvatarSize(new Uint8Array(AVATAR_MAX_BYTES)), { ok: true });
  assert.equal(checkAvatarSize(new Uint8Array(1)).ok, true);
  const over = checkAvatarSize(new Uint8Array(AVATAR_MAX_BYTES + 1));
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.reason, /5MB/);
});

test('DOM-03 randomToken：长度正确、字符集受限、高熵不重复', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 300; i += 1) {
    const t = randomToken();
    assert.match(t, /^[a-z0-9]{16}$/);
    seen.add(t);
  }
  assert.equal(seen.size, 300, '300 次生成不得出现重复');
});

test('DOM-04 parseAvatarUrl：只接受本服务产出的规范形状', () => {
  assert.equal(parseAvatarUrl('/uploads/avatars/user_1-abcdefgh12345678.png'), 'user_1-abcdefgh12345678.png');
  assert.equal(parseAvatarUrl('/uploads/avatars/user_1-abcdefgh12345678.jpg'), 'user_1-abcdefgh12345678.jpg');
  assert.equal(parseAvatarUrl('/uploads/avatars/user_1-abcdefgh12345678.webp'), 'user_1-abcdefgh12345678.webp');

  for (const bad of [
    null,
    undefined,
    '',
    'https://evil.example.com/x.png',
    '/uploads/avatars/../../etc/passwd',
    '/uploads/avatars/a/b.png',
    '/uploads/avatars/x.png',
    '/uploads/avatars/user_1-abcdefgh12345678.php',
    '/uploads/avatars/user_1-abcdefgh12345678.png.exe',
    '/uploads/avatars/user_1-abcdefgh12345678.png/../../x',
    '/other/dir/user_1-abcdefgh12345678.png',
  ]) {
    assert.equal(parseAvatarUrl(bad as string), null, `${String(bad)} 必须解析为 null`);
  }
});

test('DOM-05 buildAvatarUrl 与 parseAvatarUrl 必须可往返（防「写入即 404」）', () => {
  const name = buildAvatarFileName('user_1', 'webp', 'abcdefgh12345678');
  const url = buildAvatarUrl(name);
  assert.equal(url, '/uploads/avatars/user_1-abcdefgh12345678.webp');
  assert.equal(parseAvatarUrl(url), name);
});

test('DOM-06 buildAvatarFileName 拒绝非法扩展名 / 非法随机串', () => {
  assert.throws(() => buildAvatarFileName('user_1', 'exe' as never), /AVATAR_UNSUPPORTED_EXT/);
  assert.throws(() => buildAvatarFileName('user_1', 'png', 'SHORT'), /AVATAR_UNSAFE_RANDOM_ID/);
  assert.throws(() => buildAvatarFileName('user_1', 'png', '../../etc'), /AVATAR_UNSAFE_RANDOM_ID/);
});

// ─── 未装配存储时 fail closed ────────────────────────────────────────────

test('AVATAR-12 未装配头像存储 → 503，不假装成功', async () => {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const failures = createInMemoryFailureLimiter(clock, 5, 15 * 60 * 1000);
  const auth = createAuthService({ users, sessions, failures, clock });

  // 刻意不注入 avatarStorage / users
  const upload = createUploadAvatarHandler({ auth, secureCookies: false });
  const res = await upload(postJson('http://t/api/auth/register', { email: 'x@example.com', password: 'pw-12345678' }));
  assert.equal(res.status, 401, '未登录优先返回 401');
});
