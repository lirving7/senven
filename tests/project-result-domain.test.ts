import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeContentFingerprint,
  computeArtifactDedupeKey,
  canTransition,
  snapshotFromStep,
  normalizeFingerprintText,
  normalizeArtifactUrl,
  inferStatus,
} from '../src/domain/project-result/project-result.ts';

test('computeContentFingerprint 对 NFKC、换行、空白规范化', () => {
  const a = computeContentFingerprint('step-1', 'Title', 'Summary');
  const b = computeContentFingerprint('step-1', 'Title\u3000', 'Summary');
  const c = computeContentFingerprint('step-1', 'Title', 'Summary\r\n');
  const d = computeContentFingerprint('step-1', 'Ｔｉｔｌｅ', 'Summary'); // NFKC 全角字母
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a, d);
});

test('computeContentFingerprint 排除 planId / userId / 时间戳', () => {
  const base = computeContentFingerprint('step-1', 'Title', 'Summary');
  const withNoise = computeContentFingerprint('step-1', 'Title', 'Summary');
  assert.equal(base, withNoise);
  // 只改变 sourceStepId / title / summary 才会改变指纹
  const changedStep = computeContentFingerprint('step-2', 'Title', 'Summary');
  const changedTitle = computeContentFingerprint('step-1', 'Other', 'Summary');
  const changedSummary = computeContentFingerprint('step-1', 'Title', 'Other');
  assert.notEqual(base, changedStep);
  assert.notEqual(base, changedTitle);
  assert.notEqual(base, changedSummary);
});

test('normalizeFingerprintText CRLF / CR 统一为 LF 并 trim', () => {
  assert.equal(normalizeFingerprintText('a\r\nb'), 'a\nb');
  assert.equal(normalizeFingerprintText('a\rb'), 'a\nb');
  assert.equal(normalizeFingerprintText('  x  '), 'x');
});

test('normalizeArtifactUrl 只小写协议与域名，保留 pathname 大小写与 fragment，去末尾斜杠', () => {
  assert.equal(normalizeArtifactUrl('  HTTPS://EXAMPLE.COM/PATH/  '), 'https://example.com/PATH');
  assert.equal(normalizeArtifactUrl('https://example.com/path#section'), 'https://example.com/path#section');
  assert.equal(normalizeArtifactUrl('https://example.com/'), 'https://example.com/');
});

// A2-0 correctness patch：fragment 必须保留（此前被 url.hash = '' 删除）
test('normalizeArtifactUrl 保留 fragment', () => {
  assert.equal(normalizeArtifactUrl('https://example.com/path#section'), 'https://example.com/path#section');
  assert.equal(normalizeArtifactUrl('https://example.com/path#a-b_c'), 'https://example.com/path#a-b_c');
  // 末尾裸 `#`（空 fragment）按「保留 fragment」策略同样保留，且不得与无 fragment 混同
  assert.equal(normalizeArtifactUrl('https://example.com/path#'), 'https://example.com/path#');
  assert.notEqual(normalizeArtifactUrl('https://example.com/path#'), normalizeArtifactUrl('https://example.com/path'));
  // 有 / 无 fragment 不得混同
  assert.notEqual(normalizeArtifactUrl('https://example.com/path#x'), normalizeArtifactUrl('https://example.com/path'));
  // 不同 fragment 不得混同
  assert.notEqual(normalizeArtifactUrl('https://example.com/path#a'), normalizeArtifactUrl('https://example.com/path#b'));
});

// A2-0 correctness patch：只对 host/hostname lowercase，pathname 大小写敏感
test('normalizeArtifactUrl 不 lowercase pathname', () => {
  assert.equal(normalizeArtifactUrl('https://example.com/Path/To/Repo'), 'https://example.com/Path/To/Repo');
  // host / 协议仍 lowercase
  assert.equal(normalizeArtifactUrl('https://EXAMPLE.COM/Path'), 'https://example.com/Path');
  assert.equal(normalizeArtifactUrl('HTTPS://Example.COM/Path'), 'https://example.com/Path');
  // path 大小写不同 → identity 必须不同
  assert.notEqual(normalizeArtifactUrl('https://example.com/Repo'), normalizeArtifactUrl('https://example.com/repo'));
});

test('computeArtifactDedupeKey URL 优先于 excerpt', () => {
  const urlKey = computeArtifactDedupeKey('REPO', { url: 'https://example.com/repo', excerpt: 'desc' });
  const excerptKey = computeArtifactDedupeKey('REPO', { url: null, excerpt: 'desc' });
  assert.notEqual(urlKey, excerptKey);
});

test('computeArtifactDedupeKey 同 kind + 同 url 返回相同键', () => {
  const a = computeArtifactDedupeKey('REPO', { url: 'https://example.com/repo' });
  const b = computeArtifactDedupeKey('repo', { url: 'https://EXAMPLE.COM/repo/' });
  assert.equal(a, b);
});

test('computeArtifactDedupeKey excerpt 做 NFKC / 换行 / trim 规范化', () => {
  const a = computeArtifactDedupeKey('DOC', { excerpt: 'hello\nworld' });
  const b = computeArtifactDedupeKey('DOC', { excerpt: 'hello\r\nworld  ' });
  const c = computeArtifactDedupeKey('DOC', { excerpt: 'ｈｅｌｌｏ\nｗｏｒｌｄ' }); // NFKC 全角字母
  assert.equal(a, b);
  assert.equal(a, c);
});

// A2-0 correctness patch：fragment 与 pathname 大小写必须参与 identity，避免误合并
test('computeArtifactDedupeKey 区分 fragment 与 pathname 大小写', () => {
  const base = computeArtifactDedupeKey('REPO', { url: 'https://example.com/repo' });
  const basePath = computeArtifactDedupeKey('REPO', { url: 'https://example.com/Repo' });
  // fragment 参与 identity
  assert.notEqual(computeArtifactDedupeKey('REPO', { url: 'https://example.com/repo#readme' }), base);
  assert.notEqual(computeArtifactDedupeKey('REPO', { url: 'https://example.com/repo#a' }), computeArtifactDedupeKey('REPO', { url: 'https://example.com/repo#b' }));
  // pathname 大小写参与 identity
  assert.notEqual(basePath, base);
  // 仍应归并的：host 大小写、协议大小写、末尾斜杠、首尾空白
  assert.equal(computeArtifactDedupeKey('REPO', { url: 'https://EXAMPLE.com/repo' }), base);
  assert.equal(computeArtifactDedupeKey('REPO', { url: 'HTTPS://example.com/repo' }), base);
  assert.equal(computeArtifactDedupeKey('REPO', { url: 'https://example.com/repo/' }), base);
  assert.equal(computeArtifactDedupeKey('REPO', { url: '  https://example.com/repo  ' }), base);
});

test('canTransition 只允许 Draft→Submitted 与 Submitted→Revoked', () => {
  assert.equal(canTransition('DRAFT', 'SUBMITTED'), true);
  assert.equal(canTransition('SUBMITTED', 'REVOKED'), true);
  assert.equal(canTransition('DRAFT', 'REVOKED'), false);
  assert.equal(canTransition('SUBMITTED', 'DRAFT'), false);
  assert.equal(canTransition('REVOKED', 'DRAFT'), false);
  assert.equal(canTransition('REVOKED', 'SUBMITTED'), false);
});

test('snapshotFromStep 固化 sourceStepId / title / targetRequirement', () => {
  const snapshot = snapshotFromStep({ id: 'step-1', title: '[学习] K8s', targetRequirement: '熟悉 Kubernetes' });
  assert.equal(snapshot.sourceStepId, 'step-1');
  assert.equal(snapshot.sourceStepTitle, '[学习] K8s');
  assert.equal(snapshot.sourceStepTargetRequirement, '熟悉 Kubernetes');
});

test('snapshotFromStep targetRequirement 缺省为空', () => {
  const snapshot = snapshotFromStep({ id: 'step-1', title: 'title' });
  assert.equal(snapshot.sourceStepTargetRequirement, null);
});

test('inferStatus 由 submittedAt / revokedAt 推导三态', () => {
  assert.equal(inferStatus({ submittedAt: null, revokedAt: null }), 'DRAFT');
  assert.equal(inferStatus({ submittedAt: new Date(), revokedAt: null }), 'SUBMITTED');
  assert.equal(inferStatus({ submittedAt: new Date(), revokedAt: new Date() }), 'REVOKED');
});
