import { test, expect } from "@playwright/test";
import fs from "node:fs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => { throw e; });
  page.on("console", (m) => { if (m.type() === "error") throw new Error(m.text()); });
});

const SQUAD = "1 Sam Keeper\n2 Alex\n4 Chris\n5 Pat\n7 Jamie\n8 Rory\n9 Jordan\n10 Lee\n11 Dan\n14 Finn\n15 Cian\n16 Oisin";

async function addSquad(page, text = SQUAD) {
  await page.goto("./#/squad");
  await page.locator("#bulk").fill(text);
  await page.locator("#bulk-add").click();
  await page.locator("#dialog-ok").click();
}

async function newGame(page, opponent = "Rovers", half = "30") {
  await page.goto("./#/new");
  await page.locator("#opponent").fill(opponent);
  await page.locator("#half-length").fill(half);
  await page.locator("#create-game").click();
  await expect(page.locator(".live-head .opp")).toContainText(`vs ${opponent}`);
}

/** Taps the pitch at a fraction of its width/height (0,0 = top-left, our goal on the left). */
async function tapPitch(page, fx, fy) {
  const pitch = page.locator("#pitch");
  const box = await pitch.boundingBox();
  // viewBox has 1 unit padding around a 105x68 pitch.
  await pitch.click({ position: { x: ((1 + fx * 105) / 107) * box.width, y: ((1 + fy * 68) / 70) * box.height } });
}

const ev = (page, id) => page.locator(`[data-event="${id}"]`);
const pl = (page, n) => page.locator(`.pl-btn[data-number="${n}"]`);

test("squad: type players quickly, paste a list, upload a CSV, edit and remove", async ({ page }, info) => {
  await page.goto("./#/squad");
  await page.locator("#p-number").fill("3");
  await page.locator("#p-name").fill("Morgan");
  await page.locator("#p-name").press("Enter");
  await expect(page.locator("#p-number")).toBeFocused(); // ready for the next one
  await page.locator("#p-number").fill("3");
  await page.locator("#add-player").click();
  await expect(page.locator("#p-error")).toHaveText("#3 is already in the squad");

  await page.getByText("Paste or upload a list").click(); // collapsed once a squad exists
  await page.locator("#bulk").fill("4 Alex\n3 Dup\n9, Jordan");
  await page.locator("#bulk-add").click();
  await expect(page.locator("#dialog")).toContainText("Add 3 players?");
  await page.locator("#dialog select").selectOption("add");
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#toast")).toContainText("Added 2 players (skipped #3");

  const csv = info.outputPath("squad.csv");
  fs.writeFileSync(csv, "Number,Name\r\n10,Lee\r\n11,Dan\r\n");
  await page.locator("#squad-file").setInputFiles(csv);
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#squad-list li")).toHaveCount(5);

  await page.getByRole("button", { name: "Edit #11" }).click();
  await page.locator("#dialog input").first().fill("12");
  await page.locator("#dialog-ok").click();
  await page.getByRole("button", { name: "Remove #4" }).click();
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#squad-list li")).toHaveText([/3\s*Morgan/, /9\s*Jordan/, /10\s*Lee/, /12\s*Dan/]);
});

test("live: three taps in any order record an event, with undo", async ({ page }) => {
  await addSquad(page);
  await newGame(page);

  // Order 1: where, what, who.
  await tapPitch(page, 0.8, 0.5);
  await expect(page.locator("#pitch .pending")).toHaveCount(1);
  await ev(page, "shot_on").click();
  await pl(page, 9).click();
  await expect(page.locator("#live-status")).toContainText("#9 Jordan · Shot on target");
  await expect(page.locator("#recent li")).toHaveCount(1);
  // Everything resets for the next entry.
  await expect(page.locator("#pitch .pending")).toHaveCount(0);
  await expect(page.locator('.ev-btn[aria-pressed="true"], .pl-btn[aria-pressed="true"]')).toHaveCount(0);

  // Order 2: who, what, where.
  await pl(page, 4).click();
  await ev(page, "tackle_won").click();
  await tapPitch(page, 0.2, 0.3);
  await expect(page.locator("#recent li")).toHaveCount(2);
  await expect(page.locator("#recent li").first()).toContainText("Tackle won");

  // Unknown player works; undo removes it.
  await ev(page, "air_lost").click();
  await pl(page, "unknown").click();
  await tapPitch(page, 0.5, 0.5);
  await expect(page.locator("#recent li").first()).toContainText("Unknown");
  await page.locator("#live-status .undo").click();
  await expect(page.locator("#recent li")).toHaveCount(2);

  // Tapping a choice again deselects it; Clear selection resets.
  await ev(page, "air_won").click();
  await ev(page, "air_won").click();
  await expect(ev(page, "air_won")).toHaveAttribute("aria-pressed", "false");
  await pl(page, 7).click();
  await page.getByRole("button", { name: "Clear selection" }).click();
  await expect(pl(page, 7)).toHaveAttribute("aria-pressed", "false");

  // Survives a reload.
  await page.reload();
  await expect(page.locator("#recent li")).toHaveCount(2);
});

test("team sheet: per-game numbers, who's playing, and a late addition", async ({ page }) => {
  await addSquad(page, "1 Sam\n7 Jamie\n9 Jordan\n10 Lee");
  await page.goto("./#/new");
  await page.locator("#opponent").fill("Rovers");
  // Lee is away; Jordan wears 14 today.
  await page.locator('.roster-row[data-player="Lee"] input[type=checkbox]').uncheck();
  await page.getByLabel("Shirt number for Jordan").fill("14");
  await page.locator("#create-game").click();
  await expect(page.locator(".pl-btn .n")).toHaveText(["1", "7", "14", "?"]);

  // Jordan scores wearing 14.
  await ev(page, "goal").click();
  await pl(page, 14).click();
  await tapPitch(page, 0.95, 0.5);
  await expect(page.locator("#live-status")).toContainText("GOAL! 1' #14 Jordan · Goal");
  await expect(page.locator("#goals")).toHaveText("Goals 1");

  // Mid-game: Jordan switches to 9, a new player (#22 Kim) arrives.
  await page.getByRole("button", { name: "Edit players" }).click();
  await page.getByLabel("Shirt number for Jordan").fill("9");
  await page.locator("#new-num").fill("22");
  await page.locator("#new-name").fill("Kim");
  await page.locator("#add-to-sheet").click();
  await page.locator("#dialog-ok").click();
  await expect(page.locator(".pl-btn .n")).toHaveText(["1", "7", "9", "22", "?"]);
  // The earlier goal still shows the number worn at the time.
  await expect(page.locator("#recent li").first()).toContainText("#14 Jordan");

  // Clashing numbers are refused.
  await page.getByRole("button", { name: "Edit players" }).click();
  await page.getByLabel("Shirt number for Kim").fill("7");
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#dialog-error")).toContainText("both have #7");
  await page.locator("#dialog-cancel").click();

  // Kim joined the squad with her usual number; the squad's numbers are unchanged.
  await page.goto("./#/squad");
  await expect(page.locator("#squad-list li")).toHaveText([/1\s*Sam/, /7\s*Jamie/, /9\s*Jordan/, /10\s*Lee/, /22\s*Kim/]);
});

test("data saved by the first version still loads", async ({ page }) => {
  await page.goto("./");
  await page.evaluate(() => localStorage.setItem("sideline.data.v1", JSON.stringify({
    nextId: 20, players: [{ id: 1, number: 7, name: "Sam" }],
    games: [{ id: 2, opponent: "Old FC", date: "2026-11-01", halfLength: 30, squad: [1], periods: [], events: [{ id: 3, type: "air_won", playerId: 1, x: 0.5, y: 0.5, half: 1, t: 0 }] }],
  })));
  await page.reload();
  await page.goto("./#/game/2");
  await expect(page.locator(".pl-btn .n")).toHaveText(["7", "?"]);
  await expect(page.locator("#recent li")).toContainText("Header won");
  await expect(page.locator("#recent li")).toContainText("#7 Sam");
});

test("clock: start, half time, second half from half length, full time; survives reload", async ({ page }) => {
  // Freeze time so only runFor() moves the clock.
  await page.clock.install({ time: new Date("2026-11-07T10:00:00") });
  await page.clock.pauseAt(new Date("2026-11-07T10:00:01"));
  await addSquad(page);
  await newGame(page, "City", "25");
  await expect(page.locator("#clock")).toHaveText("00:00");
  await expect(page.locator("#phase-btn")).toHaveText("Start game");
  await page.locator("#phase-btn").click();
  await expect(page.locator("#phase-label")).toHaveText("1st half");

  await page.clock.runFor("12:34");
  await expect(page.locator("#clock")).toHaveText("12:34");

  // An event logged now is stamped 13'.
  await ev(page, "tackle_won").click();
  await pl(page, 5).click();
  await tapPitch(page, 0.4, 0.4);
  await expect(page.locator("#recent li").first()).toContainText("13'");

  // Phone locked / page reloaded: the clock catches up from timestamps.
  await page.clock.runFor("10:00");
  await page.reload();
  await expect(page.locator("#clock")).toHaveText("22:34");

  // Half time asks first, then stops the clock.
  await page.clock.runFor("04:00");
  await page.locator("#phase-btn").click();
  await expect(page.locator("#dialog")).toContainText("Stop the clock at 26:34");
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#phase-label")).toHaveText("Half time");
  await page.clock.runFor("08:00");
  await expect(page.locator("#clock")).toHaveText("26:34");

  await page.locator("#phase-btn").click(); // Start 2nd half: no confirmation needed
  await expect(page.locator("#phase-label")).toHaveText("2nd half");
  await expect(page.locator("#clock")).toHaveText("25:00");
  await page.clock.runFor("01:05");
  await expect(page.locator("#clock")).toHaveText("26:05");
  await ev(page, "shot_off").click();
  await pl(page, 10).click();
  await tapPitch(page, 0.9, 0.6);
  await expect(page.locator("#recent li").first()).toContainText("27'");

  await page.locator("#phase-btn").click();
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#phase-label")).toHaveText("Full time");
  // Pressed by mistake? Undo resumes the half.
  await page.locator("#live-status .undo").click();
  await expect(page.locator("#phase-label")).toHaveText("2nd half");
});

test("stats: totals, per-player table, map filters and CSV", async ({ page }) => {
  await addSquad(page);
  await newGame(page);
  const log = async (type, n, fx, fy) => { await ev(page, type).click(); await pl(page, n).click(); await tapPitch(page, fx, fy); };
  await log("tackle_won", 4, 0.3, 0.5);
  await log("tackle_won", 4, 0.35, 0.6);
  await log("air_won", 9, 0.6, 0.4);
  await log("shot_on", 9, 0.85, 0.5);
  await log("shot_off", "unknown", 0.9, 0.2);

  await page.locator("#to-stats").click();
  await expect(page.locator('[data-total="tackle_won"]')).toHaveText("2");
  await expect(page.locator('[data-total="shot_off"]')).toHaveText("1");
  await expect(page.locator("#stats-pitch .mark")).toHaveCount(5);
  await expect(page.locator("tbody tr")).toHaveText([/#4 Chris.*2/, /#9 Jordan/, /Unknown/]);

  // Hide tackles on the map; then focus on #9.
  await page.locator(".chip", { hasText: "Tackle won" }).click();
  await expect(page.locator("#stats-pitch .mark")).toHaveCount(3);
  await page.locator("tbody tr", { hasText: "#9 Jordan" }).click();
  await expect(page.locator("#stats-pitch .mark")).toHaveCount(2);
  await page.getByRole("button", { name: "Show everyone" }).click();
  await expect(page.locator("#stats-pitch .mark")).toHaveCount(3);

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/-vs-Rovers\.csv$/);
  const csv = fs.readFileSync(await dl.path(), "utf8").trim().split("\n");
  expect(csv).toHaveLength(6);
  expect(csv[1]).toContain("Tackle won,4,Chris");

  // Season totals appear on the games list.
  await page.goto("./#/games");
  await expect(page.getByRole("heading", { name: "Season totals" })).toBeVisible();
});

test("export and import restore everything after storage is cleared", async ({ page }) => {
  await addSquad(page);
  await newGame(page);
  await ev(page, "shot_on").click();
  await pl(page, 9).click();
  await tapPitch(page, 0.8, 0.5);

  await page.goto("./#/data");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#export").click()]);
  const file = await dl.path();
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(json.format).toBe("sideline-stats");
  expect(json.games[0].events).toHaveLength(1);

  await page.evaluate(() => localStorage.clear());
  await page.goto("./#/games");
  await page.reload();
  await expect(page.getByText("No games yet.")).toBeVisible();

  await page.goto("./#/data");
  await page.locator("#import-file").setInputFiles(file);
  await expect(page.locator("#dialog")).toContainText("12 players and 1 game");
  await page.locator("#dialog-ok").click();
  await expect(page.locator(".list li")).toContainText("vs Rovers");
});

test("backup reminder appears after a finished game, not during one", async ({ page }) => {
  await addSquad(page);
  await newGame(page);
  await page.locator("#phase-btn").click();
  await page.goto("./#/games");
  await expect(page.locator("#banner")).toBeHidden();
  await page.locator(".list a.main").first().click();
  await page.locator("#phase-btn").click(); // half time
  await page.locator("#dialog-ok").click();
  await page.locator("#phase-btn").click(); // 2nd half
  await page.locator("#phase-btn").click(); // full time
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#banner")).toBeHidden(); // never on the live screen
  await page.goto("./#/games");
  await expect(page.locator("#banner")).toContainText("haven't backed up");
});

test("live screen fits a phone: pitch, events and first players without scrolling", async ({ page }) => {
  // 390x740: an iPhone-sized screen minus browser toolbars. 16 players + "Unknown".
  await page.setViewportSize({ width: 390, height: 740 });
  await addSquad(page, SQUAD + "\n17 Ben\n18 Tom\n19 Max\n20 Ollie");
  await newGame(page);
  const vh = 740;
  for (const sel of ["#pitch", '[data-event="goal"]', '.pl-btn[data-number="unknown"]']) {
    const box = await page.locator(sel).boundingBox();
    expect(box.y + box.height, sel).toBeLessThanOrEqual(vh);
  }
  // Tap targets are big enough for a cold thumb.
  for (const sel of [".ev-btn", ".pl-btn", "#phase-btn"]) {
    const box = await page.locator(sel).first().boundingBox();
    expect(box.height, sel).toBeGreaterThanOrEqual(48);
    expect(box.width, sel).toBeGreaterThanOrEqual(56);
  }
  for (const route of ["#/games", "#/squad", "#/data", "#/new"]) {
    await page.goto("./" + route);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, route).toBeLessThanOrEqual(0);
  }
});

test("warns when browser storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException("blocked", "SecurityError"); }; });
  await page.goto("./");
  await expect(page.locator("#banner")).toContainText("isn't saving your data");
});
