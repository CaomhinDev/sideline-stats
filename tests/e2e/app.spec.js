import fs from "node:fs";
import { test, expect, allow, freshEmail, signInAs } from "./fixtures.js";

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

/** Start game: the lineup prompt appears first; pick "Everyone on" unless told otherwise. */
async function kickOff(page, { everyone = true } = {}) {
  await page.locator("#phase-btn").click();
  await expect(page.locator("#dialog-title")).toHaveText("Who's starting?");
  if (everyone) await page.getByRole("button", { name: "Everyone on" }).click();
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#phase-label")).toHaveText("1st half");
}

/**
 * Pins the page's clock (Date.now) to a fixed time that the test moves forward
 * explicitly: at("12:34") = 12m34s after the start. Timers keep running, so
 * Firebase and the app's 1-second clock tick behave normally.
 */
async function useMatchTime(page) {
  const T0 = new Date("2026-11-07T10:00:00").getTime();
  let offset = 0;
  await page.clock.setFixedTime(T0);
  return async (mmss) => {
    const [m, sec] = mmss.split(":").map(Number);
    offset += (m * 60 + sec) * 1000;
    await page.clock.setFixedTime(T0 + offset);
  };
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
  await page.getByRole("button", { name: "Clear", exact: true }).click();
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
  await expect(page.locator(".pl-btn .n")).toHaveText(["1", "7", "14", "?", "Them"]);

  // Jordan scores wearing 14.
  await ev(page, "goal").click();
  await pl(page, 14).click();
  await tapPitch(page, 0.95, 0.5);
  await expect(page.locator("#live-status")).toContainText("GOAL! 1' #14 Jordan · Goal");
  await expect(page.locator("#score")).toHaveText("1–0");

  // Mid-game: Jordan switches to 9, a new player (#22 Kim) arrives.
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await page.getByLabel("Shirt number for Jordan").fill("9");
  await page.locator("#new-num").fill("22");
  await page.locator("#new-name").fill("Kim");
  await page.locator("#add-to-sheet").click();
  await page.locator("#dialog-ok").click();
  await expect(page.locator(".pl-btn .n")).toHaveText(["1", "7", "9", "22", "?", "Them"]);
  // The earlier goal still shows the number worn at the time.
  await expect(page.locator("#recent li").first()).toContainText("#14 Jordan");

  // Clashing numbers are refused.
  await page.getByRole("button", { name: "Players", exact: true }).click();
  await page.getByLabel("Shirt number for Kim").fill("7");
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#dialog-error")).toContainText("both have #7");
  await page.locator("#dialog-cancel").click();

  // Kim joined the squad with her usual number; the squad's numbers are unchanged.
  await page.goto("./#/squad");
  await expect(page.locator("#squad-list li")).toHaveText([/1\s*Sam/, /7\s*Jamie/, /9\s*Jordan/, /10\s*Lee/, /22\s*Kim/]);
});

test.describe("before accounts", () => {
  test.use({ signIn: false });
  test("data saved by the first version uploads to the account on first sign-in", async ({ page, email }) => {
  await allow(email);
  await page.goto("./");
  await expect(page.locator("#sign-in")).toBeVisible();
  await page.evaluate(() => localStorage.setItem("sideline.data.v1", JSON.stringify({
    nextId: 20, players: [{ id: 1, number: 7, name: "Sam" }],
    games: [{ id: 2, opponent: "Old FC", date: "2026-11-01", halfLength: 30, squad: [1], periods: [], events: [{ id: 3, type: "air_won", playerId: 1, x: 0.5, y: 0.5, half: 1, t: 0 }] }],
  })));
  await page.reload();
  await signInAs(page, email);
  await page.goto("./#/game/2");
  await expect(page.locator(".pl-btn .n")).toHaveText(["7", "?", "Them"]);
  await expect(page.locator("#recent li")).toContainText("Header won");
  await expect(page.locator("#recent li")).toContainText("#7 Sam");
  // It's in the account now: a fresh browser with no local copy sees it after signing in.
  const other = await page.context().browser().newContext();
  const page2 = await other.newPage();
  await page2.addInitScript(() => { window.__SIDELINE_EMULATOR = true; });
  await page2.goto(new URL("./", page.url()).href);
  await signInAs(page2, email);
  await page2.goto(new URL("./#/games", page.url()).href);
  await expect(page2.locator(".list li").first()).toContainText("vs Old FC");
  await other.close();
  });
});

test("lineup, substitutions and minutes played", async ({ page }) => {
  const at = await useMatchTime(page);
  await addSquad(page, "1 Sam\n2 Alex\n3 Chris\n12 Sub");
  await newGame(page, "Rovers", "30");

  // Kick-off asks who's starting: everyone but #12.
  await page.locator("#phase-btn").click();
  await expect(page.locator("#dialog-title")).toHaveText("Who's starting?");
  for (const n of [1, 2, 3]) await page.locator(`#sub-bench .sub-chip[data-number="${n}"]`).click();
  await expect(page.locator("#sub-on .sub-chip")).toHaveCount(3);
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#phase-label")).toHaveText("1st half");
  await expect(page.locator('.pl-btn[data-number="12"]')).toHaveClass(/bench/);
  await expect(page.locator('.pl-btn[data-number="2"]')).not.toHaveClass(/bench/);

  // 20:00 in, #12 on for #2.
  await at("20:00");
  await page.locator("#subs-btn").click();
  await expect(page.locator('#sub-on .sub-chip[data-number="2"] .mins')).toHaveText("20'");
  await page.locator('#sub-on .sub-chip[data-number="2"]').click();
  await page.locator('#sub-bench .sub-chip[data-number="12"]').click();
  await expect(page.locator("#dialog")).toContainText("1 off, 1 on");
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#live-status")).toContainText("Sub 21' · on #12 · off #2");
  await expect(page.locator('.pl-btn[data-number="2"]')).toHaveClass(/bench/);

  // Half time at 30:00; second half full 30 minutes.
  await at("10:00");
  await page.locator("#phase-btn").click();
  await page.locator("#dialog-ok").click();
  await page.locator("#phase-btn").click();
  await at("30:00");
  await page.locator("#phase-btn").click();
  await page.locator("#dialog-ok").click();

  await page.locator("#to-stats").click();
  const mins = (n) => page.locator("tbody tr", { hasText: `#${n} ` }).locator("td").nth(1);
  await expect(mins(1)).toHaveText("60'");
  await expect(mins(2)).toHaveText("20'");
  await expect(mins(12)).toHaveText("40'");
  await page.getByText("Substitutions (1)").click();
  await expect(page.locator("#subs-list")).toContainText("On: #12 Sub · Off: #2 Alex");
});

test("score: our goals and theirs, with undo", async ({ page }) => {
  await addSquad(page);
  await newGame(page);
  await expect(page.locator("#score")).toHaveText("0–0");
  await ev(page, "goal").click();
  await pl(page, 9).click();
  await tapPitch(page, 0.95, 0.5);
  await expect(page.locator("#score")).toHaveText("1–0");
  // A goal conceded is a Goal credited to Them.
  const concede = async () => { await ev(page, "goal").click(); await pl(page, "them").click(); await tapPitch(page, 0.03, 0.5); };
  await concede();
  await expect(page.locator("#score")).toHaveText("1–1");
  await expect(page.locator("#live-status")).toContainText("Conceded: ");
  await expect(page.locator("#recent li").first()).toContainText("Opposition");
  // Undo straight away, or delete later from the list.
  await concede();
  await page.locator("#live-status .undo").click();
  await expect(page.locator("#score")).toHaveText("1–1");
  await concede();
  await expect(page.locator("#score")).toHaveText("1–2");
  await page.locator("#recent li").first().getByRole("button", { name: /Delete/ }).click();
  await expect(page.locator("#score")).toHaveText("1–1");
  await page.goto("./#/games");
  await expect(page.locator(".list .badge").first()).toContainText("1–1");
});

test("opposition stats and yellow cards show separately in game stats", async ({ page }) => {
  await addSquad(page);
  await newGame(page);
  const log = async (type, who, fx, fy) => { await ev(page, type).click(); await pl(page, who).click(); await tapPitch(page, fx, fy); };
  await log("yellow", 4, 0.4, 0.3);
  await log("yellow", "them", 0.6, 0.3);
  await log("shot_on", "them", 0.1, 0.5);
  await log("tackle_won", 9, 0.5, 0.5);
  await expect(page.locator("#recent li").first()).toContainText("Tackle won");
  await expect(page.locator("#recent li").nth(1)).toContainText("Them");

  await page.locator("#to-stats").click();
  await expect(page.locator('[data-total="yellow"]')).toHaveText("1"); // ours only
  await expect(page.locator("tr.them-row")).toContainText("Opposition");
  await expect(page.locator("#stats-pitch .mark")).toHaveCount(2); // "Us" by default
  await page.locator('[data-team="them"]').click();
  await expect(page.locator("#stats-pitch .mark")).toHaveCount(2);
  await page.locator('[data-team="all"]').click();
  await expect(page.locator("#stats-pitch .mark")).toHaveCount(4);
  await expect(page.locator("#stats-pitch .sym-card")).toHaveCount(2);
});

test("buttons are grouped good / bad for the team", async ({ page }) => {
  await addSquad(page);
  await newGame(page);
  await expect(page.locator(".events.good .ev-btn")).toHaveText(["Tackle won", "Broken ball won", "Header won", "Save", "Shot on target", "Goal"]);
  await expect(page.locator(".events.bad .ev-btn")).toHaveText(["Broken ball lost", "Header lost", "Shot off target", "Yellow card"]);
});

test("broken ball won and lost are logged like other events", async ({ page }) => {
  await addSquad(page);
  await newGame(page);
  for (const [type, label] of [["broken_won", "Broken ball won"], ["broken_lost", "Broken ball lost"]]) {
    await ev(page, type).click();
    await pl(page, 4).click();
    await tapPitch(page, 0.5, 0.5);
    await expect(page.locator("#recent li").first()).toContainText(label);
  }
});

test("clock: start, half time, second half from half length, full time; survives reload", async ({ page }) => {
  const at = await useMatchTime(page);
  await addSquad(page);
  await newGame(page, "City", "25");
  await expect(page.locator("#clock")).toHaveText("00:00");
  await expect(page.locator("#phase-btn")).toHaveText("Start game");
  await kickOff(page);
  await expect(page.locator("#phase-label")).toHaveText("1st half");

  await at("12:34");
  await expect(page.locator("#clock")).toHaveText("12:34");

  // An event logged now is stamped 13'.
  await ev(page, "tackle_won").click();
  await pl(page, 5).click();
  await tapPitch(page, 0.4, 0.4);
  await expect(page.locator("#recent li").first()).toContainText("13'");

  // Phone locked / page reloaded: the clock catches up from timestamps.
  await at("10:00");
  await page.reload();
  await expect(page.locator("#clock")).toHaveText("22:34");

  // Half time asks first, then stops the clock.
  await at("04:00");
  await page.locator("#phase-btn").click();
  await expect(page.locator("#dialog")).toContainText("Stop the clock at 26:34");
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#phase-label")).toHaveText("Half time");
  await at("08:00");
  await expect(page.locator("#clock")).toHaveText("26:34");

  await page.locator("#phase-btn").click(); // Start 2nd half: no confirmation needed
  await expect(page.locator("#phase-label")).toHaveText("2nd half");
  await expect(page.locator("#clock")).toHaveText("25:00");
  await at("01:05");
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
  expect(csv.slice(0, csv.indexOf(""))).toHaveLength(6); // header + 5 events, then score and minutes
  expect(csv[1]).toContain("Tackle won,4,Chris");
  expect(csv).toContain("Score,0-0");

  // Season totals appear on the games list.
  await page.goto("./#/games");
  await expect(page.getByRole("heading", { name: "Season totals" })).toBeVisible();
});

test("cleared browser storage comes back from the account; export/import moves data to another account", async ({ page }) => {
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
  await expect(page.locator(".list li").first()).toContainText("vs Rovers"); // from the account

  // A second account starts empty; importing the file gives it the same data.
  const second = freshEmail("second");
  await allow(second);
  await page.goto("./#/data");
  await page.locator("#sign-out").click();
  await expect(page.locator("#sign-in")).toBeVisible();
  await signInAs(page, second);
  await page.goto("./#/games");
  await expect(page.getByText("No games yet.")).toBeVisible();
  await page.goto("./#/data");
  await page.locator("#import-file").setInputFiles(file);
  await expect(page.locator("#dialog")).toContainText("12 players and 1 game");
  await page.locator("#dialog-ok").click();
  await expect(page.locator(".list li")).toContainText("vs Rovers");
});

test("no backup nagging when signed in (the account is the backup)", async ({ page }) => {
  await addSquad(page);
  await newGame(page);
  await kickOff(page);
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
  await expect(page.locator("#banner")).toBeHidden();
});

test("live screen fits a phone: pitch, events and first players without scrolling", async ({ page }) => {
  // 390x740: an iPhone-sized screen minus browser toolbars. 16 players + "Unknown".
  await page.setViewportSize({ width: 390, height: 740 });
  await addSquad(page, SQUAD + "\n17 Ben\n18 Tom\n19 Max\n20 Ollie");
  await newGame(page);
  const vh = 740;
  for (const sel of ["#pitch", '[data-event="yellow"]', '.pl-btn[data-number="them"]']) {
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
  // Simulate a full or blocked store for the app's own data (Firebase keeps its session elsewhere).
  await page.addInitScript(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).startsWith("sideline.")) throw new DOMException("blocked", "QuotaExceededError");
      return real.call(this, k, v);
    };
  });
  await page.goto("./");
  await expect(page.locator("#banner")).toContainText("can't keep a copy on this phone");
});

test.describe("accounts", () => {
  test.use({ signIn: false });

  test("signed-out visitors see only the sign-in screen", async ({ page }) => {
    await page.goto("./#/squad");
    await expect(page.locator("#sign-in")).toBeVisible();
    await expect(page.locator("#tabs")).toBeHidden();
  });

  test("an account that isn't on the family list is turned away", async ({ page }) => {
    await page.goto("./");
    const stranger = freshEmail("stranger");
    await signInAs(page, stranger, { expectAccess: false });
    await expect(page.locator("#gate")).toHaveAttribute("data-access", "denied");
    await expect(page.locator("#gate")).toContainText(`${stranger} doesn't have access`);
    await expect(page.locator("#tabs")).toBeHidden();
  });

  test("the same account on two devices stays in sync", async ({ page, browser, email }) => {
    await allow(email);
    await page.goto("./");
    await signInAs(page, email);
    const other = await browser.newContext({ ...test.info().project.use });
    const phone2 = await other.newPage();
    await phone2.addInitScript(() => { window.__SIDELINE_EMULATOR = true; });
    await phone2.goto(new URL("./", page.url()).href);
    await signInAs(phone2, email);

    await addSquad(page, "9 Jordan");
    await newGame(page, "Sync United");
    await ev(page, "goal").click();
    await pl(page, 9).click();
    await tapPitch(page, 0.95, 0.5);

    await phone2.goto(new URL("./#/games", page.url()).href);
    await expect(phone2.locator(".list li").first()).toContainText("vs Sync United");
    await expect(phone2.locator(".list .badge").last()).toContainText("1–0");
    await other.close();
  });

  test("a shared game is view-only for family and disappears when unshared", async ({ page, browser }) => {
    const owner = freshEmail("owner");
    const brother = freshEmail("brother");
    await allow(owner);
    await allow(brother);
    await page.goto("./");
    await signInAs(page, owner);
    const opponent = `Harbour ${Date.now()}`;
    await addSquad(page, "4 Chris");
    await newGame(page, opponent);
    await ev(page, "tackle_won").click();
    await pl(page, 4).click();
    await tapPitch(page, 0.4, 0.5);

    const ctx = await browser.newContext({ ...test.info().project.use });
    const bro = await ctx.newPage();
    await bro.addInitScript(() => { window.__SIDELINE_EMULATOR = true; });
    await bro.goto(new URL("./", page.url()).href);
    await signInAs(bro, brother);
    const sharedRow = bro.locator("#shared-list li", { hasText: opponent });
    await expect(sharedRow).toHaveCount(0); // not shared yet

    await page.locator("#to-stats").click();
    await page.locator("#share-toggle").check();
    await expect(sharedRow).toHaveCount(1);
    await sharedRow.locator("a").click();
    await expect(bro.locator("h1")).toContainText(opponent);
    await expect(bro.locator("p.muted").first()).toContainText("view only");
    await expect(bro.locator("tbody")).toContainText("#4 Chris");
    // No editing controls for a viewer.
    for (const name of ["Edit details", "Delete game"]) await expect(bro.getByRole("button", { name })).toHaveCount(0);
    await expect(bro.locator("#share-toggle")).toHaveCount(0);
    await bro.getByText(/All events/).click();
    await expect(bro.getByRole("button", { name: /Delete/ })).toHaveCount(0);

    // Owner unshares: it's gone for the viewer.
    await page.locator("#share-toggle").uncheck();
    await bro.goto(new URL("./#/games", page.url()).href);
    await expect(sharedRow).toHaveCount(0);
    await ctx.close();
  });
});

test.describe("signing out and sharing a team", () => {
  test.use({ signIn: false });

  test("sign out from the Account tab or the Games screen", async ({ page, email }) => {
    await allow(email);
    await page.goto("./");
    await signInAs(page, email);
    await page.getByRole("link", { name: "Account" }).click();
    await expect(page.locator("#account")).toContainText(email);
    await page.locator("#sign-out").click();
    await expect(page.locator("#sign-in")).toBeVisible();

    await signInAs(page, email);
    await page.goto("./#/games");
    await page.locator("#games-sign-out").click();
    await expect(page.locator("#sign-in")).toBeVisible();
  });

  test("a shared team shows its squad, season totals and every game, view only", async ({ page, browser }) => {
    const owner = freshEmail("owner");
    const sister = freshEmail("sister");
    await allow(owner);
    await allow(sister);
    await page.goto("./");
    await signInAs(page, owner);
    await addSquad(page, "4 Chris\n9 Jordan");
    const opponent = `Rovers ${Date.now()}`;
    await newGame(page, opponent);
    await ev(page, "goal").click();
    await pl(page, 9).click();
    await tapPitch(page, 0.95, 0.5);

    const ctx = await browser.newContext({ ...test.info().project.use });
    const sis = await ctx.newPage();
    await sis.addInitScript(() => { window.__SIDELINE_EMULATOR = true; });
    await sis.goto(new URL("./", page.url()).href);
    await signInAs(sis, sister);

    // Share the team from the Squad tab; the game wasn't individually shared.
    await page.goto("./#/squad");
    await page.locator("#share-team").check();
    await expect(sis.locator("#shared-teams li")).not.toHaveCount(0);
    // Other tests may share teams too, so find this owner's row by its link.
    await expect(sis.locator("#shared-teams li", { hasText: "2 players · 1 game" })).not.toHaveCount(0);
    const href = await sis.locator("#shared-teams li", { hasText: "2 players · 1 game" }).locator("a").first().getAttribute("href");
    const mine = sis.locator(`#shared-teams li:has(a[href="${href}"])`);
    await expect(mine).toHaveCount(1);
    await mine.locator("a").click();
    await expect(sis.locator("#team-squad li")).toHaveText([/4\s*Chris/, /9\s*Jordan/]);
    await expect(sis.locator("#team-games li")).toContainText(opponent);
    await expect(sis.locator("tbody")).toContainText("#9 Jordan");
    await sis.locator("#team-games li a").first().click();
    await expect(sis.locator("h1")).toContainText(opponent);
    await expect(sis.getByRole("button", { name: "Delete game" })).toHaveCount(0);

    // A game created after sharing is visible too.
    const later = `Later ${Date.now()}`;
    await newGame(page, later);
    await sis.goto(new URL("./#/games", page.url()).href);
    await expect(mine).toContainText("2 games");

    // Unsharing the team hides it all again.
    await page.goto("./#/squad");
    await page.locator("#share-team").uncheck();
    await expect(mine).toHaveCount(0);
    await expect(sis.locator("#shared-list li", { hasText: opponent })).toHaveCount(0);
    await ctx.close();
  });
});
