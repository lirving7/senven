# T3 Migration Design v1

> **状态**：**v1.1 — FINAL ACCEPTED**（T3-A0 收口：4 项修订已落实；CapabilityEvidence 双 CHECK 已通过 migration `20260917232000_capability_evidence_checks` 正式纳入迁移体系；Codex 裁决 Q5）
> **依据**：`docs/t3-architecture-freeze.md`（v1.1）＋ `docs/t3-data-model-design-v1.md`（v1.1）＋ `docs/t3-schema-design-v1.md`（v1.1）＋ **Codex Migration Review（MR-DR1 / MR-DR2 + 2 项修正）**
> **层级边界**：本文档是 **Migration Design**。**文档成文时**所有 SQL 均为**设计表述**、**未执行**。
> **T3-A0 收口后状态更新（2026-09-18）**：本文档描述的相关 migration 已**实际落地执行**并 applied —— `20260917232000_capability_evidence_checks`（双 CHECK 正式化）、`20260918124000_archive_legacy_backup`（backup 表迁出 public）、`20260918124500_capability_evidence_check_guard`（guard 作用域修正）；`prisma migrate status` = 8 migrations / up to date。

## 修订记录（Codex Migration Review 修订）

| # | 修订项 | 对应 |
|---|---|---|
| 1 | 清理范围改为**双 scope**：Scope A（DMD-S5 `RESUME_EVIDENCE`，严格）+ Scope B（已确认 QA residue `USER_STATEMENT`，一次性、不泛化） | MR-DR1 |
| 2 | 迁移生命周期改为 **Migration A → Application Projection → Migration B**（应用步骤不伪装成 migration 内步骤） | MR-DR2 |
| 3 | 删除「`prisma migrate` 回退一个版本」；改为 backup table / reverse migration / database restore；明确 COMMIT 前后的事务边界 | 修正 3 |
| 4 | Phase 3 措辞「只读事实投影」→「**幂等派生事实重建步骤**」 | 修正 4 |
| 5 | Phase 5 锁风险表述精确化；backup table 定性为 migration-scoped 审计/回滚产物（7 天为建议值，非架构约束） | 小修正 ×2 |

---

## 1. FACT

### 1.1 迁移工具链

| 项 | 事实 |
|---|---|
| ORM / 迁移 | **Prisma Migrate**，`@prisma/client` + `prisma` `^6.1.0` |
| 数据库 | PostgreSQL（`datasource db`，`env("DATABASE_URL")`） |
| 脚本 | `prisma:migrate` = `prisma migrate dev --name init`（**注意：`--name init` 硬编码**，属既有缺陷）；`prisma:generate` = `prisma generate` |
| 既有 migration | **8 个**（T3-A0 收口后实测）：`20260916113501_init`、`20260916142551_bug003_applied_default`、`20260916160421_v2_capability`、`20260917112402_v2_action_plan_usage`、`20260917155152_t3_project_result`、`20260917232000_capability_evidence_checks`（双 CHECK 正式化）、`20260918124000_archive_legacy_backup`（backup 迁出 public）、`20260918124500_capability_evidence_check_guard`（guard 作用域修正） |

### 1.2 既有 migration 形态（含 raw SQL 先例）

- Prisma Migrate 生成的 `migration.sql`，PostgreSQL 方言（`TEXT`、`TIMESTAMP(3)`、`JSONB`、PG `ENUM` 类型）。
- **已有手写 raw SQL 先例**：`20260916142551_bug003_applied_default` 在 `ALTER TABLE ... SET DEFAULT` **之前**先执行了 `UPDATE ... SET stage='APPLIED' WHERE stage='DRAFT'` —— 证明本项目已采用「**先改数据、再改结构**」的编排惯例，且**允许在 Prisma migration 内插入数据步骤**。

### 1.3 真实数据规模（本轮实测，只读）

| 表 | 行数 |
|---|---|
| `CapabilityEvidence` | **20**（T3-A0 收口实测：全部 `type=RESUME_EVIDENCE`，0 行违反双 CHECK；设计期 §1.4 记录的 5 行含 3 行 `USER_STATEMENT` QA residue 已随 DMD-S5 清理范围处理） |
| `Capability` | 5 |
| `User` | 35 |
| `ActionPlan` / `ActionStep` | 4 / 33 |
| `Evidence` | 143 |
| `KnowledgeGap` / `CareerGoal` | **0 / 0** |

### 1.4 关键新发现（影响 DMD-S5 清理范围）

- **存量 `CapabilityEvidence` 并非全是 `RESUME_EVIDENCE`**：实测有 **3 行 `type='USER_STATEMENT'`**，来源为 `scripts/qa-3b-action-plan.mjs:168` 与测试夹具的残留（该脚本注册用户后**未清理**）。
- DMD-S5 的清理范围写的是「**仅 `type = RESUME_EVIDENCE`**」→ 若照此执行，这 3 行 `USER_STATEMENT` 会**残留**，进而在加 exactly-one-source CHECK 时**直接违规**。
- 全部 5 行均为 **QA 残留**（当前无生产用户数据），且均**不可回填**（从未存源 `Evidence.id`）。
- `KnowledgeGap` / `CareerGoal` 实测 **0 行** → 删除**零数据风险**（前置条件已事实满足）。

---

## 2. 迁移边界（Prisma vs raw SQL vs application）

| 能力 | 承载方式 |
|---|---|
| enum / 建表 / 加列 / 索引 / 唯一约束 / FK（含 onDelete） | **Prisma Migrate** 自动生成 |
| **跨字段 CHECK**（XOR、type↔pointer） | **raw SQL**（Prisma schema 无法表达） |
| **数据清理 / 备份**（DELETE、CREATE TABLE AS） | **raw SQL**（沿用 bug003 先例，插入 migration） |
| **重建 RESUME_EVIDENCE 投影** | **application 步骤**（非 SQL；需更新版 C1 投影代码） |

**核心结论**：本次迁移**无法由单次 `prisma migrate dev` 原子完成**，必须拆成「**Migration A → Application Projection → Migration B**」的迁移生命周期（见 §3）。应用重建投影是**独立的 application 步骤**，不落入任何 SQL migration。

---

## 3. 迁移总体顺序（Migration A → Application Projection → Migration B）

> 按 MR-DR2：迁移生命周期明确为「两个 migration + 一个应用步骤」，**不把应用代码伪装成 SQL migration 内步骤**。

```
Migration A（Prisma migration + raw SQL，**不含 CHECK**）
   ├─ Phase 0  前置检查（只读）
   ├─ Phase 1  Schema DDL（Prisma --create-only）
   └─ Phase 2  Legacy 数据清理（raw SQL，事务内 + 备份，双 scope）

        ↓ （部署 / 启用新版 C1 Projection）

Application Projection（应用步骤，非 migration）
   └─ Phase 3  幂等派生事实重建（重建 RESUME_EVIDENCE provenance）

        ↓

Phase 4  验证（只读 SQL）

        ↓

Migration B（raw SQL）
   └─ Phase 5  ADD CHECK（exactly-one-source / type↔pointer）

        ↓

Phase 6  收尾（备份表审计窗口 + 回归）
```

---

## 4. 各阶段详设

### Phase 0 — 前置检查（只读，不落任何变更）

1. `prisma migrate status` 确认处于最新 migration。
2. 核对 `KnowledgeGap` / `CareerGoal` 行数 = 0（实测已满足）。
3. 记录 `CapabilityEvidence` 分布（5 行，2 RESUME + 3 USER_STATEMENT）。
4. 确认 Phase 3 所需的**更新版投影代码已部署可用**（否则不得进入 Phase 2）。

### Phase 1 — Schema DDL（Prisma Migrate）

> 用 `prisma migrate dev --create-only --name t3_project_result`，**人工审阅**生成 SQL 后再应用。
> **本次 Migration Design 不修改 `package.json`**：实际执行 Migration A 时，使用**显式 migration name** 或**直接调用 Prisma CLI**；是否修改既有 `prisma:migrate` 脚本属**独立工程变更**，不作为本次迁移设计的隐式前置修改。

| 顺序 | 对象 | 关键点 |
|---|---|---|
| 1 | `enum ResultArtifactKind` | REPO / DEPLOY / DOC / SCREENSHOT / OTHER |
| 2 | `ProjectResult` 表 | FK：`userId→User` **Cascade**、`planId→ActionPlan` **Restrict**；`@@unique([userId,planId,sourceStepId,contentFingerprint])`；索引 ×4 |
| 3 | `ResultArtifact` 表 | FK：`resultId→ProjectResult` **Cascade**；`@@unique([resultId,dedupeKey])`；索引 ×1 |
| 4 | `CapabilityEvidence` +2 列 | `resumeEvidenceId?`（→Evidence **Restrict**）、`resultArtifactId?`（→ResultArtifact **Restrict**）；索引 ×2 |
| 5 | 删 `KnowledgeGap` / `CareerGoal` | `DROP TABLE`（0 行，安全）；同步移除 `User` 反向关系（Prisma 生成层） |

> **本阶段不加 CHECK**（因存量行会违规）。

### Phase 2 — Legacy 数据清理（raw SQL，事务内，双 scope）

```sql
BEGIN;
-- ① 备份（migration-scoped 审计/回滚产物，非永久 schema 对象）
CREATE TABLE "_CapabilityEvidence_legacy_backup" AS
  SELECT * FROM "CapabilityEvidence";

-- ② Scope A —— DMD-S5 legacy projection cleanup（严格限定）
DELETE FROM "CapabilityEvidence"
  WHERE "type" = 'RESUME_EVIDENCE';

-- ③ Scope B —— 已确认 QA fixture residue cleanup（一次性，不泛化）
DELETE FROM "CapabilityEvidence"
  WHERE "type" = 'USER_STATEMENT';
COMMIT;
```

**Scope A（DMD-S5，严格）**：`type = RESUME_EVIDENCE` → 清理后由 Resume Projection 重建。

**Scope B（已确认 QA residue，独立且一次性）**：

> `USER_STATEMENT` 三行属于**已确认的 QA fixture residue**（`scripts/qa-3b-action-plan.mjs:168` 及测试夹具残留），**不属于** DMD-S5 的 Resume Projection legacy 数据。此次迁移仅因其**已确认无生产来源、无 provenance、且无法回填**，为满足新的 provenance CHECK 而做**一次性清理**；该清理**不得推广为运行时清理规则**，也**不得扩大为「所有无 pointer 行的通用删除策略」**。

**硬约束**：
- 两个 scope 均为**一次性 legacy 行为**，非运行时常态。
- **严禁** `DELETE` 退化为无差别的 `deleteMany({})`。

### Phase 3 — 幂等派生事实重建步骤（application 步骤，非迁移）

- 运行**更新版** `projectConfirmedSkills`（须已写 `resumeEvidenceId`）。
- **定性**：这是「**幂等派生事实重建步骤**」——它会**写入 `CapabilityEvidence`**（**非只读**），但**不创造新的用户事实**，只重建既有 `Resume Evidence → CapabilityEvidence` 的投影。
- 幂等、可重跑；每次重跑应 `created=0/unchanged` 且不重复证据。

> **T3-A 收口澄清（Codex 裁决 C11 / O-5）**：此处的 `projectConfirmedSkills` 仅服务于**历史 `Resume Evidence → CapabilityEvidence` 投影重建**（属 DMD-S5 / Scope A legacy 处理），**并非** T3-A「Project Result / ResultArtifact」的能力投影路径。
> **硬约束（冻结设计）**：**T3-A ProjectResult 创建、提交及生命周期管理不得复用 `projectConfirmedSkills` 来创建 Capability/Skill，也不得绕过 Capability confirmation 流程。**

### Phase 4 — 验证（只读 SQL，见 §8）

### Phase 5 — 加 CHECK（raw SQL）

```sql
ALTER TABLE "CapabilityEvidence"
  ADD CONSTRAINT "ce_exactly_one_source"
  CHECK (("resumeEvidenceId" IS NOT NULL) <> ("resultArtifactId" IS NOT NULL));

ALTER TABLE "CapabilityEvidence"
  ADD CONSTRAINT "ce_type_pointer_consistent"
  CHECK (
    ("type" = 'RESUME_EVIDENCE'         AND "resumeEvidenceId" IS NOT NULL) OR
    ("type" = 'PROJECT_RESULT_EVIDENCE' AND "resultArtifactId" IS NOT NULL)
  );
```

> 当前数据规模仅 5 行，可直接 `ADD CONSTRAINT`，无实际性能压力。此为**当前规模的判断，非长期规则**；未来大表迁移时，应根据 PostgreSQL 运行环境评估 `ADD CONSTRAINT ... NOT VALID` → `VALIDATE CONSTRAINT` 策略。

> **T3-A0 收口更新（Codex 裁决 Q6）**：上述两个 CHECK 此前由本 Phase 5 的 raw SQL 创建于活库，**未进入 Prisma migration 历史**。已通过新增 migration **`20260917232000_capability_evidence_checks`** 正式纳入迁移体系（`DO $$ ... IF NOT EXISTS` 幂等守卫；表达式与活库 `pg_constraint` 逐字一致）。
> 因该 migration 的 guard 仅按 `conname` 判断、作用域过宽（未限定 `conrelid` / `connamespace` / `contype`），已在其后新增**独立 migration** **`20260918124500_capability_evidence_check_guard`** 补齐作用域，确保两 CHECK 最终存在于正确的 `CapabilityEvidence` 表上（已 applied；**未修改已 applied 的 migration #6**）。
> 核验：`prisma migrate status` = 8 migrations / up to date；fresh-DB `migrate deploy` 可重建两 CHECK 且定义与正式库**逐字一致**；20 行 `CapabilityEvidence` 0 违规。

### Phase 6 — 收尾

- `prisma generate` 更新 client。
- 备份表 `_CapabilityEvidence_legacy_backup` 定性为 **migration-scoped 审计/回滚产物**（**非永久 schema 对象**），记录：创建时间、对应 migration、原始行数（5）、清理范围（Scope A / B）、审计保留期。
- **T3-A0 收口更新（Codex 裁决 Q7 + 归档）**：该表原位于 `public`，会被 Prisma introspection 识别为「migration history 之外的漂移对象」→ 已通过新 migration `20260918124000_archive_legacy_backup` 以 `ALTER TABLE ... SET SCHEMA` **迁出到非 public 归档 schema `_migration_archive`**（表结构 + 5 行数据**保持不变**）。迁出后，在 datasource 保持 `?schema=public` 的前提下，该表**不再参与 public datamodel diff**。**归档表仍保留**（本轮**不删除**）；保留期限 **7 天**（当前建议值，**非系统架构约束**）；7 天后由**独立 future migration `DROP`**。
- 跑全量回归（`tsc` / `npm test` / `next build`）。

---

## 5. 数据安全与回滚边界

| 阶段 | 安全性 |
|---|---|
| Phase 1 | 在当前 PostgreSQL / Prisma migration 执行环境下，DDL 按 migration 的事务语义执行；**若 migration 在事务边界内失败，则由事务回滚**。具体 rollback 行为以实际生成并审阅的 migration SQL 及执行环境为准 |
| Phase 2 | 事务内 + 前置备份表；失败回滚，备份表完整 |
| Phase 3 | 只读事实投影，幂等；失败可无限重试 |
| Phase 5 | 加 CHECK 前先验证（Phase 4）；违规则**不加**，退回 Phase 2 重来 |
| 整体 | `CapabilityEvidence` 是**派生投影数据**（可由 `Skill`/`Evidence` 重建），**无不可恢复点** |

**回滚（修正 3：`prisma migrate` 无生产级 `migrate down` / 自动 down migration，回退不得依赖它）**：

| 层 | 回滚方式 |
|---|---|
| Schema | **反向 SQL / 新 migration**，或 **恢复数据库 backup** |
| CapabilityEvidence | 从 `_CapabilityEvidence_legacy_backup` 恢复（**恢复前先停止相关写入**；恢复后**重新验证 provenance invariant**） |
| CHECK | `DROP CONSTRAINT ce_exactly_one_source` / `ce_type_pointer_consistent` |

**事务边界（修正 3）**：

| 失败时机 | 回滚方式 |
|---|---|
| Phase 2 **COMMIT 之前**失败 | 原事务**自动 rollback** |
| Phase 3 / 4 / 5 在 Phase 2 **COMMIT 之后**失败 | **无法靠原事务回滚** → 用 backup table 执行**人工 / 受控恢复** |

---

## 6. 失败恢复策略

| 失败点 | 恢复 |
|---|---|
| Phase 1 DDL 失败 | Prisma 自动回滚；修正 schema 后重跑 |
| Phase 2 清理失败 | 事务回滚；备份表仍在；重跑 Phase 2 |
| Phase 3 投影失败（代码未就绪/异常） | **前置阻断**：Phase 2 之前必须确认投影代码就绪；恢复 = 重跑投影（幂等） |
| Phase 4 验证发现违规 | 不进入 Phase 5；定位是 Phase 2 未清干净还是 Phase 3 未写指针；从 Phase 2 重来 |
| Phase 5 CHECK 添加失败 | 检查是否有漏网行；删除违规行（其已被备份）后重试 |

---

## 7. 迁移前 / 后 invariant

**迁移前**：
- `KnowledgeGap` / `CareerGoal` = 0 行。
- `CapabilityEvidence` 全为 legacy（无来源指针字段）。
- 处于最新 migration。

**迁移后**：
- `CapabilityEvidence` **0 行**满足 `resumeEvidenceId IS NULL AND resultArtifactId IS NULL`。
- exactly-one-source XOR 成立；`type ↔ pointer` 一致。
- `ProjectResult.planId → ActionPlan` Restrict；`ProjectResult → ResultArtifact` Cascade；来源指针 Restrict。
- `KnowledgeGap` / `CareerGoal` 已删除。
- 投影可幂等重跑（`created=0`）。

---

## 8. 验证 SQL / acceptance criteria

**验证 SQL（只读，Phase 4 执行）**：

```sql
-- ① 死表已删
SELECT to_regclass('public."KnowledgeGap"') IS NULL AS kg_gone,
       to_regclass('public."CareerGoal"')   IS NULL AS cg_gone;

-- ② 无 NULL 指针（应为 0）
SELECT count(*) AS null_pointer_rows
FROM "CapabilityEvidence"
WHERE "resumeEvidenceId" IS NULL AND "resultArtifactId" IS NULL;

-- ③ 无「双指针」行（应为 0）
SELECT count(*) AS dual_pointer_rows
FROM "CapabilityEvidence"
WHERE "resumeEvidenceId" IS NOT NULL AND "resultArtifactId" IS NOT NULL;

-- ④ type↔pointer 一致（应为 0）
SELECT count(*) AS type_mismatch_rows
FROM "CapabilityEvidence"
WHERE ("type" = 'RESUME_EVIDENCE')         <> ("resumeEvidenceId" IS NOT NULL)
   OR ("type" = 'PROJECT_RESULT_EVIDENCE') <> ("resultArtifactId" IS NOT NULL);

-- ⑤ 约束存在
SELECT conname FROM pg_constraint
WHERE conrelid = 'public."CapabilityEvidence"'::regclass
  AND conname IN ('ce_exactly_one_source','ce_type_pointer_consistent');
```

**Acceptance criteria**：上述 ②③④ 均为 **0**，① 为 `true`，⑤ 返回 2 条；再叠加全量回归 `tsc`(0) / `npm test`(fail=0) / `next build`(success)。

---

## 9. DECISION REQUEST → Codex 已裁决（修订版）

| # | Codex 裁决 | 落实 |
|---|---|---|
| **MR-DR1** | **有条件批准**：DMD-S5 保持**严格** `RESUME_EVIDENCE`（Scope A）；`USER_STATEMENT` 作为**独立、明确、一次性**的 QA residue cleanup（Scope B），**不泛化**为「所有无 pointer 行」 | §4 Phase 2 |
| **MR-DR2** | **批准**：迁移生命周期明确为 **Migration A → Application Projection → Migration B**；应用步骤不伪装成 SQL migration 内步骤 | §3 |

---

## 10. 交付确认（本轮）

| 项 | 结果 |
|---|---|
| 是否修改 `schema.prisma` | **否** |
| 是否创建 / 执行 migration | **否** |
| 是否修改任何数据 | **否**（探针为只读 `SELECT`/`count`） |
| 是否修改 `src` / `tests` / `package.json` / 其他 docs | **否** |
| 是否启动服务 | **否** |
| 是否可提交 Codex Final Review | **可提交**（MR-DR1 / MR-DR2 已由 Codex 裁决并落实，见 §9） |

**本轮停止。Migration 落地（建 migration / 改 schema / 改数据）仍绝对冻结。**
