# T3-A2-3 · Capability Identity & Adoption Consistency（正式契约）

> **状态**：**IMPLEMENTED / 待 ChatGPT 验收**（2026-09-18）
> **性质**：**A2-1 的定点契约收紧 + 全 writer 统一 enforcement**，**不是**新增 AI 功能，**不是**重新实现 A2-1。
> **范围**：`0 migration` / `0 schema change` / `0 new index` / `0 new table` / `0 new API`。
> **执行模型**：WorkBuddy（Kimi K2.7 Code）；架构裁决：ChatGPT；独立技术审查：DeepSeek Harness。

---

## 0. 沿革声明（不伪造为"历史上已冻结"）

本文档记录的是 **T3-A2-3 阶段新增/收紧** 的契约。其中：

| 内容 | 沿革 |
|---|---|
| §6.1 七条 normalization 契约 | **既有冻结**：`docs/t3-data-model-design-v1.md` §6.1（Rev.2 / BLOCKER D2） |
| `src/domain/capability/key.ts` 的实现 | **A2-2 引入**（当时仅服务于 AI 建议层的 key 规范化） |
| 「**所有 Capability writer 都必须满足 §6.1**」 | **A2-3 新确立**（本文档 §3） |
| A2-1 `declareFromProjectArtifact` 的 key 契约收紧 | **A2-3 新确立**（本文档 §2；ChatGPT 明确批准） |
| Resume Projection 写边界纳入同一契约 | **A2-3 新确立**（本文档 §4） |
| 语义 alias / merge | **仍延期**（本文档 §5） |

---

## 1. A2-3 目标

**唯一目标**：

> 所有**真正写入 `Capability` 的 writer**，都必须遵守统一的 §6.1 canonical key 契约。

**明确不做**：不新增 AI 功能；不引入别名/合并/语义等价；不改变已 CLOSED 的 A2-1 事务、锁序、证据并发机制；不改变 A2-2 分析策略。

---

## 2. A2-1 定点契约收紧

### 2.1 契约变化（唯一变化点：`key`）

| | A2-1（收紧前） | A2-3（收紧后） |
|---|---|---|
| `key` 契约 | 非空字符串（`z.string().trim().min(1)`） | **可归一为合法 canonical Capability key** |
| 归一化 | **无**（原样透传） | 复用 `domain/capability/key.ts`（§6.1 唯一来源） |
| 非法 key 行为 | 原样写库 | **拒绝**：HTTP **400 `VALIDATION_FAILED`**，**零写入** |

> 这是**显式契约收紧**，不是重新实现 A2-1。

### 2.2 明确不变的部分（逐项）

endpoint（`POST /api/project-results/:id/evidence`）、method、body shape（`{artifactId,key,label}`，`.strict()`）、认证、ownership、跨用户 404、SUBMITTED 闸门（422 `RESULT_NOT_SUBMITTED`）、凭据 URL 闸门（422）、**201（首次）/ 200（幂等）**、证据幂等、事务边界、**锁序（ProjectResult → Capability）**、Evidence 插入语句、`CONFIRMED` 语义、Skill（零写入）。

### 2.3 错误码

**不新增任何错误码**。非法 key 复用既有 `VALIDATION_FAILED`（既有映射 → **400**）。
写边界兜底产生的 `INVALID_KEY` outcome 同样是 `VALIDATION_FAILED` → 400。

### 2.4 校验位置（双层，同一契约）

```
Handler（body 级，先于任何资源查询）
  validateCapabilityKey(body.key)  ──不合法──▶ 400 VALIDATION_FAILED（零写入）
        │ 合法：传归一后的 canonical key
        ▼
Repository 写边界（constructional guarantee）
  validateCapabilityKey(key)       ──不合法──▶ { kind: 'INVALID_KEY' } → 400（零写入）
        │ canonicalKey
        ▼
  INSERT Capability ... ON CONFLICT ("userId", key) DO NOTHING
```

- **Handler 级**保证 400 与既有 body 契约（schema 校验）同级优先，不因资源存在性而变化。
- **Repository 级**是「**D 方案：Domain 规则 + Repository 写边界强制**」的落点：即使未来出现新的调用方，也无法把非法 key 写进 `Capability`。

---

## 3. §6.1 是唯一 normalization 来源

- 唯一实现：`src/domain/capability/key.ts`（`normalizeCapabilityKey` / `validateCapabilityKey` / `CAPABILITY_KEY_MAX_LENGTH`）。
- 规则（**既有冻结**，`t3-data-model-design-v1.md` §6.1 七条）：NFKC → 大小写统一 → 去首尾空白 → 规范连续空白 → **保留** `.` `+` `#` → **不使用** `normalizeForMatch` → **不执行** Match 的删标点规则。
- **禁止**：`normalizeForMatch`、`normalizeFingerprintText`、任何自实现归一化、截断 key。
- 长度上限 `CAPABILITY_KEY_MAX_LENGTH = 64`（**实现取值**；冻结文本未给数值 → 见 §7 待裁决）。
- 字符集白名单：`/^[\p{L}\p{N} .+#_-]+$/u`。

### 3.1 与 Match / fingerprint 归一化的关系（FACT）

- `normalizeForMatch`（`src/domain/jd/preprocess.ts:54`）删除 `.`、空格等 → `.NET`→`net`、`Node.js`→`nodejs`，并**保留** `&`、emoji 等 §6.1 白名单外字符 → 产出 `r&d`、`emoji😀` 等**不能作为 Capability key** 的值。
- `normalizeFingerprintText` 服务于 Q8 `contentFingerprint`，与 key 无关。
- 三个规则域**互相独立**，不得交叉套用（§6.1 第 6/7 条）。

---

## 4. Capability writer 清单与 enforcement（A2-3 审计结论）

生产代码中真正写入 `Capability` 的位置只有 3 处（其余均为测试夹具 / 脚本造数）：

| # | Writer | 位置 | key 来源 | A2-3 处置 |
|---|---|---|---|---|
| 1 | **A2-1 回流声明** | `repositories.ts` `declareFromProjectArtifact` | 请求 body `key` | **写边界强制** `validateCapabilityKey`；非法 → `INVALID_KEY` → 400，零写入 |
| 2 | **AI 建议层（A2-2）** | `src/domain/ai/analyze-project.ts` `sanitizeCandidates` | 模型输出 `key` | **A2-3 不修改**（已合格）：复用 key.ts 归一；不合法 → 502 `AI_ANALYSIS_INVALID_RESPONSE` |
| 3 | **Resume Projection** | `repositories.ts` `projectConfirmedSkills` | `Skill.key = normalizeForMatch(title)` | **写边界强制** `validateCapabilityKey`：可归一 → 用 canonical key 查/写；**不可归一 → 跳过**（`skipped`，fail closed） |

另：`confirm`（`repositories.ts` `confirm`）只写 `status`，**不写 key**，故不受本契约约束（其唯一性由独立源码守卫保证）。

### 4.1 writer #3 审计证据（C-3）

**审计问题 A：Resume Projection 产出的 key 是否已经满足 §6.1？**

split 成两个可核验命题：

**（a）现有数据** —— 满足（只读实测）：

| 对象 | 样本量 | `key !== normalizeCapabilityKey(key)` | `validateCapabilityKey` 不通过 | 最长 key |
|---|---|---|---|---|
| `Skill.key` | 177 | **0** | **0** | 31 |
| `Capability.key`（全部） | 49 | **0** | **0** | 31 |
| ↳ `RESUME_PROJECTION` | 36 | **0** | **0** | 10 |
| ↳ `PROJECT_RESULT` | 13 | **0** | **0** | 31 |

**（b）writer 是否**结构性**保证 —— **不满足**（可复现反例，用真实函数实测）：

| 输入 title | `normalizeForMatch` 产出（= Skill.key） | §6.1 结果 | 判定 |
|---|---|---|---|
| `ＰＹＴＨＯＮ` | `ｐｙｔｈｏｎ` | `python` | **非 canonical**（该函数无 NFKC） |
| `ＡＢＣ` | `ａｂｃ` | `abc` | 非 canonical |
| `ﬁnance` | `ﬁnance` | `finance` | 非 canonical（连字） |
| `①②` | `①②` | `12` | 非 canonical（兼容字符） |
| `R&D` / `SaaS & PaaS` | `r&d` / `saas&paas` | — | **校验拒绝**（白名单外） |
| `100%` / `emoji 😀` / `<b>html</b>` | 同左 | — | 校验拒绝 |
| 80 字符 title | 80 字符 key | — | 校验拒绝（超 64） |

**结论**：现有数据合规属**巧合**（历史数据恰好都是 ASCII 常规词），writer 本身**不保证**契约。
因此按指令 C-3 采取「**不满足 → 在 writer 边界统一调用现有 key.ts**」，而非 exemption。

**处置细节**：`Skill` 侧 key 的**派生规则（`normalizeForMatch`）不变**（不改 Skill schema、不改简历解析语义）；仅在 Capability **写边界**按 §6.1 归一 + 校验。除 key 外，Resume Projection 的业务语义（状态 / `level` / `source` / 证据按 `(source, excerpt)` 收敛 / `unchanged` 幂等）**均未改变**。

---

## 5. 语义 alias / merge —— 继续延期

**绝对禁止**（A2-3 范围内）：

```
Node.js → NodeJS        .NET → net
React → React 18        Python → Python Programming
```

- A2-3 只允许 **§6.1 的确定性字符串归一化**。
- **不新增** `CapabilityAlias` / `CapabilityMerge` / `CapabilityIdentityService` / 新 service 层 / 新表。
- 既有冻结仍有效：`t3-data-model-design-v1.md` §6.3「优先避免 false merge」、§6.5「`Node.js`/`NodeJS` 语义别名**不在本次 schema 设计解决**」、§5.2「规范化后同形但语义不同 → 不合并」。

---

## 6. C-4：DEFERRED

为已有 `Capability` 扩展 `label` 返回值等 API/UI 变动 → **本轮不实施**，不为其扩大 API/UI 范围。

---

## 7. 已知边界（如实记录，非缺陷隐藏）

| # | 边界 | 说明 |
|---|---|---|
| B-1 | 空白折叠 vs "换行必须拒绝" | §6.1 第 4 条要求「规范连续空白（折叠为单个空格）」，而 A2-3 指令的测试清单把「换行」列为 rejection。**二者不可同时成立**：实测 `"machine\nlearning"` → `"machine learning"`（合法）；`"\n\n"`（纯空白）→ 归一后为空 → **拒绝**。本阶段**未修改** key.ts（A2-2 已 CLOSED 的 §6.1 唯一来源），按冻结契约的真值实现并上报待裁决。 |
| B-2 | `#` 的两域巧合 | `#` 不在 `normalizeForMatch` 的删除集中，故 `C#` 在两条路径下**恰好同值**（`c#`）；这不代表两域契约相同（`.NET` / `Node.js` 即不同）。 |
| B-3 | writer #3 跳过语义 | 不可归一为合法 canonical key 的源条目计入 `skipped`（不投影）。与既有「证据不可核验即跳过（fail closed）」同向；现有数据实测 0 命中，故对现有行为**无实际影响**。 |
| B-4 | 手动声明 vs AI 建议 | writer #1 与 #2 现均经 §6.1 → 同一 `(userId, assumed key)` 收敛一致；此前「AI 给 `docker`、手输 `Docker` 产生两行」的缺口**已闭合**。 |
| B-5 | `Capability.source` 不是 provenance | `source` 为单值列，会被两条路径互相覆盖（既有事实）→ 不得作为 provenance 判据（真实判据仍是 `CapabilityEvidence.type` + 指针）。 |

---

## 8. 验收基线（本阶段实测）

| 门禁 | 结果 |
|---|---|
| `tsc --noEmit` | EXIT 0 |
| `npm test` | 见最终报告（真实数字） |
| `next build` | EXIT 0 |
| `next start` | listen OK |
| `qa-release`（新增 K1–K3） | 见最终报告 |
| `smoke-e2e` | SMOKE DONE |

**新增测试**：`tests/capability-key-contract.test.ts`（Domain）、`tests/project-result-key-contract.test.ts`（DB / API / 并发 / 第三 writer）。
**纪律**：新增 DB 测试**禁止 `{ skip }`**，DB 不可达必须 FAIL。

---

## 9. 与既有文档的关系

| 文档 | 关系 |
|---|---|
| `t3-data-model-design-v1.md` §6 | §6.1 契约的**来源**；A2-3 未修改其规则，仅确立「所有 writer 都受其约束」 |
| `t3-architecture-freeze.md` | D1 / D4 / D5 不变；A2-3 不触碰 Freeze |
| `t3-q8-q10-q11-canonical-contract.md` | 该文档管 **artifact URL / fingerprint / dedupeKey**，与 Capability key **规则域不同**，不得互相套用 |
| `HANDOFF.md` | A2-3 状态已同步 |
