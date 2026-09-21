import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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

const buf = await renderPdf(model, resolveFontPath());
const mod = require('pdf-parse') as unknown;
const PDFParseClass = (mod as { PDFParse?: unknown }).PDFParse ?? (mod as { default?: unknown }).default;
const parser = new (PDFParseClass as new (o: { data: Uint8Array }) => {
  getText: () => Promise<{ text?: string; pages?: Array<{ text?: string }> }>;
  destroy?: () => Promise<void>;
})({ data: new Uint8Array(buf) });
const r = await parser.getText();
await parser.destroy?.();
const text = r.text ?? (r.pages ?? []).map((p) => p.text ?? '').join('\n');
// 打印带可见标记：空格→␣，用于判断 letter-spacing 是否插入空格
console.log(JSON.stringify(text, null, 2));
