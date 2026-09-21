/**
 * T3-A2-1 Domain 层验收（纯函数，不依赖数据库）
 *
 * 覆盖 §二十七 Domain 矩阵：
 *   host lowercase / default port / trailing slash / fragment preservation / empty fragment /
 *   `/a` vs `/a#` / `/a#f` / pathname case-sensitive / deterministic fingerprint / deterministic dedupeKey
 * 以及闸门纯函数 canDeclareFromStatus / isUrlBacked / evaluateConfirmGate。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeArtifactDedupeKey,
  computeContentFingerprint,
  normalizeArtifactUrl,
} from '../src/domain/project-result/project-result.ts';
import { canDeclareFromStatus, evaluateConfirmGate, isUrlBacked } from '../src/domain/project-result/return.ts';
import {
  PROJECT_RESULT_EVIDENCE_TYPE,
  PROJECT_RESULT_SOURCE,
} from '../src/domain/capability/project.ts';

// ─── Q10 最终 canonicalization contract（A2-0 后正式确认） ───────────────

test('[Q10] host / protocol 小写', () => {
  assert.equal(normalizeArtifactUrl('HTTPS://EXAMPLE.COM/a'), 'https://example.com/a');
  assert.equal(normalizeArtifactUrl('https://Example.COM/a'), 'https://example.com/a');
});

test('[Q10] default port 自动规范化', () => {
  assert.equal(normalizeArtifactUrl('https://example.com:443/a'), 'https://example.com/a');
  assert.equal(normalizeArtifactUrl('http://example.com:80/a'), 'http://example.com/a');
  // 非默认端口必须保留
  assert.equal(normalizeArtifactUrl('https://example.com:8443/a'), 'https://example.com:8443/a');
});

test('[Q10] 非根 pathname 去末尾斜杠；根路径保留', () => {
  assert.equal(normalizeArtifactUrl('https://example.com/a/'), 'https://example.com/a');
  assert.equal(normalizeArtifactUrl('https://example.com/'), 'https://example.com/');
});

test('[Q10/O-B] 先对 pathname 去末尾斜杠，再保留 fragment：/a/#frag → /a#frag', () => {
  assert.equal(normalizeArtifactUrl('https://example.com/a/#frag'), 'https://example.com/a#frag');
  // ⚠️ 与裁决书 §2 第三条断言 `canonicalizeUrl("/a/#frag") !== canonicalizeUrl("/a#frag")` 冲突：
  //    按 §1 明确给出的「正确原则」（先 pathname 去非根 trailing slash，再保留 fragment），
  //    二者规范化后**必然相等**。本条按 §1 的规范实现并断言相等；矛盾已上报 ChatGPT 裁决。
  assert.equal(
    normalizeArtifactUrl('https://example.com/a/#frag'),
    normalizeArtifactUrl('https://example.com/a#frag'),
  );
  assert.equal(
    computeArtifactDedupeKey('REPO', { url: 'https://example.com/a/#frag' }),
    computeArtifactDedupeKey('REPO', { url: 'https://example.com/a#frag' }),
  );
});

test('[Q10/O-B] 去斜杠对带 query / fragment 的 URL 同样生效（不再依赖 href 结尾判断）', () => {
  assert.equal(normalizeArtifactUrl('https://example.com/a/?q=1'), 'https://example.com/a?q=1');
  assert.equal(normalizeArtifactUrl('https://example.com/a/?q=1#f'), 'https://example.com/a?q=1#f');
  assert.equal(normalizeArtifactUrl('https://example.com/a/'), 'https://example.com/a');
  // 仅去一个末尾斜杠，不影响非末尾斜杠
  assert.equal(normalizeArtifactUrl('https://example.com/a//'), 'https://example.com/a/');
});

test('[Q10/O-B] fragment 仍然保留：/a# 与 /a 必须区分（且不得用 u.hash 判空 fragment）', () => {
  assert.equal(normalizeArtifactUrl('https://example.com/a#'), 'https://example.com/a#');
  assert.notEqual(normalizeArtifactUrl('https://example.com/a#'), normalizeArtifactUrl('https://example.com/a'));
  assert.notEqual(normalizeArtifactUrl('https://example.com/a#frag'), normalizeArtifactUrl('https://example.com/a'));
  assert.notEqual(normalizeArtifactUrl('https://example.com/a#f'), normalizeArtifactUrl('https://example.com/a#other'));
});

test('[Q10] fragment 保留（不得删除）', () => {
  assert.equal(normalizeArtifactUrl('https://example.com/a#f'), 'https://example.com/a#f');
  assert.equal(normalizeArtifactUrl('https://example.com/a#Frag'), 'https://example.com/a#Frag');
});

test('[Q10] 空 fragment（裸 #）保留且与无 fragment 区分', () => {
  assert.equal(normalizeArtifactUrl('https://example.com/a#'), 'https://example.com/a#');
  assert.notEqual(normalizeArtifactUrl('https://example.com/a#'), normalizeArtifactUrl('https://example.com/a'));
});

test('[Q10] /a != /A（pathname 大小写敏感）', () => {
  assert.notEqual(normalizeArtifactUrl('https://example.com/a'), normalizeArtifactUrl('https://example.com/A'));
});

test('[Q10] 反例守卫：/A/B 不得与 /a/b 混同', () => {
  const upper = normalizeArtifactUrl('https://example.com/A/B');
  const lower = normalizeArtifactUrl('https://example.com/a/b');
  assert.equal(upper, 'https://example.com/A/B');
  assert.equal(lower, 'https://example.com/a/b');
  assert.notEqual(upper, lower);
  // 而且必须体现在 identity 上
  assert.notEqual(
    computeArtifactDedupeKey('REPO', { url: 'https://example.com/A/B' }),
    computeArtifactDedupeKey('REPO', { url: 'https://example.com/a/b' }),
  );
});

test('[Q10] /a#f != /a#other != /a', () => {
  const a = normalizeArtifactUrl('https://example.com/a#f');
  const b = normalizeArtifactUrl('https://example.com/a#other');
  const c = normalizeArtifactUrl('https://example.com/a');
  assert.equal(new Set([a, b, c]).size, 3);
});

test('[Q10] query 保留且不排序', () => {
  assert.equal(normalizeArtifactUrl('https://example.com/a?b=2&a=1'), 'https://example.com/a?b=2&a=1');
  // 顺序不同 → 不同 identity（不做第三方语义等价）
  assert.notEqual(
    normalizeArtifactUrl('https://example.com/a?b=2&a=1'),
    normalizeArtifactUrl('https://example.com/a?a=1&b=2'),
  );
});

test('[Q10] 解析失败回退 trim；空白归一', () => {
  assert.equal(normalizeArtifactUrl('  https://example.com/a  '), 'https://example.com/a');
  assert.equal(normalizeArtifactUrl('not a url'), 'not a url');
});

// ─── 确定性 ───────────────────────────────────────────────────────────

test('fingerprint 确定性：同输入恒等，且不受 planId/userId/时间影响', () => {
  const a = computeContentFingerprint('step-1', 'T', 'S');
  const b = computeContentFingerprint('step-1', 'T', 'S');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, computeContentFingerprint('step-2', 'T', 'S'));
});

test('dedupeKey 确定性：同输入恒等', () => {
  const a = computeArtifactDedupeKey('REPO', { url: 'https://example.com/a' });
  const b = computeArtifactDedupeKey('REPO', { url: 'https://example.com/a' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

// ─── 回流闸门纯函数 ───────────────────────────────────────────────────

test('canDeclareFromStatus 仅允许 SUBMITTED', () => {
  assert.equal(canDeclareFromStatus('SUBMITTED'), true);
  assert.equal(canDeclareFromStatus('DRAFT'), false);
  assert.equal(canDeclareFromStatus('REVOKED'), false);
  assert.equal(canDeclareFromStatus('submitted'), false);
});

test('isUrlBacked 判据为去空白后非空', () => {
  assert.equal(isUrlBacked('https://example.com/a'), true);
  assert.equal(isUrlBacked('   '), false);
  assert.equal(isUrlBacked(''), false);
  assert.equal(isUrlBacked(null), false);
  assert.equal(isUrlBacked(undefined), false);
});

test('evaluateConfirmGate：无证据 → 不可确认', () => {
  assert.equal(evaluateConfirmGate([]), false);
});

test('[R3] 存在 PROJECT_RESULT_EVIDENCE → 必须「URL 非空 且 未 revoke」', () => {
  const base = {
    type: PROJECT_RESULT_EVIDENCE_TYPE,
    url: null,
    excerpt: null,
    artifactUrl: 'https://example.com/a',
    resultRevokedAt: null,
  };
  assert.equal(evaluateConfirmGate([base]), true);
  // 已 revoke → 不可确认
  assert.equal(evaluateConfirmGate([{ ...base, resultRevokedAt: new Date() }]), false);
  // 无 URL（仅 excerpt）→ 不可确认
  assert.equal(evaluateConfirmGate([{ ...base, artifactUrl: null, excerpt: 'e' }]), false);
  assert.equal(evaluateConfirmGate([{ ...base, artifactUrl: '  ' }]), false);
  // 多条中至少一条有效即可
  assert.equal(
    evaluateConfirmGate([
      { ...base, resultRevokedAt: new Date() },
      { ...base, artifactUrl: 'https://example.com/b' },
    ]),
    true,
  );
});

test('[R3] 不存在 PROJECT_RESULT_EVIDENCE → 沿用 Resume 判据 url ∥ excerpt', () => {
  assert.equal(
    evaluateConfirmGate([{ type: 'RESUME_EVIDENCE', url: null, excerpt: '有摘录', artifactUrl: null, resultRevokedAt: null }]),
    true,
  );
  assert.equal(
    evaluateConfirmGate([{ type: 'RESUME_EVIDENCE', url: 'https://x/a', excerpt: null, artifactUrl: null, resultRevokedAt: null }]),
    true,
  );
  assert.equal(
    evaluateConfirmGate([{ type: 'RESUME_EVIDENCE', url: null, excerpt: null, artifactUrl: null, resultRevokedAt: null }]),
    false,
  );
  assert.equal(
    evaluateConfirmGate([{ type: 'RESUME_EVIDENCE', url: '', excerpt: '   ', artifactUrl: null, resultRevokedAt: null }]),
    false,
  );
});

test('[R3] 来源分域：存在项目证据时，Resume 证据不能单独满足闸门', () => {
  assert.equal(
    evaluateConfirmGate([
      { type: 'RESUME_EVIDENCE', url: 'https://x/a', excerpt: 'e', artifactUrl: null, resultRevokedAt: null },
      { type: PROJECT_RESULT_EVIDENCE_TYPE, url: null, excerpt: null, artifactUrl: null, resultRevokedAt: null },
    ]),
    false,
  );
});

test('常量正式定义（禁止散落硬编码）', () => {
  assert.equal(PROJECT_RESULT_SOURCE, 'PROJECT_RESULT');
  assert.equal(PROJECT_RESULT_EVIDENCE_TYPE, 'PROJECT_RESULT_EVIDENCE');
});
