# Third-Party Metadata APIs

See `docs/DOCUMENTATION.md` → Section 10 for full details.

## Providers

### TMDb (primary)
- **Use:** Search, discover, trending, top-rated, popular, airing, upcoming, cast, providers, images, trailers
- **Rate limit:** Configurable (default 40 RPS, global serialized), 429 backoff with Retry-After
- **Key:** `TMDB_API_KEY` (or admin settings, encrypted)
- **12 hydration types** available in admin console
- **Image URLs:** Stored as full CDN URLs in DB, mobile loads directly

### TVmaze (air time enrichment)
- **Use:** Episode air times (TVmaze has times TMDb doesn't)
- **Lookup:** By TVDB or IMDb ID → show → episodes
- **Smart refresh:** Only RETURNING shows with upcoming episodes missing air times
- **Key:** Optional (works without)

### OpenAI Moderation (comment images)
- **Model:** `omni-moderation-latest`
- **Input:** Comment text + image (base64 data URL)
- **Decision:** allow / reject / needs_manual_review
- **Never exposed to client**

## Avoiding Vendor Lock-in
- `MediaItem` is provider-agnostic
- `ExternalId` table maps to providers
- Adding a provider = adding a normalizer class
- All images stored as full URLs on MediaItem (not provider-specific paths)
