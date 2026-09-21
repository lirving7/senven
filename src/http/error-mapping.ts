import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AppError, ERROR_CODE } from '../errors.ts';
import { LLMError } from '../llm/provider.ts';
import { JdEmptyRequirementsError, JdShapeError, JdTooShortError } from '../domain/jd/types.ts';
import { PdfContractError } from '../domain/pdf/types.ts';
import { IntakeError, ResumeShapeError } from '../domain/resume/types.ts';
import { AiAnalysisInvalidResponseError } from '../domain/ai/analyze-project.ts';

export type MappedError = {
  status: number;
  code: string;
  /** 面向用户的文案：绝不透出上游原始错误 */
  message: string;
  retryAfterSeconds?: number;
  /**
   * C-1（ADR-015）：仅从 AppError.details.client 提取的 primitive-only 键，
   * 仅 4xx 生效，5xx 一律不附加。用于 Interview 配额路径透出
   * `answerSaved` / `feedback` 等**显式声明**的客户端可读字段。
   */
  clientExtras?: Record<string, string | number | boolean | null>;
};

/** 是否为 primitive（string / number / boolean / null）；其余一律 false */
function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * C-1：从 AppError.details.client 提取 primitive-only 键。
 * - 只读取 details.client；details 的其它字段（如 raw）绝不透出
 * - 仅 primitive 值透出；非 primitive 值被丢弃
 * - 空对象 → undefined（不附加）
 */
function clientExtrasFor(err: AppError): Record<string, string | number | boolean | null> | undefined {
  const client = (err.details as { client?: unknown } | null | undefined)?.client;
  if (typeof client !== 'object' || client === null) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(client as Record<string, unknown>)) {
    if (isPrimitive(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 统一错误映射（对应架构文档 §9 的错误表）。
 * 原则：上游细节只进日志，不出响应。
 */
export function mapError(err: unknown): MappedError {
  const mapped = mapErrorInner(err);
  // C-1：仅 4xx 附加 clientExtras；5xx 禁止透出任何 clientExtras
  if (err instanceof AppError && mapped.status >= 400 && mapped.status < 500) {
    const extras = clientExtrasFor(err);
    if (extras) mapped.clientExtras = extras;
  }
  return mapped;
}

function mapErrorInner(err: unknown): MappedError {
  // T3-A2-2：AI 分析结构异常 → 502，用专用码（**不**落到 JD_SHAPE_INVALID）
  // 必须先于 LLMError 分支判断，避免 provider 的 FORMAT 错误被误映射为 JD 语义。
  if (err instanceof AiAnalysisInvalidResponseError) {
    return { status: 502, code: ERROR_CODE.AI_ANALYSIS_INVALID_RESPONSE, message: 'AI 分析结果结构异常，请重试' };
  }

  if (err instanceof AppError) {
    switch (err.code) {
      case ERROR_CODE.UNAUTHENTICATED:
        return { status: 401, code: err.code, message: '请先登录' };
      case ERROR_CODE.VALIDATION_FAILED:
        return { status: 400, code: err.code, message: err.message };
      case ERROR_CODE.EMAIL_TAKEN:
        return { status: 409, code: err.code, message: err.message };
      case ERROR_CODE.INVALID_CREDENTIALS:
        return { status: 401, code: err.code, message: err.message };
      case ERROR_CODE.RATE_LIMITED:
      case ERROR_CODE.LLM_QUOTA_EXCEEDED: {
        const retry = (err.details as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
        return { status: 429, code: err.code, message: err.message, retryAfterSeconds: retry };
      }
      case ERROR_CODE.NOT_FOUND:
        return { status: 404, code: err.code, message: '未找到对应资源' };
      case ERROR_CODE.SUGGESTION_NOT_APPLICABLE:
        return { status: 409, code: err.code, message: err.message };
      case ERROR_CODE.SUGGESTION_ALREADY_RESOLVED:
        return { status: 409, code: err.code, message: err.message };
      case ERROR_CODE.PDF_CONTENT_INVALID:
        return { status: 422, code: err.code, message: err.message };
      case ERROR_CODE.PDF_RENDER_FAILED:
        return { status: 500, code: err.code, message: 'PDF 生成失败，请重试' };
      case ERROR_CODE.SERVICE_NOT_CONFIGURED:
        // 面向用户的文案不含环境变量名；运维提示只进日志（见 errorResponse 的 details）
        return { status: 503, code: err.code, message: '模型服务未配置，请联系管理员' };
      case ERROR_CODE.ITEM_NOT_CONFIRMABLE:
        return { status: 422, code: err.code, message: err.message };
      case ERROR_CODE.CAPABILITY_NOT_CONFIRMABLE:
        return { status: 422, code: err.code, message: err.message };
      case ERROR_CODE.FACT_GATE_BLOCKED:
        return { status: 409, code: err.code, message: err.message };
      case ERROR_CODE.RESULT_NOT_EDITABLE:
      case ERROR_CODE.RESULT_HAS_NO_ARTIFACT:
      case ERROR_CODE.RESULT_NOT_TRANSITIONABLE:
      case ERROR_CODE.RESULT_NOT_SUBMITTED:
        return { status: 422, code: err.code, message: err.message };
      case ERROR_CODE.RESULT_DUPLICATE:
        return { status: 409, code: err.code, message: err.message };
      case ERROR_CODE.LEARNING_TASK_NOT_TRANSITIONABLE:
        return { status: 422, code: err.code, message: err.message };
      case ERROR_CODE.LEARNING_TASK_ARCHIVED_EXISTS:
        return { status: 409, code: err.code, message: err.message };
      case ERROR_CODE.PORTFOLIO_ARCHIVED:
        return { status: 409, code: err.code, message: err.message };
      case ERROR_CODE.PORTFOLIO_RESULT_NOT_ELIGIBLE:
        return { status: 422, code: err.code, message: err.message };
      case ERROR_CODE.INTERVIEW_SESSION_ENDED:
        return { status: 409, code: err.code, message: err.message };
      case ERROR_CODE.INTERVIEW_TURN_PENDING:
        return { status: 409, code: err.code, message: err.message };
      case ERROR_CODE.INTERVIEW_TURN_CONFLICT:
        return { status: 409, code: err.code, message: err.message };
      case ERROR_CODE.INTERVIEW_ANSWER_IMMUTABLE:
        return { status: 422, code: err.code, message: err.message };
      // T4-5：Interview strict schema 校验失败（malformed）→ 502。
      // 复用 AI_ANALYSIS_INVALID_RESPONSE 码（ADR-015 C-3 §5），additive case，不改既有语义。
      case ERROR_CODE.AI_ANALYSIS_INVALID_RESPONSE:
        return { status: 502, code: err.code, message: err.message };
      case ERROR_CODE.JD_TOO_SHORT:
        return { status: 422, code: err.code, message: err.message };
      case ERROR_CODE.JD_EMPTY:
        return { status: 422, code: err.code, message: '未能从 JD 中提取出任何要求' };
      case ERROR_CODE.JD_SHAPE_INVALID:
        return { status: 502, code: err.code, message: '解析结果结构异常，请重试' };
      case ERROR_CODE.UPSTREAM_TIMEOUT:
        return { status: 504, code: err.code, message: '解析超时，请重试' };
      case ERROR_CODE.UPSTREAM_ERROR:
        return { status: 502, code: err.code, message: '解析服务暂时不可用' };
      case ERROR_CODE.PERSISTENCE_FAILED:
      case ERROR_CODE.INTERNAL_ERROR:
      default:
        return { status: 500, code: err.code, message: '服务异常，请稍后重试' };
    }
  }

  if (err instanceof ZodError) {
    return {
      status: 400,
      code: ERROR_CODE.VALIDATION_FAILED,
      message: err.issues.map((i) => i.message).join('；') || '请求参数不合法',
    };
  }

  // 领域层错误：长度 / 空结果 / 结构
  if (err instanceof JdTooShortError) {
    return { status: 422, code: ERROR_CODE.JD_TOO_SHORT, message: 'JD 内容过短，请粘贴完整招聘信息' };
  }
  if (err instanceof JdEmptyRequirementsError) {
    return { status: 422, code: ERROR_CODE.JD_EMPTY, message: '未能从 JD 中提取出任何要求' };
  }
  if (err instanceof JdShapeError) {
    return { status: 502, code: ERROR_CODE.JD_SHAPE_INVALID, message: '解析结果结构异常，请重试' };
  }

  if (err instanceof PdfContractError) {
    return { status: 422, code: ERROR_CODE.PDF_CONTENT_INVALID, message: err.message };
  }

  // T2：文件接收/提取错误。消息本身面向用户，不含路径与密钥
  if (err instanceof IntakeError) {
    return { status: 422, code: err.code, message: err.message };
  }
  if (err instanceof ResumeShapeError) {
    return { status: 502, code: err.code, message: '简历解析结果结构异常，请重试' };
  }

  // LLM 层错误
  if (err instanceof LLMError) {
    switch (err.code) {
      case 'FORMAT':
        return { status: 502, code: ERROR_CODE.JD_SHAPE_INVALID, message: '解析结果格式异常，请重试' };
      case 'TIMEOUT':
        return { status: 504, code: ERROR_CODE.UPSTREAM_TIMEOUT, message: '解析超时，请重试' };
      case 'RATE_LIMIT':
        return { status: 429, code: ERROR_CODE.RATE_LIMITED, message: '请求过于频繁，请稍后再试' };
      case 'AUTH':
        return { status: 500, code: ERROR_CODE.INTERNAL_ERROR, message: '服务配置异常，请联系管理员' };
      case 'UPSTREAM':
      default:
        return { status: 502, code: ERROR_CODE.UPSTREAM_ERROR, message: '解析服务暂时不可用' };
    }
  }

  return { status: 500, code: ERROR_CODE.INTERNAL_ERROR, message: '服务异常，请稍后重试' };
}

export function newRequestId(): string {
  return randomUUID();
}
