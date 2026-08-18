-- New profiles default to dark mode. Existing preferences are left unchanged.
ALTER TABLE "user_profiles"
ALTER COLUMN "theme_preference" SET DEFAULT 'DARK';
