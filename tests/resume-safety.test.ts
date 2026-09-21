import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectKind,
  isDeclaredNameConsistent,
  looksLikePlainText,
  validateIntake,
  MAX_FILE_BYTES,
} from '../src/domain/resume/intake.ts';
import { IntakeError, initialFactStatus } from '../src/domain/resume/types.ts';
import { isVerbatim, locateQuote, MAX_EXCERPT_CHARS } from '../src/domain/resume/locate.ts';
import { FACT_STATUS } from '../src/domain/types.ts';

const u8 = (bytes: number[] | string): Uint8Array =>
  typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);

const PDF = u8([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3]);
const ZIP = u8([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const JPEG = u8([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC = u8([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
const WEBP = u8([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

/* ═══════════ 接收安全：只信魔数，不信扩展名 ═══════════ */

test('T2-01 PDF 魔数识别，即使扩展名伪装成 .txt', () => {
  assert.equal(detectKind(PDF), 'PDF');
  const r = validateIntake({ bytes: PDF, declaredName: 'resume.txt' });
  assert.equal(r.kind, 'PDF');
  assert.equal(isDeclaredNameConsistent('resume.txt', 'PDF'), false, '扩展名与真实类型不符必须能被识别出来');
});

test('T2-02 DOCX 为 zip 容器，能识别', () => {
  assert.equal(detectKind(ZIP), 'DOCX');
  assert.equal(validateIntake({ bytes: ZIP, declaredName: 'r.docx' }).kind, 'DOCX');
});

test('T2-03 纯文本兜底识别', () => {
  const txt = u8('林一舟\n技能：Python、FastAPI\n项目：AIGC 内容生成');
  assert.equal(looksLikePlainText(txt), true);
  assert.equal(validateIntake({ bytes: txt, declaredName: 'r.txt' }).kind, 'TEXT');
  assert.equal(detectKind(txt), 'UNKNOWN', '纯文本没有魔数，走兜底分支');
});

test('T2-04 图片简历明确拒绝，并给出准确原因（不是静默失败）', () => {
  for (const [name, bytes] of [['JPEG', JPEG], ['PNG', PNG], ['HEIC', HEIC], ['WEBP', WEBP]] as const) {
    assert.equal(detectKind(bytes), 'IMAGE', `${name} 必须被识别为图片`);
    assert.throws(
      () => validateIntake({ bytes, declaredName: 'resume.pdf' }),
      (e: unknown) => {
        assert.ok(e instanceof IntakeError);
        assert.equal((e as IntakeError).code, 'SCAN_NOT_SUPPORTED');
        assert.match((e as IntakeError).message, /不支持图片与扫描件/);
        return true;
      },
      `${name} 伪装成 pdf 也必须被拦下`,
    );
  }
});

test('T2-05 空文件与超大文件被拒', () => {
  assert.throws(() => validateIntake({ bytes: new Uint8Array(0) }), /文件是空的/);

  const huge = new Uint8Array(MAX_FILE_BYTES + 1);
  huge.set(PDF.subarray(0, PDF.length));
  assert.throws(
    () => validateIntake({ bytes: huge, declaredName: 'big.pdf' }),
    (e: unknown) => (e as IntakeError).code === 'FILE_TOO_LARGE',
  );
  // 恰好等于上限应通过
  assert.doesNotThrow(() => validateIntake({ bytes: new Uint8Array(MAX_FILE_BYTES).fill(0x41) }) as unknown as void);
});

test('T2-06 二进制垃圾与含 NUL 的内容不算纯文本', () => {
  const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0xff, 0xfe]);
  assert.equal(looksLikePlainText(junk), false);
  assert.throws(() => validateIntake({ bytes: junk }), (e: unknown) => (e as IntakeError).code === 'UNSUPPORTED_TYPE');

  const withNul = new Uint8Array([...new TextEncoder().encode('林一舟技能'), 0x00, ...new TextEncoder().encode('Python')]);
  assert.equal(looksLikePlainText(withNul), false, '含 NUL 的内容不能当作纯文本');
});

/* ═══════════ Evidence 定位：服务端确定性反查 ═══════════ */

const SOURCE = [
  '林一舟',
  '技能：Python、FastAPI、Docker',
  '项目经历：AIGC 内容生成平台',
  '使用 Python 完成数据处理，并完成 Prompt 调优与效果对比',
  '教育经历：某大学 计算机科学',
].join('\n');

test('T2-07 逐字命中：行号与 excerpt 均由服务端算出', () => {
  const loc = locateQuote(SOURCE, 'Python、FastAPI、Docker');
  assert.ok(loc);
  assert.equal(loc?.locator, 'resume:line:2');
  assert.equal(loc?.excerpt, 'Python、FastAPI、Docker');
});

test('T2-08 跨行 quote 也能定位', () => {
  const loc = locateQuote(SOURCE, 'AIGC 内容生成平台\n使用 Python 完成数据处理');
  assert.ok(loc);
  assert.equal(loc?.locator, 'resume:line:3', '以起始行号为准');
  assert.ok(loc?.excerpt.includes('AIGC'));
});

test('T2-09 归一化容忍空格与标点差异，行号仍准确', () => {
  const loc = locateQuote(SOURCE, 'Python  完成数据处理，并完成 Prompt调优');
  assert.ok(loc, '标点/空格差异不应导致定位失败');
  assert.ok(loc?.locator.startsWith('resume:line:4'));
});

test('T2-10 定位不到 → 返回 null（绝不编造位置）', () => {
  assert.equal(locateQuote(SOURCE, '精通 Kubernetes 集群治理'), null);
  assert.equal(locateQuote(SOURCE, 'Rust'), null, '过短 quote 不参与定位');
  assert.equal(locateQuote(SOURCE, 'ab'), null);
});

test('T2-11 同一片段多次出现 → 取首次，结果确定', () => {
  const dup = 'Python 是技能\nPython 也是项目';
  const a = locateQuote(dup, 'Python');
  const b = locateQuote(dup, 'Python');
  assert.deepEqual(a, b, '同输入必须同输出');
  assert.equal(locateQuote(dup, 'Python 是技能')?.locator, 'resume:line:1');
});

test('T2-12 excerpt 超长会被截断并标注省略号', () => {
  const long = `技能：${'A'.repeat(300)}`;
  const loc = locateQuote(long, 'A'.repeat(300));
  assert.ok(loc);
  assert.ok((loc?.excerpt.length ?? 0) <= MAX_EXCERPT_CHARS + 1, '必须有上限，避免 excerpt 无界');
  assert.ok(loc?.excerpt.endsWith('…'));
});

test('T2-13 isVerbatim：逐字 true，改写 false —— 决定 UNCONFIRMED / INFERRED', () => {
  assert.equal(isVerbatim(SOURCE, '使用 Python 完成数据处理'), true);
  assert.equal(isVerbatim(SOURCE, '使用 Python 完成了复杂的数据处理工作'), false);
  assert.equal(isVerbatim(SOURCE, '精通分布式系统'), false);
});

/* ═══════════ FactStatus 默认规则：绝不自动 CONFIRMED ═══════════ */

test('T2-14 解析结果永不自动 CONFIRMED：逐字 → UNCONFIRMED，改写 → INFERRED', () => {
  assert.equal(initialFactStatus(true), FACT_STATUS.UNCONFIRMED);
  assert.equal(initialFactStatus(false), FACT_STATUS.INFERRED);

  // 穷举两个分支，任何输入都不得产出 CONFIRMED
  for (const verbatim of [true, false]) {
    assert.notEqual(initialFactStatus(verbatim), FACT_STATUS.CONFIRMED, 'T2 绝不能产出 CONFIRMED');
  }
});
