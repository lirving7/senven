# JobPilot · AI 求职工作台

JobPilot 是一个把「真实经历」变成「可投递、可解释、可追溯求职成果」的本地优先 Web 应用。它围绕一条完整的产品闭环工作：从求职目标与岗位分析开始，到简历对照、缺口分析、行动计划、学习与项目执行、成果与能力沉淀，最终进入作品集、投递跟踪、模拟面试与总览面板。

> 核心原则：**AI 只提供建议，永远不能替你制造事实。** 任何能力认定（CONFIRMED）、简历事实、投递动作都只能由用户显式确认产生。

## 核心产品流程

```
User
 → CareerGoal（求职目标）
 → JD（岗位解析）
 → Resume（简历事实逐条确认）
 → Match（简历 × 岗位对照）
 → Gap Analysis（缺口分析）
 → ActionPlan（行动计划：[学习] / [实践] / [项目]）
 → Learning / Project（学习任务与项目执行）
 → ProjectResult（项目成果 + 提交凭据）
 → Capability（能力沉淀，经用户确认）
 → Portfolio（作品集策展，可追溯到成果与凭据）
 → Application（投递跟踪，六阶段）
 → Interview（模拟面试，AI 动态追问与点评）
 → Dashboard（事实型总览面板）
 → Agent Act（受控执行：AI 提案 → 用户确认 → 系统执行）
```

## 核心功能

- **简历事实层**：上传/录入简历，AI 解析后**逐条**由用户确认（CONFIRMED / UNCONFIRMED），未确认内容不进入任何对照与建议链路；支持 PDF 导出。
- **岗位解析**：粘贴 JD，解析为分级要求清单，保留历史版本。
- **岗位对照（Match）**：简历与 JD 逐条比对，产出 MATCH / ENHANCE / MISSING 三态与缺口清单；对照结果可回放，刷新不重复计费。
- **行动计划**：从缺口生成三类步骤（学习 / 实践 / 项目），每步可发起 **AI 执行指导**（suggestion-only，不落库）。
- **学习任务**：记录学习进度，可追溯、可归档。
- **项目成果**：DRAFT → SUBMITTED → REVOKED 三态；成果可挂载真实凭据（代码仓库 / 在线 Demo / 文档 / 截图等），去重存储；支持撤销（REVOKED 保留全部历史关系）。
- **项目分析**：AI 对已提交成果给出优势 / 不足 / 证据引用 / 下一步建议（全部为建议，不写入任何能力）。
- **能力沉淀**：成果证据可回流为 UNCONFIRMED 候选能力；**唯一确认入口**由用户显式操作；能力投影（用于行动计划）只认 CONFIRMED 且有证据者。
- **作品集**：把已提交成果策展为作品集；展示「成果 → 凭据 → 能力」来源矩阵；已撤销成果保留历史并明示标注；作品集操作永不删除成果 / 凭据 / 能力。
- **投递跟踪**：六阶段（APPLIED / SCREENING / INTERVIEWING / OFFER / REJECTED / WITHDRAWN）；「已投递」始终表示累计投递总数。
- **模拟面试**：可关联真实 JD（grounding）、最多 8 轮动态追问、历史上下文含上一轮问答、AI 点评仅供练习参考；答案提交后不可修改。
- **总览面板**：纯事实聚合（目标 / 漏斗 / 近期投递 / 活动 / 提醒 / 面试统计），零 AI 评分。
- **AI 求职助手（Agent）**：基于简历与对照结果生成行动建议提案；**Agent Act 受控执行**仅支持 5 个白名单工具（见下）。

## 技术栈

- **框架**：Next.js 15（App Router）+ React 19 + TypeScript（strict）
- **数据库**：PostgreSQL 16 + Prisma 6
- **认证**：Cookie Session + scrypt 密码哈希（自研，无第三方依赖）
- **PDF**：@react-pdf/renderer（导出）、pdf-parse（解析，`serverExternalPackages` 隔离）
- **校验**：Zod（API body 全部 strict schema）
- **测试**：Node.js 内置 test runner（`node --experimental-strip-types --test`），1032 用例

## 项目架构

```
app/            # Next.js 页面与 API 路由（route.ts 仅做参数解析 + handler 调用）
  _lib/         # 前端纯逻辑层（不 import src/，规避打包态 node: 限制）
  _components/  # 通用 UI 组件
src/
  http/handlers/   # 业务 handler（鉴权、schema 校验、错误映射的唯一执行点）
  domain/          # 领域逻辑（match / capability / interview / agent / act ...）
  agent/           # Agent 工具层 + Runtime（计划）+ Act 执行器
  llm/             # LLM Provider 抽象 + 配额（quota）+ usage gate
  db/              # Prisma client + repositories（全部查询按 userId 隔离）
  auth/            # 认证服务
  ports/           # 端口/依赖接口定义
prisma/          # schema + 17 个 migrations
tests/           # 全量测试（含隔离 / 守卫 / 契约 / e2e）
scripts/         # QA 与运维脚本（含 dev-only 引导账号）
```

### Agent / Act 架构

- **Plan（建议）**：AgentRuntime 基于用户数据生成 JSON 计划提案（PROPOSED），受独立配额约束。
- **Act（执行）**：提案由用户确认后进入 CONFIRMED → EXECUTING → SUCCEEDED / FAILED（或 CANCELLED）。状态机转移表唯一，`PROPOSED → EXECUTING` 被禁止；Confirm ≠ Execute。
- **工具白名单（恰好 5 个，任何增删属契约变更）**：
  1. `create_career_goal`
  2. `attach_jd_to_goal`
  3. `create_application`
  4. `update_application_stage`
  5. `create_learning_task`
- **幂等**：每个 Action 携带 `sha256(toolName + canonicalJson(payload))` 幂等键；重复执行不产生重复事实。
- **失败语义**：EXECUTING → FAILED 不产生半成品事实（业务写入走既有事务性入口）。

## Fact Authority / 安全原则

- **AI 建议不能直接成为用户事实**：能力确认、简历事实确认、投递动作均有且仅有一个用户显式入口；AI 产出一律为 suggestion-only（不落库或仅落 UNCONFIRMED 候选）。
- **用户隔离**：所有查询以服务端 session userId 为唯一权威；请求体出现 `userId` 会被 strict schema 直接拒绝（400）；跨用户访问与「资源不存在」返回完全一致的 404（无 existence oracle）。
- **LLM 配额**：每个 LLM 特性独立 rolling-window 配额；超限返回 429 + `Retry-After`，前端不自动重试。
- **投递不自动化**：Application 仅在用户操作或用户确认的 Act 提案下创建/更新，系统绝不代替用户向外部渠道投递。
- **面试点评不构成能力认定**：Interview feedback 仅供练习参考，不写入能力体系。
- **提示注入防御**：用户内容以定界标签隔离注入 prompt；检索语料与用户数据严格按 userId 隔离。

## 数据库与 Migration

- 17 个迁移（`prisma/migrations/`），全部为纯 DDL，可公开审计；无 seed 内置账号。
- 本地开发可用 `scripts/dev-bootstrap-account.mjs --local-only` 创建开发账号：
  - `NODE_ENV=production` 硬性拒绝执行；必须显式 `--local-only`；
  - 邮箱/密码只能经环境变量提供，无默认值，密码永不打印；
  - 仅创建普通用户（无任何特权），幂等可重复执行。

## 本地运行

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
#    编辑 .env，填入本地 PostgreSQL 连接串等

# 3. 创建数据库结构（本地库）
npx prisma migrate deploy

# 4. （可选）创建本地开发账号
node --experimental-strip-types scripts/dev-bootstrap-account.mjs --local-only

# 5. 启动
npm run dev
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串（必填） |
| `LLM_API_KEY` | 外部 LLM API Key（V1 允许外部 LLM；留空则相关 AI 特性不可用） |
| `LLM_BASE_URL` | LLM API Base URL（可选） |
| `LLM_MODEL` | 模型名（可选） |
| `FACT_GUARD_LOG` | 事实层校验调试日志开关（确定性校验本身不可关闭） |
| `DEV_SEED_EMAIL` / `DEV_SEED_PASSWORD` | 仅 dev-bootstrap 脚本使用（本地开发） |

## 测试

```bash
npm test
```

覆盖：认证、各业务域单元与 API 契约、用户隔离（interview / learning / rag isolation）、
事实安全（resume-safety）、Agent 工具守卫与指纹守卫（agent-guards / agent-tool-guards）、
Act 状态机与幂等、Dashboard 聚合、端到端（e2e-postgres）等。

## Build

```bash
npx tsc --noEmit   # 类型检查
npm run build      # 生产构建
```

## 当前状态

- V1 全部核心闭环 + V2 增强（项目分析增强、作品集策展、模拟面试闭环）已完成，并通过
  全链路集成审计与统一 QA（0 个未修复 P0/P1）。
- 已知记录在案的次要问题（P2/P3）与未开始的扩展方向见 Roadmap。

## Roadmap

- 模拟面试：复盘报告、知识缺口（KnowledgeGap）视图、更多轮次策略。
- 作品集：成员级排序、导出分享。
- 面试与投递跟踪的关联（可选 FK）。
- 能力回灌：以面试表现辅助更新能力视图（仍需用户确认）。
- 更完善的分页与列表体验。
