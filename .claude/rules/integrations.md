---
paths:
  - "apps/api/src/integrations/**"
  - "apps/mobile/app/integrations.tsx"
  - "apps/mobile/hooks/useIntegrationForegroundSync.ts"
  - "apps/mobile/lib/integration-*.ts"
---

# User-data integrations (SIMKL, Stremio, Jellyfin, Plex, Emby)

- **Read `docs/INBOUND_INTEGRATIONS.md` first.**
- Direction is one-way (provider → TV Watch Time) for every provider except SIMKL. SIMKL outbound
  sync (`simkl-outbound.service.ts`) is opt-in ("Sync changes back to SIMKL", off by default).
- Imported activity must not duplicate or overwrite existing user history. Reuse the import
  matching/identity path rather than adding a parallel matcher.
- Credentials are handled by `integration-credential.service.ts`. Never log tokens.
- Test with mocked provider responses. Don't call real user accounts.
