import type { PdfDocumentModel } from './types.ts';

export const TEMPLATE_VERSION = 'single-column-a4-v1';

/** ResumeVersion.snapshot 的内容：足以确定性重渲染出同一份 PDF */
export type VersionSnapshot = {
  templateVersion: string;
  model: PdfDocumentModel;
};

export type ResumeVersionCreateInput = {
  resumeId: string;
  jdId: string | null;
  versionNo: number;
  snapshot: unknown;
  pdfUrl: string | null;
};

export function snapshotOf(model: PdfDocumentModel): VersionSnapshot {
  return { templateVersion: TEMPLATE_VERSION, model };
}

/** PDF 不落文件系统：按需从不可变快照重新渲染 */
export function versionPdfPath(resumeId: string, versionId: string): string {
  return `/api/resumes/${resumeId}/versions/${versionId}/pdf`;
}

export function toResumeVersionCreateInput(
  model: PdfDocumentModel,
  args: { resumeId: string; versionId: string; jdId?: string | null },
): ResumeVersionCreateInput {
  if (!args.resumeId || args.resumeId.trim().length === 0) {
    throw new Error('resumeId 不能为空');
  }
  return {
    resumeId: args.resumeId,
    jdId: args.jdId ?? null,
    versionNo: model.meta.versionNo,
    snapshot: snapshotOf(model),
    pdfUrl: versionPdfPath(args.resumeId, args.versionId),
  };
}
