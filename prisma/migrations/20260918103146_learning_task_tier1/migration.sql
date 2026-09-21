-- CreateEnum
CREATE TYPE "LearningTaskStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'PAUSED');

-- CreateTable
CREATE TABLE "LearningTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actionPlanId" TEXT NOT NULL,
    "sourceStepId" TEXT NOT NULL,
    "sourceStepTitle" TEXT NOT NULL,
    "sourceStepTargetRequirement" TEXT,
    "content" TEXT,
    "status" "LearningTaskStatus" NOT NULL DEFAULT 'PLANNED',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearningTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LearningTask_userId_archivedAt_idx" ON "LearningTask"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "LearningTask_actionPlanId_idx" ON "LearningTask"("actionPlanId");

-- CreateIndex
CREATE UNIQUE INDEX "LearningTask_userId_actionPlanId_sourceStepId_key" ON "LearningTask"("userId", "actionPlanId", "sourceStepId");

-- AddForeignKey
ALTER TABLE "LearningTask" ADD CONSTRAINT "LearningTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningTask" ADD CONSTRAINT "LearningTask_actionPlanId_fkey" FOREIGN KEY ("actionPlanId") REFERENCES "ActionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
