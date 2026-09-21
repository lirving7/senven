-- T6-4-A：Act 执行实体（Confirm → Execute → Result 状态机）
-- 独立于 AgentRun/AgentProposal：proposal 保持 T5-B 冻结语义（status=ACTIVE 不变）。
-- CHECK 约束兜底状态机白名单与 Act Tool 白名单（schema 无法表达 CHECK —— 与 T6-2 stage 同类已裁决保留 drift）。

CREATE TABLE "AgentAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT,
    "proposalId" TEXT,
    "toolName" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "idempotencyKey" TEXT NOT NULL,
    "result" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAction_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_status_check"
  CHECK ("status" IN ('PROPOSED', 'CONFIRMED', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'CANCELLED'));

ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_tool_whitelist_check"
  CHECK ("toolName" IN ('create_career_goal', 'attach_jd_to_goal', 'create_application', 'update_application_stage', 'create_learning_task'));

CREATE UNIQUE INDEX "AgentAction_idempotencyKey_key" ON "AgentAction"("idempotencyKey");
CREATE UNIQUE INDEX "AgentAction_proposalId_key" ON "AgentAction"("proposalId");
CREATE INDEX "AgentAction_userId_idx" ON "AgentAction"("userId");
