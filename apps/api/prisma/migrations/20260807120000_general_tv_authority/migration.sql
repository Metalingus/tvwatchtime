ALTER TYPE "StructureReason" ADD VALUE IF NOT EXISTS 'GENERAL_TVDB';

CREATE TABLE "episode_comment_thread_aliases" (
    "id" TEXT NOT NULL,
    "episode_id" TEXT NOT NULL,
    "source_thread_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "episode_comment_thread_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "episode_comment_thread_aliases_episode_id_source_thread_id_key"
    ON "episode_comment_thread_aliases"("episode_id", "source_thread_id");
CREATE INDEX "episode_comment_thread_aliases_source_thread_id_idx"
    ON "episode_comment_thread_aliases"("source_thread_id");

ALTER TABLE "episode_comment_thread_aliases"
    ADD CONSTRAINT "episode_comment_thread_aliases_episode_id_fkey"
    FOREIGN KEY ("episode_id") REFERENCES "episodes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
