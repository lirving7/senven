/**
 * PDF 视觉 QA（自动代理）：渲染 → 提取文本 → 校验中文可读。
 * 目的：验证「中文字体硬依赖」在当前环境成立，且产物不是空白页 / 不是 tofu。
 * 用法：node --experimental-strip-types scripts/pdf-visual-qa.ts
 */
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { renderPdf, resolveFontPath } from '../src/domain/pdf/render.ts';
import type { PdfDocumentModel } from '../src/domain/pdf/types.ts';

const require = createRequire(import.meta.url);

const model: PdfDocumentModel = {
  basics: { name: '林一舟', phone: '138-0000-0000', email: 'lin@example.com', city: '上海' },
  sections: {
    SKILL: [{ category: 'SKILL', text: 'Python、FastAPI、PostgreSQL', evidenceRefs: [] }],
    PROJECT: [{ category: 'PROJECT', text: 'AIGC 内容生成平台 —— 负责后端服务', evidenceRefs: [] }],
    EXPERIENCE: [{ category: 'EXPERIENCE', text: '云枢智能 后端实习生 2024-2025', evidenceRefs: [] }],
    EDUCATION: [{ category: 'EDUCATION', text: '上海交通大学 计算机科学与技术', evidenceRefs: [] }],
  },
  excluded: [],
  meta: { resumeId: 'qa', versionNo: 1, sourceFactCount: 4, confirmedCount: 4 },
};

const font = resolveFontPath();
const buf = await renderPdf(model, font);

const magicOk = buf.subarray(0, 5).toString('latin1') === '%PDF-';
const outPath = 'scripts/.pdf-qa-output.pdf';
writeFileSync(outPath, buf);

let extracted = '';
let extractError = '';
try {
  const mod = require('pdf-parse') as unknown;
  const PDFParseClass = (mod as { PDFParse?: unknown }).PDFParse ?? (mod as { default?: unknown }).default;
  const parser = new (PDFParseClass as new (o: { data: Uint8Array }) => {
    getText: () => Promise<{ text?: string; pages?: Array<{ text?: string }> }>;
    destroy?: () => Promise<void>;
  })({ data: new Uint8Array(buf) });
  try {
    const r = await parser.getText();
    extracted = r.text ?? (r.pages ?? []).map((p) => p.text ?? '').join('\n');
  } finally {
    await parser.destroy?.();
  }
} catch (e) {
  extractError = e instanceof Error ? e.message : String(e);
}

const checks: Array<[string, boolean, string]> = [
  ['PDF 魔数 %PDF-', magicOk, buf.subarray(0, 5).toString('latin1')],
  ['文件非空（>1KB）', buf.length > 1024, `${buf.length} bytes`],
  ['字体解析到中文候选', existsSync(font), font],
  ['提取文本含姓名「林一舟」', extracted.includes('林一舟'), ''],
  ['提取文本含「技能」', extracted.includes('技能'), ''],
  ['提取文本含「Python」', extracted.includes('Python'), ''],
  ['提取文本含「上海交通大学」', extracted.includes('上海交通大学'), ''],
];

let fail = 0;
console.log(`font = ${font}`);
console.log(`pdf  = ${buf.length} bytes  magic=${magicOk ? 'OK' : 'BAD'}`);
console.log('---');
for (const [name, ok, extra] of checks) {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}
if (extractError) {
  fail++;
  console.log(`FAIL  文本提取出错: ${extractError}`);
}
if (extracted.trim().length === 0 && !extractError) {
  fail++;
  console.log('FAIL  提取文本为空 —— 高度怀疑空白页 / tofu');
}
console.log('---');
console.log(`提取文本长度 = ${extracted.length} 字符`);
console.log(fail === 0 ? 'RESULT: ALL PASS' : `RESULT: ${fail} FAILED`);
process.exitCode = fail === 0 ? 0 : 1;
