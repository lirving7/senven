import { IntakeError, RESUME_SOURCE_TYPE } from './types.ts';
import type { ResumeSourceType } from './types.ts';

/**
 * 文件接收安全：只信魔数，不信扩展名。
 * 图片 / 扫描件在 V1 明确不支持 —— 给出明确原因，而不是静默失败或产出空数据。
 */

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
export const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024; // 解压后上限，防 zip bomb
export const MAX_DOCX_ENTRIES = 2048;
export const MAX_TEXT_CHARS = 20_000;

const MAGIC = {
  PDF: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  ZIP: [0x50, 0x4b, 0x03, 0x04], // PK\x03\x04（DOCX 也是 zip）
  JPEG: [0xff, 0xd8, 0xff],
  PNG: [0x89, 0x50, 0x4e, 0x47],
  GIF: [0x47, 0x49, 0x46, 0x38],
  BMP: [0x42, 0x4d],
  TIFF_LE: [0x49, 0x49, 0x2a, 0x00],
  TIFF_BE: [0x4d, 0x4d, 0x00, 0x2a],
  HEIC: [0x66, 0x74, 0x79, 0x70], // ftyp（第 4 字节起）
  WEBP_RIFF: [0x52, 0x49, 0x46, 0x46],
};

function startsWith(buf: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  return sig.every((b, i) => buf[offset + i] === b);
}

export type DetectedKind = ResumeSourceType | 'IMAGE' | 'UNKNOWN';

/** 依据魔数判定真实类型 */
export function detectKind(buf: Uint8Array): DetectedKind {
  if (startsWith(buf, MAGIC.PDF)) return RESUME_SOURCE_TYPE.PDF;
  if (startsWith(buf, MAGIC.ZIP)) return RESUME_SOURCE_TYPE.DOCX;

  // 图片：V1 明确不支持，但必须能识别出来并给出准确原因
  if (
    startsWith(buf, MAGIC.JPEG) ||
    startsWith(buf, MAGIC.PNG) ||
    startsWith(buf, MAGIC.GIF) ||
    startsWith(buf, MAGIC.BMP) ||
    startsWith(buf, MAGIC.TIFF_LE) ||
    startsWith(buf, MAGIC.TIFF_BE)
  ) {
    return 'IMAGE';
  }
  // RIFF 头 12 字节即含 'WEBP' 标识，故用 >= 12（> 12 会漏判最小合法头）
  if (startsWith(buf, MAGIC.WEBP_RIFF) && buf.length >= 12
    && String.fromCharCode(...buf.subarray(8, 12)) === 'WEBP') {
    return 'IMAGE';
  }
  if (String.fromCharCode(...buf.subarray(4, 8)) === 'ftyp') return 'IMAGE'; // HEIC/AVIF

  return 'UNKNOWN';
}

/** 纯文本兜底：能按 UTF-8 解码且不含二进制控制字符，才认为是文本 */
export function looksLikePlainText(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (text.includes('\uFFFD')) return false;
  // 允许 \t \n \r，其余 C0 控制字符视为二进制
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
}

export type IntakeResult = {
  kind: ResumeSourceType;
  /** 原始字节，仅内存中使用，绝不落盘 */
  bytes: Uint8Array;
  detectedAs: DetectedKind;
};

/**
 * 接收校验：大小 → 魔数 → 类型
 * 若扩展名与真实类型不符，以真实类型为准（并记录告警由调用方决定是否提示）
 */
export function validateIntake(input: { bytes: Uint8Array; declaredName?: string }): IntakeResult {
  const { bytes } = input;

  if (bytes.length === 0) {
    throw new IntakeError('EMPTY_FILE', '文件是空的，没有内容可以解析');
  }
  if (bytes.length > MAX_FILE_BYTES) {
    const mb = (bytes.length / 1024 / 1024).toFixed(1);
    throw new IntakeError('FILE_TOO_LARGE', `文件 ${mb}MB，超出 5MB 上限`);
  }

  const detected = detectKind(bytes);

  if (detected === 'IMAGE') {
    throw new IntakeError(
      'SCAN_NOT_SUPPORTED',
      'V1 暂不支持图片与扫描件简历。请上传 PDF / Word，或直接把简历文字粘贴进来。',
    );
  }
  if (detected === 'UNKNOWN') {
    if (looksLikePlainText(bytes)) {
      return { kind: RESUME_SOURCE_TYPE.TEXT, bytes, detectedAs: 'UNKNOWN' };
    }
    throw new IntakeError('UNSUPPORTED_TYPE', '无法识别的文件格式。仅支持 PDF / Word / 纯文本，且不支持扫描件');
  }

  return { kind: detected, bytes, detectedAs: detected };
}

export function isDeclaredNameConsistent(declaredName: string | undefined, kind: ResumeSourceType): boolean {
  if (!declaredName) return true;
  const ext = declaredName.toLowerCase().split('.').pop() ?? '';
  if (kind === RESUME_SOURCE_TYPE.PDF) return ext === 'pdf';
  if (kind === RESUME_SOURCE_TYPE.DOCX) return ext === 'docx' || ext === 'doc';
  return ext === 'txt' || ext === 'md' || ext === 'text';
}
