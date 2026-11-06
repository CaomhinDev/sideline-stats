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
- **Data:** saved in browser storage on this device; Export/Import JSON as a backup.

## Run locally

```sh
npm run serve        # http://localhost:8091, also reachable from your LAN
```

## Tests

```sh
npm test             # data logic (Node's built-in test runner)
npm run test:e2e     # browser tests in headless Chromium (Playwright)
```
