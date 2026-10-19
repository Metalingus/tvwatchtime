---
paths:
  - "apps/api/src/commsuni/**"
  - "apps/mobile/scripts/verify-commsuni-votes.cjs"
  - "docs/COMMSUNI_*.md"
  - "docs/commsuni-*.md"
  - "docs/commsuni-integrationV3"
---

# CommsUni (shared comments and engagement)

- **Provider contract:** `docs/commsuni-integrationV3` (~2.5k lines). Grep its `^#{2,3} `
  headings and read only the relevant sections. A local, untracked v1 guide
  (`commsuni-api-integration.md`) may exist; it is historical, so don't use it as the contract.
- **Our implementation and known gaps:** `docs/COMMSUNI_INTEGRATION.md`. This describes our code;
  it does not replace the provider contract.
- **Product decisions and validation history:** `docs/COMMSUNI_REVIEW.md`. Recorded owner decisions
  (one board, no extra identity-sharing prompt, deferred archive mirroring, read-only production
  rollout, profile updates disabled until writes are enabled) govern rollout. Don't change them
  without an explicit instruction. Where v3 guidance conflicts, report the conflict.
- **Backfill runbook:** `docs/COMMSUNI_BACKFILL.md`. Running a backfill is approval gate #2.
- When reporting findings, label each claim as *documented* (cite the guide section), *observed*
  (actual response/log), or *unverified assumption*.
- Don't call the live provider from tests or ad-hoc scripts; it is rate-limited and shared (see the
  guide's caching/rate-limit section). Use unit tests with a mocked `commsuni.client.ts`.
