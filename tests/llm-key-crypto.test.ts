/**
 * 用户自带 LLM API Key · 加密模块测试（AES-256-GCM，Migration #19）。
 *
 * 覆盖：round trip / 错误主密钥 / 畸形密文 / 缺失主密钥 / AAD 不匹配（跨用户不可解）/
 * IV 每次随机 / 主密钥格式（hex 与 base64url）/ 错误信息不含任何 Key 明文或密文。
 *
 * 本文件操作 process.env.LLM_USER_KEY_MASTER_SECRET（加密模块无缓存，逐调用读取）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { decryptLlmApiKey, encryptLlmApiKey, LlmKeyCryptoError } from '../src/llm/key-crypto.ts';

const MASTER_HEX = '11'.repeat(32); // 32 字节
const MASTER_B64URL = 'A'.repeat(43); // 32 字节的 base64url（'A'×43 → 32 字节 0）
const USER_A = 'user-aaaaaaaaaaaa';
const USER_B = 'user-bbbbbbbbbbbb';
const KEY_A = 'sk-test-user-a-key-0001234';

test('CRYPTO-01 加解密 round trip：hex 主密钥', () => {
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;
  const cipher = encryptLlmApiKey(KEY_A, USER_A);
  assert.notEqual(cipher, KEY_A, '密文不得等于明文');
  assert.equal(decryptLlmApiKey(cipher, USER_A), KEY_A);
});

test('CRYPTO-02 加解密 round trip：base64url 主密钥', () => {
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_B64URL;
  const cipher = encryptLlmApiKey(KEY_A, USER_A);
  assert.equal(decryptLlmApiKey(cipher, USER_A), KEY_A);
});

test('CRYPTO-03 密文格式：v1.iv.ct.tag 四段 base64url，且每次加密 IV 不同', () => {
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;
  const c1 = encryptLlmApiKey(KEY_A, USER_A);
  const c2 = encryptLlmApiKey(KEY_A, USER_A);
  assert.equal(c1.split('.').length, 4);
  assert.equal(c1.split('.')[0], 'v1');
  assert.notEqual(c1, c2, '相同明文两次加密必须产生不同密文（随机 IV）');
  assert.equal(decryptLlmApiKey(c2, USER_A), KEY_A);
});

test('CRYPTO-04 AAD 不匹配：用户 B 无法解密用户 A 的密文（跨用户隔离的密码学证明）', () => {
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;
  const cipherA = encryptLlmApiKey(KEY_A, USER_A);
  assert.throws(
    () => decryptLlmApiKey(cipherA, USER_B),
    (err: unknown) => err instanceof LlmKeyCryptoError && err.code === 'DECRYPT_FAILED',
  );
});

test('CRYPTO-05 错误主密钥：主密钥变更后旧密文不可解', () => {
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;
  const cipher = encryptLlmApiKey(KEY_A, USER_A);
  process.env.LLM_USER_KEY_MASTER_SECRET = '22'.repeat(32);
  assert.throws(
    () => decryptLlmApiKey(cipher, USER_A),
    (err: unknown) => err instanceof LlmKeyCryptoError && err.code === 'DECRYPT_FAILED',
  );
});

test('CRYPTO-06 畸形密文：段数/版本/编码/长度不符 → CIPHERTEXT_MALFORMED', () => {
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;
  const bad = [
    'garbage-without-dots',
    'v1.only.two',
    'v2.aaa.bbb.ccc',
    'v1.!!!.???.$$$',
    'v1.aaa.bbb.ccc.ddd',
  ];
  for (const token of bad) {
    assert.throws(
      () => decryptLlmApiKey(token, USER_A),
      (err: unknown) => err instanceof LlmKeyCryptoError && err.code === 'CIPHERTEXT_MALFORMED',
      `畸形密文应被拒绝：${token}`,
    );
  }
  // 合法结构但 auth tag 被篡改 → 认证失败（DECRYPT_FAILED），不是崩溃
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;
  const cipher = encryptLlmApiKey(KEY_A, USER_A).split('.');
  cipher[3] = 'A'.repeat(22);
  assert.throws(
    () => decryptLlmApiKey(cipher.join('.'), USER_A),
    (err: unknown) => err instanceof LlmKeyCryptoError && err.code === 'DECRYPT_FAILED',
  );
});

test('CRYPTO-07 缺失主密钥：加密 fail-fast；合法密文在无主密钥时不可解', () => {
  // 加密侧：无主密钥必须 fail-fast
  delete process.env.LLM_USER_KEY_MASTER_SECRET;
  assert.throws(
    () => encryptLlmApiKey(KEY_A, USER_A),
    (err: unknown) => err instanceof LlmKeyCryptoError && err.code === 'MASTER_KEY_MISSING',
  );
  // 解密侧：结构合法的密文在无主密钥时 → MASTER_KEY_MISSING（先有合法密文再删环境变量）
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;
  const cipher = encryptLlmApiKey(KEY_A, USER_A);
  delete process.env.LLM_USER_KEY_MASTER_SECRET;
  assert.throws(
    () => decryptLlmApiKey(cipher, USER_A),
    (err: unknown) => err instanceof LlmKeyCryptoError && err.code === 'MASTER_KEY_MISSING',
  );
});

test('CRYPTO-08 非法主密钥：长度/格式错 → MASTER_KEY_INVALID', () => {
  for (const bad of ['short', 'zz'.repeat(32), 'A'.repeat(31) + '2', 'g'.repeat(64)]) {
    process.env.LLM_USER_KEY_MASTER_SECRET = bad;
    assert.throws(
      () => encryptLlmApiKey(KEY_A, USER_A),
      (err: unknown) => err instanceof LlmKeyCryptoError && err.code === 'MASTER_KEY_INVALID',
      `非法主密钥应被拒绝：${bad}`,
    );
  }
});

test('CRYPTO-09 空 Key / 空 AAD：拒绝加密', () => {
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;
  assert.throws(() => encryptLlmApiKey('   ', USER_A));
  assert.throws(() => encryptLlmApiKey(KEY_A, '  '));
});

test('CRYPTO-10 错误信息脱敏：异常 message 不含 Key 明文与密文内容', () => {
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;
  const cipher = encryptLlmApiKey(KEY_A, USER_A);
  const probes: Array<() => unknown> = [
    () => decryptLlmApiKey(cipher, USER_B), // AAD 不匹配
    () => decryptLlmApiKey('v1.!!!.???.$$$', USER_A),
    () => encryptLlmApiKey(KEY_A, '  '),
  ];
  for (const probe of probes) {
    try {
      probe();
      assert.fail('期望抛出 LlmKeyCryptoError');
    } catch (err) {
      assert.ok(err instanceof LlmKeyCryptoError);
      assert.ok(!err.message.includes(KEY_A), '错误信息不得包含 Key 明文');
      assert.ok(!err.message.includes(cipher), '错误信息不得包含密文内容');
    }
  }
  // 恢复默认（避免污染其他测试文件的进程环境）
  delete process.env.LLM_USER_KEY_MASTER_SECRET;
});
