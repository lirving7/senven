/**
 * T6-3-E · dev-only bootstrap 本地开发/测试账号（方案 B，ChatGPT 裁决 + DSH 只读审查）。
 *
 * ⚠️ 本脚本**仅限本地开发/测试环境手动执行**：
 *
 *   node --experimental-strip-types scripts/dev-bootstrap-account.mjs --local-only
 *
 * 环境变量（必填，无默认值，密码不得写进仓库/报告/日志）：
 *   DEV_SEED_EMAIL       测试账号邮箱
 *   DEV_SEED_PASSWORD    测试账号密码（遵循既有认证规则：至少 8 位）
 *
 * 行为（幂等）：
 *   - NODE_ENV === "production" → 立即拒绝执行（硬门）；
 *   - 未提供 `--local-only` → 拒绝执行（双保险）；
 *   - 邮箱不存在 → 调用既有 auth.register() 创建**普通用户**（无任何 role/permission/admin 能力）；
 *   - 邮箱已存在 → no-op（不修改已有用户，不重置密码）；
 *   - 全程复用既有认证能力（email 格式校验 / 密码 ≥8 / scrypt hashPassword），
 *     零 schema 变更、零 migration、零 API、零登录/注册逻辑修改；
 *   - 密码只从环境变量读取，**绝不打印**到终端/日志；
 *   - 不挂载到 postinstall / build / migrate 等任何生命周期。
 *
 * 创建成功后立即注销 bootstrap 过程中产生的临时 session（register 副作用），
 * 不在 DB 中留下可用的会话凭据。
 */

const argv = process.argv.slice(2);

// ─── 硬门 1：生产环境拒绝 ────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  console.error('[dev-bootstrap] REFUSED: NODE_ENV=production 禁止执行本脚本。');
  process.exit(1);
}

// ─── 硬门 2：--local-only 双保险 ─────────────────────────────────────
if (!argv.includes('--local-only')) {
  console.error('[dev-bootstrap] REFUSED: 必须显式提供 --local-only 才允许执行。');
  console.error('用法: node --experimental-strip-types scripts/dev-bootstrap-account.mjs --local-only');
  process.exit(1);
}

// ─── 环境变量（无默认值；密码永不回显） ───────────────────────────────
const email = process.env.DEV_SEED_EMAIL ?? '';
const password = process.env.DEV_SEED_PASSWORD ?? '';

if (!email.trim() || !password) {
  console.error('[dev-bootstrap] REFUSED: 必须通过环境变量提供 DEV_SEED_EMAIL 与 DEV_SEED_PASSWORD（无默认值）。');
  process.exit(1);
}

// ─── 复用既有认证能力（src/ 源码经 strip-types 直接导入） ─────────────
const { prisma } = await import('../src/db/client.ts');
const { createPrismaRepositories } = await import('../src/db/repositories.ts');
const { createAuthService } = await import('../src/auth/service.ts');
const { createInMemoryFailureLimiter } = await import('../src/db/rate-limit.ts');
const { systemClock } = await import('../src/ports/index.ts');

const repos = createPrismaRepositories(prisma);
const auth = createAuthService({
  users: repos.users,
  sessions: repos.sessions,
  failures: createInMemoryFailureLimiter(systemClock),
  clock: systemClock,
});

const EMAIL_TAKEN = 'EMAIL_TAKEN';

try {
  const result = await auth.register({ email, password });
  // register 成功会签发一个 session（副作用）；立即注销，不留下可用会话
  await auth.logout(result.token);
  console.log(`[dev-bootstrap] CREATED  普通用户创建成功（email=${result.user.email}, userId=${result.user.id}）`);
  process.exitCode = 0;
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
  if (code === EMAIL_TAKEN) {
    // 幂等：邮箱已存在 → no-op（不修改既有用户、不重置密码）
    console.log('[dev-bootstrap] NOOP     邮箱已存在，未做任何修改（幂等 no-op）。');
    process.exitCode = 0;
  } else {
    // 其余为既有认证校验失败（邮箱格式 / 密码长度等）；只输出错误码，不输出密码
    console.error(`[dev-bootstrap] FAILED   认证校验未通过（code=${code || 'UNKNOWN'}）。`);
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
