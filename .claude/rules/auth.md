---
paths:
  - "apps/api/src/auth/**"
  - "apps/mobile/app/(auth)/**"
  - "apps/mobile/app/expo-auth-session.tsx"
  - "apps/mobile/api/client.ts"
  - "apps/mobile/hooks/use*Auth.ts"
  - "apps/mobile/lib/auth-redirect.ts"
  - "apps/mobile/app/settings.tsx"
---

# Auth, OAuth, and self-hosted backend

## OAuth flow (Google/Facebook; Apple has its own `apple-auth.service.ts` / `useAppleAuth`)
- Mobile opens the provider with `WebBrowser.openBrowserAsync()`.
- Redirect URI: `{API_BASE}/auth/oauth-callback` (backend endpoint). The backend receives the code
  and 302-redirects to `tvwatchtime://expo-auth-session?code=xxx`.
- `app/expo-auth-session.tsx` captures the code with `useLocalSearchParams()`.
- No Expo auth proxy; the app's own domain is used.

## Self-hosted backend
- Login/register have a "Self-hosted backend" checkbox. When checked, social login is hidden,
  a URL input appears, and the URL is stored in SecureStore.
- `getBaseUrl()` in `apps/mobile/api/client.ts` reads the base URL from SecureStore. It is editable
  in Settings.
- `PUBLIC_API_URL` (`app.json` → `extra.publicApiUrl`) is constant and used for the push relay only.
- `SITE_URL` (`.env`) builds data-deletion and password-reset email links.

## Authenticated API routes
Use the `@CurrentUser()` decorator with `JwtAuthGuard`.
