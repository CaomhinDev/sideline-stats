// Pure data logic: no DOM, no storage. Functions mutate the state they're given.

export const FORMAT = "sideline-stats";
// 2: per-game rosters and shirt numbers on events; 3: lineups, subs, goals conceded;
// 4: events can belong to the opposition (team "them"), replacing the separate conceded list.
export const VERSION = 4;

/**
 * What can happen. Ids are stored in saved data, so never rename them; labels are free to change.
 * group drives colour (defending / aerial / attacking), shape tells types apart, positive=false draws hollow.
 */
export const EVENT_TYPES = [
  // Good for the team
  { id: "tackle_won", label: "Tackle won", short: "Tkl", group: 0, shape: "circle", positive: true },
  { id: "broken_won", label: "Broken ball won", short: "BB W", group: 0, shape: "hexagon", positive: true },
  { id: "air_won", label: "Header won", short: "Hdr W", group: 1, shape: "triangle", positive: true },
  { id: "save", label: "Save", short: "Save", group: 1, shape: "diamond", positive: true },
  { id: "shot_on", label: "Shot on target", short: "On T", group: 2, shape: "square", positive: true },
  { id: "goal", label: "Goal", short: "Goal", group: 2, shape: "star", positive: true },
  // Bad for the team
  { id: "broken_lost", label: "Broken ball lost", short: "BB L", group: 0, shape: "hexagon", positive: false },
  { id: "air_lost", label: "Header lost", short: "Hdr L", group: 1, shape: "triangle", positive: false },
  { id: "shot_off", label: "Shot off target", short: "Off T", group: 2, shape: "square", positive: false },
  { id: "yellow", label: "Yellow card", short: "YC", group: 3, shape: "card", positive: false },
];
export const EVENT_IDS = EVENT_TYPES.map((t) => t.id);
export const eventType = (id) => EVENT_TYPES.find((t) => t.id === id);

/**
 * A new id, unique across devices: time-based (microsecond-ish) and never
 * below the last one issued, so two phones on one account can't collide.
 * Stays an integer within JavaScript's safe range.
 */
export function newId(state, now = Date.now()) {
  const id = Math.max(state.nextId, now * 1000 + Math.floor(Math.random() * 1000));
  state.nextId = id + 1;
  return id;
}

export function emptyState() {
  return { nextId: 1, players: [], games: [] };
}

export function todayISO(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function isValidISODate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ---------------------------------------------------------------- squad

export const activePlayers = (state) =>
  state.players.filter((p) => !p.removed).sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));

function parseNumber(value) {
  const t = String(value ?? "").trim().replace(/^#/, "");
  if (!/^\d{1,3}$/.test(t)) return null;
  return Number(t);
}

/** Returns an error message, or null if this number/name can be used. */
export function playerError(state, number, name, exceptId = null) {
  const n = parseNumber(number);
  if (n == null) return "Enter a shirt number (0–999)";
  if (String(name ?? "").trim().length > 40) return "Keep names under 40 characters";
  if (activePlayers(state).some((p) => p.number === n && p.id !== exceptId)) return `#${n} is already in the squad`;
  return null;
}

export function addPlayer(state, number, name) {
  const error = playerError(state, number, name);
  if (error) return { error };
  const player = { id: newId(state), number: parseNumber(number), name: String(name ?? "").trim() };
  state.players.push(player);
  return { player };
}

export function updatePlayer(state, id, number, name) {
  const player = state.players.find((p) => p.id === id);
  if (!player) return { error: "Player not found" };
  const error = playerError(state, number, name, id);
  if (error) return { error };
  player.number = parseNumber(number);
  player.name = String(name ?? "").trim();
  return { player };
}

const playerInHistory = (state, id) =>
  state.games.some((g) => g.events.some((e) => e.playerId === id) || g.roster.some((r) => r.playerId === id));

/**
 * Takes a player out of the squad. Anyone who appears in a game is hidden, not
 * deleted, so old team sheets and stats keep their names.
 */
export function removePlayer(state, id) {
  if (playerInHistory(state, id)) {
    const p = state.players.find((p) => p.id === id);
    if (p) p.removed = true;
  } else {
    state.players = state.players.filter((p) => p.id !== id);
  }
}

/**
 * Parses a pasted or uploaded squad list, one player per line. Accepts
 * "7 Sam Smith", "7, Sam Smith", "#7<TAB>Sam", "Sam Smith, 7" and CSV with a
 * header row. Lines without a number are reported, header-like lines skipped.
 */
export function parseSquadText(text) {
  const players = [];
  const errors = [];
  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim().replace(/^["']|["']$/g, "");
    if (!line) return;
    const cells = line.split(/\s*[,;\t]\s*/).map((c) => c.replace(/^["']|["']$/g, "").trim()).filter(Boolean);
    let number = null;
    let name = "";
    if (cells.length >= 2) {
      const numIdx = cells.findIndex((c) => parseNumber(c) != null);
      if (numIdx >= 0) {
        number = parseNumber(cells[numIdx]);
        name = cells.filter((_, j) => j !== numIdx).join(" ");
      }
    } else {
      const m = line.match(/^#?(\d{1,3})[\s.:)-]+(.*)$/) || line.match(/^(.*?)\s+#?(\d{1,3})$/);
      if (m) {
        const first = parseNumber(m[1]);
        number = first ?? parseNumber(m[2]);
        name = (first != null ? m[2] : m[1]).trim();
      } else if (parseNumber(line) != null) {
        number = parseNumber(line);
      }
    }
    if (number == null) {
      // A header row ("Number,Name") can only come before the first player.
      if (!players.length && !errors.length && /\b(no|num|number|name|player|shirt|squad)\b/i.test(line)) return;
      errors.push(`Line ${i + 1}: no shirt number in "${raw.trim()}"`);
      return;
    }
    if (players.some((p) => p.number === number)) {
      errors.push(`Line ${i + 1}: #${number} appears twice`);
      return;
    }
    players.push({ number, name: name.slice(0, 40) });
  });
  return { players, errors };
}

/** Adds parsed players. "replace" retires the current squad first; "add" skips numbers already used. */
export function importSquad(state, list, mode = "add") {
  if (mode === "replace") for (const p of activePlayers(state)) removePlayer(state, p.id);
  let added = 0;
  const skipped = [];
  for (const { number, name } of list) {
    if (addPlayer(state, number, name).player) added++;
    else skipped.push(number);
  }
  return { added, skipped };
}

// ---------------------------------------------------------------- games

/** The usual team sheet: every active squad player in their usual number. */
export const defaultRoster = (state) => activePlayers(state).map((p) => ({ playerId: p.id, number: p.number }));

/**
 * Checks a game's team sheet: [{ playerId, number }], numbers as typed.
 * Returns { roster } with numbers parsed, or { error }.
 */
export function checkRoster(state, roster) {
  const out = [];
  for (const r of roster) {
    const p = state.players.find((p) => p.id === r.playerId);
    if (!p) return { error: "Unknown player on the team sheet" };
    const n = parseNumber(r.number);
    const who = p.name || `#${p.number}`;
    if (n == null) return { error: `Enter a shirt number for ${who}` };
    const clash = out.find((o) => o.number === n);
    if (clash) {
      const other = state.players.find((p) => p.id === clash.playerId);
      return { error: `${who} and ${other.name || "another player"} both have #${n}` };
    }
    out.push({ playerId: p.id, number: n });
  }
  return { roster: out.sort((a, b) => a.number - b.number) };
}

export function setRoster(state, game, roster, now = Date.now()) {
  const res = checkRoster(state, roster);
  if (res.error) return res;
  game.roster = res.roster;
  // Anyone dropped from the sheet can't still be on the pitch.
  const ids = new Set(res.roster.map((r) => r.playerId));
  const keep = onPitch(game).filter((id) => ids.has(id));
  if (keep.length !== onPitch(game).length && phase(game) !== "full") setOnPitch(state, game, keep, now);
  return res;
}

export function createGame(state, { opponent, date, halfLength, roster }) {
  const name = String(opponent ?? "").trim();
  if (!name) return { error: "Enter the opponent's name" };
  const len = Number(halfLength);
  if (!Number.isInteger(len) || len < 1 || len > 60) return { error: "Half length must be 1–60 minutes" };
  const sheet = checkRoster(state, roster ?? defaultRoster(state));
  if (sheet.error) return { error: sheet.error };
  const game = {
    id: newId(state),
    opponent: name.slice(0, 60),
    date: isValidISODate(date) ? date : todayISO(),
    halfLength: len,
    roster: sheet.roster,
    starting: [], // on the pitch at kick-off
    subs: [], // { id, half, t, on: [ids], off: [ids] }, t in clock seconds like events
    periods: [],
    events: [],
  };
  state.games.push(game);
  return { game };
}

export function deleteGame(state, id) {
  state.games = state.games.filter((g) => g.id !== id);
}

/** "pre" | "first" | "half" | "second" | "full" */
export function phase(game) {
  const [p1, p2] = game.periods;
  if (!p1) return "pre";
  if (p1.end == null) return "first";
  if (!p2) return "half";
  return p2.end == null ? "second" : "full";
}

export const NEXT_ACTION = {
  pre: "Start game",
  first: "Half time",
  half: "Start 2nd half",
  second: "Full time",
  full: null,
};

export function advancePhase(game, now = Date.now()) {
  switch (phase(game)) {
    case "pre": game.periods.push({ start: now, end: null }); break;
    case "first": game.periods[0].end = now; break;
    case "half": game.periods.push({ start: now, end: null }); break;
    case "second": game.periods[1].end = now; break;
  }
  return phase(game);
}

/** Reverses the last phase change (e.g. Full time pressed by mistake). */
export function undoPhase(game) {
  const last = game.periods.at(-1);
  if (!last) return;
  if (last.end != null) last.end = null;
  else game.periods.pop();
}

/**
 * The match clock: which half, and seconds on the clock (second half starts
 * at halfLength:00, as a referee's watch would show).
 */
export function clock(game, now = Date.now()) {
  const p = phase(game);
  const half = p === "second" || p === "full" ? 2 : 1;
  const period = game.periods[half - 1];
  const inHalf = period ? Math.max(0, Math.floor(((period.end ?? now) - period.start) / 1000)) : 0;
  const seconds = (half === 2 ? game.halfLength * 60 : 0) + inHalf;
  return { phase: p, half, seconds, running: p === "first" || p === "second" };
}

export function formatClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Football-style minute: 0:30 is 1', and time past the half shows as 45+2'. */
export function minuteLabel(event, halfLength) {
  const end = event.half * halfLength * 60;
  if (event.t >= end) return `${event.half * halfLength}+${Math.floor((event.t - end) / 60) + 1}'`;
  return `${Math.floor(event.t / 60) + 1}'`;
}

/**
 * team "us" (default) or "them" (the opposition; no player). playerId null = unknown player of ours.
 * x: 0 own goal → 1 their goal; y: 0 top → 1 bottom.
 * The shirt number worn in this game is kept on the event, so later changes can't rewrite history.
 */
export function addEvent(state, game, { type, playerId, team = "us", x, y }, now = Date.now()) {
  if (!EVENT_IDS.includes(type)) throw new Error(`Unknown event type ${type}`);
  if (team !== "us" && team !== "them") throw new Error(`Unknown team ${team}`);
  const c = clock(game, now);
  const pid = team === "them" ? null : playerId ?? null;
  const event = {
    id: newId(state),
    type,
    team,
    playerId: pid,
    number: pid == null ? null : (game.roster.find((r) => r.playerId === pid)?.number ?? state.players.find((p) => p.id === pid)?.number ?? null),
    x: Math.round(clamp01(x) * 1000) / 1000,
    y: Math.round(clamp01(y) * 1000) / 1000,
    half: c.half,
    t: c.seconds,
  };
  game.events.push(event);
  return event;
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

export function deleteEvent(game, id) {
  game.events = game.events.filter((e) => e.id !== id);
}

// ---------------------------------------------------------------- lineup, subs & playing time

/** Who's on the pitch now: the starting lineup with every substitution applied. */
export function onPitch(game) {
  const on = new Set(game.starting);
  for (const sub of sortedSubs(game)) {
    sub.off.forEach((id) => on.delete(id));
    sub.on.forEach((id) => on.add(id));
  }
  return [...on];
}

const sortedSubs = (game) => [...game.subs].sort((a, b) => a.half - b.half || a.t - b.t || a.id - b.id);

/**
 * Makes `ids` the players on the pitch. Before kick-off that sets the starting
 * lineup; at half time it's a sub at the start of the 2nd half; otherwise a sub
 * now. Returns the sub record (null if nothing changed or before kick-off).
 */
export function setOnPitch(state, game, ids, now = Date.now()) {
  const p = phase(game);
  if (p === "full") return null;
  const want = new Set(ids);
  if (p === "pre") {
    game.starting = [...want];
    return null;
  }
  const current = new Set(onPitch(game));
  const on = [...want].filter((id) => !current.has(id));
  const off = [...current].filter((id) => !want.has(id));
  if (!on.length && !off.length) return null;
  const c = clock(game, now);
  const sub = p === "half"
    ? { id: newId(state), half: 2, t: game.halfLength * 60, on, off }
    : { id: newId(state), half: c.half, t: c.seconds, on, off };
  game.subs.push(sub);
  return sub;
}

export function deleteSub(game, id) {
  game.subs = game.subs.filter((s) => s.id !== id);
}

/** Seconds each player has been on the pitch: Map(playerId → seconds). */
export function playingTime(game, now = Date.now()) {
  const secs = new Map();
  const on = new Set(game.starting);
  const subs = sortedSubs(game);
  let i = 0;
  for (const half of [1, 2]) {
    const period = game.periods[half - 1];
    // Half-time subs (half 2, at its first second) are applied as the 2nd half starts.
    const start = (half - 1) * game.halfLength * 60;
    if (!period) break;
    const end = start + Math.max(0, Math.floor(((period.end ?? now) - period.start) / 1000));
    let from = start;
    const credit = (to) => { for (const id of on) secs.set(id, (secs.get(id) ?? 0) + Math.max(0, to - from)); };
    while (i < subs.length && subs[i].half === half) {
      const t = Math.min(Math.max(subs[i].t, start), end);
      credit(t);
      from = t;
      subs[i].off.forEach((id) => on.delete(id));
      subs[i].on.forEach((id) => on.add(id));
      i++;
    }
    credit(end);
  }
  return secs;
}

export const formatMinutes = (seconds) => `${Math.floor((seconds ?? 0) / 60)}'`;

// ---------------------------------------------------------------- score

const goals = (game, team) => game.events.filter((e) => e.type === "goal" && (e.team ?? "us") === team).length;
export const score = (game) => ({ us: goals(game, "us"), them: goals(game, "them") });

// ---------------------------------------------------------------- stats

const zeroCounts = () => Object.fromEntries(EVENT_IDS.map((id) => [id, 0]));

/**
 * Counts per type for our team (total, and per player with key "unknown" for
 * no player) and, separately, for the opposition (them).
 */
export function tally(events) {
  const total = zeroCounts();
  const them = zeroCounts();
  const byPlayer = new Map();
  for (const e of events) {
    if (e.team === "them") {
      them[e.type]++;
      continue;
    }
    total[e.type]++;
    const key = e.playerId ?? "unknown";
    if (!byPlayer.has(key)) byPlayer.set(key, zeroCounts());
    byPlayer.get(key)[e.type]++;
  }
  return { total, byPlayer, them };
}

export function seasonTally(state) {
  return tally(state.games.flatMap((g) => g.events));
}

/** Total seconds played per player across all games. */
export function seasonPlayingTime(state, now = Date.now()) {
  const total = new Map();
  for (const g of state.games) for (const [id, s] of playingTime(g, now)) total.set(id, (total.get(id) ?? 0) + s);
  return total;
}

const label = (number, name) => (number == null ? name || "?" : name ? `#${number} ${name}` : `#${number}`);

/** Player as known across the season: usual number and name. */
export function playerLabel(state, id) {
  if (id == null || id === "unknown") return "Unknown";
  const p = state.players.find((p) => p.id === id);
  return p ? label(p.number, p.name) : "?";
}

/** Player as they appeared in one game: the number they wore that day. */
export function gamePlayerLabel(state, game, id) {
  if (id == null || id === "unknown") return "Unknown";
  const p = state.players.find((p) => p.id === id);
  const number = game.roster.find((r) => r.playerId === id)?.number ?? game.events.findLast((e) => e.playerId === id)?.number ?? p?.number;
  return label(number, p?.name);
}

/** One event's player, with the number worn when it happened. */
export function eventPlayerLabel(state, event) {
  if (event.team === "them") return "Opposition";
  if (event.playerId == null) return "Unknown";
  return label(event.number, state.players.find((p) => p.id === event.playerId)?.name);
}


const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function gameCSV(state, game) {
  const rows = [["Minute", "Half", "Clock", "Event", "Number", "Player", "X (0 own goal-1 their goal)", "Y (0-1)"]];
  const name = (id) => state.players.find((p) => p.id === id)?.name ?? "";
  const num = (id) => game.roster.find((r) => r.playerId === id)?.number ?? "";
  const items = [
    ...game.events.map((e) => ({ ...e, row: [eventType(e.type).label, e.number ?? "", e.team === "them" ? "Opposition" : e.playerId == null ? "Unknown" : name(e.playerId), e.x ?? "", e.y ?? ""] })),
    ...game.subs.flatMap((sub) => [
      ...sub.off.map((id) => ({ ...sub, row: ["Sub off", num(id), name(id), "", ""] })),
      ...sub.on.map((id) => ({ ...sub, row: ["Sub on", num(id), name(id), "", ""] })),
    ]),
  ].sort((a, b) => a.half - b.half || a.t - b.t);
  for (const it of items) rows.push([minuteLabel(it, game.halfLength), it.half, formatClock(it.t), ...it.row]);
  const { us, them } = score(game);
  const mins = playingTime(game);
  rows.push([], ["Score", `${us}-${them}`], [], ["Number", "Player", "Minutes played"]);
  for (const r of game.roster) rows.push([r.number, name(r.playerId), Math.floor((mins.get(r.playerId) ?? 0) / 60)]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

// ---------------------------------------------------------------- export / import

export function toExport(state, now = new Date()) {
  return { format: FORMAT, version: VERSION, exportedAt: now.toISOString(), nextId: state.nextId, shareTeam: state.shareTeam === true, players: state.players, games: state.games };
}

/** Validates exported JSON (or the stored state). Throws an Error with a readable message. */
export function parseState(text) {
  let data;
  try {
    data = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    throw new Error("This file isn't valid JSON.");
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.players) || !Array.isArray(data.games)) {
    throw new Error("This doesn't look like a Sideline Stats export.");
  }
  if (data.format !== undefined && data.format !== FORMAT) throw new Error("This file is from a different app.");
  if (typeof data.version === "number" && data.version > VERSION) throw new Error("This file is from a newer version of Sideline Stats.");

  const ids = new Set();
  const useId = (id, what) => {
    if (!Number.isInteger(id) || id < 1) throw new Error(`A ${what} has an invalid id.`);
    if (ids.has(id)) throw new Error(`Duplicate id ${id} in file.`);
    ids.add(id);
  };
  const state = emptyState();
  for (const p of data.players) {
    useId(p?.id, "player");
    if (parseNumber(p.number) == null) throw new Error(`Player ${p.id} has an invalid number.`);
    state.players.push({ id: p.id, number: parseNumber(p.number), name: String(p.name ?? "").slice(0, 40), ...(p.removed ? { removed: true } : {}) });
  }
  const playerIds = new Set(state.players.map((p) => p.id));
  for (const g of data.games) {
    useId(g?.id, "game");
    if (typeof g.opponent !== "string" || !g.opponent.trim()) throw new Error(`Game ${g.id} has no opponent.`);
    if (!Number.isInteger(g.halfLength) || g.halfLength < 1 || g.halfLength > 60) throw new Error(`Game ${g.id} has an invalid half length.`);
    if (!Array.isArray(g.periods) || g.periods.length > 2) throw new Error(`Game ${g.id} has invalid halves.`);
    const periods = g.periods.map((p) => {
      if (!Number.isFinite(p?.start) || !(p.end == null || (Number.isFinite(p.end) && p.end >= p.start))) throw new Error(`Game ${g.id} has invalid half times.`);
      return { start: p.start, end: p.end ?? null };
    });
    if (periods[0]?.end == null && periods.length === 2) throw new Error(`Game ${g.id} has invalid half times.`);
    const events = (g.events ?? []).map((e) => {
      useId(e?.id, "event");
      if (!EVENT_IDS.includes(e.type)) throw new Error(`Event ${e.id} has an unknown type.`);
      if (e.playerId != null && !playerIds.has(e.playerId)) throw new Error(`Event ${e.id} belongs to an unknown player.`);
      if (![1, 2].includes(e.half) || !Number.isFinite(e.t) || e.t < 0) throw new Error(`Event ${e.id} has an invalid time.`);
      if (e.number != null && parseNumber(e.number) == null) throw new Error(`Event ${e.id} has an invalid shirt number.`);
      const team = e.team ?? "us";
      if (team !== "us" && team !== "them") throw new Error(`Event ${e.id} has an unknown team.`);
      const noSpot = e.x == null && e.y == null; // goals conceded from version 3 have no location
      return {
        id: e.id, type: e.type, team,
        playerId: team === "them" ? null : e.playerId ?? null,
        number: team === "them" || e.number == null ? null : parseNumber(e.number),
        x: noSpot ? null : clamp01(e.x), y: noSpot ? null : clamp01(e.y), half: e.half, t: Math.floor(e.t),
      };
    });
    // Version 1 stored a list of player ids ("squad"); version 2 a team sheet with numbers.
    const sheet = Array.isArray(g.roster)
      ? g.roster
      : (Array.isArray(g.squad) ? g.squad : []).filter((id) => playerIds.has(id)).map((id) => ({ playerId: id, number: state.players.find((p) => p.id === id).number }));
    const checked = checkRoster(state, sheet.filter((r) => playerIds.has(r?.playerId)));
    if (checked.error) throw new Error(`Game ${g.id}: ${checked.error}.`);
    for (const e of events) {
      if (e.playerId != null && e.number == null) {
        e.number = checked.roster.find((r) => r.playerId === e.playerId)?.number ?? state.players.find((p) => p.id === e.playerId).number;
      }
    }
    // Version 3 added lineups, subs and goals conceded; older games start with none.
    const known = (list, what) => {
      if (!Array.isArray(list ?? [])) throw new Error(`Game ${g.id} has an invalid ${what}.`);
      for (const id of list ?? []) if (!playerIds.has(id)) throw new Error(`Game ${g.id} has an unknown player in its ${what}.`);
      return [...new Set(list ?? [])];
    };
    const timed = (x, what) => {
      useId(x?.id, what);
      if (![1, 2].includes(x.half) || !Number.isFinite(x.t) || x.t < 0) throw new Error(`A ${what} in game ${g.id} has an invalid time.`);
      return { id: x.id, half: x.half, t: Math.floor(x.t) };
    };
    const subs = (g.subs ?? []).map((x) => ({ ...timed(x, "substitution"), on: known(x.on, "substitution"), off: known(x.off, "substitution") }));
    // Version 3 kept goals conceded in their own list; they're now opposition Goal events.
    for (const x of g.conceded ?? []) {
      const c = timed(x, "goal conceded");
      events.push({ ...c, type: "goal", team: "them", playerId: null, number: null, x: null, y: null });
    }
    state.games.push({
      id: g.id,
      opponent: g.opponent.trim(),
      date: isValidISODate(g.date) ? g.date : todayISO(),
      halfLength: g.halfLength,
      roster: checked.roster,
      ...(g.shared === true ? { shared: true } : {}),
      // Coaches (lowercase emails) who may edit this game alongside its creator.
      ...(Array.isArray(g.editors) && g.editors.length
        ? { editors: [...new Set(g.editors.filter((e) => typeof e === "string" && e.includes("@")).map((e) => e.toLowerCase()))] }
        : {}),
      starting: known(g.starting, "starting lineup"),
      subs,
      periods,
      events,
    });
  }
  state.nextId = Math.max(Number.isInteger(data.nextId) ? data.nextId : 1, Math.max(0, ...ids) + 1);
  if (data.shareTeam === true) state.shareTeam = true; // every coach can view the squad and every game
  return state;
}
