-- Episode voting redesign: re-key character_votes from character_name to a stable
-- media_cast FK, and tidy up the unused active_reaction column (reactions are now
-- multi-select, stored one-row-per-reaction in the `reactions` table).

-- 1) Drop the now-unused single-active-reaction column (added by an earlier draft;
--    safe/no-op if it was never created). Multi-select reactions live in `reactions`.
ALTER TABLE "user_episode_status" DROP COLUMN IF EXISTS "active_reaction";

-- 2) CharacterVote: migrate character_name -> cast_id (media_cast FK).
ALTER TABLE "character_votes" ADD COLUMN "cast_id" TEXT;

-- Resolve existing votes via name -> media_cast for the episode's show.
UPDATE "character_votes" cv
SET "cast_id" = mc."id"
FROM "episodes" e
JOIN "seasons" sn ON sn."id" = e."season_id"
JOIN "shows" sh ON sh."id" = sn."show_id"
JOIN "media_cast" mc ON mc."media_id" = sh."media_id"
   AND LOWER(mc."character") = LOWER(cv."character_name")
WHERE cv."episode_id" = e."id";

-- Drop unresolvable historical votes (deleted/renamed cast or null character).
DELETE FROM "character_votes" WHERE "cast_id" IS NULL;

ALTER TABLE "character_votes" ALTER COLUMN "cast_id" SET NOT NULL;
ALTER TABLE "character_votes" DROP COLUMN "character_name";

-- Index + FK for the new cast_id reference.
CREATE INDEX "character_votes_cast_id_idx" ON "character_votes"("cast_id");
ALTER TABLE "character_votes" ADD CONSTRAINT "character_votes_cast_id_fkey"
  FOREIGN KEY ("cast_id") REFERENCES "media_cast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
