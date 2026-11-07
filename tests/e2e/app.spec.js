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
  // A team name is required before the first game.
  await expect(page.locator("#opponent, #save-team-name").first()).toBeVisible();
  if (await page.locator("#save-team-name").isVisible()) {
    await page.locator("#team-name").fill("Our Team");
    await page.locator("#save-team-name").click();
  }
  await page.locator("#opponent").fill(opponent);
  await page.locator("#half-length").fill(half);
  await page.locator("#create-game").click();
  await expect(page.locator(".live-title .opp")).toContainText(`vs ${opponent}`);
}

/** Taps the pitch at a fraction of its width/height (0,0 = top-left, our goal on the left). */
async function tapPitch(page, fx, fy) {
  const pitch = page.locator("#pitch");
  // Size via the element itself (click retries if a sync redraws the pitch meanwhile).
  const box = await pitch.evaluate((el) => el.getBoundingClientRect().toJSON());
  // viewBox has 1 unit padding around a 105x68 pitch.
  await pitch.click({ position: { x: ((1 + fx * 105) / 107) * box.width, y: ((1 + fy * 68) / 70) * box.height } });
}

/** Start game: the lineup prompt appears first; pick everyone unless told otherwise. */
async function kickOff(page, { everyone = true } = {}) {
  await page.locator("#phase-btn").click();
  await expect(page.locator("#dialog-title")).toHaveText("Who's starting?");
  if (everyone) await page.locator("#select-all").click();
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

test("live: a tap inside either penalty box lands inside it on a phone", async ({ page }) => {
  await addSquad(page);
  await newGame(page);
  const pitch = page.locator("#pitch");
  // The tap area is the drawn pitch itself: no empty margins either side.
  const ratio = await pitch.evaluate((el) => { const r = el.getBoundingClientRect(); return r.width / r.height; });
  expect(Math.abs(ratio - 107 / 70)).toBeLessThan(0.03);
  // Tap the screen point where the drawing shows a spot; the dot lands there.
  for (const [ux, uy] of [[8, 34], [3, 20], [97, 48], [102, 30]]) {
    const pt = await pitch.evaluate((el, [x, y]) => {
      const p = new DOMPoint(x, y).matrixTransform(el.getScreenCTM());
      const r = el.getBoundingClientRect();
      return { x: p.x - r.left, y: p.y - r.top };
    }, [ux, uy]);
    await pitch.click({ position: pt });
    const dot = page.locator("#pitch .pending");
    expect(Number(await dot.getAttribute("cx"))).toBeCloseTo(ux, 0);
    expect(Number(await dot.getAttribute("cy"))).toBeCloseTo(uy, 0);
  }
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
  await expect(page.locator("#recent li").first()).toContainText("Tackle");

  // Unknown player works; undo removes it.
  await ev(page, "foul").click();
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
  await page.locator("#team-name").fill("Our Team");
  await page.locator("#save-team-name").click();
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
  for (const n of [1, 2, 3]) await page.locator(`#start-grid .sub-chip[data-number="${n}"]`).click();
  await expect(page.locator("#start-count")).toHaveText("Starting: 3");
  await page.locator("#dialog-ok").click();
  await expect(page.locator("#phase-label")).toHaveText("1st half");
  await expect(page.locator('.pl-btn[data-number="12"]')).toHaveClass(/bench/);
  await expect(page.locator('.pl-btn[data-number="2"]')).not.toHaveClass(/bench/);

  // 20:00 in, #12 on for #2.
  await at("20:00");
  await page.locator("#subs-btn").click();
  await expect(page.locator('#sub-off-grid .sub-chip[data-number="2"] .mins')).toHaveText("20'");
  await expect(page.locator("#dialog-ok")).toBeDisabled(); // nothing picked yet
  await page.locator('#sub-off-grid .sub-chip[data-number="2"]').click();
  await page.locator('#sub-on-grid .sub-chip[data-number="12"]').click();
  await expect(page.locator("#sub-summary")).toContainText("#2 Alex → #12 Sub");
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
  await expect(page.locator("#recent li").first()).toContainText("Tackle");
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

test("events are in Attack and Defend blocks, alphabetical", async ({ page }) => {
  await addSquad(page);
  await newGame(page);
  await expect(page.locator(".events.attack .ev-btn")).toHaveText(["Assist", "Cross", "Goal", "Pass", "Shot", "Shot off target", "Shot on target", "Throw in"]);
  await expect(page.locator(".events.defend .ev-btn")).toHaveText(["Broken ball lost", "Broken ball won", "Clearance", "Foul", "Header won", "Interception", "Tackle", "Yellow card"]);
  await expect(page.locator(".live-title .opp")).toHaveText("Our Team vs Rovers");
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

  const marks = page.locator("#stats-pitch .mark");
  const timeline = page.locator("#timeline li");
  // Tap a total: only tackles, on the map and the timeline. Again: everything.
  await page.locator('.totals [data-type="tackle_won"]').click();
  await expect(marks).toHaveCount(2);
  await expect(timeline).toHaveCount(2);
  await page.locator('.totals [data-type="tackle_won"]').click();
  await expect(marks).toHaveCount(5);
  // Tap a player: only theirs.
  await page.locator("tbody tr", { hasText: "#9 Jordan" }).locator("td").first().click();
  await expect(marks).toHaveCount(2);
  await expect(timeline).toHaveCount(2);
  await expect(page.locator("#timeline")).not.toContainText("Chris");
  // Tap a number: that player and that stat.
  await page.locator("tbody tr", { hasText: "#4 Chris" }).locator('td[data-type="tackle_won"]').click();
  await expect(page.locator("#drill-summary")).toContainText("Tackle · #4 Chris · 2 events");
  await expect(page.locator("tbody td.cell-sel")).toHaveText("2");
  // Pick an event in the timeline: it's highlighted there and on the map.
  await timeline.first().click();
  await expect(page.locator("#timeline li[aria-current=true]")).toHaveCount(1);
  await expect(page.locator("#stats-pitch .mark.selected")).toHaveCount(1);
  await page.locator("#stats-pitch .mark").nth(0).click({ force: true }); // tapping the map picks too
  await expect(page.locator("#stats-pitch .mark.selected")).toHaveCount(1);
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(marks).toHaveCount(5);

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  expect(dl.suggestedFilename()).toMatch(/-vs-Rovers\.csv$/);
  const csv = fs.readFileSync(await dl.path(), "utf8").trim().split("\n");
  expect(csv.slice(0, csv.indexOf(""))).toHaveLength(6); // header + 5 events, then score and minutes
  expect(csv[1]).toContain("Tackle,4,Chris");
  expect(csv).toContain("Score,0-0");

  // Player stats across the season: leaders, a sortable table, and each player's page.
  await page.goto("./#/games");
  await page.locator("#season-link").click();
  await expect(page.locator("#leaders li", { hasText: "Tackle" })).toContainText("#4 Chris 2");
  await page.locator("#leaders li", { hasText: "Header won" }).click(); // rank by it
  await expect(page.locator("#season tbody tr").first()).toContainText("#9 Jordan");
  await page.locator('#season th[data-col="tackle_won"]').click();
  await expect(page.locator("#season tbody tr").first()).toContainText("#4 Chris");
  await page.locator("#season tbody tr", { hasText: "#4 Chris" }).locator("a").click();
  await expect(page.locator("h1")).toHaveText("#4 Chris");
  await expect(page.locator("#stats-pitch .mark")).toHaveCount(2);
  await page.locator("#timeline li").first().click();
  await expect(page.locator("#stats-pitch .mark.selected")).toHaveCount(1);
  // A game from their list opens that game's stats, showing just them.
  await page.locator("#player-games tbody tr").first().click();
  await expect(page.locator("#drill-summary")).toContainText("#4 Chris");
  await expect(page.locator("#stats-pitch .mark")).toHaveCount(2);
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
  await expect(page.locator(".list li", { hasText: "vs Rovers" })).toHaveCount(1);
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
  test.beforeEach(() => test.slow()); // several "phones" syncing through one emulator
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
  test.beforeEach(() => test.slow()); // several "phones" syncing through one emulator
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
    await expect(mine.locator(".primary")).toHaveText("Our Team"); // the team's name, not the coach's
    await mine.locator("a").click();
    await expect(sis.locator("h1")).toHaveText("Our Team");
    await expect(sis.locator("#team-squad li")).toHaveText([/4\s*Chris/, /9\s*Jordan/]);
    await expect(sis.locator("#team-games li")).toContainText(opponent);
    await sis.locator("#season-link").click();
    await expect(sis.locator("#season tbody")).toContainText("#9 Jordan");
    await sis.goBack();
    await sis.locator("#team-games li a").first().click();
    await expect(sis.locator("h1")).toContainText(opponent);
    await expect(sis.getByRole("button", { name: "Delete game" })).toHaveCount(0);

    // A game created after sharing is visible too.
    const later = `Later ${Date.now()}`;
    await newGame(page, later);
    await sis.goto(new URL("./#/games", page.url()).href);
    await expect(mine).toContainText("2 games");

    // Renaming the team shows on the other coach's phone, on the team and its games.
    await page.goto("./#/squad");
    await page.locator("#team-name").fill("Renamed FC");
    await page.locator("#save-team-name").click();
    await expect(mine.locator(".primary")).toHaveText("Renamed FC");
    await mine.locator("a").click();
    await expect(sis.locator("#team-games li", { hasText: opponent })).toContainText(`Renamed FC vs ${opponent}`);
    await sis.goto(new URL("./#/games", page.url()).href);

    // Unsharing the team hides it all again.
    await page.goto("./#/squad");
    await page.locator("#share-team").uncheck();
    await expect(mine).toHaveCount(0);
    await expect(sis.locator("#shared-list li", { hasText: opponent })).toHaveCount(0);
    await ctx.close();
  });
});

test.describe("coaches and per-game editors", () => {
  test.beforeEach(() => test.slow()); // several "phones" syncing through one emulator
  test.use({ signIn: false });

  /** Opens a second signed-in "phone" for another coach. */
  async function coachPhone(browser, page, email) {
    const ctx = await browser.newContext({ ...test.info().project.use });
    const p2 = await ctx.newPage();
    await p2.addInitScript(() => { window.__SIDELINE_EMULATOR = true; });
    await p2.goto(new URL("./", page.url()).href);
    await signInAs(p2, email);
    return { ctx, page: p2 };
  }

  test("the Account tab lists the coaches", async ({ page }) => {
    const me = freshEmail("me");
    const other = freshEmail("other");
    await allow(me);
    await allow(other);
    await page.goto("./");
    await signInAs(page, me);
    await page.goto("./#/data");
    await expect(page.locator("#coaches")).toContainText(`${me} (you)`);
    await expect(page.locator("#coaches")).toContainText(other);
  });

  test("an editor logs events in the creator's game, at the same time as the creator", async ({ page, browser }) => {
    const owner = freshEmail("owner");
    const helper = freshEmail("helper");
    await allow(owner);
    await allow(helper);
    await page.goto("./");
    await signInAs(page, owner);
    await addSquad(page, "4 Chris\n9 Jordan");
    const opponent = `Edit FC ${Date.now()}`;
    await newGame(page, opponent);

    // Not an editor yet: the helper doesn't see it.
    const { ctx, page: coach } = await coachPhone(browser, page, helper);
    await expect(coach.locator("#co-list li", { hasText: opponent })).toHaveCount(0);

    // Owner adds the helper as an editor from the game's stats page.
    await page.locator("#to-stats").click();
    await page.locator(`#editors input[data-email="${helper}"]`).check();
    const row = coach.locator("#co-list li", { hasText: opponent });
    await expect(row).toHaveCount(1);
    await row.locator("a").click();
    await expect(coach.locator(".live-title .opp")).toContainText(opponent);
    // Owner-only controls are hidden for an editor.
    await expect(coach.getByRole("button", { name: "Players", exact: true })).toHaveCount(0);

    // Both log an event at the same moment: neither is lost.
    await page.getByRole("link", { name: "‹ Back to game" }).click();
    const log = async (p, type, n, fx) => { await p.locator(`[data-event="${type}"]`).click(); await p.locator(`.pl-btn[data-number="${n}"]`).click(); await tapPitch(p, fx, 0.5); };
    await Promise.all([log(page, "tackle_won", 4, 0.3), log(coach, "goal", 9, 0.95)]);
    await expect(page.locator("#recent li")).toHaveCount(2);
    await expect(coach.locator("#recent li")).toHaveCount(2);
    await expect(page.locator("#score")).toHaveText("1–0");
    await expect(coach.locator("#score")).toHaveText("1–0");

    // The editor can run the clock too; the owner sees it.
    await coach.locator("#phase-btn").click();
    await coach.locator("#dialog-ok").click(); // kick off without picking a lineup
    await expect(page.locator("#phase-label")).toHaveText("1st half");

    // An editor can't share, pick editors or delete.
    await coach.locator("#to-stats").click();
    await expect(coach.locator("#share-toggle")).toHaveCount(0);
    await expect(coach.locator("#editors")).toHaveCount(0);
    await expect(coach.getByRole("button", { name: "Delete game" })).toHaveCount(0);

    // Removing the editor takes the game away from them.
    await page.locator("#to-stats").click();
    await page.locator(`#editors input[data-email="${helper}"]`).uncheck();
    await expect(coach.locator("h1")).toHaveText("Not available");
    await ctx.close();
  });
});

test("the Help tab explains the essentials", async ({ page }) => {
  await page.getByRole("link", { name: "Help" }).click();
  await expect(page.locator("#help h1")).toHaveText("Help");
  await expect(page.locator("#help summary")).toHaveCount(8);
  await page.locator("#help summary", { hasText: "Share with other coaches" }).click();
  await expect(page.locator("#help")).toContainText("Coaches who can edit this game");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("reset and delete a game from the Games screen, with undo", async ({ page }) => {
  await addSquad(page);
  await newGame(page, "Reset FC");
  await kickOff(page);
  await ev(page, "goal").click();
  await pl(page, 9).click();
  await tapPitch(page, 0.95, 0.5);
  await expect(page.locator("#score")).toHaveText("1–0");

  await page.goto("./#/games");
  const row = page.locator(".list li", { hasText: "vs Reset FC" });
  await row.getByRole("button", { name: /More for/ }).click();
  await page.locator("#menu-reset").click();
  await expect(page.locator("#dialog")).toContainText("Keeps the opponent, date, half length and team sheet");
  await page.locator("#dialog-ok").click();
  await expect(row).toContainText("Not started");
  await expect(row).toContainText("0 events");
  // Undo brings it all back.
  await page.locator("#toast button").click();
  await expect(row).toContainText("1 event");

  await row.getByRole("button", { name: /More for/ }).click();
  await page.locator("#menu-delete").click();
  await page.locator("#dialog-ok").click();
  await expect(row).toHaveCount(0);
  await page.locator("#toast button").click();
  await expect(row).toHaveCount(1);

  // Delete for real: it stays gone after a reload (and from the account).
  await row.getByRole("button", { name: /More for/ }).click();
  await page.locator("#menu-delete").click();
  await page.locator("#dialog-ok").click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-sync", "ready");
  await expect(page.locator(".list li", { hasText: "vs Reset FC" })).toHaveCount(0);
});

test("reset from a game's stats page", async ({ page }) => {
  await addSquad(page);
  await newGame(page, "Stats Reset");
  await ev(page, "tackle_won").click();
  await pl(page, 4).click();
  await tapPitch(page, 0.4, 0.5);
  await page.locator("#to-stats").click();
  await page.locator("#reset-game").click();
  await page.locator("#dialog-ok").click();
  await expect(page.locator('[data-total="tackle_won"]')).toHaveText("0");
});

test("a change made just before closing the app isn't lost", async ({ page }) => {
  test.slow(); // waits for a full reconnect after reloading
  await addSquad(page);
  await newGame(page, "Quick Close");
  await ev(page, "goal").click();
  await pl(page, 9).click();
  await tapPitch(page, 0.95, 0.5);
  await page.reload(); // straight away, before Firebase may have confirmed
  await expect(page.locator("body")).toHaveAttribute("data-sync", "ready");
  await page.goto("./#/games");
  await expect(page.locator(".list li", { hasText: "vs Quick Close" })).toContainText("1–0");
});

test("team name is required before the first game", async ({ page }) => {
  await page.goto("./#/new");
  await expect(page.locator("#save-team-name")).toBeVisible();
  await page.locator("#save-team-name").click();
  await expect(page.locator("#team-name-error")).toHaveText("Enter your team's name");
  await page.locator("#team-name").fill("Ballyhale U12");
  await page.locator("#save-team-name").click();
  await expect(page.locator("#opponent")).toBeVisible();
  await page.locator("#opponent").fill("Rovers");
  await page.locator("#create-game").click();
  await expect(page.locator(".live-title .opp")).toHaveText("Ballyhale U12 vs Rovers");
  await page.goto("./#/games");
  await expect(page.locator(".list li").first()).toContainText("Ballyhale U12 vs Rovers");
  await page.goto("./#/squad");
  await expect(page.locator("h1")).toHaveText("Ballyhale U12");
});

test("possession: tap who has the ball; percentages follow the clock", async ({ page }) => {
  const at = await useMatchTime(page);
  await addSquad(page);
  await newGame(page);
  await expect(page.locator("#poss-us")).toBeDisabled(); // not until kick-off
  await kickOff(page);
  await page.locator("#poss-us").click();
  await expect(page.locator("#poss-us")).toHaveAttribute("aria-pressed", "true");
  await at("03:00");
  await page.locator("#poss-them").click();
  await at("01:00");
  await page.locator("#poss-them").click(); // ball out: nobody
  await expect(page.locator("#poss-them")).toHaveAttribute("aria-pressed", "false");
  await at("05:00");
  await expect(page.locator("#poss-pct")).toHaveText("75% – 25%");
  await page.locator("#to-stats").click();
  await expect(page.locator("#poss-summary")).toContainText("75%");
});

test("the clock button pauses, restarts the half, and undoes kick-off", async ({ page }) => {
  const at = await useMatchTime(page);
  await addSquad(page);
  await newGame(page);
  await kickOff(page);
  await at("02:00");
  await page.locator("#clock-btn").click();
  await page.locator("#pause-btn").click();
  await expect(page.locator("#phase-label")).toHaveText("Paused");
  await at("05:00");
  await expect(page.locator("#clock")).toHaveText("02:00");
  await page.locator("#clock-btn").click();
  await page.locator("#pause-btn").click(); // resume
  await at("00:30");
  await expect(page.locator("#clock")).toHaveText("02:30");

  // Misclicked kick-off: restart the half from 00:00.
  await page.locator("#clock-btn").click();
  await page.locator("#restart-half").click();
  await expect(page.locator("#clock")).toHaveText("00:00");
  await expect(page.locator("#live-status")).toContainText("1st half restarted");

  // Or undo kick-off entirely.
  await page.locator("#clock-btn").click();
  await page.locator("#undo-step").click();
  await expect(page.locator("#phase-btn")).toHaveText("Start game");
});

test.describe("admins, coaches and players", () => {
  test.beforeEach(() => test.slow()); // several "phones" syncing through one emulator
  test.use({ signIn: false });

  async function phone(browser, page, email, opts) {
    const ctx = await browser.newContext({ ...test.info().project.use });
    const p2 = await ctx.newPage();
    await p2.addInitScript(() => { window.__SIDELINE_EMULATOR = true; });
    await p2.goto(new URL("./", page.url()).href);
    await signInAs(p2, email, opts);
    return { ctx, page: p2 };
  }

  test("an admin adds a coach, makes them admin, and removes them; coaches don't see Admin", async ({ page, browser }) => {
    const admin = freshEmail("admin");
    await allow(admin, { role: "admin", name: "Boss" });
    await page.goto("./");
    await signInAs(page, admin);
    await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
    await page.getByRole("link", { name: "Admin" }).click();

    const coach = freshEmail("newcoach");
    await page.locator("#admin-email").fill(coach.toUpperCase()); // stored lowercase
    await page.locator("#admin-name").fill("New Coach");
    // Someone else changing the list meanwhile doesn't wipe what's typed.
    const meanwhile = freshEmail("meanwhile");
    await allow(meanwhile);
    await expect(page.locator(`li[data-email="${meanwhile}"]`)).toHaveCount(1);
    await expect(page.locator("#admin-name")).toHaveValue("New Coach");
    await expect(page.locator("#admin-name")).toBeFocused();
    await page.locator("#admin-add").click();
    const row = page.locator(`#coach-list li[data-email="${coach}"]`);
    await expect(row).toContainText("New Coach");
    await expect(page.locator("#toast")).toContainText("Added"); // confirmed by the server
    await expect(page.locator("#admin-email")).toHaveValue(""); // ready for the next one

    // The new coach can sign in, and has no Admin tab.
    const { ctx, page: other } = await phone(browser, page, coach);
    await expect(other.getByRole("link", { name: "Admin" })).toBeHidden();
    await other.goto(new URL("./#/admin", page.url()).href);
    await expect(other.locator("#admin")).toHaveCount(0);

    await row.getByRole("button", { name: /Make admin/ }).click();
    await expect(page.locator(`#admins li[data-email="${coach}"]`)).toHaveCount(1);
    // You can't remove or demote yourself.
    await expect(page.locator(`#admins li[data-email="${admin}"]`).getByRole("button", { name: /Remove|Make/ })).toHaveCount(0);

    await page.locator(`#admins li[data-email="${coach}"]`).getByRole("button", { name: `Remove ${coach}`, exact: true }).click();
    await page.locator("#dialog-ok").click();
    await expect(page.locator(`li[data-email="${coach}"]`)).toHaveCount(0);
    await ctx.close();
  });

  test("an admin gives a coach live editing of a team; every tap syncs between phones quickly", async ({ page, browser }) => {
    test.setTimeout(90_000);
    const admin = freshEmail("admin");
    const helper = freshEmail("helper");
    await allow(admin, { role: "admin", name: "Boss" });
    await allow(helper, { name: "Helper" });
    await page.goto("./");
    await signInAs(page, admin);
    await addSquad(page, "4 Chris\n9 Jordan");
    const opponent = `Live FC ${Date.now()}`;
    await newGame(page, opponent);
    const { ctx, page: coach } = await phone(browser, page, helper);
    const row = coach.locator("#co-list li", { hasText: opponent });
    await expect(row).toHaveCount(0);

    // The admin ticks their team under Live editing for the helper.
    const gameUrl = page.url();
    await page.goto("./#/admin");
    await page.getByRole("button", { name: `Live editing for ${helper}` }).click();
    await page.locator("#edit-teams label", { hasText: admin }).locator("input").check();
    await page.locator("#dialog-ok").click();
    await expect(page.locator(`li[data-email="${helper}"] .edits-line`)).toHaveText("Edits live: Our Team");

    // The helper gets the game straight away (no reload), titled with the team's name.
    await expect(row).toHaveCount(1);
    await expect(row.locator(".primary")).toHaveText(`Our Team vs ${opponent}`);
    await row.locator("a").click();
    await page.goto(gameUrl);
    await expect(coach.locator(".live-title")).toContainText(`Our Team vs ${opponent}`);

    // Every tap shows on the other phone within a couple of seconds.
    const quick = { timeout: 5000 }; // typically well under a second; slack for a busy test emulator
    await coach.locator("#phase-btn").click();
    await coach.locator("#dialog-ok").click(); // kick off
    await expect(page.locator("#phase-label")).toHaveText("1st half", quick);
    await page.locator("#poss-us").click();
    await expect(coach.locator("#poss-us")).toHaveAttribute("aria-pressed", "true", quick);
    await coach.locator("#poss-them").click();
    await expect(page.locator("#poss-them")).toHaveAttribute("aria-pressed", "true", quick);
    await expect(page.locator("#poss-us")).toHaveAttribute("aria-pressed", "false", quick);
    await coach.locator('[data-event="goal"]').click();
    await coach.locator('.pl-btn[data-number="9"]').click();
    await tapPitch(coach, 0.95, 0.5);
    await expect(page.locator("#score")).toHaveText("1–0", quick);

    // A game the team plays later is editable too.
    const later = `Later FC ${Date.now()}`;
    await newGame(page, later);
    await coach.goto(new URL("./#/games", page.url()).href);
    await expect(coach.locator("#co-list li", { hasText: later })).toHaveCount(1);

    // Taking it away removes the team's games from the helper.
    await page.goto(new URL("./#/admin", page.url()).href);
    await page.getByRole("button", { name: `Live editing for ${helper}` }).click();
    await page.locator("#edit-teams label", { hasText: admin }).locator("input").uncheck();
    await page.locator("#dialog-ok").click();
    await expect(coach.locator("#co-list li", { hasText: later })).toHaveCount(0);
    await ctx.close();
  });

  test("a coach adds a player, who can only view that coach's games and stats", async ({ page, browser }) => {
    test.setTimeout(90_000);
    const coach = freshEmail("coach");
    await allow(coach);
    await page.goto("./");
    await signInAs(page, coach);
    await addSquad(page, "9 Jordan");
    await newGame(page, "Player View FC");
    await ev(page, "goal").click();
    await pl(page, 9).click();
    await tapPitch(page, 0.95, 0.5);

    const player = freshEmail("player");
    await page.goto("./#/data");
    await page.locator("#player-email").fill(player);
    await page.locator("#player-name").fill("Jordan");
    await page.locator("#add-player-login").click();
    await expect(page.locator("#my-players")).toContainText("Jordan");
    await expect(page.locator("#toast")).toContainText("can now view your team"); // confirmed by the server

    const { ctx, page: kid } = await phone(browser, page, player);
    // Only Games, Help and Account.
    await expect(kid.getByRole("link", { name: "Squad" })).toBeHidden();
    await expect(kid.getByRole("link", { name: "Admin" })).toBeHidden();
    await expect(kid.locator("h1")).toHaveText("Our Team");
    const game = kid.locator("#team-games li", { hasText: "Player View FC" });
    await expect(game).toContainText("1–0");
    await game.locator("a").click();
    await expect(kid.locator("#stats-score")).toHaveText("1–0");
    for (const name of ["Edit details", "Delete game", "Reset game"]) await expect(kid.getByRole("button", { name })).toHaveCount(0);
    await expect(kid.locator("#share-toggle, #editors")).toHaveCount(0);
    // Trying to go elsewhere lands back on their team.
    for (const route of ["#/new", "#/squad", "#/admin", "#/game/1"]) {
      await kid.goto(new URL(`./${route}`, page.url()).href);
      await expect(kid.locator("#team-games")).toBeVisible();
    }
    // Live: a new goal shows up for the player.
    await page.goto("./#/games");
    await page.locator(".list li", { hasText: "Player View FC" }).locator("a.main").click();
    await ev(page, "goal").click();
    await pl(page, 9).click();
    await tapPitch(page, 0.9, 0.4);
    await expect(game).toContainText("2–0");

    // Removing the player locks them out.
    await page.goto("./#/data");
    await page.getByRole("button", { name: `Remove ${player}` }).click();
    await page.locator("#dialog-ok").click();
    await expect(page.locator("#toast")).toContainText("Removed"); // confirmed by the server
    // Locked out at the next check (every minute, or on reopening): reopen now.
    await kid.reload();
    await expect(kid.locator("#gate")).toHaveAttribute("data-access", "denied");
    await ctx.close();
  });
});
