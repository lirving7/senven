# T2→T3 桥接阶段 · 数据 / 页面设计（v1）

> 对应验收标准：`t2-t3-bridge-acceptance.md`（v2 已冻结）
> 本文档只做设计，**不含实现**。实现前需你确认 §6 的两个待定项。

---

## 0. 设计总览与一个可验证属性

| 项 | 结论 |
|---|---|
| **Schema 变更** | **无** |
| **Migration** | **0 次** |
| **新增模型 / 表** | **0 个** |
| 新增 API | 桥接-A：0（投影是确认动作的副作用）；桥接-B：0（入口为纯前端） |
| 复用的既有资产 | `Capability`、`CapabilityEvidence`、`ActionPlan`、`ActionStep` |

> "迁移量 = 0" 是本阶段可被机械验证的设计属性，也是"不新增实体"约束的最强证据。

---

## 1. 桥接-A：数据设计（投影）

### 1.1 投影映射表

源：`Skill`（resume 事实条目）+ `Evidence`（事实证据）
目标：`Capability` + `CapabilityEvidence`

| 源 | 目标 | 说明 |
|---|---|---|
| `Skill.key` | `Capability.key` | 幂等键之一（配 `userId`） |
| `Skill.label` | `Capability.label` | |
| `Skill.level`（可空） | `Capability.level` | |
| —（由确认动作决定） | `Capability.status = CONFIRMED` | 且必须通过 1.3 的证据校验 |
| 常量 `RESUME_PROJECTION` | `Capability.source` | 与既有 `MANUAL` 区分，便于按来源审计 |
| `Evidence.excerpt` | `CapabilityEvidence.excerpt` | |
| `Evidence.source`（枚举 → 字符串） | `CapabilityEvidence.source` | 取值 `RESUME_TEXT` / `USER_STATEMENT` / `OCR` / `JD` |
| 常量 `RESUME_EVIDENCE` | `CapabilityEvidence.type` | 标识证据来源类型 |
| — | `CapabilityEvidence.url = null` | 简历证据无 URL |

写入键：`Capability.@@unique([userId, key])`。

### 1.2 幂等实现

以 upsert 语义落库（`where: { userId_key: { userId, key } }`）：
- 不存在 → 创建；
- 已存在 → 更新 `label / level / status`，证据按 `(source, excerpt)` 去重后补齐。

副产品：**同一用户多份简历含同一技能**（`Skill.@@unique([resumeId, key])` 是 resume 作用域）→ 投影到用户作用域时自然收敛为一条 Capability，符合"能力库"语义。

### 1.3 事实安全不变式（可测）

- **不变式 1**：`confirmItem` 只允许 `locator` 与 `excerpt` 均非空的条目转 CONFIRMED → "CONFIRMED Skill 必有可用证据"。
- **不变式 2**：投影**再次独立校验**证据；若无可用证据 → **直接不投影**（fail closed）。这条覆盖"夹具 / 直写 DB 造出 CONFIRMED 但无证据"的例外。
- 推论：投影**不可能**凭空产生 CONFIRMED 事实（对应 **B7.5**）。

### 1.4 触发点设计

| 路径 | 时机 | 作用 |
|---|---|---|
| **主路径** | `PATCH /api/resumes/:id/items/:itemId` 确认成功（→ CONFIRMED）后，在同一请求内调用投影 | 让能力库即时反映确认结果 |
| **兜底 reconcile** | 生成 ActionPlan 之前，补齐"该用户已 CONFIRMED 但缺 Capability 的 Skill" | 无需重构事务边界即可保证 `have` 最终完整 |

失败模式是**安全**的：漏投影只会让 `have` **少**一项（fail closed），绝不会**多**一个假事实。

**为何不做同事务强一致**：`confirmItem` 目前在 `ResumeRepository` 内以 `updateMany` 直写；要纳入同一事务需给它注入 tx client，改动面大于收益，而兜底 reconcile 已同时保证**最终一致**与**事实安全**。

### 1.5 被否决的替代方案（记录理由，避免反复）

| 方案 | 内容 | 否决理由 |
|---|---|---|
| X | 让 `deriveHaveGaps` 直接读 CONFIRMED `Skill`，彻底不写 Capability | 会让 `Capability` / `CapabilityEvidence` 永久成为死表；T3/T4 的"能力库 / 成果回流"没有落点，与"先投影后回流"路线冲突 |
| Y | 同事务强一致投影 | 需重构 `confirmItem` 事务边界；见 1.4 |

### 1.6 不暴露的接口

投影**不提供独立公开写接口** —— 否则用户可手动制造能力事实，绕过事实验证层。若日后需要"重建能力库"，应以**幂等**的运维性质接口提供（见 §6-(3)）。

---

## 2. 桥接-B：页面设计（学习 / 项目入口）

### 2.1 位置与形态

在既有页面 `/action-plans/[id]` 的**每条 ActionStep 上**增加「学习 / 项目入口」区块。**纯前端、零落库、零新增 API。**

类型识别：3A 已把 LLM 的 `type` 折叠进标题前缀（`[学习]` / `[实践]` / `[项目]`），前端据此区分入口形态——**不需要新字段**。

### 2.2 入口内容（全部来自既有数据）

| 展示项 | 数据来源 | 是否新生成 |
|---|---|---|
| 要补的岗位要求 | `ActionStep.targetRequirement` | 否 |
| 建议动作 | `ActionStep.desc` | 否 |
| "下一步做什么"指引 | 前端按类型渲染固定文案（学习：选一门系统课程 + 动手练习；实践：把 desc 的动作做一遍；项目：挑最小可展示的切口） | 否（静态文案） |
| 站外检索入口 | 由 `targetRequirement` 拼接查询链接，新窗口打开 | 否 |

### 2.3 事实安全（对应 B5）

指引文案只描述**"要做什么"**，**不得**出现"你已经掌握 / 你已完成"之类断言。入口是**行动建议**，不是事实陈述。

### 2.4 明确不做

- 不做 LLM 生成的学习路线 / 技术地图 / 项目步骤（T3 主体）
- 不做任务持久化（无 `LearningTask`）
- 不改 `ActionStep`（不加字段）

---

## 3. 验收 → 测试映射

| 验收 | 验证方式 |
|---|---|
| B7.1 / B7.2 / B7.3 / B7.5（投影） | 独立 QA 验收：真实 Prisma；确认一条**带证据**的 Skill → 断言 Capability 出现且带 `CapabilityEvidence`；重复确认 → 不重复；**直写一条 CONFIRMED 但无证据的 Skill** → 断言**不投影** |
| B7.6（可见性） | 投影后生成 ActionPlan，断言 `have` 非空（修复"恒为空"） |
| B7.4（单向） | 断言投影前后 `Skill` 行未变 |
| B1~B4 / B5 / B6 | 沿用 T2 既有验证方式（provider 零调用 / 404·400 / 429 / 状态机 / 文案不越界） |
| B8 | 新增 `tests/qa-t2t3-bridge-acceptance.test.ts`（独立、自带 fake provider） |

回归沿用：`tsc` / `npm test` / `next build` / `qa-release` 49/49 / `smoke-e2e`。

---

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 重复投影导致证据堆积 | upsert + 证据按 `(source, excerpt)` 去重 |
| 确认成功但投影失败 | 兜底 reconcile（§1.4）；失败模式 fail closed |
| 投影把"推断"当"事实" | 只投影 **CONFIRMED** Skill；并对证据做独立校验（§1.3） |
| 入口文案被误解为事实 | 文案只写"要做什么"（§2.3） |

---

## 5. 实施顺序建议（实现阶段用）

1. 投影仓储方法（幂等 upsert + 证据去重 + 证据校验）
2. 接入确认路径（主路径）+ 生成 ActionPlan 前的 reconcile
3. 独立 QA 验收（B7 全部子项）
4. 前端入口区块（B1/B2/B5/B6 相关）
5. 5 项回归门禁

---

## 6. 待你确认（两项）

- **(1)§2.2 的"站外检索入口"是否保留？** 它是纯链接拼接，零风险；若你认为不该引导站外资源，可只保留站内指引文案。
- **(2)§1.4 的兜底 reconcile 是否纳入？** 我建议**纳入**（成本低，且是"投影最终一致 + fail closed"的保证）；若你希望更省，可只做主路径，代价是"确认成功但投影失败的窗口内 `have` 会缺项"。

> §1.6 的运维性质"重建能力库"接口：本阶段**不做**；如你需要，请明确，我再补进设计。
