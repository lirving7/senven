# T2→T3 桥接阶段 · 验收标准（v2 · 已冻结）

> **阶段标签**：T2→T3 桥接
> **上游**：V2 · T2 FINAL ACCEPTED / CLOSED
> **状态**：**已冻结**（2026-09-17，用户拍板）
> 下一步：数据 / 页面设计（见 `t2-t3-bridge-design.md`）

---

## 0. 冻结的范围

```
Skill CONFIRMED
      ↓
Capability 投影        ← 本阶段（补上唯一缺失的写入路径）
      ↓
ActionPlan
      ↓
ActionStep
      ↓
学习 / 项目入口         ← 本阶段
      ↓
   ─────────  T2→T3 桥接 到此为止  ─────────
      ↓
T3：项目成果 + Evidence
      ↓
Capability 回流         ← T3 阶段
```

| | 本阶段 |
|---|---|
| ✅ 做 | Capability 写入路径；Skill → Capability 投影；学习 / 项目入口 |
| ❌ 不做 | Capability 回流；LearningTask / ProjectTask / Portfolio 等新实体；修改 `ActionStep` 增加证据字段；复用 `KnowledgeGap`；提前进入完整 T3 |

**决策依据**：`ActionStep` 没有证据归属能力，强行加字段等于让桥接阶段承担 T3 成果系统的职责；且"完成任务 ≠ 获得能力事实"，会违反 A5/B5 事实安全原则。T3 出现真正的可核验证据（项目成果 / 代码 / 作品集 / GitHub）后，再设计 `Evidence → Capability` 回流，数据模型更自然。

---

## 1. 验收标准（B1~B8）

| 编号 | 标准 | 沿用 |
|---|---|---|
| B1 | **入口不自动生成**：从 ActionStep 进入学习 / 项目须用户显式点击；未点击时 LLM provider 零调用 | A1 |
| B2 | **归属隔离**：跨用户 404（不泄露存在性）；body 注入 userId 400 | A2 |
| B3 | **事务原子性**：生成失败（provider 崩溃 / 结构错误 / 写库失败）不留半成品 | A3 |
| B4 | **配额**：Gate 在 provider 之前；耗尽 429 + provider 零调用 + 留痕 `QUOTA_REJECTED(requestCount=0)` | A4 |
| B5 | **事实安全**：不得编造用户未确认的经历；指引只描述"要做什么"，不得声称用户已具备 / 已完成 | A5 |
| B6 | **执行推进**：ActionStep `TODO→IN_PROGRESS→DONE`，状态**只以服务端为准**，非法枚举 400 | A7 |
| B7 | **事实投影闭环**：CONFIRMED Skill 能形成可核验 Capability，且**不得凭空制造新的 CONFIRMED 事实** | 新增 |
| B8 | **独立验收**：新增 QA 独立验收（自带 fake provider，不复用开发者自测），覆盖 B1~B7 | T2 标准 |

### B7 子项（投影闭环的可测定义）

| 编号 | 标准 |
|---|---|
| B7.1 | **投影存在性**：简历事实确认（Skill → CONFIRMED）后，能力库出现对应的 **CONFIRMED** Capability |
| B7.2 | **幂等**：重复确认同一条事实不产生重复 Capability（以 `@@unique([userId, key])` 为准） |
| B7.3 | **证据同源**：投影出的 Capability 必须带可核验 `CapabilityEvidence`（excerpt 非空）；**无可用证据则不投影**（fail closed） |
| B7.4 | **单向**：投影仅 Skill → Capability，不得反向修改 Skill |
| B7.5 | **不凭空制造**：投影不得产生 CONFIRMED Skill 之外的任何新事实 |
| B7.6 | **可见性**：投影后 ActionPlan 的 `have` 由空态变为真实内容（3B「已有能力」不再恒为空） |

---

## 2. 全阶段回归

`tsc` 0 错误 / `npm test` 0 失败（跳过数保持既有值）/ `next build` / `qa-release` 49/49 / `smoke-e2e` SMOKE DONE。

---

## 3. 移交 T3 的验收标准（本阶段不做，先登记以免遗漏）

| 编号 | 标准 |
|---|---|
| T3-R1 | **回流证据锚点**：项目成果本身是实体，证据天然有归属（`ResumeProject` 模式可参考） |
| T3-R2 | **回流必须带可核验证据**：无证据不得产生新 Capability |
| T3-R3 | **幂等**：同一次成果不得重复回流 |
| T3-R4 | **可追溯**：新 Capability 能追溯到来源成果 |
| T3-R5 | **不越过用户确认**：回流产生的能力不得直接 CONFIRMED，须按事实安全规则待用户确认 |

---

## 4. 明确不做（沿用用户边界）

学习路线 / 技术地图 / 项目导师（T3 主体）；作品集 / 模拟面试 / 面试复盘（T4）；知识库 / RAG / Agent（T5）；Android / Kotlin / 端侧 LLM（T6）。
