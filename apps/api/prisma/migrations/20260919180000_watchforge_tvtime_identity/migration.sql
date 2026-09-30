-- Durable, typed TV Time UUID aliases reuse external_ids and its unique index.
ALTER TYPE "ExternalProvider" ADD VALUE IF NOT EXISTS 'TV_TIME';
