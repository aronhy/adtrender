CREATE TABLE "StudioPreference" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "followedAdvertiserIds" TEXT[] DEFAULT ARRAY[]::TEXT[], "preferences" JSONB NOT NULL DEFAULT '{}', "version" INTEGER NOT NULL DEFAULT 0, "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "StudioPreference_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "StudioPreference_userId_workspaceId_key" ON "StudioPreference"("userId", "workspaceId");
CREATE INDEX "StudioPreference_workspaceId_idx" ON "StudioPreference"("workspaceId");
ALTER TABLE "StudioPreference" ADD CONSTRAINT "StudioPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioPreference" ADD CONSTRAINT "StudioPreference_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
