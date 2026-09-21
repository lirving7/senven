-- CreateTable
CREATE TABLE "PortfolioProject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortfolioProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioProjectResult" (
    "id" TEXT NOT NULL,
    "portfolioProjectId" TEXT NOT NULL,
    "projectResultId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioProjectResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortfolioProject_userId_archivedAt_idx" ON "PortfolioProject"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "PortfolioProjectResult_projectResultId_idx" ON "PortfolioProjectResult"("projectResultId");

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioProjectResult_portfolioProjectId_projectResultId_key" ON "PortfolioProjectResult"("portfolioProjectId", "projectResultId");

-- AddForeignKey
ALTER TABLE "PortfolioProject" ADD CONSTRAINT "PortfolioProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioProjectResult" ADD CONSTRAINT "PortfolioProjectResult_portfolioProjectId_fkey" FOREIGN KEY ("portfolioProjectId") REFERENCES "PortfolioProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioProjectResult" ADD CONSTRAINT "PortfolioProjectResult_projectResultId_fkey" FOREIGN KEY ("projectResultId") REFERENCES "ProjectResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;
