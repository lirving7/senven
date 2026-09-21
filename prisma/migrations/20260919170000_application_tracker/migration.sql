-- T6-2 · Application Tracker（Migration #16）
-- 授权范围：JobApplication 扩展（position / careerGoalId / resumeVersionId / appliedAt / stage enum→text+CHECK /
-- jdId 正式 FK RESTRICT / careerGoalId+resumeVersionId FK RESTRICT / 新索引）。
-- 本 SQL 手工编写并经人工审阅（与 #15 同流程：hand-authored + migrate deploy，规避 migrate dev 的 drift-reset 风险）。
-- 原则（授权书 §三）：
--   * 非空数据库安全：appliedAt 以 createdAt 回填，不用 now() 覆盖历史；
--   * detect-and-fail：DRAFT/CLOSED/未知 stage、dangling jdId 一律让迁移显式报错停止，
--     禁止自动 NULL / 自动映射 / 删除（不静默破坏历史数据）；
--   * 不修改 #1–#15 的任何结构。

-- ---------------------------------------------------------------
-- 1. 新列（全部可空；appliedAt 先可空再回填再 NOT NULL）
-- ---------------------------------------------------------------
ALTER TABLE "JobApplication" ADD COLUMN "careerGoalId" TEXT;
ALTER TABLE "JobApplication" ADD COLUMN "resumeVersionId" TEXT;
ALTER TABLE "JobApplication" ADD COLUMN "position" TEXT;
ALTER TABLE "JobApplication" ADD COLUMN "appliedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------
-- 2. appliedAt 历史回填：appliedAt = createdAt（保留申请历史时间）
-- ---------------------------------------------------------------
UPDATE "JobApplication" SET "appliedAt" = "createdAt";
ALTER TABLE "JobApplication" ALTER COLUMN "appliedAt" SET NOT NULL;
ALTER TABLE "JobApplication" ALTER COLUMN "appliedAt" SET DEFAULT now();

-- ---------------------------------------------------------------
-- 3. 脏数据检测（detect-and-fail）——任何命中都让迁移失败并暴露问题
-- ---------------------------------------------------------------
DO $$
DECLARE
  bad_stages TEXT;
  dangling_jd TEXT;
BEGIN
  -- 3a. stage 必须能进入最终合法集合（DRAFT / CLOSED / 未知值 → 失败）
  SELECT COALESCE(string_agg(DISTINCT stage::text, ',' ORDER BY stage::text), '')
    INTO bad_stages
    FROM "JobApplication"
   WHERE stage::text NOT IN ('APPLIED', 'SCREENING', 'INTERVIEWING', 'OFFER', 'REJECTED', 'WITHDRAWN');
  IF bad_stages <> '' THEN
    RAISE EXCEPTION 'T6_2_LEGACY_STAGE:% （存在无法映射进新 stage 集合的历史数据，禁止静默清洗）', bad_stages;
  END IF;

  -- 3b. dangling jdId：引用不存在的 JD，或 JD 存在但归属其他用户（历史脏数据 → 失败）
  SELECT COALESCE(string_agg(ja.id, ',' ORDER BY ja.id), '')
    INTO dangling_jd
    FROM "JobApplication" ja
    LEFT JOIN "JobDescription" jd ON jd."id" = ja."jdId"
   WHERE ja."jdId" IS NOT NULL
     AND (jd."id" IS NULL OR jd."userId" <> ja."userId");
  IF dangling_jd <> '' THEN
    RAISE EXCEPTION 'T6_2_DANGLING_JD:% （jdId 悬空或跨用户归属，禁止静默置空）', dangling_jd;
  END IF;
END $$;

-- ---------------------------------------------------------------
-- 4. stage：enum → text + raw CHECK（仅 6 个合法值）
-- ---------------------------------------------------------------
ALTER TABLE "JobApplication" ALTER COLUMN "stage" SET DATA TYPE TEXT;
ALTER TABLE "JobApplication" ALTER COLUMN "stage" SET DEFAULT 'APPLIED';
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_stage_check"
  CHECK ("stage" IN ('APPLIED', 'SCREENING', 'INTERVIEWING', 'OFFER', 'REJECTED', 'WITHDRAWN'));

-- ---------------------------------------------------------------
-- 5. FK（全部 ON DELETE RESTRICT，授权书 §三）
-- ---------------------------------------------------------------
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_jdId_fkey"
  FOREIGN KEY ("jdId") REFERENCES "JobDescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_careerGoalId_fkey"
  FOREIGN KEY ("careerGoalId") REFERENCES "CareerGoal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_resumeVersionId_fkey"
  FOREIGN KEY ("resumeVersionId") REFERENCES "ResumeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------
-- 6. 索引（新增 5 个；保留既有 userId / userId+stage）
-- ---------------------------------------------------------------
CREATE INDEX "JobApplication_careerGoalId_idx" ON "JobApplication"("careerGoalId");
CREATE INDEX "JobApplication_resumeVersionId_idx" ON "JobApplication"("resumeVersionId");
CREATE INDEX "JobApplication_jdId_idx" ON "JobApplication"("jdId");
CREATE INDEX "JobApplication_userId_careerGoalId_idx" ON "JobApplication"("userId", "careerGoalId");
CREATE INDEX "JobApplication_userId_appliedAt_idx" ON "JobApplication"("userId", "appliedAt");

-- ---------------------------------------------------------------
-- 7. 枚举类型清理：确认无其他列引用后再删除（有引用则此句失败暴露问题）
-- ---------------------------------------------------------------
DROP TYPE "ApplicationStage";
