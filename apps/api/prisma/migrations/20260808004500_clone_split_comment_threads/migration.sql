-- Split episode comments are physically cloned and independent. This table was
-- introduced by the immediately preceding, already-applied development migration;
-- it is now obsolete. No production release used the alias implementation.
DROP TABLE IF EXISTS "episode_comment_thread_aliases";
