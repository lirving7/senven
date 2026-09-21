/**
 * T4-5 C-1 —— clientExtras 错误管道单测（无 DB）。
 *
 * 验证（ADR-015 C-1）：
 * - MappedError.clientExtras 仅从 AppError.details.client 读取
 * - primitive-only（非 primitive 丢弃）
 * - 仅 4xx 生效；5xx 不附加
 * - 非 Interview 的 LLM_QUOTA_EXCEEDED 无 clientExtras（响应键保持 ['error']）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { appError, ERROR_CODE } from '../src/errors.ts';
import { mapError } from '../src/http/error-mapping.ts';
import { errorResponse } from '../src/http/request.ts';

test('C-1：4xx AppError 附加 primitive clientExtras', () => {
  const err = appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, '配额不足', {
    client: { answerSaved: true, feedback: null },
  });
  const mapped = mapError(err);
  assert.equal(mapped.status, 429);
  assert.deepEqual(mapped.clientExtras, { answerSaved: true, feedback: null });
});

test('C-1：details.client 之外的数据不外溢（details.raw 不透出）', () => {
  const err = appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, 'x', {
    raw: 'secret-upstream-detail',
    client: { answerSaved: true },
  });
  const mapped = mapError(err);
  assert.deepEqual(mapped.clientExtras, { answerSaved: true });
  assert.equal('raw' in (mapped.clientExtras ?? {}), false);
});

test('C-1：非 primitive 的 client 值被丢弃', () => {
  const err = appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, 'x', {
    client: { good: 'yes', bad: { nested: true }, arr: [1, 2] },
  });
  const mapped = mapError(err);
  assert.deepEqual(mapped.clientExtras, { good: 'yes' });
});

test('C-1：5xx 不附加 clientExtras', () => {
  const err = appError(ERROR_CODE.INTERNAL_ERROR, 'boom', {
    client: { answerSaved: true },
  });
  const mapped = mapError(err);
  assert.equal(mapped.status, 500);
  assert.equal(mapped.clientExtras, undefined);
});

test('C-1：非 Interview 的 LLM_QUOTA_EXCEEDED（无 details.client）不附加 clientExtras', () => {
  const err = appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, '配额不足', {
    retryAfterSeconds: 60,
  });
  const mapped = mapError(err);
  assert.equal(mapped.status, 429);
  assert.equal(mapped.clientExtras, undefined);
});

test('C-1：errorResponse 对非 clientExtras 429 保持顶层键 = ["error"]', async () => {
  const err = appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, '配额不足', { retryAfterSeconds: 60 });
  const res = errorResponse(err, 'req-1');
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['error']);
});

test('C-1：errorResponse 对 Interview 429 顶层键含 clientExtras 且保留 error', async () => {
  const err = appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, '配额不足', {
    client: { answerSaved: true, feedback: null },
  });
  const res = errorResponse(err, 'req-2');
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['answerSaved', 'error', 'feedback']);
  assert.equal(body.answerSaved, true);
  assert.equal(body.feedback, null);
});
