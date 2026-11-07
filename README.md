# Sideline Stats

Log your team's match events from the sideline in three taps: **where** on the
pitch, **what** happened, and **who** (any order; it saves when all three are
chosen). Plain HTML, CSS and JavaScript, no build step, no server-side code.

- **Squad:** type players in (number + name), or paste/upload a list or CSV.
- **Games:** opponent, date, half length, and who's playing.
- **Clock:** Start game → Half time → Start 2nd half → Full time. The second
  half starts at the half length (e.g. 30:00). Worked out from timestamps, so
  it's right after the phone locks or the page reloads. The screen is kept
  awake while a half is running (where the browser supports it).
- **Events:** tackle won, won in air, lost in air, shot on target, shot off target.
- **Stats:** totals, per-player table, pitch map with filters, CSV download,
  and season totals across games.
- **Accounts:** Google sign-in. Admins manage coaches, coaches add view-only
  player logins; data syncs to Firebase (Firestore) with an offline copy on
  the phone. Export/Import JSON as an extra backup.

## Run locally

```sh
npm run serve        # http://localhost:8091, also reachable from your LAN
```

## Tests

```sh
npm test             # data logic (Node's built-in test runner)
npm run test:e2e     # browser tests in headless Chromium (Playwright)
BASE_URL=https://caomhindev.github.io/sideline-stats/ npm run test:e2e   # against the live site
```

## Deploy

Live at https://caomhindev.github.io/sideline-stats/ (GitHub Pages). Every push
to `main` runs all tests and publishes only if they pass
(`.github/workflows/deploy.yml`). Only `index.html`, `styles.css`, `icon.svg`
and `js/` are published.

```sh
npm run deploy       # same as: git push origin main
```
