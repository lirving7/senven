-- T6-1 · CareerGoal 求职目标系统（Migration #15）
-- 授权范围：CareerGoal + CareerGoalJobDescription + FK/indexes/unique/CHECK + Current 部分唯一索引。
-- 本 SQL 为手工编写并经人工审阅（授权书 §十四：create-only 等价流程）；
-- 不含任何对既有表（含 T5-A RAG / T5-B Agent / #1–#14 结构）的修改，不含 seed 数据。
-- 注意：`migrate dev` 在本库存在 drift-reset 风险（B-1/B-2 事故），故本迁移不经 dev 生成。

-- ---------------------------------------------------------------
-- 1. CareerGoal
-- ---------------------------------------------------------------
CREATE TABLE "CareerGoal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "location" TEXT,
    "employmentType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareerGoal_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------
-- 2. CareerGoalJobDescription（M:N，沿用 PortfolioProjectResult 范式：不存 userId）
-- ---------------------------------------------------------------
CREATE TABLE "CareerGoalJobDescription" (
    "id" TEXT NOT NULL,
    "careerGoalId" TEXT NOT NULL,
    "jdId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CareerGoalJobDescription_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------
-- 3. FK（两端 Cascade）
-- ---------------------------------------------------------------
ALTER TABLE "CareerGoal" ADD CONSTRAINT "CareerGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CareerGoalJobDescription" ADD CONSTRAINT "CareerGoalJobDescription_careerGoalId_fkey" FOREIGN KEY ("careerGoalId") REFERENCES "CareerGoal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CareerGoalJobDescription" ADD CONSTRAINT "CareerGoalJobDescription_jdId_fkey" FOREIGN KEY ("jdId") REFERENCES "JobDescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------
-- 4. 索引与唯一约束
-- ---------------------------------------------------------------
CREATE INDEX "CareerGoal_userId_idx" ON "CareerGoal"("userId");

CREATE UNIQUE INDEX "CareerGoalJobDescription_careerGoalId_jdId_key" ON "CareerGoalJobDescription"("careerGoalId", "jdId");

CREATE INDEX "CareerGoalJobDescription_jdId_idx" ON "CareerGoalJobDescription"("jdId");

-- ---------------------------------------------------------------
-- 5. CHECK（raw SQL 固定封闭值域；不使用 Prisma enum）
-- ---------------------------------------------------------------
ALTER TABLE "CareerGoal" ADD CONSTRAINT "CareerGoal_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'));

ALTER TABLE "CareerGoal" ADD CONSTRAINT "CareerGoal_employmentType_check" CHECK ("employmentType" IN ('FULL_TIME', 'PART_TIME', 'INTERNSHIP', 'CONTRACT'));

-- isCurrent = true 时 status 必须为 ACTIVE（授权书 §五）
ALTER TABLE "CareerGoal" ADD CONSTRAINT "CareerGoal_current_active_check" CHECK (NOT "isCurrent" OR "status" = 'ACTIVE');

-- ---------------------------------------------------------------
-- 6. Current Goal 部分唯一索引（方案 A；授权书 §五）
--    同一 userId 最多一个 isCurrent = true；不依赖 Prisma schema diff，
--    由机械守卫直接核验该索引存在。
-- ---------------------------------------------------------------
CREATE UNIQUE INDEX "CareerGoal_userId_current_key" ON "CareerGoal"("userId") WHERE "isCurrent";
