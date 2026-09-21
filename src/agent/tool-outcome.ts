/**
 * T5-B-2A —— Agent 只读工具层：结果信封与错误映射
 *
 * 错误码**复用既有 `ERROR_CODE`**（T5B-F-47：如需新增码属 Contract Change）：
 *   - 未知工具名 / 输入不合 strict schema / 缺少会话 userId → `VALIDATION_FAILED`
 *   - 跨用户或不存在（统一**无 oracle**，不泄露存在性，T5B-F-17.5）→ `NOT_FOUND`
 *   - 其他不可预期失败 → `INTERNAL_ERROR`（不含任何内部细节回显）
 *
 * 结果信封刻意**不包含** userId、不包含堆栈、不包含输入原文。
 */

import type { ErrorCode } from '../errors.ts';
import type { AgentDataTrust, AgentReadToolName } from './contracts.ts';

/** 适配器层的失败原因（显式化，禁止用异常做控制流） */
export type AgentReadToolFailureReason =
  /** 资源不存在 / 不属于该用户（统一无 oracle，T5B-F-17.5） */
  | 'NOT_FOUND'
  /** `rag_retrieve` 专用：`query` 归一后越界（1–200） */
  | 'INVALID_QUERY';

/** 适配器层返回形态 */
export type AgentReadToolPayload<T> =
  | { ok: true; data: T }
  | { ok: false; reason: AgentReadToolFailureReason };

/** 工具层对外唯一返回形态 */
export type AgentReadToolOutcome =
  | {
      status: 'OK';
      tool: AgentReadToolName;
      layer: string;
      trust: AgentDataTrust;
      /** 结构性声明：本层全部只读（T5B-F-18） */
      readOnly: true;
      data: unknown;
    }
  | { status: 'UNKNOWN_TOOL'; tool: string; code: ErrorCode; message: string }
  | { status: 'INVALID_INPUT'; tool: AgentReadToolName; code: ErrorCode; issues: string[] }
  | { status: 'NOT_FOUND'; tool: AgentReadToolName; code: ErrorCode }
  | { status: 'FAILED'; tool: AgentReadToolName; code: ErrorCode };
