import test from 'node:test';
import assert from 'node:assert/strict';

import { createAuthService, SESSION_TTL_MS } from '../src/auth/service.ts';
import { hashPassword, verifyPassword } from '../src/auth/password.ts';
import { hashSessionToken } from '../src/auth/token.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import {
  createLoginHandler,
  createLogoutHandler,
  createMeHandler,
  createRegisterHandler,
} from '../src/http/handlers/auth.ts';
import {
  FixedClock,
  InMemorySessionRepository,
  InMemoryUserRepository,
  bodyOf,
  extractSessionToken,
  getJson,
  postJson,
} from './fakes.ts';

const EMAIL = 'alice@example.com';
const PASSWORD = 'correct-horse-battery';

function harness() {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const failures = createInMemoryFailureLimiter(clock, 5, 15 * 60 * 1000);
  const auth = createAuthService({ users, sessions, failures, clock });
  const deps = { auth, secureCookies: false };
  return {
    clock,
    users,
    sessions,
    auth,
    register: createRegisterHandler(deps),
    login: createLoginHandler(deps),
    logout: createLogoutHandler(deps),
    me: createMeHandler(deps),
  };
}

test('AUTH-01 注册成功：201 + 下发会话 Cookie，密码以哈希存储', async () => {
  const h = harness();
  const res = await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));
  assert.equal(res.status, 201);

  const token = extractSessionToken(res);
  assert.ok(token, '必须下发会话 Cookie');

  const stored = h.users.rows[0];
  assert.equal(stored.email, EMAIL);
  assert.ok(stored.passwordHash && stored.passwordHash.startsWith('scrypt$'));
  assert.ok(!stored.passwordHash?.includes(PASSWORD), '严禁明文存储密码');
});

test('AUTH-02 密码哈希可正确校验，错误密码不通过', async () => {
  const hash = await hashPassword('s3cret-password');
  assert.equal(await verifyPassword('s3cret-password', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
  assert.equal(await verifyPassword('s3cret-password', 'garbage'), false);
});

test('AUTH-03 数据库只存 token 的哈希，明文 token 不落库', async () => {
  const h = harness();
  const res = await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));
  const token = extractSessionToken(res);
  assert.ok(token);

  assert.equal(h.sessions.rows.length, 1);
  assert.equal(h.sessions.rows[0].tokenHash, hashSessionToken(token as string));
  assert.ok(!h.sessions.rows.some((r) => r.tokenHash === token), '库中不得出现明文 token');
});

test('AUTH-04 邮箱重复 → 409 EMAIL_TAKEN', async () => {
  const h = harness();
  await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));
  const res = await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));
  assert.equal(res.status, 409);
  const body = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(body.error.code, 'EMAIL_TAKEN');
});

test('AUTH-05 邮箱格式非法 / 密码过短 → 400 VALIDATION_FAILED', async () => {
  const h = harness();
  const bad1 = await h.register(postJson('http://t/api/auth/register', { email: 'not-an-email', password: PASSWORD }));
  assert.equal(bad1.status, 400);
  const bad2 = await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: 'short' }));
  assert.equal(bad2.status, 400);
  assert.equal(h.users.rows.length, 0, '校验失败不得创建用户');
});

test('AUTH-06 登录成功 → 200 + Cookie，邮箱大小写与空格归一', async () => {
  const h = harness();
  await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));
  const res = await h.login(postJson('http://t/api/auth/login', { email: '  ALICE@Example.com ', password: PASSWORD }));
  assert.equal(res.status, 200);
  assert.ok(extractSessionToken(res));
});

test('AUTH-07 密码错误 / 邮箱不存在 → 同为 401，不泄露账号是否存在', async () => {
  const h = harness();
  await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));

  const wrongPwd = await h.login(postJson('http://t/api/auth/login', { email: EMAIL, password: 'nope-nope-nope' }));
  const noUser = await h.login(postJson('http://t/api/auth/login', { email: 'ghost@example.com', password: PASSWORD }));

  assert.equal(wrongPwd.status, 401);
  assert.equal(noUser.status, 401);
  const a = (await bodyOf(wrongPwd)) as { error: { code: string; message: string } };
  const b = (await bodyOf(noUser)) as { error: { code: string; message: string } };
  assert.equal(a.error.code, 'INVALID_CREDENTIALS');
  assert.equal(a.error.message, b.error.message, '两条错误信息必须一致');
});

test('AUTH-08 登录失败限流：连续 5 次失败后第 6 次被拦截为 429', async () => {
  const h = harness();
  await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));

  for (let i = 0; i < 5; i++) {
    const res = await h.login(postJson('http://t/api/auth/login', { email: EMAIL, password: 'bad-password' }));
    assert.equal(res.status, 401, `第 ${i + 1} 次应为 401`);
  }

  const blocked = await h.login(postJson('http://t/api/auth/login', { email: EMAIL, password: PASSWORD }));
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'), '429 必须带 retry-after');
  const body = (await bodyOf(blocked)) as { error: { code: string } };
  assert.equal(body.error.code, 'RATE_LIMITED');
});

test('AUTH-09 登录成功会重置失败计数', async () => {
  const h = harness();
  await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));

  for (let i = 0; i < 4; i++) {
    await h.login(postJson('http://t/api/auth/login', { email: EMAIL, password: 'bad-password' }));
  }
  const ok = await h.login(postJson('http://t/api/auth/login', { email: EMAIL, password: PASSWORD }));
  assert.equal(ok.status, 200);

  for (let i = 0; i < 4; i++) {
    const res = await h.login(postJson('http://t/api/auth/login', { email: EMAIL, password: 'bad-password' }));
    assert.equal(res.status, 401, '计数已重置，不应被限流');
  }
});

test('AUTH-10 限流窗口过后自动解锁（15 分钟）', async () => {
  const h = harness();
  await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));

  for (let i = 0; i < 5; i++) {
    await h.login(postJson('http://t/api/auth/login', { email: EMAIL, password: 'bad-password' }));
  }
  assert.equal((await h.login(postJson('http://t/api/auth/login', { email: EMAIL, password: PASSWORD }))).status, 429);

  h.clock.advanceMs(15 * 60 * 1000 + 1000);
  assert.equal((await h.login(postJson('http://t/api/auth/login', { email: EMAIL, password: PASSWORD }))).status, 200);
});

test('AUTH-11 getCurrentUser：有效会话返回用户', async () => {
  const h = harness();
  const res = await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));
  const token = extractSessionToken(res);
  const user = await h.auth.getCurrentUser(token);
  assert.ok(user);
  assert.equal(user?.email, EMAIL);
  assert.equal((user as { passwordHash?: string }).passwordHash, undefined, '不得返回密码哈希');
});

test('AUTH-12 getCurrentUser：会话过期返回 null 并清理', async () => {
  const h = harness();
  const res = await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));
  const token = extractSessionToken(res);

  h.clock.advanceMs(SESSION_TTL_MS + 1000);
  assert.equal(await h.auth.getCurrentUser(token), null);
  assert.equal(h.sessions.rows.length, 0, '过期会话应被删除');
});

test('AUTH-13 getCurrentUser：无 token / 伪造 token 返回 null', async () => {
  const h = harness();
  assert.equal(await h.auth.getCurrentUser(null), null);
  assert.equal(await h.auth.getCurrentUser(''), null);
  assert.equal(await h.auth.getCurrentUser('forged-token-value'), null);
});

test('AUTH-14 Logout：会话被吊销，之后访问返回 401 并清除 Cookie', async () => {
  const h = harness();
  const res = await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));
  const token = extractSessionToken(res);

  const out = await h.logout(postJson('http://t/api/auth/logout', {}, token));
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') ?? '', /jp_session=;/);
  assert.equal(h.sessions.rows.length, 0);

  const after = await h.me(getJson('http://t/api/auth/me', token));
  assert.equal(after.status, 401);
});

test('AUTH-15 /api/auth/me：未登录 401，已登录 200', async () => {
  const h = harness();
  const anon = await h.me(getJson('http://t/api/auth/me'));
  assert.equal(anon.status, 401);
  const anonBody = (await bodyOf(anon)) as { error: { code: string } };
  assert.equal(anonBody.error.code, 'UNAUTHENTICATED');

  const res = await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));
  const token = extractSessionToken(res);
  const authed = await h.me(getJson('http://t/api/auth/me', token));
  assert.equal(authed.status, 200);
  const data = (await bodyOf(authed)) as { data: { user: { email: string } } };
  assert.equal(data.data.user.email, EMAIL);
});

test('AUTH-16 响应绝不包含密码哈希或明文密码', async () => {
  const h = harness();
  const res = await h.register(postJson('http://t/api/auth/register', { email: EMAIL, password: PASSWORD }));
  const raw = JSON.stringify(await bodyOf(res));
  assert.ok(!raw.includes(PASSWORD));
  assert.ok(!raw.includes('scrypt$'));
});
