/**
 * T3-A2-4 Phase 1 —— ActionStep 类型前缀契约（**单一来源**）
 *
 * 现有真实机制（Phase 1 不改变该架构）：
 *   LLM `actions[].type`
 *     → STEP_TYPE_LABEL
 *     → title 折叠为 `[标签] 原标题`
 *     → 前端 parseStepKind 按同一前缀还原类型
 *
 * 本模块只做一件事：把「类型 → 标签 → 前缀」定义成**唯一来源**，
 * 供服务端（`src/http/handlers/action-plans.ts`）与前端（`app/_lib/step-entry.ts`）同时引用，
 * 消除两处手工映射漂移的风险。
 *
 * 约束：
 *   - **纯函数 + 零依赖**（无 zod / 无 node API），因此可以安全地被客户端组件间接引用；
 *   - **不新增字段、不新增枚举列**（ActionStep 仍无 type 列，type 只在标题前缀里）；
 *   - 降级语义**完全沿用既有实现**（见 `resolveStepTypePrefix`），本阶段不重新设计。
 */

/** 允许的步骤类型（与服务端提示词、前端解析三处一致） */
export const STEP_TYPES = ['LEARN', 'PRACTICE', 'PROJECT'] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** 类型 → 中文标签 */
export const STEP_TYPE_LABEL: Record<StepType, string> = {
  LEARN: '学习',
  PRACTICE: '实践',
  PROJECT: '项目',
};

/**
 * 解析用「括号形式」：`[学习]`（**无**尾随空格）。
 * 用于前端 `startsWith` 判定 —— 兼容仅有前缀而无正文的标题（如 `[学习]`）。
 */
export const STEP_TYPE_BRACKET: Record<StepType, string> = {
  LEARN: '[学习]',
  PRACTICE: '[实践]',
  PROJECT: '[项目]',
};

/**
 * 生成用「精确前缀」：`[学习] `（**含一个尾随空格**）。
 * 与服务端折叠格式 `\`[${label}] ${title}\`` 逐字一致。
 */
export const STEP_TYPE_PREFIX: Record<StepType, string> = {
  LEARN: '[学习] ',
  PRACTICE: '[实践] ',
  PROJECT: '[项目] ',
};

/** 严格类型守卫：只接受三个合法常量之一（大小写敏感，调用方负责归一化） */
export function isStepType(value: unknown): value is StepType {
  return typeof value === 'string' && (STEP_TYPES as readonly string[]).includes(value);
}

/**
 * 由 LLM 的 `type` 解析出前缀。
 *
 * **完全沿用既有降级语义**（Phase 1 未重新设计，勿擅自更改）：
 *   - `type` 缺失 / 空串 / 非字符串 → `''`（不加前缀，标题保持原样）
 *   - `type` 非法（三个合法值之外）→ `''`（不加前缀）
 *   - `type` 大小写不敏感（沿用既有 `toUpperCase()`）
 *   - 本函数**不做 trim**（与 Phase 1 前的 `a.type.toUpperCase()` 逐字节一致）
 *
 * ⚠️ 关于「带空白包裹的 type」（端到端事实，勿误解）：
 *   真实链路里 `actionItemSchema.type` 是 `z.string().trim().optional()`，
 *   因此 `' LEARN '` 会在**进入本函数之前**被 zod 归一为 `'LEARN'` → 折叠出 `[学习] `。
 *   即：**端到端「去空白后合法」= 合法**；本函数不 trim 并不构成行为差异，
 *   只是把归一化责任留在上游 schema（不要在纯函数里重复 trim，否则等于改契约）。
 *
 * 说明（加固点，不改变实际可达路径）：既有实现写作 `a.type ? label(...) : ''`，
 * 若 `type` 为非字符串的真值（如数字）会抛 TypeError；此处改为返回 `''`。
 * 该差异在真实 LLM 链路上不可达 —— 非字符串会在结构校验阶段被判为 502，不会走到折叠步骤。
 */
export function resolveStepTypePrefix(type: unknown): string {
  if (typeof type !== 'string' || type.length === 0) return '';
  const key = type.toUpperCase();
  return isStepType(key) ? STEP_TYPE_PREFIX[key] : '';
}

/**
 * 3A 的标题折叠：
 *   - 合法 type → `[标签] 原标题`（精确前缀，含尾随空格）
 *   - 缺失 / 非法 → 标题**原样返回**（不产生任何前缀）
 */
export function applyStepTypePrefix(title: string, type: unknown): string {
  const prefix = resolveStepTypePrefix(type);
  return prefix.length > 0 ? `${prefix}${title}` : title;
}
