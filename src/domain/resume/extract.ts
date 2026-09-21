import { unzipSync } from 'fflate';

import {
  MAX_DOCX_ENTRIES,
  MAX_DOCX_XML_BYTES,
  MAX_TEXT_CHARS,
  validateIntake,
} from './intake.ts';
import { IntakeError, RESUME_SOURCE_TYPE } from './types.ts';
import type { ExtractedText, ResumeSourceType } from './types.ts';

/**
 * 阶段 1：文本提取。**只接受已通过 intake 校验的字节**。
 *
 * pdf-parse v2 用 package.json 的 `exports` 锁定入口（import → dist/pdf-parse/esm/index.js，
 * 导出 `{ PDFParse }`）。此处用**静态字面量的动态 import** 加载。
 *
 * ⚠️ T6-3-F 修复背景（勿回退）：
 * 早期写法是 `createRequire(import.meta.url)` + `require.resolve('pdf-parse')` + `require(entry)`
 * （entry 为**变量**）。在 Next.js（webpack/RSC）打包下，`createRequire` 被改写为 `undefined`，
 * `require.resolve` 被改写为带 `(rsc)/./` 前缀的模块 id 字面量，`require(变量)` 被改写为
 * `__webpack_require__(<sync recursive ContextModule>)`，而该 context 的 `keys()` 为空，
 * 运行时必抛 `Cannot find module '(rsc)/./node_modules/pdf-parse/dist/pdf-parse/cjs/index.cjs'`。
 * 改用**静态字面量** `import('pdf-parse')` 后，webpack 可在编译期静态解析并打入对应 chunk，
 * 运行时不再命中空 context。
 */

type PdfParseFn = (b: Buffer) => Promise<{ text?: string }>;

let pdfParseFn: PdfParseFn | null = null;
let pdfParsePromise: Promise<PdfParseFn> | null = null;

/**
 * 延迟加载 pdf-parse（静态字面量动态 import，可被 webpack 静态解析）。
 * 延迟加载的好处：TXT/DOCX 路径完全不依赖 pdf 库能否加载；
 * 同时用 promise 缓存避免并发首次调用重复初始化。
 */
async function getPdfParse(): Promise<PdfParseFn> {
  if (pdfParseFn) return pdfParseFn;
  if (!pdfParsePromise) {
    pdfParsePromise = (async () => {
      try {
        const mod = await import('pdf-parse');
        const PDFParseClass = (mod as { PDFParse?: unknown }).PDFParse ?? (mod as { default?: unknown }).default;
        if (typeof PDFParseClass !== 'function') {
          throw new Error('pdf-parse 导出形态无法识别');
        }
        pdfParseFn = async (buf: Buffer) => {
          // v2 API：new PDFParse({ data }).getText() → { text, pages }
          const parser = new (PDFParseClass as new (o: { data: Uint8Array }) => {
            getText: () => Promise<{ text?: string; pages?: Array<{ text?: string }> }>;
            destroy?: () => Promise<void>;
          })({ data: new Uint8Array(buf) });
          try {
            const r = await parser.getText();
            return { text: r.text ?? (r.pages ?? []).map((p) => p.text ?? '').join('\n') };
          } finally {
            await parser.destroy?.();
          }
        };
        return pdfParseFn;
      } catch (err) {
        throw new IntakeError(
          'PDF_ENGINE_UNAVAILABLE',
          `PDF 解析组件不可用：${err instanceof Error ? err.message : '未知原因'}`,
        );
      }
    })();
  }
  return pdfParsePromise;
}

const DOCX_ENTRY = 'word/document.xml';

/** document.xml → 纯文本：段落转换行、tab 保留、剥离标签、还原实体 */
export function docxXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 解压 DOCX：条目数与解压后大小都在解压前判定，防 zip bomb */
export function readDocxXml(bytes: Uint8Array): string {
  let entryCount = 0;
  let rejectedForSize = false;
  let out: string | null = null;

  const unzipped = unzipSync(bytes, {
    filter: (f) => {
      entryCount += 1;
      if (entryCount > MAX_DOCX_ENTRIES) return false;
      if (f.name === DOCX_ENTRY) {
        if (f.originalSize > MAX_DOCX_XML_BYTES) {
          rejectedForSize = true;
          return false;
        }
        return true;
      }
      return false;
    },
  });

  if (rejectedForSize) {
    throw new IntakeError('DOCX_TOO_LARGE_INNER', 'Word 文档解压后内容过大，已拒绝处理');
  }
  if (entryCount > MAX_DOCX_ENTRIES) {
    throw new IntakeError('DOCX_TOO_MANY_ENTRIES', 'Word 文档内部条目异常多，已拒绝处理');
  }

  const file = unzipped[DOCX_ENTRY];
  if (!file) {
    throw new IntakeError('DOCX_INVALID', 'Word 文档结构不完整（缺少 document.xml），无法提取文字');
  }
  out = new TextDecoder('utf-8').decode(file);
  return out;
}

function finalize(text: string, sourceType: ResumeSourceType, warnings: string[]): ExtractedText {
  const cleaned = text.replace(/\u0000/g, '').trim();
  if (cleaned.length === 0) {
    throw new IntakeError(
      'EXTRACT_EMPTY',
      '这份文件里没有提取到任何文字。如果它是扫描件或图片，请改用 PDF（文字版）或直接粘贴简历文字。',
    );
  }
  if (cleaned.length > MAX_TEXT_CHARS) {
    warnings.push(`简历超长，仅解析前 ${MAX_TEXT_CHARS} 字`);
  }
  return { text: cleaned.slice(0, MAX_TEXT_CHARS), sourceType, warnings };
}

export async function extractText(input: { bytes: Uint8Array; declaredName?: string }): Promise<ExtractedText> {
  // 复用 intake 的全部安全规则，不重新实现一套
  const { kind, bytes } = validateIntake(input);
  const warnings: string[] = [];

  if (kind === RESUME_SOURCE_TYPE.TEXT) {
    return finalize(new TextDecoder('utf-8').decode(bytes), kind, warnings);
  }

  if (kind === RESUME_SOURCE_TYPE.PDF) {
    let raw: string;
    try {
      const parsed = await (await getPdfParse())(Buffer.from(bytes));
      raw = parsed.text ?? '';
    } catch (err) {
      throw new IntakeError('PDF_PARSE_FAILED', `PDF 读取失败：${err instanceof Error ? err.message : '未知原因'}`);
    }
    return finalize(raw, kind, warnings);
  }

  // DOCX
  let xml: string;
  try {
    xml = readDocxXml(bytes);
  } catch (err) {
    if (err instanceof IntakeError) throw err;
    throw new IntakeError('DOCX_PARSE_FAILED', 'Word 文档读取失败，可能已损坏或加密');
  }
  return finalize(docxXmlToText(xml), kind, warnings);
}

export { MAX_TEXT_CHARS };
