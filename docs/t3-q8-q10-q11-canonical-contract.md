# T3 · Q8 / Q10 / Q11 正式契约（含 A2-0 确认的 URL canonicalization）

> 状态：**正式成文**（2026-09-18，T3-A2-1 阶段）
> 目的：Q8 / Q10 / Q11 此前**仅存在于 `HANDOFF.md`**，未进入 `docs/`。本文件将其正式落入设计文档体系，并把 artifact URL canonicalization 细节固化为可核验契约。

## 0. 沿革声明（**不作历史追溯**）

本文件**不是**"历史上早已冻结"的文本。如实记录：

| 项 | 事实 |
|---|---|
| Q8 / Q10 / Q11 的原始记录位置 | 仅 `HANDOFF.md` §5（三条要点式表述） |
| Q10 中「fragment / pathname 大小写」的具体规则 | 在 T3-A0 冻结文本（`docs/t3-architecture-freeze.md`、`t3-data-model-design-v1.md`、`t3-schema-design-v1.md`、`t3-migration-design-v1.md`）中**均无记载**；`docs/` 内 `fragment` / `pathname` / `hash` 零命中 |
| 2026-09-18 之前的实现行为 | `src/domain/project-result/project-result.ts` 曾执行 `url.hash = ''`（删除 fragment）与 `url.pathname = url.pathname.toLowerCase()`（无条件小写 pathname），并在 `tests/project-result-domain.test.ts` 中以测试固化该行为 |
| 规则确立方式 | 由 **T3-A2-0 correctness patch**（2026-09-18，ChatGPT 裁决 / DeepSeek Harness 复核）修正并正式确认；修正后行为有独立测试与反例守卫 |
| 历史数据影响 | A2-0 实测：受影响历史行 **0**（唯一存量行 url 全小写且无 fragment，被移除的两处操作对其为 no-op），故 `dedupeKey` 无失配、无需回填 |

即：本契约中的 URL canonicalization 细节属**经修正后确认**，而非"一直如此"。

---

## 1. Q8 · `contentFingerprint`（ProjectResult 内容指纹）

- **Draft** 阶段 `contentFingerprint = NULL`；`submit` 时由**服务端**计算。
- 算法：`SHA-256(canonical JSON { sourceStepId, title, summary })`。
- 规范化：先对三个字段各做 `NFKC` → `CRLF/CR → LF` → `trim`（实现：`normalizeFingerprintText`）。
- **不含**：`planId` / `userId` / 时间戳 / 随机数 / UUID / `createdAt`（确定性要求，见 `docs/t3-data-model-design-v1.md` §7.2，编号 **R2**）。
- 唯一性：`@@unique([userId, planId, sourceStepId, contentFingerprint])`；同一 ActionStep 不同 fingerprint **允许多个** Result。
- 代码锚点：`src/domain/project-result/project-result.ts:computeContentFingerprint`。

---

## 2. Q10 · `dedupeKey` 与 artifact URL canonicalization

### 2.1 身份构造

```
dedupeKey = SHA-256(canonical JSON { kind, identity })
identity  = 有 url ? normalizeArtifactUrl(url) : normalizeFingerprintText(excerpt ?? '')
kind      = 大写（toUpperCase）
```

### 2.2 URL canonicalization 契约（**T3-A2-0 正式确认**）

| # | 规则 | 说明 |
|---|---|---|
| 1 | `protocol` → lowercase | |
| 2 | `hostname` → lowercase | **仅** host/hostname 做 lowercase |
| 3 | default port → 自动规范化 | 由 WHATWG URL 解析完成（如 `https://h:443/a` → `https://h/a`）；非默认端口保留 |
| 4 | **`pathname` 保持原始大小写** | **禁止** `pathname.toLowerCase()` |
| 5 | 非根 pathname → 去末尾斜杠 | 根路径 `/` 保留 |
| 6 | `query` 保留 | **不排序**、不做第三方语义等价 |
| 7 | **`fragment` 保留** | **禁止** `url.hash = ''` |
| 8 | 首尾空白 → trim；解析失败 → 回退 trim 后原串 | |
| 9 | 不做任何第三方 URL 语义等价变换 | |

### 2.3 必须成立的区分（反例守卫）

```
/a      != /A
/a      != /a#
/a#f    != /a#other
/A/B    != /a/b
/a?b=2&a=1 != /a?a=1&b=2
```

仍应**正确归并**的：host 大小写、协议大小写、`/a/` ↔ `/a`（末尾斜杠）、`/a/#f` ↔ `/a#f`、首尾空白。

### 2.4 执行顺序（**先 pathname 去斜杠，再保留 fragment**）

规则 5 与规则 7 的**施加顺序**是被规范定义的，不可依赖「完整 href 是否以 `/` 结尾」这类启发式：

```
先：对 pathname 去除非根末尾斜杠
后：保留 fragment（原样）
```

据此：

| 输入 | 规范化输出 | 说明 |
|---|---|---|
| `https://h/a/#frag` | `https://h/a#frag` | 斜杠在 pathname 内，fragment 不影响去斜杠 |
| `https://h/a#frag` | `https://h/a#frag` | 同上 |
| `https://h/a/?q=1` | `https://h/a?q=1` | 带 query 同样生效 |
| `https://h/a/?q=1#f` | `https://h/a?q=1#f` | 带 query + fragment 同样生效 |
| `https://h/a/` | `https://h/a` | |
| `https://h/` | `https://h/` | 根路径保留 |
| `https://h/a//` | `https://h/a/` | 只去**一个**末尾斜杠 |

> ⚠️ **实现沿革（非冻结历史）**：T3-A2-1 首版曾按「完整 href 是否以 `/` 结尾」判断去斜杠，导致
> `https://h/a/#frag` 保留斜杠、与 `https://h/a#frag` 产生 false split（即 O-B）。
> 该行为**不是**冻结规则，已于 O-B 修正中按上述执行顺序改正。正式规则始终以 Q10 为准：
> **非根 pathname trailing slash 去除，fragment 保留。**

### 2.5 已知边界（如实记录）

- 末尾裸 `#`（空 fragment）保留，故 `https://h/a#` 与 `https://h/a` 视为**不同** identity（规则 7 的必然结果）。
- 本契约**不**做第三方 URL 语义等价（规则 9），故 query 参数顺序不同即视为不同 identity。

### 2.6 禁止回归

```text
禁止 pathname.toLowerCase()
禁止 url.hash = ''
禁止用 u.hash 判断空 fragment 是否存在
禁止按「完整 href 是否以 / 结尾」判断去斜杠（会对带 fragment/query 的 URL 失效）
```

代码锚点：`src/domain/project-result/project-result.ts:normalizeArtifactUrl`；
测试锚点：`tests/project-result-domain.test.ts`、`tests/project-result-return-domain.test.ts`（含 `/A/B ≠ /a/b` 反例守卫）。

---

## 3. Q11 · 重复 artifact 的响应语义

- 同一 `(resultId, dedupeKey)` 重复提交 → 命中唯一约束 `@@unique([resultId, dedupeKey])` → **不产生重复行**。
- 服务端以 `INSERT ... ON CONFLICT ("resultId","dedupeKey") DO NOTHING RETURNING *` 实现，冲突时**返回已存在行**。
- HTTP 语义：**200**（非 409），**不产生 `ARTIFACT_DUPLICATE` 错误码**。
- 代码锚点：`src/db/repositories.ts:projectResults.addArtifact`；`src/http/handlers/project-results.ts:createAddProjectResultArtifactHandler`。

---

## 4. T3-A2-1 新增：PROJECT_RESULT 回流来源

| 项 | 值 | 说明 |
|---|---|---|
| `Capability.source` | `PROJECT_RESULT` | 正式常量 `PROJECT_RESULT_SOURCE`；**禁止散落硬编码** |
| `CapabilityEvidence.type` | `PROJECT_RESULT_EVIDENCE` | 正式常量 `PROJECT_RESULT_EVIDENCE_TYPE`；与活库 CHECK `ce_type_pointer_consistent`（migration `20260917232000`）取值一致 |
| provenance 指针 | `CapabilityEvidence.resultArtifactId` → `ResultArtifact` → `ProjectResult` | |
| 证据唯一性 | partial unique index `CapabilityEvidence_capabilityId_resultArtifactId_key`（migration `20260918150500`，`WHERE "resultArtifactId" IS NOT NULL`） | 只覆盖 ProjectResult 侧；**不为 resumeEvidenceId 建唯一索引**（属独立延期事项 D-2） |
| 确认闸门 | 存在 `PROJECT_RESULT_EVIDENCE` 的能力：需「`ResultArtifact.url` 非空 且 `ProjectResult.revokedAt IS NULL`」；**不存在**时沿用既有 Resume 判据 `url ∥ excerpt` | 来源分域，见 `R3` |
| 回流状态 | 只创建 `UNCONFIRMED` | 已存在的 Capability **只读**，不 UPDATE `status` / `level` / `source` |
| Skill | **不写** | 依赖类型 + 源码 guard + DB 测试三重证明 |

> `Capability.source` 为**单值列**，不是 provenance 的唯一判据；真正 provenance 由 `CapabilityEvidence.type` + `resumeEvidenceId` / `resultArtifactId` 决定（多来源存储形态属 T3-A0 明确延期项）。
