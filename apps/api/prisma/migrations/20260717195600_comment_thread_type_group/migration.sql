-- Add GROUP to comment thread types for community group discussions.
-- Group threads are keyed by (thread_type 'GROUP', thread_id = curated group slug);
-- no new table required.
ALTER TYPE "CommentThreadType" ADD VALUE 'GROUP';
