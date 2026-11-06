// Pure data logic: no DOM, no storage. Functions mutate the state they're given.

export const FORMAT = "sideline-stats";
export const VERSION = 1;

/** The five things that can happen. Group drives chart colour; positive drives fill. */
export const EVENT_TYPES = [
  { id: "tackle_won", label: "Tackle won", short: "Tkl W", group: 0, positive: true },
  { id: "air_won", label: "Won in air", short: "Air W", group: 1, positive: true },
  { id: "air_lost", label: "Lost in air", short: "Air L", group: 1, positive: false },
  { id: "shot_on", label: "Shot on target", short: "On T", group: 2, positive: true },
  { id: "shot_off", label: "Shot off target", short: "Off T", group: 2, positive: false },
];
export const EVENT_IDS = EVENT_TYPES.map((t) => t.id);
export const eventType = (id) => EVENT_TYPES.find((t) => t.id === id);

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
  const player = { id: state.nextId++, number: parseNumber(number), name: String(name ?? "").trim() };
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

const playerHasEvents = (state, id) => state.games.some((g) => g.events.some((e) => e.playerId === id));

/** Players with recorded events are hidden, not deleted, so old stats keep their names. */
export function removePlayer(state, id) {
  if (playerHasEvents(state, id)) {
    const p = state.players.find((p) => p.id === id);
    if (p) p.removed = true;
  } else {
    state.players = state.players.filter((p) => p.id !== id);
  }
  for (const g of state.games) g.squad = g.squad.filter((pid) => pid !== id);
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

export function createGame(state, { opponent, date, halfLength, squad }) {
  const name = String(opponent ?? "").trim();
  if (!name) return { error: "Enter the opponent's name" };
  const len = Number(halfLength);
  if (!Number.isInteger(len) || len < 1 || len > 60) return { error: "Half length must be 1–60 minutes" };
  const game = {
    id: state.nextId++,
    opponent: name.slice(0, 60),
    date: isValidISODate(date) ? date : todayISO(),
    halfLength: len,
    squad: squad ?? activePlayers(state).map((p) => p.id),
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

/** playerId null means "unknown player". x: 0 own goal → 1 their goal; y: 0 top → 1 bottom. */
export function addEvent(state, game, { type, playerId, x, y }, now = Date.now()) {
  if (!EVENT_IDS.includes(type)) throw new Error(`Unknown event type ${type}`);
  const c = clock(game, now);
  const event = {
    id: state.nextId++,
    type,
    playerId: playerId ?? null,
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

// ---------------------------------------------------------------- stats

const zeroCounts = () => Object.fromEntries(EVENT_IDS.map((id) => [id, 0]));

/** Counts per type overall and per player (key "unknown" for no player). */
export function tally(events) {
  const total = zeroCounts();
  const byPlayer = new Map();
  for (const e of events) {
    total[e.type]++;
    const key = e.playerId ?? "unknown";
    if (!byPlayer.has(key)) byPlayer.set(key, zeroCounts());
    byPlayer.get(key)[e.type]++;
  }
  return { total, byPlayer };
}

export function seasonTally(state) {
  return tally(state.games.flatMap((g) => g.events));
}

export function playerLabel(state, id) {
  if (id == null || id === "unknown") return "Unknown";
  const p = state.players.find((p) => p.id === id);
  if (!p) return "?";
  return p.name ? `#${p.number} ${p.name}` : `#${p.number}`;
}

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function gameCSV(state, game) {
  const rows = [["Minute", "Half", "Clock", "Event", "Number", "Player", "X (0 own goal-1 their goal)", "Y (0-1)"]];
  const sorted = [...game.events].sort((a, b) => a.half - b.half || a.t - b.t);
  for (const e of sorted) {
    const p = state.players.find((p) => p.id === e.playerId);
    rows.push([minuteLabel(e, game.halfLength), e.half, formatClock(e.t), eventType(e.type).label, p?.number ?? "", p?.name ?? (p ? "" : "Unknown"), e.x, e.y]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

// ---------------------------------------------------------------- export / import

export function toExport(state, now = new Date()) {
  return { format: FORMAT, version: VERSION, exportedAt: now.toISOString(), nextId: state.nextId, players: state.players, games: state.games };
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
      return { id: e.id, type: e.type, playerId: e.playerId ?? null, x: clamp01(e.x), y: clamp01(e.y), half: e.half, t: Math.floor(e.t) };
    });
    state.games.push({
      id: g.id,
      opponent: g.opponent.trim(),
      date: isValidISODate(g.date) ? g.date : todayISO(),
      halfLength: g.halfLength,
      squad: (Array.isArray(g.squad) ? g.squad : []).filter((id) => playerIds.has(id)),
      periods,
      events,
    });
  }
  state.nextId = Math.max(Number.isInteger(data.nextId) ? data.nextId : 1, Math.max(0, ...ids) + 1);
  return state;
}
