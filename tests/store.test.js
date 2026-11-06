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
  // #9 had an event so is hidden but still labelled; #1 had none so is gone.
  assert.equal(S.playerLabel(st, g.events[0].playerId), "#9 Jordan");
  assert.equal(st.players.some((p) => p.number === 1), false);
});

test("game phases advance and can be undone", () => {
  const st = squad();
  const g = S.createGame(st, { opponent: "Rovers", halfLength: 30 }).game;
  assert.equal(g.squad.length, 2);
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
  assert.throws(() => S.addEvent(st, g, { type: "goal", x: 0, y: 0 }), /Unknown event/);
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
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^1',1,00:30,Tackle won,,Unknown,/);
  assert.match(lines[2], /^2',1,01:30,Won in air,5,"Kev ""The Wall"", Jr",0.25,0.5$/);
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
  assert.throws(() => S.parseState(bad((d) => (d.games[0].events[0].type = "goal"))), /unknown type/);
  assert.throws(() => S.parseState(bad((d) => (d.games[0].events[0].playerId = 999))), /unknown player/);
  assert.throws(() => S.parseState(bad((d) => (d.games[0].halfLength = 0))), /half length/);
  assert.throws(() => S.parseState(bad((d) => (d.games[0].events[0].id = d.players[0].id))), /Duplicate id/);
  assert.throws(() => S.parseState(bad((d) => (d.players[0].number = "x"))), /invalid number/);
});

test("removing a player without events deletes them and drops them from squads", () => {
  const st = squad();
  const g = S.createGame(st, { opponent: "R", halfLength: 30 }).game;
  S.removePlayer(st, st.players[0].id);
  assert.equal(st.players.length, 1);
  assert.equal(g.squad.length, 1);
});
