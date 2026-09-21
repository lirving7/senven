import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock } from '../src/ports/index.ts';
import {
  createConfirmCapabilityHandler,
  createGetCapabilityHandler,
  createListCapabilitiesHandler,
} from '../src/http/handlers/capabilities.ts';
import { bodyOf, getJson, postJson } from './fakes.ts';

/**
 * V2 T1 · Capability 能力层：只读 + 确认 + 事实安全门控。
 * 铁律：confirm 是唯一 CONFIRMED 路径，且必须有可核验证据（url/excerpt 非空）。
 */

const dbUp = await (async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();
const skip = dbUp ? false : 'PostgreSQL 不可达';
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const repos = createPrismaRepositories(prisma);
const auth = () =>
  createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });

async function signUp(tag: string) {
  const r = await auth().register({ email: `cap_${tag}_${stamp}@example.com`, password: 'password-1234' });
  return { token: r.token, userId: r.user.id };
}

const deps = () => ({ auth: auth(), capabilities: repos.capabilities });
const list = () => createListCapabilitiesHandler(deps());
const get = () => createGetCapabilityHandler(deps());
const confirm = () => createConfirmCapabilityHandler(deps());

async function seedCapability(userId: string, withEvidence: boolean) {
  let evidenceId: string | null = null;
  if (withEvidence) {
    const ev = await prisma.evidence.create({
      data: { source: 'RESUME_TEXT', locator: 'resume:line:1', excerpt: 'RAG demo' },
      select: { id: true },
    });
    evidenceId = ev.id;
  }
  return prisma.capability.create({
    data: {
      userId,
      key: `cap_${stamp}`,
      label: 'RAG',
      source: 'MANUAL',
      status: 'UNCONFIRMED',
      evidence: evidenceId
        ? { create: [{ type: 'RESUME_EVIDENCE', source: 'RESUME_TEXT', url: null, excerpt: 'RAG demo', resumeEvidenceId: evidenceId }] }
        : undefined,
    },
    select: { id: true },
  });
}

test('CAP-01 未登录访问能力接口 → 401', { skip }, async () => {
  assert.equal((await list()(getJson('http://t/api/capabilities'))).status, 401);
});

test('CAP-02 能力列表仅本人可见；空库为 []', { skip }, async () => {
  const a = await signUp('a');
  const b = await signUp('b');
  await seedCapability(a.userId, true);

  const la = (await bodyOf(await list()(getJson('http://t/api/capabilities', a.token)))) as { data: { items: Array<{ label: string }> } };
  assert.equal(la.data.items.length, 1);
  assert.equal(la.data.items[0].label, 'RAG');

  const lb = (await bodyOf(await list()(getJson('http://t/api/capabilities', b.token)))) as { data: { items: unknown[] } };
  assert.equal(lb.data.items.length, 0, 'B 看不到 A 的能力');
});

test('CAP-03 详情含证据；跨用户 → 404', { skip }, async () => {
  const a = await signUp('c');
  const b = await signUp('d');
  const cap = await seedCapability(a.userId, true);

  const detail = await get()(getJson('http://t/api/capabilities', a.token), cap.id);
  assert.equal(detail.status, 200);
  const body = (await bodyOf(detail)) as { data: { evidence: Array<{ url: string }> } };
  assert.equal(body.data.evidence.length, 1);

  assert.equal((await get()(getJson('http://t/api/capabilities', b.token), cap.id)).status, 404);
});

test('CAP-04 有证据确认 → 200 CONFIRMED（唯一 CONFIRMED 路径）', { skip }, async () => {
  const a = await signUp('e');
  const cap = await seedCapability(a.userId, true);

  const res = await confirm()(postJson(`http://t/api/capabilities/${cap.id}/confirm`, { confirmed: true }, a.token), cap.id);
  assert.equal(res.status, 200);
  assert.equal(((await bodyOf(res)) as { data: { status: string } }).data.status, 'CONFIRMED');
});

test('CAP-05 无证据确认 → 422（事实安全铁律：不得绕过证据）', { skip }, async () => {
  const a = await signUp('f');
  const cap = await seedCapability(a.userId, false);

  const res = await confirm()(postJson(`http://t/api/capabilities/${cap.id}/confirm`, { confirmed: true }, a.token), cap.id);
  assert.equal(res.status, 422);
  assert.equal(((await bodyOf(res)) as { error: { code: string } }).error.code, 'CAPABILITY_NOT_CONFIRMABLE');

  // 状态不得被改动
  const row = await prisma.capability.findUniqueOrThrow({ where: { id: cap.id } });
  assert.equal(row.status, 'UNCONFIRMED');
});

test('CAP-99 清理', { skip }, async () => {
  const users = await prisma.user.findMany({ where: { email: { contains: `_${stamp}@example.com` } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.$disconnect();
});
