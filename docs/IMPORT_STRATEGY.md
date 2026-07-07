# Import Strategy

See `docs/DOCUMENTATION.md` → Section 11 for full details.

## Supported Sources
- ZIP (CSV files) — TVTime GDPR export
- Standalone CSV — generic
- Standalone JSON — flexible schema

## TVTime Files Processed
| File | Entity | Rows |
|------|--------|------|
| `seen_episode_source.csv` | Watched episodes | 1,380 |
| `tracking-prod-records.csv` (v1) | Watch + follow + towatch (typed rows) | ~877 watch |
| `tracking-prod-records-v2.csv` | Per-episode rows (no type column) + watchlist | 8,696 episodes |
| `user_tv_show_data.csv` | Watchlist (is_followed) + favorites (is_favorited) | 422 |
| `followed_tv_show.csv` | Watchlist (active flag) | 355 |

## Matching Priority (no external IDs in TVTime)
1. DB exact normalized title → 0.9 confidence
2. DB core-title (strip parentheticals) → 0.85
3. DB contains + normalized → 0.8
4. TMDb exact-title search → 0.75
5. TMDb fuzzy → 0.5 (needs_review)

## Skip List (never imported)
votes, ratings, emotions, character votes, comments, lists, where-to-watch, badges, tokens, tracking events, sessions, IPs, ads

## Security
- Max upload: 25 MB
- ZIP: reject encrypted/nested/path-traversal/bombs
- CSV-only inside ZIP
- Rate limit: configurable imports/user/day
- Rollback: via `import_applied_records`
