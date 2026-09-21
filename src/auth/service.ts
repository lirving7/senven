import { appError, ERROR_CODE } from '../errors.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { hashSessionToken, newSessionToken } from './token.ts';
import { systemClock } from '../ports/index.ts';
import type { Clock, Counter, FailureLimiter, PublicUser, SessionRepository, UserRepository } from '../ports/index.ts';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
export const PASSWORD_MIN_LENGTH = 8;
export const MAX_LOGIN_FAILURES = 5;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** 用于等时比较的占位哈希，避免「邮箱是否存在」被时序区分（用户枚举防护） */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AuthResult = {
  token: string;
  expiresAt: Date;
  user: PublicUser;
};

export type AuthServiceDeps = {
  users: UserRepository;
  sessions: SessionRepository;
  failures: FailureLimiter;
  clock?: Clock;
  sessionTtlMs?: number;
  maxLoginFailures?: number;
};

export type AuthService = {
  register(input: { email: string; password: string; displayName?: string | null }): Promise<AuthResult>;
  login(input: { email: string; password: string }): Promise<AuthResult>;
  logout(token: string): Promise<void>;
  getCurrentUser(token: string | null): Promise<PublicUser | null>;
};

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function toPublicUser(user: {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}): PublicUser {
  return { id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl };
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const clock = deps.clock ?? systemClock;
  const ttl = deps.sessionTtlMs ?? SESSION_TTL_MS;
  const maxFailures = deps.maxLoginFailures ?? MAX_LOGIN_FAILURES;

  async function issueSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = newSessionToken();
    const expiresAt = new Date(clock.now().getTime() + ttl);
    await deps.sessions.create({ userId, tokenHash: hashSessionToken(token), expiresAt });
    return { token, expiresAt };
  }

  return {
    async register(input) {
      const email = normalizeEmail(input.email ?? '');
      const password = input.password ?? '';

      if (!EMAIL_RE.test(email)) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, '邮箱格式不正确', { field: 'email' });
      }
      if (password.length < PASSWORD_MIN_LENGTH) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, `密码至少 ${PASSWORD_MIN_LENGTH} 位`, { field: 'password' });
      }

      const existing = await deps.users.findByEmail(email);
      if (existing) {
        throw appError(ERROR_CODE.EMAIL_TAKEN, '该邮箱已被注册', { field: 'email' });
      }

      const passwordHash = await hashPassword(password);
      const user = await deps.users.create({
        email,
        passwordHash,
        displayName: input.displayName ?? null,
      });

      const session = await issueSession(user.id);
      return { token: session.token, expiresAt: session.expiresAt, user: toPublicUser(user) };
    },

    async login(input) {
      const email = normalizeEmail(input.email ?? '');
      const password = input.password ?? '';
      const key = `login:${email}`;

      const gate = await deps.failures.check(key);
      if (gate.blocked) {
        throw appError(ERROR_CODE.RATE_LIMITED, '登录失败次数过多，请稍后再试', {
          retryAfterSeconds: gate.retryAfterSeconds,
        });
      }

      const user = EMAIL_RE.test(email) ? await deps.users.findByEmail(email) : null;
      const stored = user?.passwordHash ?? DUMMY_HASH;
      const ok = await verifyPassword(password, stored);

      if (!user || !user.passwordHash || !ok) {
        await deps.failures.record(key);
        throw appError(ERROR_CODE.INVALID_CREDENTIALS, '邮箱或密码不正确');
      }

      await deps.failures.reset(key);
      const session = await issueSession(user.id);
      return { token: session.token, expiresAt: session.expiresAt, user: toPublicUser(user) };
    },

    async logout(token) {
      if (!token) return;
      await deps.sessions.deleteByTokenHash(hashSessionToken(token));
    },

    async getCurrentUser(token) {
      if (!token) return null;
      const session = await deps.sessions.findByTokenHash(hashSessionToken(token));
      if (!session) return null;
      if (session.expiresAt.getTime() <= clock.now().getTime()) {
        await deps.sessions.deleteByTokenHash(hashSessionToken(token));
        return null;
      }
      const user = await deps.users.findById(session.userId);
      return user ? toPublicUser(user) : null;
    },
  };
}

export type LoginFailureCounter = Counter;
