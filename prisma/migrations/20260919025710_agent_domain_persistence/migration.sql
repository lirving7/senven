-- T5-B-1 · Agent Domain Persistence（Migration #14）
--
-- ⚠️ 人工审阅记录（授权书 §14 / §15）：
--   `prisma migrate dev --create-only` 生成时**自动追加了 2 条未授权且具破坏性的语句**，
--   来源是 T5-A 已裁决的「预期 drift」（Prisma Schema 无法表达 generated stored 列与 GIN 索引）：
--       -- DropIndex            DROP INDEX "KnowledgeChunk_search_vector_gin";
--       -- AlterTable           ALTER TABLE "KnowledgeChunk" ALTER COLUMN "searchVector" DROP DEFAULT;
--   二者均命中 §14 明令禁止项（DROP INDEX / ALTER 既有 RAG 表），且会摧毁 T5-A 冻结结构，
--   故在应用前**人工移除**。本迁移只保留授权结构。
--
-- 授权结构（穷尽）：
--   1. AgentRun table
--   2. AgentProposal table
--   3. User → AgentRun CASCADE FK
--   4. AgentRun → AgentProposal CASCADE FK
--   5. AgentRun(userId) index
--   6. AgentProposal(runId, revision) unique
--   7. 4 个 CHECK（raw SQL 幂等登记）：AgentRun.status / AgentRun.goalKind / AgentProposal.kind / AgentProposal.status
--
-- 禁止（本文件确认不存在）：CREATE EXTENSION / pgvector / embedding / tsvector / DROP EXPRESSION /
--   DROP INDEX / ALTER 既有 RAG 表 / ALTER #10~#13 / INSERT 业务种子数据。

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goalKind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "modelVersion" TEXT,
    "semanticVersions" JSONB NOT NULL DEFAULT '{}',
    "promptTemplateVersion" TEXT NOT NULL,
    "quotaUsage" JSONB NOT NULL DEFAULT '{}',
    "providerRequestId" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentProposal" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "basedOnRefs" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentRun_userId_idx" ON "AgentRun"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProposal_runId_revision_key" ON "AgentProposal"("runId", "revision");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── T5-B-1：4 个 CHECK（raw SQL 幂等登记；沿用项目既有 DO $$ ... IF NOT EXISTS ... $$ 方式）───

-- AgentRun.v1 goalKind 白名单（v1 仅 CAREER_ASSISTANCE）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentRun_goalKind_check'
  ) THEN
    ALTER TABLE "AgentRun"
      ADD CONSTRAINT "AgentRun_goalKind_check"
      CHECK ("goalKind" IN ('CAREER_ASSISTANCE'));
  END IF;
END $$;

-- AgentRun.status 白名单（6 值；不得出现 CONFIRMED）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentRun_status_check'
  ) THEN
    ALTER TABLE "AgentRun"
      ADD CONSTRAINT "AgentRun_status_check"
      CHECK ("status" IN ('CREATED', 'PLANNING', 'PROPOSED', 'CANCELLED', 'FAILED', 'EXPIRED'));
  END IF;
END $$;

-- AgentProposal.kind 白名单（v1 仅 PLAN）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentProposal_kind_check'
  ) THEN
    ALTER TABLE "AgentProposal"
      ADD CONSTRAINT "AgentProposal_kind_check"
      CHECK ("kind" IN ('PLAN'));
  END IF;
END $$;

-- AgentProposal.status 白名单（v1 仅 ACTIVE；不得出现 SUPERSEDED / DISMISSED / CONFIRMED / EXECUTED）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AgentProposal_status_check'
  ) THEN
    ALTER TABLE "AgentProposal"
      ADD CONSTRAINT "AgentProposal_status_check"
      CHECK ("status" IN ('ACTIVE'));
  END IF;
END $$;
