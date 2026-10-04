ALTER TABLE "Drawing" ADD COLUMN "path" TEXT NOT NULL DEFAULT '/';

CREATE INDEX "Drawing_userId_collectionId_path_updatedAt_idx"
ON "Drawing"("userId", "collectionId", "path", "updatedAt");
