# T3 Schema Design v1.1

> **状态**：**v1.1 — FINAL ACCEPTED**（DR-3 / DR-4 / DR-5 已由 Codex 裁决并落实；T3-A0 收口，Codex 裁决 Q5）
> **依据**：`docs/t3-architecture-freeze.md`（v1.1 FINAL ACCEPTED）＋ `docs/t3-data-model-design-v1.md`（v1.1 FINAL ACCEPTED）＋ **Codex Schema Design Review 裁决（DMD-S3 / S4 / S5）**
> **层级边界**：本文档是 **Schema Design**，不是实现。**文档成文时**所有 `@@`/`@relation`/`onDelete` 为**设计表述**，**未写入 `schema.prisma`**。
> **T3-A0 收口后状态更新（2026-09-18）**：`ProjectResult` / `ResultArtifact` 模型及其 `@relation`/`onDelete`、`CapabilityEvidence` 的 exactly-one-source / type↔pointer 约束均已**实际写入 `schema.prisma` 并经 migration 落地**（CHECK 约束以 migration 内 raw SQL 登记 —— 本环境 Prisma 6.19.3 不解析内联 `@@check`）。

## 修订记录（v1 → v1.1）

| # | 修订项 | 对应 Codex 裁决 |
|---|---|---|
| 1 | `ProjectResult.contentFingerprint` 确认**可空**：Draft = NULL；Submitted / Revoked = 必存在 | **DMD-S3** |
| 2 | `ProjectResult.userId → User` 确认 **Cascade**；接受「User 删除可能因仍存在 provenance 而失败」边界 | **DMD-S4** |
| 3 | DR-5 落地：Legacy Resume Evidence **清理 + 可重建投影**；补 9 步正确迁移顺序与作用域约束（一次性、仅 `type=RESUME_EVIDENCE`、严禁全量 `deleteMany({})`） | **DMD-S5** |

---

## 1. FACT（当前 `schema.prisma` 真实结构）

### 1.1 现有枚举

| 枚举 | 值 |
|---|---|
| `FactStatus` | `CONFIRMED` `INFERRED` `UNCONFIRMED` `MISSING` |
| `EvidenceSource` | `RESUME_TEXT` `USER_STATEMENT` `OCR` `JD` |
| `SourceType` | `TEXT` `PDF` `DOCX` `IMAGE` |
| 其余 | `RequirementCategory` `Criticality` `MatchStatus` `ApplicationStage` `SuggestionStatus`（与 T3 无关） |

### 1.2 相关模型当前结构（unique / index / FK / onDelete）

| 模型 | 关键字段 | unique | index | FK onDelete |
|---|---|---|---|---|
| `User` | id, email(@unique), … | `email` | — | — |
| `Evidence` | id, source(EvidenceSource), locator, excerpt?, skillId?/resumeProjectId?/educationId?/experienceId? | — | `[skillId]` `[resumeProjectId]`（**缺** educationId/experienceId 索引） | 4 个可空 FK 均 **Cascade** |
| `Skill` | resumeId, key, label, level?, status(FactStatus) | `[resumeId, key]` | `[resumeId]` | → Resume Cascade |
| `Capability` | userId, key, label, level?, status(FactStatus), source | **`[userId, key]`** | `[userId]` | → User Cascade |
| `CapabilityEvidence` | capabilityId, type(String), source(String), url?, excerpt? | — | `[capabilityId]` | → Capability **Cascade** |
| `ActionPlan` | userId, matchRunId, jdId?, goal, have(Json), gaps(Json) | — | `[userId]` `[matchRunId]` | → User Cascade；→ MatchRun Cascade |
| `ActionStep` | planId, order, title, desc, status(String 默认 TODO), targetRequirement? | — | `[planId]` | → ActionPlan Cascade |
| `KnowledgeGap` / `CareerGoal` | （死脚手架） | — | `[userId]` | → User Cascade |

### 1.3 与 DMD 的冲突点（需本设计消解）

| # | 冲突 |
|---|---|
| C1 | `CapabilityEvidence` 无任何来源指针（`evidenceId` 类字段零存在）→ DMD §4.3 需新增 `resumeEvidenceId` / `resultArtifactId` |
| C2 | `CapabilityEvidence.capabilityId` 现为 **Cascade**，而 DMD 要求来源侧 Restrict —— 二者不冲突（不同 FK），但须确认保留 Cascade |
| C3 | `ActionPlan` / `ActionStep` 无 `ProjectResult` 反向关系 → 需新增 |
| C4 | `KnowledgeGap` / `CareerGoal` 存在且被 `User` 反向引用 → 需删除 |
| C5 | `Capability.source`（String 必填）语义与"多来源"不再单值对应 → DMD 明确"其存储形态延期"，本设计**不改**该字段 |
| C6 | `CapabilityEvidence.type` 为 **String**（非枚举），既有值 `RESUME_EVIDENCE`（C1）/ `PROJECT_ARTIFACT`（测试夹具）→ 是否升枚举需裁决（本设计建议**保持 String + CHECK**，见 DR 清单） |

---

## 2. OBSERVATION

### 2.1 Prisma / PostgreSQL 能表达什么

| 能力 | Prisma schema | PostgreSQL（raw migration） |
|---|---|---|
| 唯一约束（复合） | ✅ `@@unique` | ✅ |
| 外键 onDelete（Cascade / Restrict / SetNull） | ✅ `@relation(onDelete:)` | ✅ |
| 索引（复合） | ✅ `@@index` | ✅ |
| 枚举 | ✅ `enum` | ✅ |
| **跨字段 XOR（exactly-one-source）** | ❌ | ✅ `CHECK` |
| **字段间一致性（type↔pointer）** | ❌ | ✅ `CHECK` |
| **条件唯一（仅 submitted 行按 fingerprint 唯一）** | ❌（无 partial unique） | ⚠️ 部分唯一索引可表达，但 Prisma 不管理 |
| **条件约束（revokedAt 非空 ⟹ submittedAt 非空）** | ❌ | ✅ `CHECK` |

**结论**：DMD 的 R6/R7/部分生命周期约束，**Prisma schema 层无法表达**，只能走 **raw SQL `CHECK`（进 migration）** + **application 兜底**。

### 2.2 Schema 层面潜在风险

- **R1 遗留数据不可回填**：既有 `CapabilityEvidence` 行（C1 投影产出）**没有任何来源指针**，且 C1 从未保存源 `Evidence.id` → 引入 exactly-one-source 后，**既有行无法回填**（provenance 链接已丢失）。→ 已由 **DMD-S5** 裁决（§6.1）。
- **R2 Cascade × Restrict 交互**：`ProjectResult.userId` 若 Cascade（默认），删除 User 时 → ProjectResult Cascade → ResultArtifact Cascade → 被 `CapabilityEvidence.resultArtifactId` 的 Restrict 阻断。**当前无 User 删除路径，故不可达**，语义上存在 → 已由 **DMD-S4** 裁决（保持 Cascade，接受该边界）。
- **R3 `source` 单值误导**：`Capability.source` / `CapabilityEvidence.source` 在多来源下语义弱化，本设计**不改**（DMD 已延期），仅记录。

---

## 3. SCHEMA DESIGN

### 3.0 新增枚举

```prisma
enum ResultArtifactKind {
  REPO
  DEPLOY
  DOC
  SCREENSHOT
  OTHER
}
```

> 依据 DMD §3.3 固定 5 值。选枚举而非 String：新表无存量数据、无需回填，且给 DB 层约束。（若未来需动态增 kind，再改 String + app 校验——属实现期可回退，不属本次裁决。）

### 3.1 新增 `ProjectResult`

```prisma
model ProjectResult {
  id                          String          @id @default(cuid())
  userId                      String
  user                        User            @relation(fields: [userId], references: [id], onDelete: Cascade)   // DMD-S4：保持 Cascade
  planId                      String
  plan                        ActionPlan      @relation(fields: [planId], references: [id], onDelete: Restrict) // DR2
  sourceStepId                String          // 历史线索，非 FK（D6-a / §1.3）
  sourceStepTitle             String          // 快照
  sourceStepTargetRequirement String?         // 快照
  title                       String
  summary                     String
  contentFingerprint          String?         // DMD-S3：Draft = NULL；Submitted / Revoked 必存在
  createdAt                   DateTime        @default(now())
  submittedAt                 DateTime?       // null = Draft
  revokedAt                   DateTime?       // null = 有效；非空 = Revoked（终态）
  artifacts                   ResultArtifact[]

  @@unique([userId, planId, sourceStepId, contentFingerprint])
  @@index([userId, planId])
  @@index([userId, submittedAt])
  @@index([contentFingerprint])
  @@index([sourceStepId])
}
```

**设计理由**：
- `planId` **Restrict**：落实 DMD-DR2（ActionPlan 存在 ProjectResult 时不可删）。
- `sourceStepId` **非 FK**：落实 D6-a"创建时强绑定 + 历史快照"，因 ActionStep 每次 regenerate 被 delete+recreate（FACT `repositories.ts:1099`），硬 FK 会 Cascade/SetNull/Restrict 三害。
- 三态由 `submittedAt` / `revokedAt` 表达（DMD §1.2），不设 status 枚举。
- 复合唯一 `[userId, planId, sourceStepId, contentFingerprint]`：落实 BLOCKER D3（同步骤多成果允许 / 同指纹幂等）。

**Application Invariant（DMD-S3，由提交逻辑保证）**：

| 状态 | submittedAt | contentFingerprint | revokedAt |
|---|---|---|---|
| Draft | NULL | NULL | NULL |
| Submitted | 非空 | 非空 | NULL |
| Revoked | 非空 | 非空 | 非空 |

### 3.2 新增 `ResultArtifact`

```prisma
model ResultArtifact {
  id        String              @id @default(cuid())
  resultId  String
  result    ProjectResult       @relation(fields: [resultId], references: [id], onDelete: Cascade)
  kind      ResultArtifactKind
  url       String?
  excerpt   String?
  dedupeKey String
  createdAt DateTime            @default(now())

  @@unique([resultId, dedupeKey])
  @@index([resultId])
}
```

**设计理由**：
- `resultId` **Cascade**：落实 DMD-DR2（ProjectResult → ResultArtifact 保持 Cascade）。
- `dedupeKey` + `@@unique([resultId, dedupeKey])`：证据幂等（DMD §3.3）。
- `kind` 枚举（§3.0）。

### 3.3 修改 `CapabilityEvidence`

```prisma
model CapabilityEvidence {
  id               String          @id @default(cuid())
  capabilityId     String
  capability       Capability      @relation(fields: [capabilityId], references: [id], onDelete: Cascade)
  type             String          // 保持 String；R7 用 CHECK + app 兜底
  source           String
  url              String?
  excerpt          String?
  resumeEvidenceId String?
  resumeEvidence   Evidence?       @relation(fields: [resumeEvidenceId], references: [id], onDelete: Restrict)
  resultArtifactId String?
  resultArtifact   ResultArtifact? @relation(fields: [resultArtifactId], references: [id], onDelete: Restrict)
  createdAt        DateTime        @default(now())

  @@index([capabilityId])
  @@index([resumeEvidenceId])
  @@index([resultArtifactId])
}
```

**设计理由**：
- 两个可空来源指针 **Restrict**：落实 R3（来源不可硬删）+ exactly-one-source（R6）。
- `type` **保持 String**：避免枚举迁移 + 既有 `PROJECT_ARTIFACT` 值回填问题；R7（type↔pointer）由 CHECK + app 保证（见 §4）。
- 既有 `capabilityId` Cascade **保留**（Capability 删除仍级联其证据）。

**Prisma 无法表达、须 raw SQL CHECK（进 migration）+ app 兜底**：

```sql
-- R6 exactly-one-source
CHECK (("resumeEvidenceId" IS NOT NULL)::int + ("resultArtifactId" IS NOT NULL)::int = 1)

-- R7 type ↔ pointer 一致
CHECK (
  ("type" = 'RESUME_EVIDENCE'         AND "resumeEvidenceId" IS NOT NULL)
  OR
  ("type" = 'PROJECT_RESULT_EVIDENCE' AND "resultArtifactId" IS NOT NULL)
)
```

> ⚠️ 上述 CHECK 与既有数据冲突（既有行两指针皆 NULL）→ **部署时序见 §6.1（DMD-S5）**。

### 3.4 修改 `ActionPlan` / `User` / `Evidence`（仅反向关系）

```prisma
model ActionPlan {
  // …… 现有字段不变
  results  ProjectResult[]
}

model User {
  // …… 现有字段
  projectResults ProjectResult[]
  // 移除：gaps KnowledgeGap[]  /  careerGoals CareerGoal[]
}

model Evidence {
  // …… 现有字段不变
  capabilityEvidences CapabilityEvidence[]
}
```

### 3.5 删除

```prisma
// 删除 model KnowledgeGap  （及 User.gaps）
// 删除 model CareerGoal    （及 User.careerGoals）
```

---

## 4. CONSTRAINT MATRIX（DMD 约束 → 保证层）

| DMD 约束 | Schema 保证 | App 保证 | 说明 |
|---|---|---|---|
| `planId` Restrict（DR2） | ✅ `onDelete: Restrict` | — | |
| `resultId` Cascade（DR2） | ✅ `onDelete: Cascade` | — | |
| 来源指针 Restrict（R3） | ✅ `onDelete: Restrict` | — | |
| fingerprint 唯一（BLOCKER D3） | ✅ `@@unique` | — | 依赖 DMD-S3 可空语义 |
| `(userId,key)` 收敛（D5） | ✅ 既有 `@@unique` | — | |
| 候选/已确认共行 + 状态只升（F4/R5） | ⚠️ 无降级路径已由代码事实保证 | ✅ | 无 schema 机制 |
| exactly-one-source（R6） | ⚠️ PG CHECK（raw SQL） | ✅ 兜底 | Prisma 不可表达 |
| type↔pointer（R7） | ⚠️ PG CHECK（raw SQL） | ✅ 兜底 | Prisma 不可表达 |
| 三态顺序 / revoked 不可恢复（INV-L1） | ⚠️ 部分 CHECK | ✅ | `revokedAt⟹submittedAt` 可 CHECK |
| 来源隔离写入（BLOCKER D1） | ❌ | ✅ | 实现契约（`deleteMany` 须按来源） |
| 指纹确定性（R2） | ❌ | ✅ | 服务端算 |
| snapshot immutable（R-F1-3） | ❌ | ✅ | 无更新路径 |
| sourceStepId∈planId / planId∈userId（R-F1-1/2） | ⚠️ userId/planId 有 FK，但 `sourceStepId∈planId` 无 FK | ✅ | 创建时校验 |
| 无 level 自动合并 / 不覆盖已确认 level（L-1/L-2） | ❌ | ✅ | 写 level 时按 status 判定 |
| key normalization（F5） | ❌ | ✅ | 服务端算 key |
| 证据 append-only（I5） | ⚠️ 无机制阻止 deleteMany | ✅ | 实现约束 |

---

## 5. MIGRATION IMPACT（仅分析，禁止执行）

| 类别 | 内容 |
|---|---|
| **新增表（2）** | `ProjectResult`、`ResultArtifact` |
| **新增枚举（1）** | `ResultArtifactKind` |
| **新增字段（2）** | `CapabilityEvidence.resumeEvidenceId?`、`.resultArtifactId?` |
| **新增反向关系（3）** | `User.projectResults`、`ActionPlan.results`、`Evidence.capabilityEvidences` |
| **删除表（2）** | `KnowledgeGap`、`CareerGoal`（+ `User.gaps` / `User.careerGoals`） |
| **删除/修改字段** | 无（`CapabilityEvidence.type/source/url/excerpt` 均保留） |
| **新增 unique（2）** | `ProjectResult` 复合、`ResultArtifact` 复合 |
| **新增 index（7）** | `ProjectResult`×4、`ResultArtifact`×1、`CapabilityEvidence`×2 |
| **FK onDelete 修改** | 无既有 FK 变更；新增 FK 用 Restrict（planId、两个来源指针）与 Cascade（resultId、userId） |
| **raw SQL CHECK（2+1）** | exactly-one-source、type↔pointer、（可选）revokedAt⟹submittedAt |

**数据迁移风险**：

| 风险 | 说明 |
|---|---|
| **MR-1（高）** | 既有 `CapabilityEvidence` 行无来源指针，**无法回填**（provenance 链接未存）；exactly-one-source CHECK 若立即启用会拒绝存量行 → **已由 DMD-S5 裁决**（清理 + 重建，见 §6.1） |
| **MR-2（中）** | `CapabilityEvidence.type` 既有值 `PROJECT_ARTIFACT`（仅测试夹具）与 `RESUME_EVIDENCE`；若升枚举需回填 —— 本设计**保持 String 规避** |
| **MR-3（低）** | `KnowledgeGap` / `CareerGoal` 预期空表（零引用），删除前核对行数 |
| **MR-4（低）** | `ProjectResult.userId` 保持 Cascade 与 `CapabilityEvidence→ResultArtifact` Restrict 的级联顺序（当前无 User 删除路径，不可达）—— **已由 DMD-S4 裁决**（保持 Cascade，接受该边界） |

---

## 6. DECISION REQUEST → Codex 已裁决（v1.1）

| # | Codex 裁决 | 落实 |
|---|---|---|
| **DMD-S3** | `ProjectResult.contentFingerprint` **可空**：Draft = NULL；Submitted / Revoked = 必存在 | §3.1 |
| **DMD-S4** | `ProjectResult.userId → User` **保持 Cascade**；接受「User 删除可能因仍存在 CapabilityEvidence provenance 而失败」—— 当前无 User 删除路径，属未来删除语义边界，不阻塞 T3 | §3.1 |
| **DMD-S5** | Legacy Resume Evidence **清理 + 可重建投影**；否决「永久豁免 / Legacy 类型 / 新增 provenance 状态字段 / 第三种来源 / 保留无法追溯的旧行」 | §6.1 |

### 6.1 DR-5 迁移语义（DMD-S5，一次性 legacy 行为）

**原则**：旧 `CapabilityEvidence`（`RESUME_EVIDENCE`）属**可由既有事实重新生成的投影数据**，不是唯一事实源 → **清理后由更新版投影重建**，而非永久豁免。

**正确迁移顺序（9 步，非简单 `ALTER TABLE ADD CHECK`）**：

```
1. 新增两个 nullable provenance FK（resumeEvidenceId / resultArtifactId）
2. 新建 ProjectResult / ResultArtifact
3. 新增 CapabilityEvidence 新字段
4. 清理旧的无 provenance CapabilityEvidence
5. 用更新后的 Resume Projection 重建 RESUME_EVIDENCE
6. 新生成的行必须具有 resumeEvidenceId
7. 验证不存在 resumeEvidenceId IS NULL AND resultArtifactId IS NULL
8. 再加入 XOR CHECK（exactly-one-source）
9. 再加入 type ↔ pointer CHECK
```

**作用域约束（硬性）**：

| 约束 | 内容 |
|---|---|
| 清理范围 | **严格限定 `type = RESUME_EVIDENCE`** |
| 一次性 | 属 **one-time legacy migration 行为**，非运行时常态 |
| 严禁 | 不得退化为 `evidence: { deleteMany: {} }` 这类**无差别全量删除** |
| 后续运行时 | 正常业务代码遵守 DMD：Resume Projection 只操作 `RESUME_EVIDENCE`；Project Result Return 只操作 `PROJECT_RESULT_EVIDENCE` |

---

## 7. 交付确认（本轮）

| 项 | 结果 |
|---|---|
| 是否修改任何文件 | **否**（`schema.prisma` / `src` / `tests` / `package.json` / 其他 docs 均未动） |
| 是否创建 migration | **否** |
| 是否启动服务 | **否**（`127.0.0.1:3100` → `ECONNREFUSED`） |
| Schema Design 是否可提交 Codex Final Review | **已提交并通过（v1.1 FINAL ACCEPTED）**（DR-3 / DR-4 / DR-5 已由 Codex 裁决并落实，见 §6；T3-A0 收口，Codex 裁决 Q5） |

**本轮停止。Schema 落地（修改 `schema.prisma` / migration）仍冻结。**
