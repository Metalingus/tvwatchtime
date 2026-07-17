-- Anime classification evidence on shows (TMDB origin language/country).
ALTER TABLE "shows" ADD COLUMN "original_language" TEXT;
ALTER TABLE "shows" ADD COLUMN "origin_countries" TEXT[];
