import { test, allow, signInAs } from "./fixtures.js";

test.use({ signIn: false });

// Seeds a mid-game state and saves screenshots to screenshots/ for review.
for (const scheme of ["light", "dark"]) {
  test(`screenshots (${scheme})`, async ({ page, email }) => {
    await allow(email);
    const shot = (name, fullPage = false) => page.screenshot({ path: `screenshots/${scheme}-${name}.png`, fullPage });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("./");
    await page.locator("#sign-in").waitFor();
    await shot("signin");
    await page.evaluate(() => {
      const names = ["Sam", "Alex", "Chris", "Pat", "Jamie", "Rory", "Jordan", "Lee", "Dan", "Finn", "Cian", "Oisin", "Liam", "Conor"];
      const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16];
      const players = names.map((name, i) => ({ id: i + 1, number: nums[i], name }));
      const types = ["tackle_won", "broken_won", "broken_lost", "air_won", "air_lost", "save", "shot_on", "shot_off", "goal", "yellow"];
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const events = [];
      let id = 100;
      for (let i = 0; i < 46; i++) {
        const type = types[Math.floor(rnd() * 10)];
        const shot = type.startsWith("shot") || type === "goal";
        const half = i < 26 ? 1 : 2;
        events.push({
          id: id++, type, playerId: Math.floor(rnd() * 14) + 1,
          x: shot ? 0.72 + rnd() * 0.25 : rnd() * 0.9 + 0.05, y: shot ? 0.25 + rnd() * 0.5 : rnd() * 0.9 + 0.05,
          half, t: half === 1 ? Math.floor(i * 65) : 1800 + Math.floor((i - 26) * 60),
        });
      }
      const now = Date.now();
      const games = [
        { id: 50, opponent: "Rovers U12", date: "2026-11-07", halfLength: 30, squad: players.map((p) => p.id),
          starting: players.slice(0, 11).map((p) => p.id),
          subs: [{ id: 900, half: 1, t: 1200, on: [12], off: [3] }, { id: 901, half: 2, t: 1800, on: [13, 14], off: [7, 9] }],
          conceded: [{ id: 902, half: 1, t: 1500 }], // old format: converted on load
          periods: [{ start: now - 52 * 60_000, end: now - 21 * 60_000 }, { start: now - 1 * 60_000 - 23_000, end: null }], events },
        { id: 51, opponent: "City", date: "2026-10-31", halfLength: 30, squad: players.map((p) => p.id),
          periods: [{ start: 1, end: 1800001 }, { start: 2000000, end: 3800000 }], events: events.slice(0, 20).map((e) => ({ ...e, id: e.id + 1000 })) },
      ];
      localStorage.setItem("sideline.data.v1", JSON.stringify({ nextId: 5000, players, games }));
    });
    await page.reload();
    await signInAs(page, email); // first sign-in uploads the seeded data
    await page.goto("./#/game/50");
    // Mid-entry: place chosen and event chosen, waiting for the player.
    const pitch = page.locator("#pitch");
    const box = await pitch.boundingBox();
    await pitch.click({ position: { x: box.width * 0.78, y: box.height * 0.4 } });
    await page.locator('[data-event="shot_on"]').click();
    await shot("live");
    await page.locator('.pl-btn[data-number="9"]').click();
    await shot("live-saved");
    await page.goto("./#/game/50/stats");
    await shot("stats", true);
    await page.goto("./#/games");
    await shot("games", true);
    await page.goto("./#/squad");
    await shot("squad");
    await page.goto("./#/help");
    await page.locator("#help summary", { hasText: "Share with other coaches" }).click();
    await shot("help", true);
    await page.goto("./#/game/50/stats");
    await page.locator("#editors").scrollIntoViewIfNeeded();
    await shot("editors");
    await page.goto("./#/game/50");
    await page.locator("#subs-btn").click();
    await page.locator('#sub-on .sub-chip[data-number="5"]').click();
    await page.locator('#sub-bench .sub-chip[data-number="9"]').click();
    await shot("subs");
    await page.locator("#dialog-cancel").click();
    await page.goto("./#/new");
    await page.locator("#opponent").fill("Harbour United");
    await page.getByLabel("Shirt number for Jordan").fill("12");
    await page.locator('.roster-row[data-player="Lee"] input[type=checkbox]').uncheck();
    await shot("new-game");
  });
}
