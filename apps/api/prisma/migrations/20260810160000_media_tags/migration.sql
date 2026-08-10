CREATE TABLE media_tags (
    id TEXT NOT NULL,
    slug TEXT NOT NULL,
    CONSTRAINT media_tags_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX media_tags_slug_key ON media_tags(slug);

CREATE TABLE media_item_tags (
    media_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL DEFAULT 1,
    derived_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT media_item_tags_pkey PRIMARY KEY (media_id, tag_id)
);

CREATE INDEX media_item_tags_tag_id_media_id_idx ON media_item_tags(tag_id, media_id);

ALTER TABLE media_item_tags
    ADD CONSTRAINT media_item_tags_media_id_fkey
    FOREIGN KEY (media_id) REFERENCES media_items(id)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE media_item_tags
    ADD CONSTRAINT media_item_tags_tag_id_fkey
    FOREIGN KEY (tag_id) REFERENCES media_tags(id)
    ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO media_tags (id, slug) VALUES
    ('tag_k_drama', 'k-drama'),
    ('tag_j_drama', 'j-drama'),
    ('tag_c_drama', 'c-drama'),
    ('tag_isekai', 'isekai'),
    ('tag_true_crime', 'true-crime'),
    ('tag_sitcom', 'sitcom')
ON CONFLICT (slug) DO NOTHING;

-- Seed assignments from the normalized metadata already in the catalog. Future
-- hydrations run the same rule set in application code.
WITH raw_signals AS (
    SELECT
        mi.id,
        mi.type::text AS media_type,
        split_part(lower(COALESCE(s.original_language, m.language, '')), '-', 1) AS language,
        COALESCE(s.origin_countries, ARRAY[]::TEXT[]) AS countries,
        COALESCE(s.keywords, m.keywords, '[]'::jsonb) AS raw_keywords,
        EXISTS (
            SELECT 1
            FROM media_genres mg
            JOIN genres g ON g.id = mg.genre_id
            WHERE mg.media_id = mi.id
              AND lower(COALESCE(g.slug, g.name)) = 'drama'
        ) AS has_drama_genre,
        EXISTS (
            SELECT 1
            FROM media_genres mg
            JOIN genres g ON g.id = mg.genre_id
            WHERE mg.media_id = mi.id
              AND lower(COALESCE(g.slug, g.name)) IN ('anime', 'animation')
        ) AS has_animation_genre,
        EXISTS (
            SELECT 1
            FROM media_genres mg
            JOIN genres g ON g.id = mg.genre_id
            WHERE mg.media_id = mi.id
              AND lower(COALESCE(g.slug, g.name)) = 'sitcom'
        ) AS has_sitcom_genre
    FROM media_items mi
    LEFT JOIN shows s ON s.media_id = mi.id
    LEFT JOIN movies m ON m.media_id = mi.id
),
signals AS (
    SELECT
        r.*,
        COALESCE(k.keywords, ARRAY[]::TEXT[]) AS keywords
    FROM raw_signals r
    LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT trim(regexp_replace(lower(value), '[^a-z0-9]+', ' ', 'g'))) AS keywords
        FROM jsonb_array_elements_text(
            CASE
                WHEN jsonb_typeof(r.raw_keywords) = 'array' THEN r.raw_keywords
                ELSE '[]'::jsonb
            END
        )
    ) k ON TRUE
)
INSERT INTO media_item_tags (media_id, tag_id, rule_version, derived_at)
SELECT s.id, t.id, 1, CURRENT_TIMESTAMP
FROM signals s
CROSS JOIN LATERAL (
    VALUES
        (
            'k-drama',
            s.media_type = 'SHOW'
            AND (s.language IN ('ko', 'kor') OR s.countries && ARRAY['KR']::TEXT[])
            AND (
                s.has_drama_genre
                OR s.keywords && ARRAY['korean drama', 'k drama', 'kdrama']::TEXT[]
            )
            AND NOT (
                s.has_animation_genre
                OR s.keywords && ARRAY['anime', 'animation']::TEXT[]
            )
        ),
        (
            'j-drama',
            s.media_type = 'SHOW'
            AND (s.language IN ('ja', 'jpn') OR s.countries && ARRAY['JP']::TEXT[])
            AND (
                s.has_drama_genre
                OR s.keywords && ARRAY['japanese drama', 'j drama', 'jdrama']::TEXT[]
            )
            AND NOT (
                s.has_animation_genre
                OR s.keywords && ARRAY['anime', 'animation']::TEXT[]
            )
        ),
        (
            'c-drama',
            s.media_type = 'SHOW'
            AND (
                s.language IN ('zh', 'zho', 'chi')
                OR s.countries && ARRAY['CN', 'HK', 'TW']::TEXT[]
            )
            AND (
                s.has_drama_genre
                OR s.keywords && ARRAY['chinese drama', 'c drama', 'cdrama']::TEXT[]
            )
            AND NOT (
                s.has_animation_genre
                OR s.keywords && ARRAY['anime', 'animation']::TEXT[]
            )
        ),
        ('isekai', s.keywords && ARRAY['isekai']::TEXT[]),
        ('true-crime', s.keywords && ARRAY['true crime']::TEXT[]),
        ('sitcom', s.has_sitcom_genre OR s.keywords && ARRAY['sitcom']::TEXT[])
) AS rule(slug, matches)
JOIN media_tags t ON t.slug = rule.slug
WHERE rule.matches
ON CONFLICT (media_id, tag_id) DO UPDATE
SET rule_version = EXCLUDED.rule_version,
    derived_at = EXCLUDED.derived_at;
