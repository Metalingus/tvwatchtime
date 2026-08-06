-- Normalize titles once at write time so import matching can use ordinary indexed equality.
-- The immutable wrapper is required for PostgreSQL stored generated columns.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION tvwatch_normalize_title(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT trim(
    regexp_replace(
      lower(unaccent('unaccent', coalesce(input, ''))),
      '[^[:alnum:]]+',
      ' ',
      'g'
    )
  )
$$;

ALTER TABLE media_items
  ADD COLUMN normalized_title text
  GENERATED ALWAYS AS (tvwatch_normalize_title(title)) STORED NOT NULL;

CREATE INDEX media_items_type_normalized_title_idx
  ON media_items(type, normalized_title);

-- Retain the conservative contains fallback, but make it indexable.
CREATE INDEX media_items_title_trgm_idx
  ON media_items USING gin (title gin_trgm_ops);

CREATE TABLE media_title_aliases (
  media_id text NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  locale text NOT NULL,
  title text NOT NULL,
  normalized_title text
    GENERATED ALWAYS AS (tvwatch_normalize_title(title)) STORED NOT NULL,
  CONSTRAINT media_title_aliases_pkey PRIMARY KEY (media_id, locale)
);

CREATE INDEX media_title_aliases_normalized_title_idx
  ON media_title_aliases(normalized_title);

CREATE INDEX media_title_aliases_title_trgm_idx
  ON media_title_aliases USING gin (title gin_trgm_ops);

INSERT INTO media_title_aliases (media_id, locale, title)
SELECT media.id, localized.locale, localized.title
FROM media_items AS media
CROSS JOIN LATERAL jsonb_each_text(
  CASE
    WHEN jsonb_typeof(media.titles) = 'object' THEN media.titles
    ELSE '{}'::jsonb
  END
) AS localized(locale, title)
WHERE localized.title IS NOT NULL;

CREATE OR REPLACE FUNCTION sync_media_title_aliases()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM media_title_aliases WHERE media_id = NEW.id;

  IF jsonb_typeof(NEW.titles) = 'object' THEN
    INSERT INTO media_title_aliases (media_id, locale, title)
    SELECT NEW.id, localized.locale, localized.title
    FROM jsonb_each_text(NEW.titles) AS localized(locale, title)
    WHERE localized.title IS NOT NULL;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER media_items_sync_title_aliases
AFTER INSERT OR UPDATE OF titles ON media_items
FOR EACH ROW
EXECUTE FUNCTION sync_media_title_aliases();
