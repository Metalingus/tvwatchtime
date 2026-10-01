---
paths:
  - "apps/api/src/social/**"
  - "apps/api/src/comment-images/**"
  - "apps/api/src/data-deletion/**"
  - "apps/api/src/users/lib/deleted-user.ts"
  - "apps/api/src/common/*vote*.ts"
  - "apps/mobile/components/voting/**"
  - "apps/mobile/app/comment/**"
  - "apps/mobile/app/community-comment/**"
  - "packages/shared/src/vote-math.ts"
---

# Social systems (comments, reviews, spoilers, voting, moderation, account deletion)

- **Read `docs/SOCIAL_SYSTEMS.md` first.** Data model: `docs/DATA_MODEL.md`. Background:
  `DOCUMENTATION.md` §13 (comments/images), §20 (moderation), §21 (export/deletion).
- Shared comments also flow through CommsUni (see the `commsuni` rule).
- Vote math: `packages/shared/src/vote-math.ts` (largest-remainder `computePercentages`,
  `applyVoteChange` for optimistic recompute) is shared by API tests and mobile. Change it there,
  never fork it.
- Mobile voting: `components/voting/` (VotingSection, SelectableIconTile, StarRatingControl,
  ReactionGrid, FavoriteCharacterVote, `meta.ts`). `useEpisodeVotes` in `api/hooks.ts` holds
  per-section optimistic mutations.
- Moderation: `social/moderation.service.ts` (block/report/admin moderation).
- Account deletion uses the anonymize-and-delete flow in `users/lib/deleted-user.ts`. Follow it
  rather than deleting user rows directly; see the SOCIAL_SYSTEMS account-deletion section.
- Comment images need S3/MinIO and return 503 without it. OpenAI moderation is skipped without a key.
