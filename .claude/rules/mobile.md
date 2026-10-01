---
paths:
  - "apps/mobile/**"
---

# Mobile app rules (`@tvwatch/mobile`)

## Adding a screen
1. Add the route under `apps/mobile/app/` (Expo Router, file-based).
2. Fetch through `apps/mobile/api/client.ts` (`api.get` / `api.post` inject the JWT). React Query
   hooks live in `apps/mobile/api/hooks.ts`; add new hooks there.
3. Use the shared theme (`apps/mobile/theme/theme.ts`) and components in `apps/mobile/components`.
4. Respect dark theme and safe areas. Icons: `@expo/vector-icons` (Ionicons).
5. Images: `expo-image` `Image`, not React Native `Image`. Search results use `expo-image` directly
   with `contentFit="cover"`, not `PosterImage`.

## Grids (Android bugs otherwise)
- NEVER use `FlatList numColumns` or `flexWrap` + `gap`.
- Use chunked rows: split items into arrays of N, render each as
  `<View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>`, and pad incomplete
  rows with invisible spacer Views.
- `PosterCard` takes a `style` prop; pass `{ marginRight: 0 }` inside grids.
- 100+ items: `FlatList` with `initialNumToRender`, `maxToRenderPerBatch`, `windowSize`.

## iOS native modal safety
- NEVER call global `showDialog` / `showConfirm` / `showError`, present a sheet, or open a second
  RN `Modal` while a native `Modal` is visible. UIKit can wedge the app, even though the same flow
  works on Android and web.
- Render confirmations, errors, loading states, and follow-ups inline inside the visible modal.
  Toasts are fine for non-blocking feedback.
- If a second presentation is unavoidable, dismiss the first and wait for its `onDismiss`
  callback. Two state updates in the same tick are not enough.
- Verify every modal flow on iOS: open → action → confirm/cancel → back/close.

## Localization and theme
- Every user-facing string is an i18n key (`apps/mobile/i18n`, `apps/mobile/locales/<lang>/*.json`).
  Add or update the key in every locale; then run `pnpm --filter @tvwatch/mobile check:locales`
  (validates JSON, BOM, and mojibake).
- Visual values come from theme tokens; check contrast in light and dark.

## Key files
- `app/_layout.tsx`: Gate component (auth routing, `mustChangePassword`)
- `components/cards.tsx`: PosterCard, EpisodeCard, grids. `components/ListCard.tsx`: list card.
- `components/primitives.tsx`: PosterImage (expo-image), T, Button, Card
- `components/voting/`: episode voting UI (see the `social` rule)

## Testing and release
- Jest for logic/hooks; React Native Testing Library for components:
  `pnpm --filter @tvwatch/mobile test -- <pattern>`.
- Web-facing changes need a fresh Expo web export before the next web release (product owner runs it).
