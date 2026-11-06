import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../js/store.js";

const squad = () => {
  const st = S.emptyState();
  S.addPlayer(st, "1", "Sam Keeper");
  S.addPlayer(st, "9", "Jordan");
  return st;
};

test("players need a unique shirt number; name is optional", () => {
  const st = squad();
  assert.match(S.addPlayer(st, "9", "Other").error, /already/);
  assert.match(S.addPlayer(st, "abc", "X").error, /shirt number/);
  assert.match(S.addPlayer(st, "1000", "X").error, /shirt number/);
  assert.ok(S.addPlayer(st, "#14", "").player);
  assert.deepEqual(S.activePlayers(st).map((p) => p.number), [1, 9, 14]);
});

test("squad text parsing handles common formats", () => {
  const { players, errors } = S.parseSquadText(
    "Number,Name\n1, Sam Keeper\n4\tAlex Murphy\n#7 Chris O'Neill\n10. Pat\nJamie Byrne, 11\nRory 12\n15\n\nno number here\n4 Duplicate"
  );
  assert.deepEqual(players, [
    { number: 1, name: "Sam Keeper" },
    { number: 4, name: "Alex Murphy" },
    { number: 7, name: "Chris O'Neill" },
    { number: 10, name: "Pat" },
    { number: 11, name: "Jamie Byrne" },
    { number: 12, name: "Rory" },
    { number: 15, name: "" },
  ]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /no shirt number/);
  assert.match(errors[1], /#4 appears twice/);
});

test("quoted CSV from a spreadsheet parses", () => {
  const { players } = S.parseSquadText('"No","Player"\r\n"3","Lee, Danny"\r\n');
  // A comma inside quotes splits naively; the number is still found and the name kept.
  assert.equal(players[0].number, 3);
  assert.match(players[0].name, /Lee/);
});

test("importSquad add skips used numbers; replace retires old squad but keeps stats", () => {
  const st = squad();
  const g = S.createGame(st, { opponent: "Rovers", halfLength: 30 }).game;
  S.advancePhase(g, 0);
  S.addEvent(st, g, { type: "tackle_won", playerId: st.players[1].id, x: 0.5, y: 0.5 }, 60_000);
  assert.deepEqual(S.importSquad(st, [{ number: 9, name: "Dup" }, { number: 5, name: "New" }], "add"), { added: 1, skipped: [9] });
  S.importSquad(st, [{ number: 2, name: "Fresh" }], "replace");
  assert.deepEqual(S.activePlayers(st).map((p) => p.number), [2]);
  // Both were on the game's team sheet, so they're hidden rather than deleted.
  assert.equal(S.playerLabel(st, g.events[0].playerId), "#9 Jordan");
  assert.equal(st.players.find((p) => p.number === 1).removed, true);
});

test("game phases advance and can be undone", () => {
  const st = squad();
  const g = S.createGame(st, { opponent: "Rovers", halfLength: 30 }).game;
  assert.equal(g.roster.length, 2);
  assert.equal(S.phase(g), "pre");
  assert.equal(S.advancePhase(g, 1000), "first");
  assert.equal(S.advancePhase(g, 1000 + 31 * 60_000), "half");
  S.undoPhase(g);
  assert.equal(S.phase(g), "first");
  S.advancePhase(g, 1000 + 31 * 60_000);
  assert.equal(S.advancePhase(g, 2_000_000), "second");
  assert.equal(S.advancePhase(g, 3_000_000), "full");
  assert.equal(S.advancePhase(g, 4_000_000), "full");
});

test("clock: first half from 0, second half continues from half length, survives reloads", () => {
  const st = squad();
  const g = S.createGame(st, { opponent: "R", halfLength: 25 }).game;
  assert.deepEqual(S.clock(g, 5), { phase: "pre", half: 1, seconds: 0, running: false });
  S.advancePhase(g, 10_000);
  assert.equal(S.clock(g, 10_000 + 83_500).seconds, 83);
  assert.equal(S.formatClock(83), "01:23");
  S.advancePhase(g, 10_000 + 26 * 60_000); // half time at 26:00
  assert.equal(S.clock(g, 99_999_999).seconds, 26 * 60); // stopped
  S.advancePhase(g, 5_000_000);
  assert.equal(S.clock(g, 5_000_000 + 61_000).seconds, 25 * 60 + 61);
  assert.equal(S.formatClock(25 * 60 + 61), "26:01");
});

test("minute labels use football convention including added time", () => {
  assert.equal(S.minuteLabel({ half: 1, t: 0 }, 30), "1'");
  assert.equal(S.minuteLabel({ half: 1, t: 30 }, 30), "1'");
  assert.equal(S.minuteLabel({ half: 1, t: 29 * 60 + 59 }, 30), "30'");
  assert.equal(S.minuteLabel({ half: 1, t: 30 * 60 }, 30), "30+1'");
  assert.equal(S.minuteLabel({ half: 1, t: 32 * 60 + 5 }, 30), "30+3'");
  assert.equal(S.minuteLabel({ half: 2, t: 30 * 60 }, 30), "31'");
  assert.equal(S.minuteLabel({ half: 2, t: 60 * 60 + 10 }, 30), "60+1'");
});

test("events record half, clock time and clamped position", () => {
  const st = squad();
  const g = S.createGame(st, { opponent: "R", halfLength: 30 }).game;
  S.advancePhase(g, 0);
  const e = S.addEvent(st, g, { type: "shot_on", playerId: null, x: 1.4, y: -0.2 }, 125_000);
  assert.deepEqual({ half: e.half, t: e.t, x: e.x, y: e.y, playerId: e.playerId }, { half: 1, t: 125, x: 1, y: 0, playerId: null });
  assert.throws(() => S.addEvent(st, g, { type: "corner", x: 0, y: 0 }), /Unknown event/);
});

test("tally counts by type and player", () => {
  const st = squad();
  const [a, b] = st.players;
  const g = S.createGame(st, { opponent: "R", halfLength: 30 }).game;
  for (const [type, pid] of [["tackle_won", a.id], ["tackle_won", a.id], ["air_lost", b.id], ["shot_off", null]]) S.addEvent(st, g, { type, playerId: pid, x: 0, y: 0 });
  const t = S.tally(g.events);
  assert.equal(t.total.tackle_won, 2);
  assert.equal(t.byPlayer.get(a.id).tackle_won, 2);
  assert.equal(t.byPlayer.get(b.id).air_lost, 1);
  assert.equal(t.byPlayer.get("unknown").shot_off, 1);
});

test("CSV export lists events in match order with escaping", () => {
  const st = squad();
  S.addPlayer(st, "5", 'Kev "The Wall", Jr');
  const g = S.createGame(st, { opponent: "R", halfLength: 30 }).game;
  S.advancePhase(g, 0);
  S.addEvent(st, g, { type: "air_won", playerId: st.players[2].id, x: 0.25, y: 0.5 }, 90_000);
  S.addEvent(st, g, { type: "tackle_won", playerId: null, x: 0.1, y: 0.1 }, 30_000);
  const lines = S.gameCSV(st, g).trim().split("\n");
  assert.equal(lines[0].split(",")[0], "Minute");
  assert.ok(lines.includes("Score,0-0"));
  assert.match(lines[1], /^1',1,00:30,Tackle won,,Unknown,/);
  assert.match(lines[2], /^2',1,01:30,Header won,5,"Kev ""The Wall"", Jr",0.25,0.5$/);
});

test("export/import round-trips and rejects bad files", () => {
  const st = squad();
  const g = S.createGame(st, { opponent: "Rovers", date: "2026-11-01", halfLength: 30 }).game;
  S.advancePhase(g, 1000);
  S.addEvent(st, g, { type: "shot_on", playerId: st.players[0].id, x: 0.9, y: 0.4 }, 61_000);
  const back = S.parseState(JSON.stringify(S.toExport(st)));
  assert.deepEqual(back.players, st.players);
  assert.deepEqual(back.games, st.games);
  assert.ok(back.nextId >= st.nextId);

  const ok = JSON.parse(JSON.stringify(S.toExport(st)));
  const bad = (mut) => { const d = structuredClone(ok); mut(d); return JSON.stringify(d); };
  assert.throws(() => S.parseState("nope"), /valid JSON/);
  assert.throws(() => S.parseState(bad((d) => (d.format = "weigh-in"))), /different app/);
  assert.throws(() => S.parseState(bad((d) => (d.games[0].events[0].type = "corner"))), /unknown type/);
  assert.throws(() => S.parseState(bad((d) => (d.games[0].events[0].playerId = 999))), /unknown player/);
  assert.throws(() => S.parseState(bad((d) => (d.games[0].halfLength = 0))), /half length/);
  assert.throws(() => S.parseState(bad((d) => (d.games[0].events[0].id = d.players[0].id))), /Duplicate id/);
  assert.throws(() => S.parseState(bad((d) => (d.players[0].number = "x"))), /invalid number/);
  assert.throws(() => S.parseState(bad((d) => (d.games[0].events[0].number = "x"))), /invalid shirt number/);
  assert.throws(() => S.parseState(bad((d) => d.games[0].roster.push({ ...d.games[0].roster[0], playerId: d.players[1].id }))), /both have/);
});

test("removing a player who never played deletes them; past team sheets are untouched", () => {
  const st = squad();
  const [keeper, striker] = st.players;
  const g = S.createGame(st, { opponent: "R", halfLength: 30, roster: [{ playerId: striker.id, number: 9 }] }).game;
  S.removePlayer(st, keeper.id);
  assert.equal(st.players.some((p) => p.id === keeper.id), false);
  S.removePlayer(st, striker.id);
  assert.equal(st.players.find((p) => p.id === striker.id).removed, true);
  assert.deepEqual(g.roster, [{ playerId: striker.id, number: 9 }]);
  assert.deepEqual(S.defaultRoster(st), []);
});

test("each game has its own team sheet and numbers", () => {
  const st = squad();
  const [sam, jordan] = st.players;
  S.addPlayer(st, "4", "Chris");
  const chris = st.players[2];
  // Jordan wears 10 today; Chris isn't playing.
  const g1 = S.createGame(st, { opponent: "R", halfLength: 30, roster: [{ playerId: sam.id, number: "1" }, { playerId: jordan.id, number: "10" }] }).game;
  assert.deepEqual(g1.roster.map((r) => r.number), [1, 10]);
  assert.match(S.createGame(st, { opponent: "R", halfLength: 30, roster: [{ playerId: sam.id, number: 5 }, { playerId: chris.id, number: 5 }] }).error, /both have #5/);
  assert.match(S.createGame(st, { opponent: "R", halfLength: 30, roster: [{ playerId: sam.id, number: "" }] }).error, /shirt number for Sam Keeper/);
  // Defaults follow the squad's usual numbers.
  assert.deepEqual(S.defaultRoster(st).map((r) => r.number), [1, 4, 9]);

  S.advancePhase(g1, 0);
  const e = S.addEvent(st, g1, { type: "goal", playerId: jordan.id, x: 0.9, y: 0.5 }, 60_000);
  assert.equal(e.number, 10);
  assert.equal(S.eventPlayerLabel(st, e), "#10 Jordan");
  assert.equal(S.gamePlayerLabel(st, g1, jordan.id), "#10 Jordan");
  assert.equal(S.playerLabel(st, jordan.id), "#9 Jordan"); // season view uses the usual number
  assert.equal(S.score(g1).us, 1);

  // Changing the sheet mid-game (Jordan switches to 11) doesn't rewrite the earlier goal.
  assert.ok(!S.setRoster(st, g1, [{ playerId: jordan.id, number: 11 }, { playerId: chris.id, number: 4 }]).error);
  assert.equal(S.eventPlayerLabel(st, e), "#10 Jordan");
  assert.equal(S.gamePlayerLabel(st, g1, jordan.id), "#11 Jordan");
  assert.match(S.setRoster(st, g1, [{ playerId: jordan.id, number: 4 }, { playerId: chris.id, number: 4 }]).error, /both have #4/);
  assert.deepEqual(g1.roster.map((r) => r.number), [4, 11]); // unchanged after the rejected edit
  // Season totals are by person, whatever number they wore.
  assert.equal(S.seasonTally(st).byPlayer.get(jordan.id).goal, 1);
});

test("version 1 data (squad lists, no numbers on events) is upgraded on load", () => {
  const v1 = {
    format: "sideline-stats", version: 1, nextId: 20,
    players: [{ id: 1, number: 7, name: "Sam" }, { id: 2, number: 9, name: "Jo" }],
    games: [{
      id: 3, opponent: "Rovers", date: "2026-11-01", halfLength: 30, squad: [1, 2],
      periods: [{ start: 0, end: 1800000 }],
      events: [{ id: 4, type: "air_won", playerId: 2, x: 0.5, y: 0.5, half: 1, t: 60 }, { id: 5, type: "shot_on", playerId: null, x: 1, y: 0.5, half: 1, t: 70 }],
    }],
  };
  const st = S.parseState(JSON.stringify(v1));
  assert.deepEqual(st.games[0].roster, [{ playerId: 1, number: 7 }, { playerId: 2, number: 9 }]);
  assert.equal(st.games[0].events[0].number, 9);
  assert.equal(st.games[0].events[1].number, null);
  assert.equal(S.eventType("air_won").label, "Header won"); // old ids, new names
});

const MIN = 60_000;

test("lineup and subs: who's on, and minutes played across halves", () => {
  const st = S.emptyState();
  const [a, b, c] = ["A", "B", "C"].map((n, i) => S.addPlayer(st, String(i + 1), n).player);
  const g = S.createGame(st, { opponent: "R", halfLength: 30 }).game;
  // Before kick-off, choosing players sets the starting lineup (no sub recorded).
  assert.equal(S.setOnPitch(st, g, [a.id, b.id], 0), null);
  assert.deepEqual(g.starting, [a.id, b.id]);

  S.advancePhase(g, 0); // kick-off
  // 10 minutes in: C on for B.
  const sub = S.setOnPitch(st, g, [a.id, c.id], 10 * MIN);
  assert.deepEqual({ on: sub.on, off: sub.off, half: sub.half, t: sub.t }, { on: [c.id], off: [b.id], half: 1, t: 600 });
  assert.deepEqual(S.onPitch(g).sort(), [a.id, c.id].sort());
  assert.equal(S.setOnPitch(st, g, [c.id, a.id], 11 * MIN), null); // no change, no sub

  S.advancePhase(g, 30 * MIN); // half time after 30 minutes
  // Half-time change: B back on for A, counted from the start of the 2nd half.
  const ht = S.setOnPitch(st, g, [b.id, c.id], 40 * MIN);
  assert.deepEqual({ half: ht.half, t: ht.t }, { half: 2, t: 1800 });
  S.advancePhase(g, 45 * MIN); // 2nd half kicks off
  S.advancePhase(g, 75 * MIN); // full time after 30 more minutes
  assert.equal(S.setOnPitch(st, g, [a.id], 80 * MIN), null); // nothing after full time

  const mins = S.playingTime(g, 999 * MIN);
  assert.equal(mins.get(a.id), 30 * 60); // whole 1st half
  assert.equal(mins.get(b.id), 10 * 60 + 30 * 60); // first 10, all of 2nd half
  assert.equal(mins.get(c.id), 20 * 60 + 30 * 60); // last 20 of 1st half, all of 2nd
  assert.equal(S.formatMinutes(mins.get(c.id)), "50'");

  // Deleting a sub (e.g. Undo) rewinds who was on: C never came on, B played throughout.
  S.deleteSub(g, sub.id);
  const after = S.playingTime(g, 999 * MIN);
  assert.equal(after.get(c.id) ?? 0, 0);
  assert.equal(after.get(b.id), 60 * 60);
});

test("minutes run while a half is live", () => {
  const st = S.emptyState();
  const a = S.addPlayer(st, "1", "A").player;
  const g = S.createGame(st, { opponent: "R", halfLength: 30 }).game;
  S.setOnPitch(st, g, [a.id], 0);
  S.advancePhase(g, 0);
  assert.equal(S.playingTime(g, 7 * MIN + 30_000).get(a.id), 450);
});

test("dropping an on-pitch player from the team sheet subs them off", () => {
  const st = S.emptyState();
  const [a, b] = ["A", "B"].map((n, i) => S.addPlayer(st, String(i + 1), n).player);
  const g = S.createGame(st, { opponent: "R", halfLength: 30 }).game;
  S.setOnPitch(st, g, [a.id, b.id], 0);
  S.advancePhase(g, 0);
  S.setRoster(st, g, [{ playerId: a.id, number: 1 }], 5 * MIN);
  assert.deepEqual(S.onPitch(g), [a.id]);
  assert.equal(S.playingTime(g, 20 * MIN).get(b.id), 300);
});

test("score: Goal events for us and for the opposition", () => {
  const st = S.emptyState();
  const a = S.addPlayer(st, "9", "A").player;
  const g = S.createGame(st, { opponent: "R", halfLength: 30 }).game;
  S.advancePhase(g, 0);
  S.addEvent(st, g, { type: "goal", playerId: a.id, x: 1, y: 0.5 }, MIN);
  S.addEvent(st, g, { type: "goal", playerId: null, x: 1, y: 0.5 }, 2 * MIN);
  const c = S.addEvent(st, g, { type: "goal", team: "them", playerId: a.id, x: 0.02, y: 0.5 }, 3 * MIN);
  assert.equal(c.playerId, null); // opposition events never name our players
  assert.equal(S.eventPlayerLabel(st, c), "Opposition");
  assert.deepEqual(S.score(g), { us: 2, them: 1 });
  S.deleteEvent(g, c.id);
  assert.deepEqual(S.score(g), { us: 2, them: 0 });
  assert.throws(() => S.addEvent(st, g, { type: "goal", team: "ref", x: 0, y: 0 }), /Unknown team/);
});

test("opposition events are tallied apart from ours", () => {
  const st = S.emptyState();
  const a = S.addPlayer(st, "4", "A").player;
  const g = S.createGame(st, { opponent: "R", halfLength: 30 }).game;
  S.addEvent(st, g, { type: "yellow", playerId: a.id, x: 0.4, y: 0.4 });
  S.addEvent(st, g, { type: "yellow", team: "them", x: 0.6, y: 0.4 });
  S.addEvent(st, g, { type: "shot_on", team: "them", x: 0.1, y: 0.5 });
  const t = S.tally(g.events);
  assert.equal(t.total.yellow, 1);
  assert.equal(t.them.yellow, 1);
  assert.equal(t.them.shot_on, 1);
  assert.equal(t.total.shot_on, 0);
  assert.equal(t.byPlayer.has("unknown"), false);
  assert.equal(S.seasonTally(st).total.yellow, 1);
});

test("events are grouped good then bad for the team, with stable ids", () => {
  const good = S.EVENT_TYPES.filter((t) => t.positive).map((t) => t.id);
  const bad = S.EVENT_TYPES.filter((t) => !t.positive).map((t) => t.id);
  assert.deepEqual(good, ["tackle_won", "broken_won", "air_won", "save", "shot_on", "goal"]);
  assert.deepEqual(bad, ["broken_lost", "air_lost", "shot_off", "yellow"]);
  assert.equal(S.eventType("yellow").label, "Yellow card");
});

test("version 3 goals conceded become opposition Goal events", () => {
  const v3 = {
    format: "sideline-stats", version: 3, nextId: 50,
    players: [{ id: 1, number: 9, name: "A" }],
    games: [{
      id: 2, opponent: "R", date: "2026-11-01", halfLength: 30, roster: [{ playerId: 1, number: 9 }], starting: [1], subs: [],
      conceded: [{ id: 3, half: 1, t: 600 }], periods: [{ start: 0, end: null }],
      events: [{ id: 4, type: "goal", playerId: 1, number: 9, x: 1, y: 0.5, half: 1, t: 300 }],
    }],
  };
  const g = S.parseState(JSON.stringify(v3)).games[0];
  assert.equal("conceded" in g, false);
  assert.deepEqual(S.score(g), { us: 1, them: 1 });
  const conceded = g.events.find((e) => e.team === "them");
  assert.deepEqual(conceded, { id: 3, type: "goal", team: "them", playerId: null, number: null, x: null, y: null, half: 1, t: 600 });
  assert.equal(g.events.find((e) => e.id === 4).team, "us");
  // And it survives a round trip.
  assert.deepEqual(S.parseState(JSON.stringify(S.toExport({ nextId: 50, players: [{ id: 1, number: 9, name: "A" }], games: [g] }))).games[0], g);
});

test("version 2 data gains empty lineups and subs; current data round-trips", () => {
  const st = S.emptyState();
  const [a, b] = ["A", "B"].map((n, i) => S.addPlayer(st, String(i + 1), n).player);
  const g = S.createGame(st, { opponent: "R", halfLength: 30 }).game;
  const v2 = JSON.parse(JSON.stringify(S.toExport(st)));
  v2.version = 2;
  for (const game of v2.games) { delete game.starting; delete game.subs; }
  const up = S.parseState(JSON.stringify(v2)).games[0];
  assert.deepEqual([up.starting, up.subs], [[], []]);

  S.setOnPitch(st, g, [a.id], 0);
  S.advancePhase(g, 0);
  S.setOnPitch(st, g, [b.id], MIN);
  S.addEvent(st, g, { type: "goal", team: "them", x: 0, y: 0.5 }, 2 * MIN);
  const back = S.parseState(JSON.stringify(S.toExport(st)));
  assert.deepEqual(back.games[0], g);
  const bad = JSON.parse(JSON.stringify(S.toExport(st)));
  bad.games[0].subs[0].on = [999];
  assert.throws(() => S.parseState(JSON.stringify(bad)), /unknown player in its substitution/);
});
