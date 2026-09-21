# T3 Data Model Design v1.1

> **状态**：**v1.1 — FINAL ACCEPTED**（T3-A0 收口，Codex 裁决 Q5）
> **依据**：T3 Architecture Freeze v1.1（FINAL ACCEPTED）＋ **Codex T3 DMD 正式裁决**（含 v1.1 补齐项）
> **版本对应**：上一轮交付的「Rev.2（Codex 裁决落实版）」属 **v1 系**；本次修订产出 **v1.1**。
> **层级边界**：本文档处于 **Data Model Design 层**。**文档成文时**未修改 `schema.prisma`、未创建 migration、未改代码。
> **T3-A0 收口后状态更新（2026-09-18）**：`ProjectResult` / `ResultArtifact` / `CapabilityEvidence`（含双 CHECK）相关结构已**实际写入 `schema.prisma` 并随 migration 落地**（见 migration #5 / #6 / #7 / #8）。
> **本文档不包含任何由本助手作出的架构裁决** —— 全部裁决来自 Codex，本文按其决定落实。

---

## 修订记录

### Rev.1 → Rev.2（Codex 裁决落实）

| # | 修订项 | 对应 Codex 裁决 | 涉及章节 |
|---|---|---|---|
| 1 | ProjectResult ↔ ActionStep 绑定改称并定义为「**逻辑强绑定 + 历史快照绑定**」（不再是数据库级 FK）；补 4 条硬不变量与 `sourceStepId` 的语义边界 | **R1** | §2、§1.3 |
| 2 | ProjectResult 幂等改为**数据库级唯一约束** `@@unique([userId, planId, sourceStepId, contentFingerprint])`；明确指纹确定性要求 | **BLOCKER D3**、**R2** | §7.1、§7.2、§1.4 |
| 3 | 新增「**凭据存在 ≠ 可验证证据**」定义；excerpt-only 不得单独满足 I1；产生 Candidate 需 ≥1 个可验证 Artifact | **R4** | §3.2、§3.4 |
| 4 | 新增「**Artifact existence ≠ Artifact ownership**」；不得从 URL 自动推断归属 | **R4（第四项）** | §3.5 |
| 5 | CapabilityEvidence 来源指回的删除语义由 `SetNull` 改为 **Restrict / source immutable**；补 **exactly-one-source** 与 **type↔pointer 一致** | **R3**、**R6**、**R7** | §4.3、§10 |
| 6 | 新增「**来源隔离写入不变量**」（各来源只能增删改自己拥有的 CapabilityEvidence；现有 C1 `deleteMany({})` 与 D5/I5 冲突，未来实现须改为 source-scoped reconciliation） | **BLOCKER D1** | §4.4 |
| 7 | 新增「**Capability key normalization contract**」（独立于 Match）；正式接受 `.net≠net`、`Node.js≠NodeJS`、`C#=C＃`、`C++=c++`；明确优先避免 false merge | **BLOCKER D2** | §6 |
| 8 | 补 level 规则：`CONFIRMED` 的 level 不得被未经用户确认的新来源静默覆盖；新来源只能追加证据 | **R5** | §8.3、§8.5 |
| 9 | 明确实体范围仅 `ProjectResult` + `ResultArtifact`；不新增第三个业务实体；`KnowledgeGap` / `CareerGoal` 删除 | **裁决 8** | §10 |
| 10 | 移除 Rev.1 中由本助手撰写的"建议 / 推荐 / blocker 定级"表述，改为落实 Codex 裁决 | — | 全文 |

> **治理指针（2026-09-18 · 限定范围修订）**：上表第 9 项（实体范围仅 `ProjectResult` + `ResultArtifact`）在 **T3 v1 阶段**继续成立；自 **T3 后续 band** 起，该范围被 **`ADR-T3-A2-5`（`JobPilot_ADR_T3-A2-5_LearningTask.md`）限定修订** —— `LearningTask` 作为**受控增量实体**进入 T3 后续 band。**本行为指针注记，不重写历史正文，不推翻原裁决语义。**

### Rev.2 → v1.1（本次修订）

| # | v1.1 修订项 | 对应指令 | 涉及章节 |
|---|---|---|---|
| 1 | 绑定术语补「**创建时**强绑定」限定 → 「创建时强绑定 + 历史快照绑定」 | 指令 1 | §1.3、§2.1 |
| 2 | **新增 ProjectResult 生命周期 invariant**：Draft / Submitted / Revoked 三态定义 + INV-L1~L4（revoked 不可恢复 / revoked 的未确认 Candidate 不得继续确认 / 已 CONFIRMED 不因 revoke 回收 / revoke 不删凭据） | 指令 10 | §1.2 |
| 3 | **明确 T3 v1 不进行 `Capability.level` 自动合并**（此前仅表述"算法延期"，现明确"不做自动合并"） | 指令 7 | §8.4 |
| 4 | 「可验证证据」措辞统一为「**可重新定位 / 可访问**」 | 指令 8 | §3.2、§3.4 |
| 5 | 新增 **DECISION REQUEST DR-1**（多来源部分撤销时 INV-L2 的适用边界） | 指令 10 引发的边界 | §12.2 |
| 6 | 指令 2 / 3 / 4 / 5 / 6 / 9 / 11 / 12 经逐条核对，**已在 Rev.2 落实**，本次不重复改动 | 指令 2~6、9、11、12 | 见 §0 对照表 |
| 7 | **落实 Codex 裁决 DMD-DR1**：§12.2 由「待裁决」改为「**Codex 已裁决**」并补三种情形与概念分离；据此**精化 INV-L2**、**新增 INV-L5** | **Codex DECISION DMD-DR1** | §12.2、§1.2 |
| 8 | **新增 DR-2**（`ActionPlan` 删除语义 `Cascade` 与来源指针 `Restrict` 的潜在冲突）登记为**待裁决** | 上一轮只读核对 | §12.3（已随第 9 项关闭） |
| 9 | **落实 Codex 裁决 DMD-DR2**：`ProjectResult.planId` 由 `Cascade` 改为 **`Restrict`**；§2.4 同步为「存在 ProjectResult 时不可删除 / 不得静默级联删除」并补最终关系语义与业务语义；DR-2 由「待裁决」改为「**Codex 已裁决**」，§12.3 待裁决项清空 | **Codex DECISION DMD-DR2** | §1.4、§2.4、§12.2、§12.3 |

---

## 0. Codex 裁决落实对照

| 审查发现（Rev.1 提出） | Codex 裁决 | 落实位置 |
|---|---|---|
| **F1**：`ProjectResult → ActionStep` 硬 FK 与 regenerate（`repositories.ts:1099` 的 `deleteMany`）冲突 | 「逻辑强绑定 + 历史快照绑定」；**不是**数据库级 FK | §1.3、§2 |
| **幂等**：`find → create` 不能保证并发幂等 | 采用 **数据库级唯一约束**；指纹必须确定性 | §7.1、§7.2 |
| **F3**：存在两套"可用证据"判定（`repositories.ts:835` 与 `:883`） | 拆分「凭据存在」与「可验证证据」；明确门槛 | §3.2、§3.4 |
| **F2 / provenance**：`SetNull` 会造成 provenance 静默断裂 | 改 **Restrict / source immutable**；撤销用软撤销 | §4.3、§1.2 |
| **F4**：候选与已确认共行；投影写 `level` 时**不检查 status**（`repositories.ts:962-972`） | 共行保留；**已确认 level 不得被静默覆盖** | §8 |
| **F5**：`normalizeForMatch` 实测产生 false merge（`.net`→`net`）与 false split（`C#` vs `C＃`） | 独立 normalization contract；**优先避免 false merge** | §6 |
| **CapabilityEvidence**：无任何来源指针字段；`repositories.ts:970` 存在**无过滤** `deleteMany({})` | 新增来源指回；**exactly-one-source**；**来源隔离写入不变量** | §4.3、§4.4 |

---

## 1. ProjectResult

### 1.1 实体职责

**`ProjectResult` = 用户围绕某一个 ActionStep 实际产出、且可提供凭据的成果。**

它是 T3 事实回流的**入口实体**与**证据锚点**，也是 provenance 链的中间节点。

| 属于 Result | 不属于 Result（各自归属） |
|---|---|
| 用户对产出的描述（做了什么 / 产出是什么） | **计划中的项目** → `ActionStep`（尚未产出） |
| 该产出的**凭据**（见 §3） | **简历里的项目经历** → `ResumeProject` |
| 由它派生的**候选能力**（经用户确认后成为事实） | **学习过程记录** → 未来 `LearningTask`（T3 后续） |
| 与来源步骤的归属关系 | **作品集编排** → T4 `Portfolio` |

### 1.2 生命周期语义

```
  用户从某个 ActionStep 创建                     用户显式提交（D3：唯一触发）
        │                                                  │
        ▼                                                  ▼
   ┌─────────┐   提交    ┌───────────┐   AI 分析   ┌──────────────────┐
   │  草稿   │ ────────→ │  已提交   │ ──────────→ │  候选能力          │
   │ (未提交)│           │           │             │ (UNCONFIRMED)     │
   └─────────┘           └───────────┘             └──────────────────┘
                              │                              │
                              │ 用户撤销                      │ 用户显式确认
                              ▼                              ▼
                        ┌───────────┐                 ┌──────────────┐
                        │  已撤销   │                 │  CONFIRMED   │
                        │ (软撤销)  │                 │  Capability  │
                        └───────────┘                 └──────────────┘
                          ● 不删除凭据                   ● 不随撤销回收
```

**规则**：
- **草稿不触发 AI 分析**；只有"已提交"进入回流。
- **撤销采用软撤销**（`revokedAt`）。**来源可以被撤销，但不能被静默抹掉** —— 因此不以 `DELETE` 表达撤销。
- 撤销后 provenance 仍可解释「该能力曾由某成果支撑，该成果已被用户撤销」。

**状态定义（三态）**：

| 状态 | 判定条件 | 允许的动作 |
|---|---|---|
| **Draft** | `submittedAt == null` 且 `revokedAt == null` | 可编辑；**不触发 AI 分析**；不产生任何事实 |
| **Submitted** | `submittedAt != null` 且 `revokedAt == null` | 只读（快照不可改，§2.2 R-F1-3）；可撤销；可触发 AI 分析并产生 Candidate |
| **Revoked** | `revokedAt != null` | 只读；**不可恢复**；不产生新的 Candidate |

**生命周期 invariant**：

| 编号 | 不变量 |
|---|---|
| **INV-L1** | 三态关系为 **Draft → Submitted → Revoked**；**`Revoked` 为终态，不可恢复**（不得回退至 Draft 或 Submitted） |
| **INV-L2** | **`Revoked` 来源不再构成当前确认的有效依据。** 但「部分来源被 revoke」**不自动使 Candidate 失效** —— Candidate 是否仍可确认，取决于**是否仍存在至少一个未撤销、且满足证据门槛的有效来源**；**全部有效来源均被 revoke → 不得确认**（见 §12.2 **DMD-DR1**） |
| **INV-L3** | **已被 `CONFIRMED` 的 Capability 不因 revoke 而回收**（撤销来源 ≠ 事实消失） |
| **INV-L4** | `Revoked` **不删除** `ResultArtifact`（来源不可被静默抹掉，§4.3） |
| **INV-L5** | `Revoked` 来源的 `ResultArtifact` / `CapabilityEvidence` **不被删除** —— 可继续作为**历史 provenance**，但**不得作为当前 Candidate confirmation 的有效依据**（历史事实 ≠ 当前确认资格） |

> INV-L2 / INV-L5 的完整语义见 §12.2 **Codex 已裁决 DMD-DR1**。

### 1.3 与 ActionStep 的关系（Codex 裁决 R1）

> **本产物与 ActionStep 的关系定义为：创建时强绑定 + 历史快照绑定（logical strong binding at creation / historical snapshot binding）。**
> **不是**数据库级 `ActionStep` 外键。

保留：

```
planId                          （FK，稳定）
sourceStepId                    （非 FK，值保存）
sourceStepTitle                  （快照）
sourceStepTargetRequirement      （快照）
```

**必须明确写入的语义**：

| # | 语义 |
|---|---|
| a | Result 创建时，`sourceStepId` **必须属于** `planId` |
| b | Result 创建时，`planId` **必须属于** 当前 `userId` |
| c | 快照在创建时**从真实 ActionStep 固化** |
| d | 提交后**快照不可修改** |
| e | regenerate 后**不得重新绑定**旧 Result |
| f | regenerate 后 `sourceStepId` **允许悬空** |
| g | regenerate 后 provenance 的**权威解释依赖快照** |
| h | `sourceStepId` **不得作为 FK join 使用** |

**结构依据（FACT）**：`replacePlanContent` 在 `repositories.ts:1099` 执行 `actionStep.deleteMany({ where: { planId } })` 后以 `createMany` 重建且**不传 `id`**（`1105-1113`），而 `ActionStep.id` 为 `@default(cuid())`（`schema.prisma:431`）→ **每次 regenerate 全部 step id 变化**。`ActionPlan` 行则从不被删除（regenerate 只 `update`，`1100-1103`）→ `planId` 稳定。

### 1.4 字段与约束（设计）

| 字段 | 语义 | 约束 |
|---|---|---|
| `id` | 主键 | — |
| `userId` | 归属 | FK → `User`，`Cascade`；`@@index` |
| `planId` | 稳定归属（regenerate 不删 plan） | FK → `ActionPlan`，**`Restrict`**（等价不可删除语义；见 §2.4 与 §12.2 **DMD-DR2**） |
| `sourceStepId` | 来源步骤（**值保存，非 FK**） | 必填；`@@index` |
| `sourceStepTitle` | 来源步骤标题**快照** | 必填；创建后不可修改 |
| `sourceStepTargetRequirement` | 来源步骤对应岗位要求**快照** | 可空；创建后不可修改 |
| `title` | 成果名称 | 必填 |
| `summary` | 产出描述 | 必填 |
| `contentFingerprint` | 确定性内容指纹（见 §7.2） | 必填；参与复合唯一 |
| `createdAt` | 创建时间 | 默认 now |
| `submittedAt` | 提交时间；**null = 草稿** | 可空；`@@index([userId, submittedAt])` |
| `revokedAt` | 撤销时间；null = 有效 | 可空 |

**唯一约束（Codex 裁决 BLOCKER D3）**：

```
@@unique([userId, planId, sourceStepId, contentFingerprint])
```

- **允许**：同一 ActionStep + 不同 fingerprint → 多个 Result
- **禁止**：同一 user + plan + sourceStep + fingerprint → 多个 Result

---

## 2. 强绑定：术语与硬不变量

### 2.1 术语（Codex 裁决 R1）

| 术语 | 含义 |
|---|---|
| **创建时强绑定** | 创建时 `ProjectResult` **恰好**对应一个**真实存在**的 `ActionStep`；不可为空、不可多来源 |
| **历史快照绑定** | 该对应关系以**快照**形式固化，成为 regenerate 之后可解释、不可改写的权威历史上下文 |
| **不是**数据库级 FK | 不建立 `ProjectResult → ActionStep` 的外键（原因见 §1.3 结构依据） |

**为何此定义不违反 D6-a**：D6-a 的核心是「Project Result 必须能明确追溯到**它产生时的那个唯一 ActionStep**」，**而非**要求该 ActionStep 永久存在。

### 2.2 硬不变量（Codex 裁决 R1，编号 R-F1-1 ~ R-F1-4）

| 编号 | 不变量 |
|---|---|
| **R-F1-1** | 创建 Result 时：`sourceStepId` 必须属于 `planId` |
| **R-F1-2** | 创建 Result 时：`planId` 必须属于当前 `userId` |
| **R-F1-3** | `sourceStepTitle` / `sourceStepTargetRequirement` 在创建时从真实 ActionStep 快照，**提交后不可修改** |
| **R-F1-4** | regenerate 后：**不得**重新绑定、迁移或解释旧 `sourceStepId` |

### 2.3 `sourceStepId` 的语义边界

> **`sourceStepId` 是历史线索，不是可解析 FK；snapshot 是 regenerate 后的权威历史上下文。**

推论（实现时须遵守）：
- 不得以 `sourceStepId` 做 join / 关联查询以获取步骤详情
- provenance 的展示与解释以**快照**为准
- `sourceStepId` 悬空是**预期状态**，不是数据错误

### 2.4 删除 / 失效 / 重复提交原则

| 场景 | 原则 | 依据 |
|---|---|---|
| regenerate 替换 steps | 成果**不受影响**（无 DB FK，且 plan 稳定） | §1.3、§2.1 |
| `ActionPlan` 被删除（**存在** ProjectResult 时） | **删除必须被阻止** —— `ProjectResult.planId` 为 **`Restrict`**；**不允许通过删除 ActionPlan 级联删除 ProjectResult**（裁决 **DMD-DR2**） | 历史 provenance 不得因 ActionPlan 删除而静默消失 |
| `ActionPlan` 被删除（**无** ProjectResult 时） | 可正常删除（若系统未来提供删除能力） | `Restrict` 仅在存在引用时阻断 |
| 重复提交同一成果 | 命中复合唯一约束 → 幂等（§7） | BLOCKER D3 |
| 同一步骤提交多个**不同**成果 | **允许** | 指纹不同 |
| 用户撤销成果 | **软撤销**（`revokedAt`）；凭据保留；已确认能力不回收 | 裁决 R3 |
| 步骤被 regenerate 替换后 | 以**快照**解释当时上下文 | §2.3 |

**业务语义补充（裁决 DMD-DR2）**：

- `ProjectResult` 应通过 **`Revoked`** 表达业务撤销，**而不是通过删除消除历史**（§1.2 三态）。
- **最终关系语义**：

```
ActionPlan
   │  Restrict
   ▼
ProjectResult
   │  Cascade
   ▼
ResultArtifact
```

---

## 3. ResultArtifact 与「可验证证据」

### 3.1 与 Project Result 的关系

`ProjectResult` **1 : N** `ResultArtifact`；提交时**至少 1 条**。

### 3.2 凭据存在 ≠ 可验证证据（Codex 裁决 R4）

> **必须严格区分两个概念。**

| 概念 | 定义 |
|---|---|
| **凭据存在**（Artifact existence） | `ResultArtifact` 行存在，且 `url` 或 `excerpt` 有值 |
| **可验证证据**（Verifiable evidence） | 至少存在**一个可重新定位 / 可访问的 artifact**（URL / 稳定存储对象定位）—— 即「存在性」与「可核验性」在此统一 |

**规则**：

| # | 规则 |
|---|---|
| 1 | `ResultArtifact` **可以保存** `url` 与 `excerpt`，**也允许 excerpt-only** 作为用户提交材料 |
| 2 | **excerpt-only 不得单独满足 I1 的"可核验证据"要求** |
| 3 | **产生 Candidate Capability 至少需要存在一个「可验证 Artifact」（可重新定位 / 可访问）** |
| 4 | `CONFIRMED` 仍须满足：**用户显式确认** ＋ **可核验证据**（Architecture Freeze I1 不变） |
| 5 | Candidate 恒为 `UNCONFIRMED` |

**结构依据（FACT）**：当前仓库同时存在两套判定 —— `repositories.ts:835`（`locator` 与 `excerpt` **都**非空）与 `repositories.ts:883`（`url` **或** `excerpt` 任一非空）；现有 DMD 不得沿用模糊表述。

### 3.3 字段与约束（设计）

| 字段 | 语义 | 约束 |
|---|---|---|
| `id` | 主键 | — |
| `resultId` | 所属成果 | FK → `ProjectResult`，`Cascade`；`@@index` |
| `kind` | 凭据类型：`REPO` / `DEPLOY` / `DOC` / `SCREENSHOT` / `OTHER` | 必填 |
| `url` | 外部凭据链接 | 可空 |
| `excerpt` | 自述 / 摘录 | 可空 |
| `dedupeKey` | 去重键（服务端算） | 必填；`@@unique([resultId, dedupeKey])` |
| `createdAt` | 创建时间 | 默认 now |

### 3.4 证据门槛

```
Candidate Capability 的产生
        ↓
要求：≥ 1 个「可验证 Artifact」（可重新定位 / 可访问）

CONFIRMED Capability
        ↓
要求：用户显式确认 ＋ 可核验证据（I1）
```

### 3.5 Artifact existence ≠ Artifact ownership（Codex 裁决 R4）

> **不得从 URL 自动推断"这是用户本人完成的"。**

T3 v1 可验证的是「**存在可访问的成果凭据**」；**不能**凭 URL 认定归属。
因此 AI 分析**最多**产生 `Candidate Capability`（`UNCONFIRMED`）；最终须经**用户确认 + 可核验证据**才为 `CONFIRMED`。

### 3.6 证据追加原则

- **Append-only**：已提交凭据只增不减。
- 同一条凭据重复提交 → 命中 `@@unique([resultId, dedupeKey])` → 不产生重复行。
- **撤销成果不删除凭据**（§1.2）。

---

## 4. Capability 多来源 Provenance

### 4.1 来源总表

| 来源路 | 触发 | 原始凭据载体 | `CapabilityEvidence.type` |
|---|---|---|---|
| **Resume Projection**（C1/C2） | 简历事实确认 → 投影 | `Evidence` | `RESUME_EVIDENCE` |
| **Project Result Return**（T3 新增） | 提交成果 → AI 分析 → 用户确认 | `ResultArtifact` | `PROJECT_RESULT_EVIDENCE` |

### 4.2 同一 `(userId, key)` 收敛

```
Resume Projection ──┐
                    ├──→  同一 Capability 行 (userId, key)
Project Result  ────┘            │
                                 ├── CapabilityEvidence ← 来源：简历证据
                                 └── CapabilityEvidence ← 来源：成果凭据
```

### 4.3 来源指回字段（Codex 裁决 R3 / R6 / R7）

`CapabilityEvidence` **新增**：

| 新增字段 | 指向 |
|---|---|
| `resumeEvidenceId?` | `Evidence` |
| `resultArtifactId?` | `ResultArtifact` |

**删除语义（裁决 R3）**：采用 **Restrict / source immutable**。

> **不使用 `SetNull` 作为正常删除语义。** 来源侧"可以被撤销，但不能被静默抹掉"（§1.2）。

**exactly-one-source（裁决 R6）**：每一条 `CapabilityEvidence` **必须恰好对应一个来源**：

```
合法 A：  resumeEvidenceId != null  AND  resultArtifactId == null
合法 B：  resumeEvidenceId == null  AND  resultArtifactId != null

禁止  ：  resumeEvidenceId == null  AND  resultArtifactId == null
禁止  ：  resumeEvidenceId != null  AND  resultArtifactId != null
```

**type 与 pointer 一致（裁决 R7）**：

```
type = RESUME_EVIDENCE          ⟺  resumeEvidenceId != null
type = PROJECT_RESULT_EVIDENCE  ⟺  resultArtifactId != null
```

**不得出现 type 与 pointer 不一致。**

### 4.4 来源隔离写入不变量（Codex 裁决 BLOCKER D1）

> **各来源只能创建 / 更新 / 删除自己拥有的 `CapabilityEvidence`。**

```
Resume Projection      → 只能增删改 RESUME_PROJECTION 自己拥有的 Evidence
Project Result Return  → 只能增删改 PROJECT_RESULT 自己拥有的 Evidence
```

**任何来源不得清理其他来源的 `CapabilityEvidence`。**

**结构依据（FACT）**：`repositories.ts:970` 现为

```ts
evidence: { deleteMany: {}, create: projection.evidence },
```

其中 `deleteMany: {}` **无 where 过滤**，作用域是该 `Capability` 的**全部** `CapabilityEvidence` 行；而同一语句随后只重建**简历投影**那一批。由于 C1 投影会在**每次 confirm（C2）**与**每次生成 ActionPlan（C3 reconcile）**时执行，其他来源的证据行会落入该语句的作用域。

> **现有行为与 T3 的 D5 / I5 冲突，因此未来实现必须改为 source-scoped reconciliation。**
> **本轮不修改代码**（本轮只改本文档）。

### 4.5 `Capability.source` 的定位

多来源由 `CapabilityEvidence` 的来源指针表达。
`Capability.source` 的存储形态仍按 **Architecture Freeze 延期**至 Schema 阶段；**不作为多来源的唯一判据**。

### 4.6 T3-A ProjectResult 与 Capability 投影的边界（Codex 裁决 C11 / O-5）

> **硬约束（冻结设计）**：**T3-A ProjectResult 创建、提交及生命周期管理不得复用 `projectConfirmedSkills` 来创建 Capability/Skill，也不得绕过 Capability confirmation 流程。**

- T3-A 的 Project Result 回流（`ProjectResult` / `ResultArtifact`）使用**独立投影路径**；`projectConfirmedSkills` 仅服务于既有 **Resume Evidence → CapabilityEvidence** 的历史投影（DMD-S5 / Scope A）。**两者不得互相调用或复用。**
- Project Result 产生的候选事实一律落 `UNCONFIRMED`；`CONFIRMED` 仍**只能由用户显式确认**产生（延续 D4 铁律），**不得**由 ProjectResult 的创建 / 提交 / 生命周期动作直接或间接产生。
- 越界判定：任何实现（Repository / Domain / Handler / Route）**不得**以 ProjectResult 为由调用 `projectConfirmedSkills`，或跳过 confirmation 直接写 `Capability.status = CONFIRMED` / 写 `Skill`。

---

## 5. `(userId, key)` 收敛规则

### 5.1 视为同一 Capability

同一 `userId` 且同一**规范化 `key`**（契约见 §6）→ **同一行**（由 `@@unique([userId, key])` 强制）。

### 5.2 不能合并

| 场景 | 是否合并 | 依据 |
|---|---|---|
| 不同用户同名技能 | **不合并** | `userId` 属键 |
| 同一技术熟练度不同 | **合并**（同一行，`level` 表达程度） | — |
| 规范化后同形但语义不同 | **不合并** | 由 §6 契约避免 false merge |
| 来源不同（简历 vs 成果） | **合并** | §4.2 |

### 5.3 多来源多证据共同支撑

- 一个 `Capability` : **N 条** `CapabilityEvidence`（各自 exactly-one-source，§4.3）。
- **状态只升不降**（§8.2）。

---

## 6. Capability key normalization contract（Codex 裁决 BLOCKER D2）

> **Capability key 使用独立于 Match 的 normalization contract。**

### 6.1 契约（7 条）

```
1. Unicode NFKC
2. 大小写统一
3. 去首尾空白
4. 规范连续空白
5. 保留技术标识符中的 . + #
6. 不使用 normalizeForMatch
7. 不执行 Match 专用的"删除标点"规则
```

### 6.2 正式接受的行为

| 输入 | T3 Capability Key |
|---|---|
| `.net` | `.net` |
| `net` | `net` |
| `C#` | `c#` |
| `C＃` | `c#` |
| `C++` | `c++` |
| `Node.js` | `node.js` |
| `NodeJS` | `nodejs` |

即正式接受：`.net ≠ net`、`Node.js ≠ NodeJS`、`C# = C＃`、`C++ = c++`。

### 6.3 取舍原则

> **T3 v1 优先避免 false merge。**

理由：false split 可以后续通过别名 / 语义层处理；**false merge 会直接把两个不同事实压进同一个 Capability**。

### 6.4 与既有实现的关系（FACT）

`normalizeForMatch`（`src/domain/jd/preprocess.ts:54-59`）会删除 `.` 等标点。当前 `Capability.key` **继承**该规则：`Skill.key = normalizeForMatch(title)`（`repositories.ts:693`）→ C1 投影直接复制 `skill.key`（`project.ts:75`）。
**实测**：`.net` → `net`（与字面 `net` 同值）；`C#` → `c#` 而全角 `C＃` → `c＃`（不同值）。

> Capability normalization **≠** Match normalization，二者继续独立。

### 6.5 延期项

`Node.js` / `NodeJS` 的**语义别名**问题**不在本次 schema 设计中解决**。

### 6.6 全 writer enforcement（T3-A2-3 补充，2026-09-18）

> **本节为 A2-3 追加的补充说明，不修改 §6.1–§6.5 的任何既有规则，也不改写上文历史。**

A2-3 确立：**所有真正写入 `Capability` 的 writer 都必须遵守 §6.1 契约**，并在**写边界**强制（复用 `src/domain/capability/key.ts`，不新增归一化实现）。

| Writer | 处置 |
|---|---|
| A2-1 回流声明（`declareFromProjectArtifact`） | 写边界 `validateCapabilityKey`；非法 → 400 `VALIDATION_FAILED`，零写入（**定点契约收紧**） |
| A2-2 AI 建议层（`analyze-project.ts`） | 已合格，**A2-3 不修改** |
| Resume Projection（`projectConfirmedSkills`） | 写边界 `validateCapabilityKey`；不可归一的源条目 → 跳过（fail closed） |

**规则域独立性（重申）**：`normalizeForMatch`（Match）与 `normalizeFingerprintText`（Q8 指纹）**均不得**用于 `Capability.key`。
详见 `docs/t3-a2-3-capability-key-contract.md`。

---

## 7. 幂等边界

### 7.1 ProjectResult 幂等（Codex 裁决 BLOCKER D3）

**必须采用数据库级唯一约束**：

```
@@unique([userId, planId, sourceStepId, contentFingerprint])
```

| 情形 | 结果 |
|---|---|
| 同一 ActionStep + 不同 fingerprint | **允许多个 Result** |
| 同一 user + plan + sourceStep + fingerprint | **禁止重复** |

**结构依据（FACT）**：`.upsert(` 在全仓库**零使用**；现有去重为「非唯一索引 + 先查后建」（`schema.prisma:213` + `repositories.ts:217-223`）与「`findUnique` + create/update」（`repositories.ts:920-972`），二者均非原子。

### 7.2 指纹确定性（Codex 裁决 R2）

`contentFingerprint` **必须完全由用户提交内容的确定性规范化结果产生**，**不得包含**：

```
时间 / 随机数 / UUID / createdAt
```

### 7.3 其余幂等边界

| 场景 | 策略 |
|---|---|
| ResultArtifact 重复提交 | `@@unique([resultId, dedupeKey])` |
| Candidate Capability 重复产生 | 与已确认共用同一行（§8.1），受 `@@unique([userId,key])` 保护 |
| Confirm 后重复处理 | 只追加证据，不新建行 |
| 两路来源同时命中 | 各自追加自己的证据，来源不覆盖（§4.4） |
| reconcile 与回流并发 | 均为幂等 upsert；source-scoped（§4.4） |

---

## 8. Capability 状态与 level 规则

### 8.1 共行（Codex 裁决 R5）

保留 `@@unique([userId, key])`；**Candidate 与 Confirmed 共用同一 `Capability` row**。

### 8.2 status 迁移

```
只允许：  UNCONFIRMED → CONFIRMED
不允许：  静默 downgrade
```

**结构依据（FACT）**：`confirm`（`repositories.ts:876-887`）仅 `updateMany({ data: { status: 'CONFIRMED' } })`；全仓库无任何代码可写入 `INFERRED` / `UNCONFIRMED` / `MISSING`。

### 8.3 level 规则（Codex 裁决 R5）

| 情形 | 规则 |
|---|---|
| `UNCONFIRMED` Capability | 可以保存候选 / 暂定 level |
| `CONFIRMED` Capability | **未经用户确认，不得被新来源静默降低或覆盖** |

**结构依据（FACT）**：`repositories.ts:962-972` 的更新分支会写入 `level`，且**不读取该行当前 `status`**。

### 8.4 T3 v1 不做 level 自动合并

**T3 v1 明确不进行 `Capability.level` 的自动合并** —— 任何来源的写入**都不得自动计算并合并出一个 level 去覆盖既有值**。

| 规则 | 内容 |
|---|---|
| **L-1** | **T3 v1 不进行 level 自动合并**（不做「取最高 / 取最新 / 取综合」） |
| **L-2** | `CONFIRMED` Capability 的 `level` **不得被新来源静默覆盖**（§8.3） |
| **L-3** | 新来源只能**追加证据**（§8.5） |
| **L-4** | **level comparison / 合并算法延后 T3+**（延期项） |

### 8.5 新来源的行为约束

**新来源只能追加证据**；`level` 的变更须符合 §8.3。

---

## 9. KnowledgeGap / CareerGoal 清理

| 检查 | 结果（FACT） |
|---|---|
| `src` 引用 | **0 处** |
| `app` 引用 | **0 处** |
| 仅存在位置 | `prisma/schema.prisma`（模型 + `User` 反向关系字段）与 2 个 migration（`..._init`、`..._v2_capability`） |
| 被其他表外键引用 | **无**（仅被 `User` 反向引用） |

**裁决（Codex 裁决 8）**：**删除** `KnowledgeGap` 与 `CareerGoal`（及 `User` 上对应反向关系）。
**边界**：删除属 **T3 实施阶段**（Schema Design → Migration），**不在本轮**，**本文档不修改 `schema.prisma`**。

---

## 10. T3 v1 Schema Scope

### ✅ A. 必须新增 / 调整

| 对象 | 变更 |
|---|---|
| **`ProjectResult`** | 新增实体（§1.4；含复合唯一约束） |
| **`ResultArtifact`** | 新增实体（§3.3） |
| **`CapabilityEvidence`** | 新增 `resumeEvidenceId?` / `resultArtifactId?`（**Restrict / source immutable**；exactly-one-source；type↔pointer 一致） |
| **`ActionPlan`** | 新增反向关系（不改字段） |
| **`User`** | 新增反向关系；并移除待删表的两条反向关系 |
| **`Evidence`** | 新增反向关系（不改字段） |

**实体范围（Codex 裁决 8）**：仅 `ProjectResult` + `ResultArtifact`。**不新增第三个业务实体。**

> **治理指针（2026-09-18 · 限定范围修订）**：本处实体范围在 **T3 v1 阶段**继续成立；自 **T3 后续 band** 起，被 **`ADR-T3-A2-5`** 限定修订 —— `LearningTask` 作为**受控增量实体**进入 T3 后续 band（仅 `t3-architecture-freeze.md:174` 轻量语义）。**本行为指针注记，不重写历史正文，不推翻原裁决语义。**

### ❌ B. 必须删除

`KnowledgeGap`、`CareerGoal`（含 `User` 上两条反向关系）。

### ⛔ C. 明确不动

| 对象 | 原因 |
|---|---|
| `Skill` / `Resume` / `ResumeProject` / `Education` / `Experience` | V1 事实层；T3 不回写（I6） |
| `Evidence`（字段） / `JobDescription` / `JobRequirement` / `MatchRun` / `MatchItem` | Match 输入源不变 |
| `ActionStep`（字段） | 不改字段；`DONE ≠ Fact` 已固化（I2） |
| `Capability` 的 `@@unique([userId, key])` | 收敛规则核心（§5） |
| `Session` / `ResumeSuggestion` / `ResumeVersion` / `JobApplication` / `LlmUsage` / `FactFlag` | 与 T3 无关 |

### 🕐 D. T3+ 延期

| 项 | 去向 |
|---|---|
| Match 输入源升级为 `Capability` | T3+ 独立决策 |
| 独立于 ActionStep 的成果回流 | T3+ |
| **level comparison algorithm** | 延期（§8.4） |
| **`Node.js` / `NodeJS` 语义别名** | 延期（§6.5） |
| `Capability.source` 的存储形态 | Schema 阶段 |
| `LearningTask` / 学习路线 / 技术地图 | T3 后续 |
| `Portfolio` / 模拟面试 | T4 |
| 知识库 / RAG / Agent | T5 |
| 端侧 LLM / Android | T6 |

---

## 11. 审查前自检

| # | 自检项 | 结果 |
|---|---|---|
| 1 | 是否只修改 `docs/t3-data-model-design-v1.md`？ | 待本轮结束时核对 |
| 2 | 是否修改 `schema.prisma`？ | **否** |
| 3 | 是否创建 migration？ | **否** |
| 4 | 是否修改 `src` / `tests` / 配置？ | **否** |
| 5 | 是否启动服务？ | **否** |
| 6 | 是否新增业务实体？ | **否**（仅 `ProjectResult` + `ResultArtifact`） |
| 7 | 是否自行作出架构裁决 / 改变 Codex 决定？ | **否**（全文按裁决逐条落实，见 §0 / 修订记录） |
| 8 | 是否保持设计层（未出 `.prisma` 代码）？ | **是**（仅转述裁决给出的唯一约束签名） |
| 9 | 是否进入 Schema Design？ | **否** |

---

## 12. 待 Codex 第二轮 Review

| 项 | 状态 |
|---|---|
| F1 ~ F5 | 已按裁决落实，待复核 |
| I1–I7 | 未削弱（§4.4 / §6 / §8 为新增保护） |
| R1–R10 | 未削弱 |
| BLOCKER D1 / D2 / D3 | 已在文档层落实（D1 为未来实现约束，本轮不改代码） |
| REQUIRED REVISION R1 ~ R7 | 已逐条落实 |
| 延期项 | level comparison algorithm（§8.4）、Node.js 别名（§6.5）、`Capability.source` 形态、T3+ 各项 |

### 12.1 本次 12 项指令落实对照

| 指令 # | 项 | 状态 | 位置 |
|---|---|---|---|
| 1 | F1 定义为「创建时强绑定 + 历史快照」；regenerate 后 `sourceStepId` 可悬空、snapshot 为权威、不得作长期 FK JOIN | **已补措辞**（Rev.2 已有实质条款） | §1.3、§2.1、§2.3 |
| 2 | Result 创建时 user / plan / sourceStep 所属校验 + snapshot immutable | **Rev.2 已落实** | §2.2 R-F1-1~3 |
| 3 | 唯一约束 `(userId, planId, sourceStepId, contentFingerprint)`；fingerprint 不含时间戳 / 随机数 | **Rev.2 已落实** | §1.4、§7.1、§7.2 |
| 4 | 各来源只能管理自己来源的 CapabilityEvidence，不得全量 `deleteMany` | **Rev.2 已落实** | §4.4 |
| 5 | 来源指针不采用 `SetNull`；采用 Restrict / 等价不可删除语义 | **Rev.2 已落实** | §4.3 |
| 6 | source XOR invariant + `type` 一致 | **Rev.2 已落实** | §4.3 |
| 7 | T3 v1 不做 level 自动合并；不得静默覆盖已确认 level；算法延后 T3+ | **本次补齐** | §8.4 |
| 8 | 统一「存在性 / 可核验性」；excerpt-only 不足；至少一个可重新定位 / 可访问 artifact | **本次补齐措辞** | §3.2、§3.4 |
| 9 | 独立 normalization contract（NFKC / 大小写 / 空白 / 保留 `.` `+` `#`）；`.net≠net`、`Node.js≠NodeJS`、`C#=C＃` | **Rev.2 已落实** | §6 |
| 10 | ProjectResult 生命周期 invariant（三态 / revoked 不可恢复 / revoked 的未确认 Candidate 不得确认 / 已确认不回收） | **本次新增** | §1.2 |
| 11 | 同一 ActionStep 允许多个不同 Result；相同 fingerprint 幂等 | **Rev.2 已落实** | §1.4、§7.1 |
| 12 | 不改变 Architecture Freeze v1.1 决策；不新增范围外实体 | **遵守** | §10 |

### 12.2 Codex 已裁决

#### DMD-DR1 —— 部分来源 revoke 时 Candidate 的可确认性（**Codex 已裁决**）

**裁决**：**部分来源被 revoke，不自动使 Candidate 失效。** Candidate 是否仍可确认，取决于**是否仍存在至少一个未撤销、且满足 T3 v1 证据门槛的有效来源**。

| # | 裁决内容 |
|---|---|
| 1 | 部分来源被 revoke **不自动使 Candidate 失效** |
| 2 | 只要仍存在至少一个「未被 revoke 的有效来源」，**且该来源满足 T3 v1 的 Candidate 证据门槛**，则 Candidate **仍可由用户确认** |
| 3 | 若支撑该 Candidate 的**全部**有效来源均已 revoke，则 Candidate **不得确认** |
| 4 | Revoked 的 `ResultArtifact` / `CapabilityEvidence` **不得被删除** |
| 5 | Revoked 来源可继续作为**历史 provenance**，但**不得继续作为当前 Candidate confirmation 的有效依据** |
| 6 | 已 `CONFIRMED` 的 Capability **不因某个来源 revoke 而回收** |
| 7 | **不新增任何架构机制**，不重新设计 Candidate 模型 |

**三种情形**：

| 情形 | 描述 | 结果 |
|---|---|---|
| **A** | 仅一个来源，该来源被 revoke | **不得确认** |
| **B** | 两个来源，其中一个 revoke，另一个 SUBMITTED 且仍有可重新定位 / 可访问的有效 Artifact | **仍可确认** |
| **C** | 所有来源均 revoke | **不得确认** |

**概念分离（本裁决的关键）**：

| 概念 | 含义 |
|---|---|
| **历史事实** | 「该 Capability 曾经由某 Result 支撑」—— 始终保留、可追溯 |
| **当前确认资格** | 「现在是否仍存在有效来源，可支持用户确认」—— 随来源撤销而变化 |

**落实位置**：§1.2 **INV-L2**（精化）/ **INV-L5**（新增）。

#### DMD-DR2 —— `ActionPlan` 删除语义（**Codex 已裁决**）

**裁决**：

| # | 裁决内容 |
|---|---|
| 1 | `ProjectResult.planId → ActionPlan` **不采用 `Cascade`**，改为 **`Restrict` / 等价不可删除语义** |
| 2 | `ActionPlan` 存在 `ProjectResult` 时，**不允许**通过删除 `ActionPlan` 级联删除 `ProjectResult` |
| 3 | `ProjectResult → ResultArtifact` **保持 `Cascade`** |
| 4 | `CapabilityEvidence → ResultArtifact` **保持 `Restrict` / source immutable** |
| 5 | `ProjectResult` 的历史 provenance **不得因 `ActionPlan` 删除而静默消失** |

**最终关系语义**：

```
ActionPlan
   │  Restrict
   ▼
ProjectResult
   │  Cascade
   ▼
ResultArtifact
```

**业务语义**：

| 情形 | 结果 |
|---|---|
| `ActionPlan` **没有** `ProjectResult` | 可以正常删除（若系统未来提供删除能力） |
| `ActionPlan` **已存在** `ProjectResult` | **删除必须被阻止** |
| 需要业务撤销成果 | 通过 **`Revoked`** 表达，**不以删除消除历史** |

**边界**：不新增实体；不改变 Architecture Freeze v1.1；不设计新的删除机制；不修改任何代码实现。

**落实位置**：§1.4（`planId` → `Restrict`）、§2.4（删除原则与业务语义）。

### 12.3 待裁决（DECISION REQUEST）

**当前无待裁决项。** DR-1 / DR-2 均已由 Codex 裁决并落实（见 §12.2）。

**本轮停止。Schema 仍然绝对冻结。**
