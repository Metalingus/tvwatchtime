// TVTime (and generic) import — shows/movies: tracked (watched), followed (watchlist), favorited.
// Lists: TV Time `lists-prod-lists.csv` → CustomList (source=TVTIME, identity by sourceKey).
//   - Series items resolved via {tv_show_id -> name} map (user_tv_show_data / followed_tv_show / tracking-v2)
//     then the shared media matcher; movie items (uuid, no name in export) are staged as unresolved warnings.
//   - Idempotent: re-import updates metadata + adds missing items; manual lists (source=MANUAL) never touched.
//   - Visibility defaults to PRIVATE unless is_public is explicitly true.
// Scope per request: NO comments, votes, character votes, reactions, where-watched, badges.
