# Security & Privacy Checklist

See `docs/DOCUMENTATION.md` → Section 9 for auth details.

## Authn / Authz
- [x] JWT access (15m) + refresh (30d), secret from env/admin settings
- [x] `JwtAuthGuard` default, `@Public()` opt-out, `OptionalJwtAuthGuard` for personalized public
- [x] `@CurrentUser()` decorator; ownership scoping on all mutations
- [x] Argon2 password hashing
- [x] OAuth code exchange (server-side secret, never on mobile)
- [x] RolesGuard with 7-level hierarchy enforced server-side

## Encryption
- [x] Comment images: AES-256-GCM envelope (per-image data key, wrapped by master)
- [x] Admin settings: AES-256-GCM for sensitive values
- [x] Master key: env var, 32 bytes
- [x] Encrypted data never sent to mobile

## Transport
- [x] Helmet, CORS allowlist
- [ ] (prod) HTTPS, HSTS, rate limiting (@nestjs/throttler)
- [x] Push relay (`POST /api/push/relay`) is `@Public()` — protected by Redis per-token rate limit (`PUSH_RELAY_RATE_LIMIT` / `PUSH_RELAY_RATE_WINDOW_MINUTES`)

## Self-Hosted Backend Security
- [x] Self-hosted URL stored in SecureStore (encrypted at rest on device)
- [x] Social login hidden for self-hosted (no OAuth secrets to leak via URL)
- [x] Self-hosted push never touches the public DB — only the public relay forwards to Expo
- [x] `publicApiUrl` + `eas.projectId` baked into the binary — cannot be tampered by self-hosted URL
- [x] Relay rejects malformed/oversized payloads, validates Expo token shape

## Privacy
- [x] `DELETE /me` cascades user data
- [x] Feature flags (comments, imports, push) enforced server-side
- [x] Image moderation (OpenAI) before publish
- [x] Metadata stripped (Sharp default)
- [x] Temp files deleted after import/processing
- [x] Audit log for all admin actions

## Import Safety
- [x] Max upload 25 MB
- [x] Safe ZIP (reject encrypted/nested/traversal/bombs)
- [x] CSV-only inside ZIP
- [x] Rate limited (configurable imports/user/day)
- [x] Rollback via import_applied_records
