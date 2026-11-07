import * as S from "./store.js";
import * as storage from "./storage.js";

// Firebase loads from Google's CDN. If it can't (offline on first open), the app
// still runs from this phone's copy for the last signed-in account and syncs later.
let cloud = null;
try {
  cloud = await import("./cloud.js");
} catch (e) {
  console.warn("Cloud sync unavailable:", e);
}

// ---------------------------------------------------------------- state

const app = {
  state: S.emptyState(),
  meta: storage.loadMeta(),
  loadProblem: null,
  storageOk: storage.storageAvailable(),
  persisted: null,
  // Account: access is "checking" | "signed-out" | "denied" | "unverifiable" | "no-cloud" | "allowed"
  user: null,
  access: "checking",
  authError: null,
  shared: [], // games others have shared: [{ docId, owner, ownerName, names, game }]
  sharedTeams: [], // teams others have shared: [{ uid, ownerName, players }]
  coGames: [], // other coaches' games you can edit: [{ docId, owner, ownerName, st, game }]
  people: [], // everyone on the allowlist (coaches and admins can see it): [{ email, name, role, team }]
  coaches: [], // the coaches and admins among them
  role: null, // "admin" | "coach" | "player"
  playerTeam: null, // for a player: the uid of the coach whose team they follow
  edits: [], // for a coach: uids of teams an admin has let them edit live
  allTeams: [], // for an admin: every team, [{ uid, teamName, ownerName }]
  route: { name: "games" },
  pending: null, // live entry: { gameId, x, y, type, playerId } – playerId undefined = not chosen, null = unknown
  // Game stats drill-down: half, team, one event type or side ("all" | "attack" | "defend" | type id), one player, one picked event.
  statsFilter: { half: 0, type: "all", playerId: undefined, team: "us", selected: null },
  // Season stats: table sort, and the player page's type filter and picked event.
  season: { key: null, sort: { col: "all", dir: 1 }, pkey: null, type: "all", selected: null },
};

function commit(mutate, { rerender = true } = {}) {
  const result = mutate(app.state);
  app.storageOk = storage.saveState(app.state);
  app.meta.changesSinceExport = (app.meta.changesSinceExport ?? 0) + 1;
  storage.saveMeta(app.meta);
  pushChanges();
  if (rerender) render();
  return result;
}

// ---------------------------------------------------------------- account & sync

// What we last sent to (or received from) Firestore, so only real changes are written.
//   players: JSON of your squad doc
//   games:   docId → { game, top } for your games (game = a copy, top = owner-only fields as JSON)
//   co:      docId → game copy, for other coaches' games you can edit
const sent = { players: null, games: new Map(), co: new Map() };
let stopWatching = [];
// Feeds of games for the teams an admin has let this coach edit: uid → stop().
let teamFeeds = new Map();

const clone = (v) => JSON.parse(JSON.stringify(v));

/** JSON with object keys sorted, so two copies of the same data compare equal. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Names (and usual numbers) of everyone in a game, so other coaches can view it without your squad. */
function namesFor(game) {
  const ids = new Set([...game.roster.map((r) => r.playerId), ...game.events.map((e) => e.playerId).filter((id) => id != null)]);
  const out = {};
  for (const id of ids) {
    const p = app.state.players.find((p) => p.id === id);
    if (p) out[id] = { number: p.number, name: p.name };
  }
  return out;
}

/**
 * The Firestore updates that turn prev into cur. Events and subs are added and
 * removed one by one (so two coaches' simultaneous entries both survive); every
 * other field is set whole.
 */
function gameOps(prev, cur) {
  const set = {};
  for (const key of new Set([...Object.keys(prev), ...Object.keys(cur)])) {
    if (key === "events" || key === "subs" || key === "possession") continue;
    if (stable(prev[key]) !== stable(cur[key])) set[`game.${key}`] = cur[key] === undefined ? cloud.unset() : clone(cur[key]);
  }
  const ops = Object.keys(set).length ? [set] : [];
  for (const key of ["events", "subs", "possession"]) {
    const before = new Map((prev[key] ?? []).map((x) => [x.id, stable(x)]));
    const after = new Map((cur[key] ?? []).map((x) => [x.id, stable(x)]));
    const removed = (prev[key] ?? []).filter((x) => after.get(x.id) !== stable(x));
    const added = (cur[key] ?? []).filter((x) => before.get(x.id) !== stable(x));
    if (removed.length) ops.push({ [`game.${key}`]: cloud.remove(removed) });
    if (added.length) ops.push({ [`game.${key}`]: cloud.add(added) });
  }
  return ops;
}

// Writes not yet confirmed by Firebase. While any are outstanding, an incoming
// snapshot may predate them, so it's held back (and applied once they settle).
let inFlight = 0;
let heldBack = null;
let heldBackCo = null;

/**
 * Changes Firebase hasn't confirmed yet are noted on the phone (meta.pending),
 * so if the app is closed or reloaded first, the phone's copy wins next time
 * and the changes (including deleted games) are sent again.
 */
function notePending(deletedDocId) {
  const uid = app.user.uid;
  const p = app.meta.pending?.[uid] ?? { dirty: false, deleted: [] };
  p.dirty = true;
  if (deletedDocId && !p.deleted.includes(deletedDocId)) p.deleted.push(deletedDocId);
  app.meta.pending = { ...app.meta.pending, [uid]: p };
  saveMeta();
}

function track(promise) {
  inFlight++;
  const uid = app.user?.uid;
  promise.catch(syncFailed).finally(() => {
    inFlight--;
    if (inFlight === 0 && uid && app.user?.uid === uid && app.meta.pending?.[uid]) {
      delete app.meta.pending[uid]; // everything confirmed
      saveMeta();
    }
    if (inFlight === 0) {
      if (heldBack) { const args = heldBack; heldBack = null; receive(...args); }
      if (heldBackCo) { const list = heldBackCo; heldBackCo = null; receiveEditable(list); }
    }
  });
}

/** A live feed was refused: if this account has been removed, lock the app. */
async function accessLost(e) {
  if (e?.code !== "permission-denied" || !app.user || !cloud) return;
  if ((await cloud.getAccess(app.user)) === false) {
    app.access = "denied";
    stopWatching.forEach((stop) => stop());
    stopWatching = [];
    teamFeeds.forEach((stop) => stop());
    teamFeeds = new Map();
    render();
  }
}

/** Re-checks access, so someone removed from the list is locked out within a minute (or on reopening). */
async function recheckAccess() {
  if (app.access !== "allowed" || !app.user || !cloud || document.visibilityState !== "visible") return;
  if ((await cloud.getAccess(app.user)) === false) accessLost({ code: "permission-denied" });
}
setInterval(recheckAccess, 60_000);
document.addEventListener("visibilitychange", recheckAccess);

async function syncFailed(e) {
  console.warn("Sync failed:", e);
  // Refused writes are either a removed coach (then lock the app) or, say, a game
  // whose editor rights were just taken away (then the watchers drop it).
  if (e?.code === "permission-denied" && app.user && cloud && (await cloud.isAllowed(app.user)) === false) {
    app.access = "denied";
    render();
  }
}

const topFields = (g, teamShared) => ({ shared: teamShared || g.shared === true, editors: g.editors ?? [], names: namesFor(g) });

/** Writes anything that changed since the last sync. Firestore queues writes while offline. */
function pushChanges() {
  if (!app.user || app.access !== "allowed" || app.role === "player") return;
  if (!cloud) {
    app.meta.unsynced = { ...app.meta.unsynced, [app.user.uid]: true };
    saveMeta();
    return;
  }
  const uid = app.user.uid;
  const teamShared = app.state.shareTeam === true;
  const teamName = app.state.teamName ?? "";
  const players = JSON.stringify({ players: app.state.players, teamShared, teamName });
  if (players !== sent.players) {
    sent.players = players;
    notePending();
    track(cloud.saveUser(app.user, { players: app.state.players, shared: teamShared, teamName }));
  }
  const live = new Set();
  for (const g of app.state.games) {
    const docId = cloud.gameDocId(uid, g.id);
    live.add(docId);
    const top = topFields(g, teamShared);
    const topJson = stable(top);
    const prev = sent.games.get(docId);
    if (!prev) {
      notePending();
      track(cloud.saveGame(app.user, g, top.names, top.shared));
    } else {
      const ops = gameOps(prev.game, g);
      if (topJson !== prev.top) ops.unshift(top);
      if (ops.length) notePending();
      for (const fields of ops) track(cloud.updateGame(docId, fields));
    }
    sent.games.set(docId, { game: clone(g), top: topJson });
  }
  for (const docId of [...sent.games.keys()]) {
    if (!live.has(docId)) {
      sent.games.delete(docId);
      notePending(docId);
      track(cloud.removeGame(uid, docId.slice(uid.length + 1)));
    }
  }
  // Other coaches' games you're editing: only the game itself can change.
  for (const entry of app.coGames) {
    const prev = sent.co.get(entry.docId);
    if (!prev) continue;
    for (const fields of gameOps(prev, entry.game)) track(cloud.updateGame(entry.docId, fields));
    sent.co.set(entry.docId, clone(entry.game));
  }
}

let reconciled = false;

/** Applies your squad and games from Firestore (another device, another coach, or after reconnecting). */
function receive(user, games, fromServer) {
  if (inFlight > 0 && reconciled) {
    heldBack = [user, games, fromServer];
    return;
  }
  if (!reconciled) {
    // Wait for the server's answer before deciding anything about a first sign-in.
    if (!fromServer) return;
    reconciled = true;
    document.body.dataset.sync = "ready";
    const cloudEmpty = !user && games.length === 0;
    const uid = app.user.uid;
    const pending = app.meta.pending?.[uid];
    const unsynced = app.meta.unsynced?.[uid] || pending?.dirty;
    if (cloudEmpty) {
      // First sign-in: upload this phone's data (from before accounts, if that's all there is).
      const legacy = storage.loadLegacy();
      if (!app.state.players.length && !app.state.games.length && legacy) {
        app.state = legacy.state;
        storage.saveState(app.state);
        storage.retireLegacy(app.user.uid);
        toast("Your existing squad and games are now saved to your account.");
        render();
      }
      pushChanges();
      return;
    }
    if (unsynced) {
      // Changes Firebase never confirmed (app closed too soon, or Firebase couldn't
      // load): keep this phone's copy, add games that only exist in the cloud
      // (another device), and send everything again, deletions included.
      const deleted = new Set(pending?.deleted ?? []);
      const mine = new Set(app.state.games.map((g) => g.id));
      app.state.games.push(...parseGames(games).filter((g) => !mine.has(g.id) && !deleted.has(cloud.gameDocId(uid, g.id))));
      app.meta.unsynced = { ...app.meta.unsynced, [uid]: false };
      saveMeta();
      for (const docId of deleted) {
        notePending(docId);
        track(cloud.removeGame(uid, docId.slice(uid.length + 1)));
      }
      pushChanges();
      storage.saveState(app.state);
      render();
      return;
    }
  }
  let incoming;
  try {
    incoming = S.parseState({ players: user?.players ?? [], games, shareTeam: user?.shared === true, teamName: user?.teamName ?? "" });
  } catch (e) {
    console.warn("Ignoring unreadable cloud data:", e);
    return;
  }
  // Remember the server's copy as the base for future field-level updates.
  const teamShared = incoming.shareTeam === true;
  sent.players = JSON.stringify({ players: incoming.players, teamShared, teamName: incoming.teamName ?? "" });
  sent.games = new Map(incoming.games.map((g) => [cloud.gameDocId(app.user.uid, g.id), { game: clone(g), top: stable(topFields(g, teamShared)) }]));
  // Usually this is just our own write coming back: keep the same objects (open
  // dialogs and Undo buttons hold references to them) unless something really changed.
  if (canonical(incoming) === canonical(app.state)) return;
  incoming.nextId = Math.max(incoming.nextId, app.state.nextId);
  app.state = incoming;
  storage.saveState(app.state);
  refresh();
}

/** Other coaches' games you can edit, as [{ docId, owner, ownerName, st, game }]. */
function receiveEditable(list) {
  if (inFlight > 0) {
    heldBackCo = list;
    return;
  }
  const next = [];
  for (const item of list) {
    const players = Object.entries(item.names ?? {}).map(([id, p]) => ({ id: Number(id), number: p.number, name: p.name ?? "" }));
    let st;
    try {
      st = S.parseState({ players, games: [item.game] });
    } catch (e) {
      console.warn("Ignoring unreadable shared game:", e);
      continue;
    }
    const game = st.games[0];
    const old = app.coGames.find((x) => x.docId === item.docId);
    sent.co.set(item.docId, clone(game));
    if (old && stable(old.game) === stable(game) && stable(old.st.players) === stable(st.players)) {
      next.push(old); // unchanged: keep the objects the screen is using
    } else {
      next.push({ docId: item.docId, owner: item.owner, ownerName: item.ownerName, st, game });
    }
  }
  for (const docId of [...sent.co.keys()]) if (!next.some((x) => x.docId === docId)) sent.co.delete(docId);
  const changed = stable(next.map((x) => x.game)) !== stable(app.coGames.map((x) => x.game));
  app.coGames = next;
  if (changed || ["games", "co", "costats"].includes(app.route.name)) refresh();
}

/** Squad and games in a fixed shape and order, for comparing two copies. */
function canonical(state) {
  try {
    const st = S.parseState({ players: state.players, games: state.games, shareTeam: state.shareTeam === true, teamName: state.teamName ?? "" });
    st.games.sort((a, b) => a.id - b.id);
    return stable({ players: st.players, games: st.games, shareTeam: st.shareTeam === true, teamName: st.teamName ?? "" });
  } catch {
    return Math.random().toString(); // unreadable: treat as different
  }
}

function parseGames(games) {
  try {
    return S.parseState({ players: app.state.players, games }).games;
  } catch {
    return [];
  }
}

async function startAccount(user) {
  delete document.body.dataset.sync; // set to "ready" once this account's first sync is done
  stopWatching.forEach((stop) => stop());
  stopWatching = [];
  teamFeeds.forEach((stop) => stop());
  teamFeeds = new Map();
  reconciled = false;
  inFlight = 0;
  heldBack = null;
  heldBackCo = null;
  sent.players = null;
  sent.games = new Map();
  sent.co = new Map();
  app.shared = [];
  app.sharedTeams = [];
  app.coGames = [];
  app.people = [];
  app.coaches = [];
  app.role = null;
  app.playerTeam = null;
  app.edits = [];
  app.allTeams = [];
  app.user = user;
  app.authError = null;
  if (!user) {
    app.access = "signed-out";
    app.state = S.emptyState();
    storage.useAccount(null);
    render();
    return;
  }
  // Show this account's copy on this phone straight away.
  storage.useAccount(user.uid);
  const local = storage.loadState();
  app.state = local.state;
  app.loadProblem = local.problem;
  app.access = "checking";
  render();

  let access = cloud ? await cloud.getAccess(user) : null;
  if (access === null) access = app.meta.roles?.[user.uid] ?? (app.meta.allowed?.[user.uid] ? { role: "coach" } : null); // offline: trust the last answer
  if (app.user !== user) return; // signed out meanwhile
  if (!access) {
    app.access = access === false ? "denied" : "unverifiable";
    render();
    return;
  }
  app.role = access.role;
  app.playerTeam = access.team ?? null;
  app.edits = access.edits ?? [];
  app.meta.roles = { ...app.meta.roles, [user.uid]: access };
  app.meta.allowed = { ...app.meta.allowed, [user.uid]: true };
  app.meta.lastUser = user;
  saveMeta();
  app.access = "allowed";
  if (app.role === "player" && !["help", "data", "shared"].includes(app.route.name)) go("#/games");
  render();
  if (!cloud) {
    document.body.dataset.sync = "ready";
    return;
  }
  // Changes to this account's access apply straight away: removed → locked out;
  // a new role → start over with it; new team edit rights → follow those teams.
  stopWatching.push(cloud.watchAccess(user, (now) => {
    if (app.user !== user || app.access !== "allowed") return;
    if (now === false) return accessLost({ code: "permission-denied" });
    if (now.role !== app.role || now.team !== app.playerTeam) return startAccount(user);
    app.meta.roles = { ...app.meta.roles, [user.uid]: now };
    saveMeta();
    if (stable(now.edits) !== stable(app.edits)) {
      app.edits = now.edits;
      followTeams();
    }
  }, (e) => console.warn("Access feed unavailable:", e)));
  if (app.role === "player") {
    // Players only follow their team, read only.
    stopWatching.push(cloud.watchTeam(app.playerTeam, (team, games) => {
      app.sharedTeams = team ? [{ uid: app.playerTeam, ...team }] : [];
      app.shared = games;
      document.body.dataset.sync = "ready";
      refresh();
    }, (e) => { console.warn("Team unavailable:", e); accessLost(e); }));
    return;
  }
  const warn = (what) => (e) => { console.warn(`${what} unavailable:`, e); accessLost(e); };
  const rerenderOn = (...routes) => () => { if (routes.includes(app.route.name)) refresh(); };
  const sharedChanged = rerenderOn("games", "shared", "team");
  const teamsChanged = rerenderOn("games", "team");
  const peopleChanged = rerenderOn("data", "stats", "admin");
  stopWatching.push(
    cloud.watchMine(user.uid, receive, syncFailed),
    cloud.watchShared(user.uid, (list) => { app.shared = list; sharedChanged(); }, warn("Shared games")),
    cloud.watchSharedTeams(user.uid, (list) => { app.sharedTeams = list; teamsChanged(); }, warn("Shared teams")),
    cloud.watchEditable(user, (list) => { editableDirect = list; mergeEditable(); }, warn("Games you can edit")),
    cloud.watchPeople((list) => {
      app.people = list;
      app.coaches = list.filter((p) => p.role !== "player");
      peopleChanged();
    }, warn("Coaches list")),
  );
  editableDirect = [];
  editableByTeam = new Map();
  followTeams();
  if (app.role === "admin") {
    stopWatching.push(cloud.watchAllTeams((list) => { app.allTeams = list; if (app.route.name === "admin") refresh(); }, warn("Teams")));
  }
}

// Games you can edit come from two places: games that list you as an editor, and
// every game of the teams an admin has let you edit.
let editableDirect = [];
let editableByTeam = new Map();
function mergeEditable() {
  const byId = new Map();
  for (const x of [...editableDirect, ...[...editableByTeam.values()].flat()]) {
    if (x.owner !== app.user?.uid) byId.set(x.docId, x);
  }
  receiveEditable([...byId.values()]);
}

/** Starts (and stops) the feeds for the teams in app.edits. */
function followTeams() {
  const user = app.user;
  const want = new Set(app.edits.filter((uid) => uid !== user.uid));
  for (const [uid, stop] of teamFeeds) {
    if (!want.has(uid)) { stop(); teamFeeds.delete(uid); editableByTeam.delete(uid); }
  }
  for (const uid of want) {
    if (teamFeeds.has(uid)) continue;
    teamFeeds.set(uid, cloud.watchTeamGames(uid, (list) => {
      if (app.user !== user || !teamFeeds.has(uid)) return;
      editableByTeam.set(uid, list);
      mergeEditable();
    }, (e) => console.warn("Team games unavailable:", e)));
  }
  mergeEditable();
}

const saveMeta = () => storage.saveMeta(app.meta);
const findGame = (id) => app.state.games.find((g) => g.id === id);
/** The live copy of a game (yours, or one you're editing), for callbacks that run later: the data may have been refreshed from another device. */
const current = (game) => findGame(game.id) ?? app.coGames.find((x) => x.game.id === game.id)?.game ?? game;

// ---------------------------------------------------------------- formatting

const longDate = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fmtDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return longDate.format(new Date(Date.UTC(y, m - 1, d))); };
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const PHASE_LABEL = { pre: "Not started", first: "1st half", half: "Half time", second: "2nd half", full: "Full time" };

// ---------------------------------------------------------------- DOM helpers

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  setProps(el, props);
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}
const SVG_NS = "http://www.w3.org/2000/svg";
function s(tag, props, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  setProps(el, props);
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}
function setProps(el, props = {}) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
}

/** Event symbol: colour = group (defending/aerial/attacking), shape = type, hollow = lost / off target. */
function symbolShape(type, cx, cy, r, extra = {}) {
  const t = S.eventType(type);
  if (t.shape === "card") {
    // A yellow card always looks like one: a filled yellow portrait rectangle.
    return s("rect", { ...extra, class: `sym-card ${extra.class ?? ""}`.trim(), x: cx - r * 0.62, y: cy - r * 0.95, width: r * 1.24, height: r * 1.8, rx: r * 0.15 });
  }
  const cls = `sym-${t.group}${t.positive ? "" : " sym-hollow"} ${extra.class ?? ""}`.trim();
  const poly = (pts) => s("polygon", { ...extra, class: cls, points: pts.map(([x, y]) => `${cx + x * r},${cy + y * r}`).join(" "), "stroke-linejoin": "round" });
  switch (t.shape) {
    case "circle": return s("circle", { ...extra, class: cls, cx, cy, r: r * 0.95 });
    case "diamond": return poly([[0, -1.15], [1.05, 0], [0, 1.15], [-1.05, 0]]);
    case "triangle": return poly([[0, -1.1], [1.05, 0.75], [-1.05, 0.75]]);
    case "tri-down": return poly([[0, 1.1], [1.05, -0.75], [-1.05, -0.75]]);
    case "hexagon": return poly(Array.from({ length: 6 }, (_, i) => [Math.cos((Math.PI / 3) * i) * 1.05, Math.sin((Math.PI / 3) * i) * 1.05]));
    case "star": return poly(Array.from({ length: 10 }, (_, i) => {
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const rr = i % 2 ? 0.5 : 1.25;
      return [Math.cos(a) * rr, Math.sin(a) * rr + 0.1];
    }));
    default: return s("rect", { ...extra, class: cls, x: cx - r * 0.85, y: cy - r * 0.85, width: r * 1.7, height: r * 1.7, rx: r * 0.2 });
  }
}
const symbolIcon = (type, size = 18) =>
  s("svg", { width: size, height: size, viewBox: "0 0 20 20", "aria-hidden": "true" }, symbolShape(type, 10, 10.5, 7.2));

// ---------------------------------------------------------------- dialog & toast

const dialog = document.getElementById("dialog");
let dialogOk = null;
document.getElementById("dialog-cancel").addEventListener("click", () => dialog.close());
document.getElementById("dialog-form").addEventListener("submit", (e) => {
  const error = dialogOk?.();
  if (error) {
    e.preventDefault();
    const p = document.getElementById("dialog-error");
    p.textContent = error;
    p.hidden = false;
  }
});

function openDialog({ title, body, okLabel = "OK", danger = false, cancel = true, onOk }) {
  document.getElementById("dialog-title").textContent = title;
  document.getElementById("dialog-body").replaceChildren(...[body].flat().filter(Boolean));
  document.getElementById("dialog-error").hidden = true;
  document.getElementById("dialog-cancel").hidden = !cancel;
  const ok = document.getElementById("dialog-ok");
  ok.disabled = false;
  ok.textContent = okLabel;
  ok.className = danger ? "btn btn-danger" : "btn";
  dialogOk = onOk;
  dialog.showModal();
  dialog.querySelector("#dialog-body input:not([type=checkbox])")?.select();
}

const toastEl = document.getElementById("toast");
let toastTimer = null;
function toast(text, undo) {
  clearTimeout(toastTimer);
  if (app.route.name === "live") {
    // On the live screen, messages go in a fixed line under the clock so nothing covers the buttons.
    app.liveStatus = { text, undo };
    renderLiveStatus();
    toastTimer = setTimeout(() => { app.liveStatus = null; renderLiveStatus(); }, 8000);
    return;
  }
  toastEl.replaceChildren(
    h("span", {}, text),
    undo && h("button", { type: "button", onclick: () => { hideToast(); undo(); } }, "Undo"));
  toastEl.hidden = false;
  toastTimer = setTimeout(hideToast, undo ? 6000 : 3000);
}
function hideToast() { toastEl.hidden = true; app.liveStatus = null; }

function liveStatusContent() {
  const st = app.liveStatus;
  if (!st) return [h("span", { class: "muted" }, "Tap where, what and who, in any order.")];
  return [h("span", { class: "msg" }, st.text),
    st.undo && h("button", { type: "button", class: "undo", onclick: () => { const u = st.undo; app.liveStatus = null; clearTimeout(toastTimer); u(); renderLiveStatus(); } }, "Undo")];
}
function renderLiveStatus() {
  document.getElementById("live-status")?.replaceChildren(...liveStatusContent().filter(Boolean));
}

// ---------------------------------------------------------------- export / import

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData() {
  download(`sideline-stats-${S.todayISO()}.json`, JSON.stringify(S.toExport(app.state), null, 2), "application/json");
  app.meta.lastExportAt = new Date().toISOString();
  app.meta.changesSinceExport = 0;
  saveMeta();
  render();
}

async function importFile(file) {
  let incoming;
  try {
    incoming = S.parseState(await file.text());
  } catch (e) {
    openDialog({ title: "Can't import that file", body: h("p", {}, e.message), cancel: false, onOk: () => {} });
    return;
  }
  const cur = app.state;
  const hasData = cur.players.length > 0 || cur.games.length > 0;
  const summary = (st) => `${plural(S.activePlayers(st).length, "player")} and ${plural(st.games.length, "game")}`;
  openDialog({
    title: "Import this file?",
    body: [
      h("p", {}, `The file has ${summary(incoming)}.`),
      hasData && h("p", {}, `It will replace your current squad and games (${summary(cur)}) in your account. Export first if you want to keep a copy.`),
    ],
    okLabel: hasData ? "Replace" : "Import",
    danger: hasData,
    onOk: () => {
      commit((st) => Object.assign(st, incoming), { rerender: false });
      app.meta.changesSinceExport = 0;
      saveMeta();
      toast("Import complete.");
      go("#/games");
    },
  });
}

// ---------------------------------------------------------------- routing

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "game" && parts[1]) return { name: parts[2] === "stats" ? "stats" : "live", id: Number(parts[1]) };
  if (parts[0] === "shared" && parts[1]) return { name: "shared", docId: decodeURIComponent(parts[1]) };
  if (parts[0] === "team" && parts[1]) {
    const uid = decodeURIComponent(parts[1]);
    if (parts[2] === "season") return { name: "team", uid, sub: "season" };
    if (parts[2] === "player" && parts[3]) return { name: "team", uid, sub: "player", playerId: Number(parts[3]) };
    return { name: "team", uid };
  }
  if (parts[0] === "season") return { name: "season", playerId: parts[1] ? Number(parts[1]) : undefined };
  if (parts[0] === "co" && parts[1]) return { name: parts[2] === "stats" ? "costats" : "co", docId: decodeURIComponent(parts[1]) };
  if (["games", "squad", "data", "new", "help", "admin"].includes(parts[0])) return { name: parts[0] };
  return { name: "games" };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener("hashchange", () => {
  app.route = parseRoute();
  hideToast();
  render();
  window.scrollTo(0, 0);
});

// ---------------------------------------------------------------- render

const view = document.getElementById("view");

function render() {
  if (app.access !== "allowed") {
    document.body.classList.remove("live");
    document.getElementById("tabs").hidden = true;
    document.getElementById("banner").hidden = true;
    view.replaceChildren(viewGate());
    updateWakeLock(false);
    return;
  }
  // Players can only view: their team's games and stats, help, and their account.
  if (app.role === "player" && !["games", "shared", "team", "help", "data"].includes(app.route.name)) {
    app.route = { name: "games" };
    history.replaceState(null, "", "#/games");
  }
  const r = app.route;
  const coEntry = r.name === "co" || r.name === "costats" ? app.coGames.find((x) => x.docId === r.docId) ?? null : null;
  const game = r.id != null ? findGame(r.id) : coEntry?.game ?? null;
  if ((r.name === "live" || r.name === "stats") && !game) {
    app.route = { name: "games" };
    history.replaceState(null, "", "#/games");
    return render();
  }
  const live = r.name === "live" || (r.name === "co" && !!coEntry);
  document.body.classList.toggle("live", live);
  document.getElementById("tabs").hidden = live;
  const tab = ["new", "stats", "shared", "team", "co", "costats", "season"].includes(r.name) ? "games" : r.name;
  const tabs = document.getElementById("tabs");
  tabs.dataset.role = app.role ?? "";
  tabs.querySelector('[data-tab="admin"]').hidden = app.role !== "admin";
  tabs.querySelector('[data-tab="squad"]').hidden = app.role === "player";
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  renderBanner(live);
  const notEditable = () => h("section", {}, h("a", { class: "link-btn", href: "#/games" }, "‹ Games"),
    h("h1", {}, "Not available"), h("p", { class: "muted" }, "You can't edit this game (anymore). The coach who created it may have removed you."));
  const views = {
    games: app.role === "player" ? viewPlayerHome : viewGames, admin: viewAdmin, new: viewNewGame, live: () => viewLive(game), stats: () => viewStats(game), shared: viewShared, team: () => (r.sub ? viewTeamSeason(r) : viewTeam()), squad: viewSquad,
    season: () => (r.playerId != null ? viewSeasonPlayer(ownSeason(), r.playerId) : viewSeason(ownSeason())), data: viewData, help: viewHelp,
    co: () => (coEntry ? viewLive(coEntry.game) : notEditable()),
    costats: () => (coEntry ? viewStats(coEntry.game, { st: coEntry.st, co: coEntry }) : notEditable()),
  };
  view.replaceChildren(views[r.name]());
  updateWakeLock(live && S.clock(game).running);
  tick();
}

// Typing survives redraws caused by other people's changes (refresh), and only those:
// the app's own redraws (after saving, say) start fields afresh.
view.addEventListener("input", (e) => { if (e.target.id) e.target.dataset.typed = "1"; });

/** Redraws for a change from elsewhere, keeping what's being typed and where. */
function refresh() {
  const typed = [...view.querySelectorAll("[data-typed][id]")].map((el) => ({
    id: el.id, value: el.value, focused: document.activeElement === el, hash: location.hash,
    sel: (() => { try { return [el.selectionStart, el.selectionEnd]; } catch { return null; } })(),
  }));
  render();
  for (const t of typed) {
    const el = document.getElementById(t.id);
    if (!el || t.hash !== location.hash) continue;
    el.value = t.value;
    el.dataset.typed = "1";
    if (t.focused) {
      el.focus();
      try { if (t.sel) el.setSelectionRange(...t.sel); } catch { /* not a text field */ }
    }
  }
}

function clearInputs(...ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) { el.value = ""; delete el.dataset.typed; }
  }
}

function renderBanner(live) {
  const banner = document.getElementById("banner");
  const m = app.meta;
  let content = null;
  if (!app.storageOk) {
    content = [h("span", {}, "This browser can't keep a copy on this phone (storage is blocked or full), so it needs a connection to save. Export to be safe."),
      h("button", { type: "button", class: "btn btn-small", onclick: exportData }, "Export now")];
  } else if (app.loadProblem) {
    content = [h("span", {}, app.loadProblem), h("button", { type: "button", class: "btn btn-small btn-quiet", onclick: () => { app.loadProblem = null; render(); } }, "Dismiss")];
  } else if (!live && !cloud && m.changesSinceExport > 0) {
    // Nudge after a finished game, or after a fortnight, but never mid-game.
    const finishedSince = app.state.games.some((g) => S.phase(g) === "full" && g.periods[1].end > Date.parse(m.lastExportAt ?? 0));
    const stale = m.lastExportAt && Date.now() - Date.parse(m.lastExportAt) > 14 * 86_400_000;
    if (finishedSince || stale) {
      content = [h("span", {}, m.lastExportAt ? "You have changes since your last backup." : "You haven't backed up yet. Browser storage can be cleared, so keep a copy."),
        h("button", { type: "button", class: "btn btn-small", onclick: exportData }, "Export now")];
    }
  }
  banner.hidden = !content;
  banner.replaceChildren(...(content ?? []));
}

// ---- Help

function viewHelp() {
  const section = (title, open, ...items) => h("details", { open: open || null }, h("summary", {}, title), ...items);
  const ul = (...lis) => h("ul", {}, lis.map((li) => h("li", {}, li)));
  const b = (t) => h("strong", {}, t);
  const table = (head, rows) => h("div", { class: "table-wrap" }, h("table", { class: "help-table" },
    h("thead", {}, h("tr", {}, head.map((x) => h("th", {}, x)))),
    h("tbody", {}, rows.map((r) => h("tr", {}, r.map((x) => h("td", {}, x)))))));
  if (app.role === "player") {
    return h("section", { class: "help", id: "help" },
      h("h1", {}, "Help"),
      section("Viewing your team", true, ul(
        ["Your team's games are on ", b("Games"), ". Tap one for the score, possession, a pitch map and stats by player."],
        ["Games update live while your coach logs them."],
        ["You can view only; your coach makes all changes."])),
      positionsSection(section, table, b));
  }
  return h("section", { class: "help", id: "help" },
    h("h1", {}, "Help"),
    h("p", { class: "muted" }, "Log what happens in a match in three taps, then see who did what, where."),
    section("1. Set up your team", true, ul(
      ["Go to ", b("Squad"), ". Enter your ", b("team's name"), " first: games show as \"Your team vs Rovers\"."],
      ["Add players: type a shirt number and name, press Enter, repeat. Or ", b("Paste or upload a list"), " (one per line, like ", h("code", {}, "7 Sam"), "; CSV works too)."],
      "Numbers here are each player's usual number. You can change them for any single game.")),
    section("2. Start a game", false, ul(
      [b("Games → + New game"), ". Enter the opponent, date and half length."],
      ["Untick anyone not playing, and change a shirt number for that day if needed."],
      [b("Start game"), " asks ", b("Who's starting?"), ": tick the starting players (or Select all), then ", b("Kick off"), "."])),
    section("3. Log events (three taps)", false, ul(
      ["Tap ", b("where"), " on the pitch, ", b("what"), " happened, and ", b("who"), ". Any order. It saves on the third tap."],
      ["Your team always attacks to the ", b("right"), ", in both halves."],
      ["Events are in two blocks, each A–Z: ", b("Attack"), " (Assist … Throw in) and ", b("Defend"), " (Broken ball … Yellow card)."],
      [b("?"), " = one of yours but you didn't see who. ", b("Them"), " = the opposition (a Goal for Them is a goal conceded)."],
      [b("Our ball / Their ball"), ": tap whoever has the ball to track possession. Tap the lit one again when the ball goes out."],
      ["Mistake? Tap ", b("Undo"), " under the clock, or ", b("Delete"), " in the Latest list."]),
      h("p", { class: "tip" }, "Tip: add the app to your phone's home screen (browser menu → Add to Home Screen) so it's one tap away.")),
    section("4. Clock, subs and team sheet", false, ul(
      ["The big button runs the match: ", b("Start game → Half time → Start 2nd half → Full time"), "."],
      ["The ", b("⏸"), " button by the clock: ", b("Pause"), " (injury, stoppage), ", b("Restart this half"), " from its start (misclick), or ", b("Undo"), " the last step."],
      ["The clock keeps correct time even if the phone locks."],
      [b("Subs"), ": tap who's ", b("coming off"), ", then who's ", b("going on"), ". Check the ", b("Changes"), " list, then ", b("Make subs"), ". Minutes played are counted for you."],
      [b("Players"), ": change today's numbers or add someone who turned up."],
      [b("Reset game"), " clears the clock and events but keeps the team sheet. ", b("Delete game"), " removes it. Both are in the ", b("⋯"), " menu on Games, and can be undone straight after."])),
    section("5. See the stats", false, ul(
      ["Tap ", b("stats →"), " on a game: score, ", b("possession"), ", totals, a pitch map, and a table by player with minutes."],
      ["Tap a total, a player, a column or a number in the table to see just those on the map and timeline. Tap it again to show everything."],
      ["Tap an event in the ", b("Timeline"), " (or on the map) to highlight it. The map stays in view while you scroll."],
      [b("Player stats"), " (Games screen, under Season): leaders for every stat, a table you can sort by any column, and each player's games, map and timeline."],
      [b("Download CSV"), " opens in any spreadsheet."])),
    section("6. Share with other coaches", false, ul(
      [b("One game, view only"), ": on its stats page, tick ", b("Share with coaches"), "."],
      [b("Your whole team, view only"), ": on ", b("Squad"), ", tick ", b("Share my team with coaches"), ". Covers every game, now and later."],
      [b("Let a coach edit a game"), ": on its stats page, under ", b("Coaches who can edit this game"), ", tick their name. You can both log at the same time, and every tap (events, clock, possession, subs) shows on both phones within a second or two."],
      [b("Let a coach edit all your games"), ": ask an admin. On the ", b("Admin"), " tab they tap ", b("Live editing"), " next to the coach and tick your team."],
      ["Only you can share, choose editors, change the team sheet or delete your games."])),
    section("7. Coaches, admins and players", false, ul(
      [b("Coaches"), " use the app fully. ", b("Admins"), " are coaches who also add and remove coaches, and choose who can edit which team's games live, on the ", b("Admin"), " tab."],
      [b("Players"), " can view your games and stats, live, and nothing else. Add their Google (Gmail) address under ", b("Account → Player logins"), "."],
      ["Everything saves to your account after every tap. No signal? Keep going: it uploads when you're back online."],
      [b("Account → Export JSON"), " downloads a spare copy of everything."])),
    positionsSection(section, table, b));
}

/** Traditional shirt numbers and common formations. */
function positionsSection(section, table, b) {
  return section("Positions & numbers", false,
    h("p", {}, "Traditionally each number goes with a position. Teams vary, but this is the usual pattern:"),
    table(["No.", "Usual position"], [
      ["1", "Goalkeeper"], ["2", "Right back"], ["3", "Left back"], ["4", "Centre back (or defensive midfield)"],
      ["5", "Centre back"], ["6", "Defensive / centre midfield (or centre back)"], ["7", "Right wing"],
      ["8", "Central midfield"], ["9", "Striker (centre forward)"], ["10", "Attacking midfield / second striker"], ["11", "Left wing"],
    ]),
    h("p", { style: "margin-top:12px" }, "Common formations (defence–midfield–attack), with typical numbers, keeper (1) behind:"),
    table(["Formation", "Defence", "Midfield", "Attack"], [
      ["4-4-2", "2 · 5 · 4 · 3", "7 · 6 · 8 · 11", "10 · 9"],
      ["4-3-3", "2 · 5 · 4 · 3", "6 · 8 · 10", "7 · 9 · 11"],
      ["4-2-3-1", "2 · 5 · 4 · 3", "6 · 8, then 7 · 10 · 11", "9"],
      ["3-5-2", "4 · 5 · 6", "2 · 8 · 10 · 7 · 3 (wing-backs)", "9 · 11"],
      ["9-a-side 3-2-3", "2 · 5 · 3", "4 · 8", "7 · 9 · 11"],
      ["7-a-side 2-3-1", "2 · 3", "7 · 8 · 11", "9"],
    ]),
    h("p", { class: "tip" }, "Defence and midfield read right to left, as the team faces the opposition's goal (so 2 is on the right, 3 on the left)."));
}

// ---- Sign-in gate

function viewGate() {
  const signInBtn = (label = "Sign in with Google") => h("button", {
    type: "button", class: "btn btn-block", id: "sign-in",
    onclick: async () => {
      app.authError = null;
      try {
        await cloud.signIn();
      } catch (e) {
        app.authError = e?.message ?? String(e);
        render();
      }
    },
  }, label);
  const signOutBtn = (label) => h("button", { type: "button", class: "btn btn-quiet btn-block", onclick: () => cloud?.signOut() }, label);
  const screens = {
    checking: [h("p", { class: "muted" }, "Checking your account…")],
    "signed-out": [
      h("p", {}, "Log match events from the sideline in three taps."),
      h("p", { class: "muted" }, "Sign in with the Google account you've been given access with."),
      cloud ? signInBtn() : h("p", {}, "Can't reach Google right now. Check your connection and reload."),
    ],
    denied: [
      h("p", {}, h("strong", {}, app.user?.email), " doesn't have access to Sideline Stats."),
      h("p", { class: "muted" }, "Ask the app's owner to add this Google account to the coaches list, or sign in with a different account."),
      signOutBtn("Use a different account"),
    ],
    unverifiable: [
      h("p", {}, "Can't check your access while offline."),
      h("p", { class: "muted" }, "Connect to the internet and reload. After the first check, the app works offline."),
      h("button", { type: "button", class: "btn btn-block", onclick: () => location.reload() }, "Try again"),
    ],
    "no-cloud": [
      h("p", {}, "Sideline Stats needs an internet connection the first time you sign in on this device."),
      h("button", { type: "button", class: "btn btn-block", onclick: () => location.reload() }, "Try again"),
    ],
  };
  return h("section", { class: "gate", id: "gate", "data-access": app.access },
    h("img", { src: "icon.svg", alt: "", width: 64, height: 64 }),
    h("h1", {}, "Sideline Stats"),
    screens[app.access] ?? screens.checking,
    app.authError && h("p", { class: "field-error" }, app.authError));
}

// ---- Shared with me (view only)

function viewShared() {
  const item = app.shared.find((x) => x.docId === app.route.docId);
  if (!item) {
    return h("section", {}, h("a", { class: "link-btn", href: "#/games" }, "‹ Games"),
      h("h1", {}, "Not available"),
      h("p", { class: "muted" }, app.shared.length ? "This game is no longer shared with you." : "Loading shared games…"));
  }
  const read = readShared(item);
  if (!read) {
    return h("section", {}, h("a", { class: "link-btn", href: "#/games" }, "‹ Games"), h("h1", {}, "Can't show this game"), h("p", { class: "muted" }, "Its data couldn't be read."));
  }
  return viewStats(read.game, { st: read.st, readOnly: true, sharedBy: item.ownerName || "another coach" });
}

// ---- Another coach's shared team (view only)

/** A shared game as a readable { st, game }, or null if it can't be read. */
function readShared(item) {
  const players = Object.entries(item.names ?? {}).map(([id, p]) => ({ id: Number(id), number: p.number, name: p.name ?? "" }));
  try {
    const st = S.parseState({ players, games: [item.game] });
    return { st, game: st.games[0] };
  } catch {
    return null;
  }
}

function viewTeam(uid = app.route.uid) {
  const team = app.sharedTeams.find((t) => t.uid === uid) ?? (app.role === "player" ? { uid, players: [], ownerName: "" } : null);
  if (!team) {
    return h("section", {}, h("a", { class: "link-btn", href: "#/games" }, "‹ Games"),
      h("h1", {}, "Not available"), h("p", { class: "muted" }, "This team is no longer shared with you."));
  }
  const games = app.shared.filter((x) => x.owner === team.uid).sort((a, b) => (a.game.date < b.game.date ? 1 : -1));
  // Season view over their games, labelled with their squad.
  let st;
  try {
    st = S.parseState({ players: team.players ?? [], games: games.map((x) => x.game) });
  } catch {
    st = S.parseState({ players: team.players ?? [], games: [] });
  }
  const players = S.activePlayers(st);
  return h("section", {},
    app.role !== "player" && h("a", { class: "link-btn", href: "#/games" }, "‹ Games"),
    h("h1", { style: "margin-bottom:4px" }, team.teamName || `${team.ownerName || "A coach"}'s team`),
    h("p", { class: "muted" }, app.role === "player" ? `Coached by ${team.ownerName || "your coach"}. View only.` : "Shared with you by another coach, view only."),
    h("h2", {}, `Games (${games.length})`),
    games.length
      ? h("ul", { class: "list", id: "team-games" }, games.map((x) => {
          const sc = S.score(x.game);
          return h("li", {},
            h("a", { class: "main", href: `#/shared/${encodeURIComponent(x.docId)}` },
              h("div", { class: "primary" }, S.matchTitle(x.game, team.teamName)),
              h("div", { class: "secondary" }, fmtDate(x.game.date))),
            h("span", { class: "badge" }, `${sc.us}–${sc.them} · ${PHASE_LABEL[S.phase(x.game)]}`));
        }))
      : h("p", { class: "muted" }, "No games yet."),
    games.length > 0 && h("a", { class: "btn btn-quiet btn-block", href: `#/team/${encodeURIComponent(team.uid)}/season`, id: "season-link", style: "margin-top:16px" }, "Player stats: leaders and totals →"),
    h("h2", {}, `Squad (${players.length})`),
    players.length
      ? h("ul", { class: "list", id: "team-squad" }, players.map((p) => h("li", {}, h("span", { class: "shirt" }, p.number), h("div", { class: "main" }, h("div", { class: "primary" }, p.name || h("span", { class: "muted" }, "(no name)"))))))
      : h("p", { class: "muted" }, "No players yet."));
}

// ---- A player's home: their team, view only

function viewPlayerHome() {
  if (!app.sharedTeams.length && !app.shared.length) {
    return h("section", {}, h("h1", {}, "Your team"), h("p", { class: "muted" }, document.body.dataset.sync === "ready"
      ? "Nothing here yet. Your coach's games will appear once they've played one."
      : "Loading…"));
  }
  return viewTeam(app.playerTeam);
}

// ---- Games list

/** Another coach's current team name, when we can see their team (else titles use the name saved on the game). */
const teamNameOf = (uid) => app.sharedTeams.find((t) => t.uid === uid)?.teamName || app.allTeams.find((t) => t.uid === uid)?.teamName || "";

/** Shared games that aren't already shown under a shared team. */
const sharedGamesOnly = () => {
  const teams = new Set(app.sharedTeams.map((t) => t.uid));
  return app.shared.filter((x) => !teams.has(x.owner));
};

function viewGames() {
  const st = app.state;
  const games = [...st.games].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  return h("section", {},
    h("h1", {}, "Games"),
    !S.activePlayers(st).length && h("div", { class: "card" },
      h("p", {}, "Start by adding your squad (shirt numbers and names)."),
      h("a", { class: "btn", href: "#/squad" }, "Add squad")),
    h("a", { class: "btn btn-block", href: "#/new", id: "new-game" }, "+ New game"),
    games.length
      ? h("ul", { class: "list", style: "margin-top:16px" }, games.map((g) => {
          const c = S.clock(g);
          const sc = S.score(g);
          const showScore = c.phase !== "pre" || sc.us + sc.them > 0;
          const status = `${showScore ? `${sc.us}–${sc.them} · ` : ""}${c.running ? `${PHASE_LABEL[c.phase]} ${S.formatClock(c.seconds)}` : PHASE_LABEL[c.phase]}`;
          return h("li", {},
            h("a", { class: "main", href: `#/game/${g.id}` },
              h("div", { class: "primary" }, S.matchTitle(g, st.teamName)),
              h("div", { class: "secondary" }, `${fmtDate(g.date)} · ${plural(g.events.length, "event")}`)),
            g.shared && h("span", { class: "badge", title: "Shared with coaches (view only)" }, "Shared"),
            h("span", { class: `badge${c.running ? " live" : ""}` }, status),
            h("button", { type: "button", class: "link-btn more", "aria-label": `More for ${S.matchTitle(g, st.teamName)}`, onclick: () => gameMenu(g) }, "⋯"));
        }))
      : h("p", { class: "muted", style: "margin-top:16px" }, "No games yet."),
    app.coGames.length > 0 && [
      h("h2", {}, "Games you can edit"),
      h("p", { class: "muted small" }, "Other coaches' games you can log in: games you've been added to, and every game of teams an admin has given you."),
      h("ul", { class: "list", id: "co-list" }, [...app.coGames].sort((a, b) => (a.game.date < b.game.date ? 1 : -1)).map((x) => {
        const c = S.clock(x.game);
        const sc = S.score(x.game);
        return h("li", {},
          h("a", { class: "main", href: `#/co/${encodeURIComponent(x.docId)}` },
            h("div", { class: "primary" }, S.matchTitle(x.game, teamNameOf(x.owner))),
            h("div", { class: "secondary" }, `${fmtDate(x.game.date)} · ${x.ownerName || "another coach"}'s game`)),
          h("span", { class: `badge${c.running ? " live" : ""}` }, `${sc.us}–${sc.them} · ${c.running ? `${PHASE_LABEL[c.phase]} ${S.formatClock(c.seconds)}` : PHASE_LABEL[c.phase]}`));
      }))],
    app.sharedTeams.length > 0 && [
      h("h2", {}, "Teams shared with me"),
      h("ul", { class: "list", id: "shared-teams" }, app.sharedTeams.map((t) => {
        const n = app.shared.filter((x) => x.owner === t.uid).length;
        return h("li", {},
          h("a", { class: "main", href: `#/team/${encodeURIComponent(t.uid)}` },
            h("div", { class: "primary" }, t.teamName || `${t.ownerName || "A coach"}'s team`),
            h("div", { class: "secondary" }, `${t.teamName && t.ownerName ? `${t.ownerName} · ` : ""}${plural((t.players ?? []).filter((p) => !p.removed).length, "player")} · ${plural(n, "game")} · view only`)));
      }))],
    sharedGamesOnly().length > 0 && [
      h("h2", {}, "Games shared with me"),
      h("p", { class: "muted small" }, "Single games other coaches have shared. View only."),
      h("ul", { class: "list", id: "shared-list" }, sharedGamesOnly().sort((a, b) => (a.game.date < b.game.date ? 1 : -1)).map((x) => {
        const sc = S.score(x.game);
        return h("li", {},
          h("a", { class: "main", href: `#/shared/${encodeURIComponent(x.docId)}` },
            h("div", { class: "primary" }, S.matchTitle(x.game, teamNameOf(x.owner))),
            h("div", { class: "secondary" }, `${fmtDate(x.game.date)} · by ${x.ownerName || "another coach"}`)),
          h("span", { class: "badge" }, `${sc.us}–${sc.them} · ${PHASE_LABEL[S.phase(x.game)]}`));
      }))],
    st.games.length > 0 && [h("h2", {}, "Season"),
      h("a", { class: "btn btn-quiet btn-block", href: "#/season", id: "season-link" }, "Player stats: leaders and totals →")],
    h("p", { class: "muted small signed-in-as" }, "Signed in as ", app.user?.email, " · ",
      h("button", { type: "button", class: "link-btn small", id: "games-sign-out", onclick: () => cloud?.signOut() }, "Sign out")));
}

// ---- New game

function viewNewGame() {
  const players = S.activePlayers(app.state);
  const opponent = h("input", { id: "opponent", name: "opponent", autocomplete: "off", maxlength: 60, placeholder: "e.g. Rovers U12", required: true });
  const date = h("input", { type: "date", id: "game-date", value: S.todayISO() });
  const half = h("input", { type: "number", id: "half-length", inputmode: "numeric", min: 1, max: 60, value: app.meta.lastHalfLength ?? 30 });
  const error = h("p", { class: "field-error", hidden: true, id: "new-game-error" });
  const sheet = rosterEditor(S.defaultRoster(app.state));

  if (!app.state.teamName) {
    return h("section", {}, h("h1", {}, "New game"),
      h("p", {}, "First, name your team."),
      teamNameForm({ onSaved: () => render() }));
  }
  return h("section", {},
    h("h1", {}, "New game"),
    h("p", { class: "muted" }, h("strong", {}, app.state.teamName), " vs …"),
    h("form", {
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        const res = S.createGame(app.state, {
          opponent: opponent.value, date: date.value, halfLength: Number(half.value), roster: sheet.read(),
        });
        if (res.error) {
          // createGame bails before touching state on error, so nothing to roll back.
          error.textContent = res.error;
          error.hidden = false;
          return;
        }
        app.meta.lastHalfLength = res.game.halfLength;
        commit(() => {}, { rerender: false });
        go(`#/game/${res.game.id}`);
      },
    },
      h("div", { class: "field" }, h("label", { for: "opponent" }, "Playing against"), opponent),
      h("div", { class: "row field" },
        h("div", { class: "grow" }, h("label", { for: "game-date" }, "Date"), date),
        h("div", { style: "width:130px" }, h("label", { for: "half-length" }, "Half (mins)"), half)),
      h("div", { class: "field" },
        h("label", {}, "Who's playing, and in which number?"),
        !players.length && h("p", { class: "muted small" }, "No squad yet. Add players below, or on the Squad tab. You can also log events against \"Unknown\"."),
        sheet.el),
      error,
      h("button", { type: "submit", class: "btn btn-block", id: "create-game" }, "Create game")));
}

/** Inline "your team's name" form, used on Squad and when starting a first game. */
function teamNameForm({ onSaved, compact = false } = {}) {
  const input = h("input", { id: "team-name", maxlength: S.TEAM_NAME_MAX, autocomplete: "off", placeholder: "e.g. Ballyhale U12", value: app.state.teamName ?? "", "aria-label": "Team name" });
  const err = h("p", { class: "field-error", hidden: true, id: "team-name-error" });
  const save = () => {
    const msg = S.teamNameError(input.value);
    if (msg) { err.textContent = msg; err.hidden = false; input.focus(); return false; }
    // Rename every game too, so other coaches see the new name on all of them.
    commit((st) => {
      st.teamName = input.value.trim();
      for (const g of st.games) g.team = st.teamName;
    }, { rerender: !onSaved });
    onSaved?.();
    return true;
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
  return h("div", { class: `card team-name${compact ? " compact" : ""}` },
    h("label", { for: "team-name" }, "Your team's name"),
    h("p", { class: "muted small", style: "margin:0 0 8px" }, "Shown on every game, e.g. \"Ballyhale U12 vs Rovers\"."),
    h("div", { class: "row" }, h("div", { class: "grow" }, input), h("button", { type: "button", class: "btn", id: "save-team-name", onclick: save }, "Save")),
    err);
}

// ---- Live entry

/**
 * Where a game lives: your own (st = your squad and games) or another coach's
 * that you can edit (co = that entry, st = its player names).
 */
function ctxFor(game) {
  const co = app.coGames.find((x) => x.game.id === game.id) ?? null;
  return { st: co ? co.st : app.state, co };
}
/** "Ballyhale U12 vs Rovers" for a game in this context. */
const titleOf = (game, st = ctxFor(game).st) => S.matchTitle(game, st.teamName);

const liveHref = (game) => { const { co } = ctxFor(game); return co ? `#/co/${encodeURIComponent(co.docId)}` : `#/game/${game.id}`; };

/** The team sheet for this game: [{ id, number (worn today), name }], by number. */
function matchdayPlayers(game) {
  const { st } = ctxFor(game);
  return game.roster.map((r) => {
    const p = st.players.find((p) => p.id === r.playerId);
    return { id: r.playerId, number: r.number, name: p?.name ?? "" };
  });
}

function viewLive(game) {
  const { co } = ctxFor(game);
  if (app.pending?.gameId !== game.id) app.pending = { gameId: game.id };
  const pend = app.pending;
  const c = S.clock(game);
  const next = S.NEXT_ACTION[c.phase];
  const players = matchdayPlayers(game);
  const recent = [...game.events].sort((a, b) => b.id - a.id).slice(0, 5);
  // Once a lineup is set, bench players are dimmed (still tappable).
  const on = new Set(S.onPitch(game));
  const benchDim = on.size > 0;

  const pitch = pitchSvg({
    marks: [],
    pending: pend.x != null ? { x: pend.x, y: pend.y } : null,
    onTap: (x, y) => { pend.x = x; pend.y = y; afterPick(game); },
    label: "Pitch: tap where it happened. Your team attacks to the right.",
  });

  return h("section", {},
    // The match title gets its own line, so both team names have room.
    h("div", { class: "live-title" },
      h("a", { class: "back", href: "#/games", "aria-label": "Back to games" }, "‹"),
      h("span", { class: "opp", title: titleOf(game) },
        h("span", { class: "us-name" }, ctxFor(game).st.teamName || game.team || "Us"), h("span", { class: "vs-name" }, ` vs ${game.opponent}`))),
    h("div", { class: "live-head" },
      h("span", { class: "score", id: "score", "aria-label": `Score: us ${S.score(game).us}, them ${S.score(game).them}` }, `${S.score(game).us}–${S.score(game).them}`),
      h("div", { class: "title" },
        h("div", { class: "clock-line" },
          h("div", { class: "clock-stack" },
            h("span", { class: `clock${c.paused ? " paused" : ""}`, id: "clock" }, S.formatClock(c.seconds)),
            h("span", { class: "phase-label", id: "phase-label" }, c.paused ? "Paused" : PHASE_LABEL[c.phase])),
          h("button", {
            type: "button", class: "clock-btn", id: "clock-btn", "aria-label": "Clock options: pause, restart half, undo",
            disabled: c.phase === "pre", onclick: () => clockMenu(game),
          }, clockIcon(c.paused)))),
      next
        ? h("button", { type: "button", class: "btn phase-btn", id: "phase-btn", onclick: () => phaseAction(game) }, next)
        : h("a", { class: "btn btn-quiet phase-btn", href: `${liveHref(game)}/stats` }, "Stats")),
    h("div", { class: "live-status", id: "live-status", role: "status", "aria-live": "polite" }, liveStatusContent()),
    possessionBar(game, c),
    h("div", { class: "pitch-wrap" }, pitch),
    ["attack", "defend"].map((side) => h("div", {
      class: `events ${side}`, role: "group", "aria-label": side === "attack" ? "Attack" : "Defend",
    },
      h("span", { class: "side-label", "aria-hidden": "true" }, side === "attack" ? "Attack" : "Defend"),
      S.eventButtons(side).map((t) => h("button", {
        type: "button", class: "ev-btn", "aria-pressed": String(pend.type === t.id), "data-event": t.id,
        onclick: () => { pend.type = pend.type === t.id ? undefined : t.id; afterPick(game); },
      }, symbolIcon(t.id, 16), h("span", {}, t.label))))),
    h("div", { class: "players", role: "group", "aria-label": "Player" },
      players.map((p) => h("button", {
        type: "button", class: `pl-btn${benchDim && !on.has(p.id) ? " bench" : ""}`, "aria-pressed": String(pend.playerId === p.id), "data-number": p.number,
        "aria-label": `#${p.number} ${p.name}`,
        onclick: () => { pend.playerId = pend.playerId === p.id ? undefined : p.id; afterPick(game); },
      }, h("span", { class: "n" }, p.number), p.name && h("span", { class: "nm" }, p.name))),
      h("button", {
        type: "button", class: "pl-btn", "aria-pressed": String(pend.playerId === null), "data-number": "unknown", "aria-label": "Unknown player",
        onclick: () => { pend.playerId = pend.playerId === null ? undefined : null; afterPick(game); },
      }, h("span", { class: "n" }, "?"), h("span", { class: "nm" }, "Unknown")),
      h("button", {
        type: "button", class: "pl-btn them", "aria-pressed": String(pend.playerId === "them"), "data-number": "them", "aria-label": `Opposition (${game.opponent})`,
        onclick: () => { pend.playerId = pend.playerId === "them" ? undefined : "them"; afterPick(game); },
      }, h("span", { class: "n" }, "Them"), h("span", { class: "nm" }, "Opp."))),
    h("div", { class: "tools" },
      h("button", { type: "button", class: "btn btn-quiet btn-small", disabled: !(pend.x != null || pend.type || pend.playerId !== undefined),
        onclick: () => { app.pending = { gameId: game.id }; render(); } }, "Clear"),
      h("button", { type: "button", class: "btn btn-quiet btn-small", id: "subs-btn", disabled: c.phase === "full" || !game.roster.length, onclick: () => subsDialog(game) }, "Subs"),
      // The team sheet belongs to the game's creator.
      co ? h("span", { class: "muted small co-note" }, `${co.ownerName || "Another coach"}'s game`)
        : h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => editMatchday(game) }, "Players")),
    h("div", { class: "recent" },
      h("div", { class: "step" }, h("h2", {}, "Latest"), h("a", { class: "link-btn small", href: `${liveHref(game)}/stats`, id: "to-stats" }, `All ${game.events.length} · stats →`)),
      recent.length
        ? h("ul", { class: "list", id: "recent" }, recent.map((e) => eventRow(game, e)))
        : h("p", { class: "muted small" }, "Tap where, what and who, in any order. It saves when all three are chosen.")));
}

/** Pause (two bars) or play (triangle), drawn so it looks the same on every phone. */
const clockIcon = (paused) => s("svg", { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true" },
  paused ? s("path", { d: "M4 2.5v11l9-5.5z", fill: "currentColor" })
    : [s("rect", { x: 3, y: 2.5, width: 3.5, height: 11, rx: 1, fill: "currentColor" }), s("rect", { x: 9.5, y: 2.5, width: 3.5, height: 11, rx: 1, fill: "currentColor" })]);

/** "Our ball | Their ball": tap who has it; tap again when it goes out of play. */
function possessionBar(game, c) {
  const now = S.possessionNow(game);
  const pct = S.possessionPercent(S.possessionTime(game));
  const live = c.running;
  const pick = (team) => {
    const { st } = ctxFor(game);
    commit(() => S.setPossession(st, current(game), S.possessionNow(current(game)) === team ? null : team));
  };
  return h("div", { class: "possession", role: "group", "aria-label": "Who has the ball" },
    h("button", { type: "button", class: "poss-btn us", id: "poss-us", "aria-pressed": String(now === "us"), disabled: !live, onclick: () => pick("us") }, "Our ball"),
    h("span", { class: "poss-pct", id: "poss-pct", title: "Possession, us – them" }, pct ? `${pct.us}% – ${pct.them}%` : live ? "Possession" : "–"),
    h("button", { type: "button", class: "poss-btn them", id: "poss-them", "aria-pressed": String(now === "them"), disabled: !live, onclick: () => pick("them") }, "Their ball"));
}

/** Pause / resume, restart the half from its start, or undo the last clock step. */
function clockMenu(game) {
  const c = S.clock(game);
  const live = c.phase === "first" || c.phase === "second";
  const halfName = c.half === 1 ? "1st half" : "2nd half";
  const lastStep = { first: "kick-off", half: "half time", second: "2nd-half kick-off", full: "full time" }[c.phase];
  const close = (fn) => () => { dialog.close(); fn(); };
  openDialog({
    title: "Clock",
    body: h("div", { class: "menu" },
      h("p", { class: "muted small", style: "margin:0 0 4px" }, `${S.formatClock(c.seconds)} · ${c.paused ? "paused" : PHASE_LABEL[c.phase]}`),
      live && h("button", { type: "button", class: "btn btn-block", id: "pause-btn", onclick: close(() => {
        const was = c.paused;
        commit(() => (was ? S.resumeClock(current(game)) : S.pauseClock(current(game))));
        toast(was ? "Clock running." : "Clock paused.", () => commit(() => (was ? S.pauseClock(current(game)) : S.resumeClock(current(game)))));
      }) }, clockIcon(!c.paused), c.paused ? " Resume clock" : " Pause clock"),
      live && h("button", { type: "button", class: "btn btn-quiet btn-block", id: "restart-half", onclick: close(() => {
        const half = c.half;
        const old = commit(() => S.restartHalf(current(game)));
        toast(`${halfName} restarted from ${S.formatClock((half - 1) * game.halfLength * 60)}.`, () => commit(() => Object.assign(current(game).periods[half - 1], old)));
      }) }, `↺ Restart ${halfName} from ${S.formatClock((c.half - 1) * game.halfLength * 60)}`),
      lastStep && h("button", { type: "button", class: "btn btn-quiet btn-block", id: "undo-step", onclick: close(() => {
        const before = clone(current(game).periods);
        commit(() => S.undoPhase(current(game)));
        toast(`Undid ${lastStep}.`, () => commit(() => { current(game).periods = before; }));
      }) }, `↶ Undo ${lastStep}`),
      h("p", { class: "muted small", style: "margin:4px 0 0" }, "Restarting keeps events already logged in this half, with their times.")),
    okLabel: "Close", cancel: false, onOk: () => {},
  });
}

function afterPick(game) {
  const p = app.pending;
  if (p.x != null && p.type && p.playerId !== undefined) {
    const team = p.playerId === "them" ? "them" : "us";
    const { st } = ctxFor(game);
    const ev = commit(() => S.addEvent(st, game, { type: p.type, team, playerId: team === "them" ? null : p.playerId, x: p.x, y: p.y }), { rerender: false });
    app.pending = { gameId: game.id };
    navigator.vibrate?.(30);
    render();
    toast(`${ev.type === "goal" ? (team === "them" ? "Conceded: " : "GOAL! ") : ""}${S.minuteLabel(ev, game.halfLength)} ${S.eventPlayerLabel(st, ev)} · ${S.eventType(ev.type).label}`,
      () => commit(() => S.deleteEvent(current(game), ev.id)));
  } else {
    render();
  }
}

function eventRow(game, e, { st = ctxFor(game).st, readOnly = false, selected = false, onSelect = null, detail = null } = {}) {
  return h("li", {
    "data-event-id": e.id, class: onSelect ? "clickable" : null, "aria-current": selected ? "true" : null,
    onclick: onSelect ? (ev) => { if (!ev.target.closest("button")) onSelect(e); } : null,
  },
    h("span", { class: "muted small", style: "width:52px;flex:none;font-variant-numeric:tabular-nums" }, S.minuteLabel(e, game.halfLength)),
    symbolIcon(e.type, 18),
    h("div", { class: "main" },
      h("div", { class: "primary" }, S.eventType(e.type).label, e.team === "them" && h("span", { class: "badge them-badge" }, "Them")),
      h("div", { class: "secondary" }, detail ?? S.eventPlayerLabel(st, e))),
    !readOnly && h("button", {
      type: "button", class: "link-btn", "aria-label": `Delete ${S.eventType(e.type).label} at ${S.minuteLabel(e, game.halfLength)}`,
      onclick: () => {
        const copy = { ...e };
        commit(() => S.deleteEvent(current(game), e.id));
        toast("Event deleted.", () => commit(() => current(game).events.push(copy)));
      },
    }, "Delete"));
}

function phaseAction(game, { lineupDone = false } = {}) {
  const p = S.phase(game);
  // Ask who's starting once; kicking off with nobody picked simply skips playing time.
  if (p === "pre" && !lineupDone && game.roster.length && !game.starting.length) {
    subsDialog(game, { kickOff: () => phaseAction(game, { lineupDone: true }) });
    return;
  }
  const doIt = () => {
    commit(() => S.advancePhase(current(game)));
    const label = PHASE_LABEL[S.phase(game)];
    toast(p === "pre" ? "Kick-off! Clock running." : p === "half" ? "Second half started." : `${label}.`, () => commit(() => S.undoPhase(current(game))));
  };
  if (p === "first" || p === "second") {
    const c = S.clock(game);
    openDialog({
      title: p === "first" ? "Half time?" : "Full time?",
      body: h("p", {}, `Stop the clock at ${S.formatClock(c.seconds)}.`),
      okLabel: p === "first" ? "Half time" : "Full time",
      onOk: doIt,
    });
  } else {
    doIt();
  }
}

/**
 * Who's on the pitch. Tap a player to move them between pitch and bench; the
 * change is recorded at the clock time when Done is pressed. Before kick-off
 * this sets the starting lineup.
 */
function subsDialog(game, { kickOff } = {}) {
  const players = matchdayPlayers(game);
  if (kickOff || S.phase(game) === "pre") return lineupDialog(game, { kickOff });
  const mins = S.playingTime(game);
  const onPitch = new Set(S.onPitch(game));
  const offPicks = []; // in tap order, so pairs read naturally
  const onPicks = [];
  const label = (p) => `#${p.number}${p.name ? ` ${p.name}` : ""}`;
  const byId = new Map(players.map((p) => [p.id, p]));
  const body = h("div", { class: "subs" });
  const toggle = (list, id) => { const i = list.indexOf(id); i >= 0 ? list.splice(i, 1) : list.push(id); draw(); };
  const chip = (p, picked, tag, list) => h("button", {
    type: "button", class: `sub-chip${picked ? ` picked ${tag}` : ""}`, "data-number": p.number, "aria-pressed": String(picked),
    "aria-label": `${label(p)}, ${S.formatMinutes(mins.get(p.id))} played${picked ? `, going ${tag}` : ""}`,
    onclick: () => toggle(list, p.id),
  }, h("span", { class: "n" }, p.number), h("span", { class: "nm" }, p.name), h("span", { class: "mins" }, picked ? tag.toUpperCase() : S.formatMinutes(mins.get(p.id))));
  const draw = () => {
    const pitch = players.filter((p) => onPitch.has(p.id));
    const bench = players.filter((p) => !onPitch.has(p.id));
    const pairs = Array.from({ length: Math.max(offPicks.length, onPicks.length) }, (_, i) => [byId.get(offPicks[i]), byId.get(onPicks[i])]);
    body.replaceChildren(
      h("h3", { class: "sub-step off" }, "1 · Tap who's coming off"),
      h("div", { class: "sub-grid", id: "sub-off-grid" }, pitch.length ? pitch.map((p) => chip(p, offPicks.includes(p.id), "off", offPicks)) : h("p", { class: "muted small" }, "Nobody's on the pitch yet.")),
      h("h3", { class: "sub-step on" }, "2 · Tap who's going on"),
      h("div", { class: "sub-grid", id: "sub-on-grid" }, bench.length ? bench.map((p) => chip(p, onPicks.includes(p.id), "on", onPicks)) : h("p", { class: "muted small" }, "Nobody on the bench.")),
      h("h3", { class: "sub-step" }, "Changes"),
      h("ul", { class: "sub-summary", id: "sub-summary" }, pairs.length
        ? pairs.map(([off, on]) => h("li", {},
            off ? h("span", { class: "tag off" }, label(off)) : h("span", { class: "muted" }, "nobody off"),
            h("span", { "aria-hidden": "true" }, " → "),
            on ? h("span", { class: "tag on" }, label(on)) : h("span", { class: "muted" }, "nobody on")))
        : h("li", { class: "muted" }, "None yet. Minutes are recorded when you press Make subs.")));
    document.getElementById("dialog-ok").disabled = pairs.length === 0;
  };
  openDialog({
    title: "Substitutions",
    body,
    okLabel: "Make subs",
    onOk: () => {
      const next = new Set(onPitch);
      offPicks.forEach((id) => next.delete(id));
      onPicks.forEach((id) => next.add(id));
      const sub = commit(() => S.setOnPitch(ctxFor(game).st, current(game), [...next]));
      if (sub) {
        const names = (ids) => ids.map((id) => `#${current(game).roster.find((r) => r.playerId === id)?.number}`).join(", ");
        toast(`Sub ${S.minuteLabel(sub, game.halfLength)}${sub.on.length ? ` · on ${names(sub.on)}` : ""}${sub.off.length ? ` · off ${names(sub.off)}` : ""}`,
          () => commit(() => S.deleteSub(current(game), sub.id)));
      }
    },
  });
  draw();
}

/** Before kick-off: a simple checklist of who's starting. */
function lineupDialog(game, { kickOff } = {}) {
  const players = matchdayPlayers(game);
  const picked = new Set(S.onPitch(game));
  const body = h("div", { class: "subs" });
  const draw = () => {
    body.replaceChildren(
      h("div", { class: "step" },
        h("strong", { id: "start-count" }, `Starting: ${picked.size}`),
        h("span", {},
          h("button", { type: "button", class: "link-btn small", id: "select-all", onclick: () => { players.forEach((p) => picked.add(p.id)); draw(); } }, "Select all"),
          h("button", { type: "button", class: "link-btn small", onclick: () => { picked.clear(); draw(); } }, "Clear"))),
      h("div", { class: "sub-grid", id: "start-grid" }, players.map((p) => h("button", {
        type: "button", class: `sub-chip${picked.has(p.id) ? " picked start" : ""}`, "data-number": p.number, "aria-pressed": String(picked.has(p.id)),
        "aria-label": `#${p.number} ${p.name}${picked.has(p.id) ? ", starting" : ""}`,
        onclick: () => { picked.has(p.id) ? picked.delete(p.id) : picked.add(p.id); draw(); },
      }, h("span", { class: "n" }, p.number), h("span", { class: "nm" }, p.name), h("span", { class: "mins" }, picked.has(p.id) ? "✓" : "")))),
      h("p", { class: "muted small", style: "margin-top:8px" }, kickOff ? "You can kick off with nobody picked; minutes just won't be counted." : "Change this any time before kick-off."));
  };
  draw();
  openDialog({
    title: "Who's starting?",
    body,
    okLabel: kickOff ? "Kick off" : "Save lineup",
    onOk: () => {
      commit(() => S.setOnPitch(ctxFor(game).st, current(game), [...picked]));
      if (kickOff) kickOff();
    },
  });
}

function editMatchday(game) {
  const sheet = rosterEditor(game.roster);
  openDialog({
    title: "Team sheet for this game",
    body: [h("p", { class: "muted small" }, "Numbers here are for this game only. Events already logged keep the number worn at the time."), sheet.el],
    okLabel: "Save",
    onOk: () => {
      const res = S.checkRoster(app.state, sheet.read());
      if (res.error) return res.error;
      commit(() => S.setRoster(app.state, current(game), sheet.read()));
    },
  });
}

/**
 * Team-sheet editor: tick who's playing and set today's shirt numbers, or add
 * someone new on the spot. read() returns [{ playerId, number }] as typed.
 */
function rosterEditor(roster) {
  const onSheet = new Map(roster.map((r) => [r.playerId, r.number]));
  // Everyone in the squad, plus anyone on this sheet who has since left the squad.
  const people = [...S.activePlayers(app.state), ...app.state.players.filter((p) => p.removed && onSheet.has(p.id))];
  const rows = [];
  const list = h("div", { class: "roster" });
  const addRow = (p, checked, number) => {
    const check = h("input", { type: "checkbox", checked, "aria-label": `${p.name || "#" + p.number} is playing` });
    const num = h("input", {
      class: "roster-num", inputmode: "numeric", maxlength: 3, value: number, "aria-label": `Shirt number for ${p.name || "#" + p.number}`,
      oninput: () => (check.checked = true),
    });
    rows.push({ p, check, num });
    list.append(h("div", { class: "roster-row", "data-player": p.name || p.number },
      h("label", {}, check, h("span", {}, p.name || h("span", { class: "muted" }, "(no name)"))), num));
  };
  for (const p of people) addRow(p, onSheet.has(p.id), onSheet.get(p.id) ?? p.number);

  const newNum = h("input", { class: "roster-num", inputmode: "numeric", maxlength: 3, placeholder: "No.", "aria-label": "New player's number", id: "new-num" });
  const newName = h("input", { placeholder: "New player's name", maxlength: 40, "aria-label": "New player's name", id: "new-name" });
  const newErr = h("p", { class: "field-error", hidden: true });
  const addNew = () => {
    const res = S.addPlayer(app.state, newNum.value, newName.value);
    if (res.error) {
      newErr.textContent = res.error;
      newErr.hidden = false;
      return;
    }
    commit(() => {}, { rerender: false }); // joins the squad straight away
    addRow(res.player, true, res.player.number);
    newNum.value = newName.value = "";
    newErr.hidden = true;
    newNum.focus();
  };
  newName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addNew(); } });

  const el = h("div", {},
    h("div", { class: "row", style: "justify-content:flex-end;margin-bottom:4px" },
      h("button", { type: "button", class: "link-btn small", onclick: () => { const all = rows.every((r) => r.check.checked); rows.forEach((r) => (r.check.checked = !all)); } }, "All / none")),
    list,
    h("div", { class: "row", style: "margin-top:8px" },
      h("div", { class: "num" }, newNum), h("div", { class: "grow" }, newName),
      h("button", { type: "button", class: "btn btn-quiet", id: "add-to-sheet", onclick: addNew }, "Add")),
    newErr);
  return { el, read: () => rows.filter((r) => r.check.checked).map((r) => ({ playerId: r.p.id, number: r.num.value })) };
}

// ---- Pitch

function pitchSvg({ marks, pending, onTap, label, highlight, selected = null, onMark = null }) {
  const W = 105, H = 68;
  const stripes = Array.from({ length: 7 }, (_, i) => i % 2 && s("rect", { class: "stripe", x: i * 15, y: 0, width: 15, height: H }));
  const box = (x0, depth, width) => {
    const y0 = (H - width) / 2;
    return x0 === 0
      ? s("rect", { class: "line", x: 0, y: y0, width: depth, height: width })
      : s("rect", { class: "line", x: W - depth, y: y0, width: depth, height: width });
  };
  const svg = s("svg", {
    class: "pitch", viewBox: `-1 -1 ${W + 2} ${H + 2}`, role: onTap ? "application" : "img", "aria-label": label,
    id: onTap ? "pitch" : "stats-pitch",
  },
    s("rect", { class: "grass", x: -1, y: -1, width: W + 2, height: H + 2, rx: 2 }),
    stripes,
    s("rect", { class: "line", x: 0, y: 0, width: W, height: H }),
    s("line", { class: "line", x1: W / 2, y1: 0, x2: W / 2, y2: H }),
    s("circle", { class: "line", cx: W / 2, cy: H / 2, r: 9.15 }),
    s("circle", { class: "spot", cx: W / 2, cy: H / 2, r: 0.5 }),
    box(0, 16.5, 40.3), box(W, 16.5, 40.3), box(0, 5.5, 18.3), box(W, 5.5, 18.3),
    s("circle", { class: "spot", cx: 11, cy: H / 2, r: 0.5 }),
    s("circle", { class: "spot", cx: W - 11, cy: H / 2, r: 0.5 }),
    s("path", { class: "line", d: `M16.5 ${H / 2 - 7.3} A9.15 9.15 0 0 1 16.5 ${H / 2 + 7.3}` }),
    s("path", { class: "line", d: `M${W - 16.5} ${H / 2 - 7.3} A9.15 9.15 0 0 0 ${W - 16.5} ${H / 2 + 7.3}` }),
    s("text", { class: "dir", x: W / 2 + 12, y: 4.5 }, "ATTACKING →"),
    // The picked event is drawn last (on top), larger and ringed.
    [...marks].sort((a, b) => (a.id === selected) - (b.id === selected)).map((e) => {
      const dim = highlight && !highlight(e);
      const sel = selected != null && e.id === selected;
      const mark = symbolShape(e.type, e.x * W, e.y * H, sel ? 2.6 : 1.7, { class: sel ? "mark selected" : "mark", opacity: dim ? 0.25 : 1, "data-event-id": e.id });
      if (onMark) mark.addEventListener("click", () => onMark(e));
      return sel ? [s("circle", { class: "sel-ring", cx: e.x * W, cy: e.y * H, r: 4.4 }), mark] : mark;
    }),
    pending && [
      s("circle", { class: "pending-ring", cx: pending.x * W, cy: pending.y * H, r: 3.4 }),
      s("circle", { class: "pending", cx: pending.x * W, cy: pending.y * H, r: 1.6 }),
    ]);
  if (onTap) {
    svg.addEventListener("click", (e) => {
      const r = svg.getBoundingClientRect();
      // Map from the padded viewBox back to pitch fractions.
      const vx = ((e.clientX - r.left) / r.width) * (W + 2) - 1;
      const vy = ((e.clientY - r.top) / r.height) * (H + 2) - 1;
      onTap(Math.min(1, Math.max(0, vx / W)), Math.min(1, Math.max(0, vy / H)));
    });
  }
  return svg;
}

// ---- Stats

/**
 * Game stats. For a game someone has shared with you, st holds just that game's
 * player names and readOnly hides every editing control.
 */
function viewStats(game, { st = app.state, readOnly = false, sharedBy = null, co = null } = {}) {
  const owner = !readOnly && !co; // only the creator can share, pick editors, edit details or delete
  const f = app.statsFilter;
  if (f.gameId !== game.id) Object.assign(f, { gameId: game.id, half: 0, type: "all", playerId: undefined, team: "us", selected: null });
  const types = S.statTypes(game.events);
  const inHalf = game.events.filter((e) => !f.half || e.half === f.half);
  const t = S.tally(inHalf);
  const teamOf = (e) => e.team ?? "us";
  const picked = inHalf.filter((e) => S.typeMatches(f.type, e.type)
    && (f.team === "all" || teamOf(e) === f.team)
    && (f.playerId === undefined || (teamOf(e) === "us" && (e.playerId ?? "unknown") === f.playerId)))
    .sort((a, b) => a.half - b.half || a.t - b.t || a.id - b.id);
  const shown = picked.filter((e) => e.x != null);
  const selected = picked.some((e) => e.id === f.selected) ? f.selected : null;
  const c = S.clock(game);
  // One tap filters the map and timeline; the same tap again clears it.
  const pick = (playerId, type) => {
    if (playerId !== undefined && type !== undefined) {
      const same = f.playerId === playerId && f.type === type;
      f.playerId = same ? undefined : playerId;
      f.type = same ? "all" : type;
    } else if (playerId !== undefined) {
      f.playerId = f.playerId === playerId ? undefined : playerId;
    } else if (type !== undefined) {
      f.type = f.type === type ? "all" : type;
    }
    if (f.playerId !== undefined) f.team = "us";
    f.selected = null;
    render();
  };
  const select = (e) => { f.selected = f.selected === e.id ? null : e.id; render(); };
  const what = f.type === "all" ? "All events" : f.type === "attack" ? "Attack events" : f.type === "defend" ? "Defend events" : S.eventType(f.type).label;
  const who = f.playerId !== undefined ? S.gamePlayerLabel(st, game, f.playerId) : { us: "us", them: "the opposition", all: "both teams" }[f.team];

  return h("section", {},
    h("div", { class: "step", style: "margin:4px 0 12px" },
      readOnly ? h("a", { class: "link-btn", href: "#/games" }, "‹ Games") : h("a", { class: "link-btn", href: liveHref(game) }, "‹ Back to game"),
      h("span", { class: `badge${c.running ? " live" : ""}` }, c.running ? `${PHASE_LABEL[c.phase]} ${S.formatClock(c.seconds)}` : PHASE_LABEL[c.phase])),
    h("h1", { style: "margin-bottom:4px" }, S.matchTitle(game, st.teamName), " ", h("span", { class: "score big", id: "stats-score" }, `${S.score(game).us}–${S.score(game).them}`)),
    h("p", { class: "muted" }, fmtDate(game.date), sharedBy && ` · shared by ${sharedBy} (view only)`, co && ` · ${co.ownerName || "another coach"}'s game, you can edit`),
    owner && h("label", { class: "share-toggle" },
      h("input", { type: "checkbox", id: "share-toggle", checked: game.shared === true, onchange: (e) => commit(() => { current(game).shared = e.target.checked; if (!e.target.checked) delete current(game).shared; }) }),
      h("span", {}, h("strong", {}, "Share with coaches"), h("br"), h("span", { class: "muted small" }, "Every coach can view this game. Only you, and editors below, can change it."))),
    owner && editorsPicker(game),
    h("div", { class: "chips", role: "group", "aria-label": "Half" },
      [["Both halves", 0], ["1st half", 1], ["2nd half", 2]].map(([label, v]) =>
        h("button", { type: "button", class: "chip", "aria-pressed": String(f.half === v), onclick: () => { f.half = v; f.selected = null; render(); } }, label))),
    possessionSummary(game, f.half),
    h("h2", {}, "Team totals"),
    totalsTiles(types, t.total, f.type, (id) => pick(undefined, id)),
    h("div", { class: "drill", id: "stats-map" },
      h("div", { class: "map-sticky" },
        h("div", { class: "drill-head" },
          h("span", { id: "drill-summary" }, h("strong", {}, what), ` · ${who} · `, plural(picked.length, "event")),
          (f.type !== "all" || f.playerId !== undefined) && h("button", { type: "button", class: "link-btn", id: "show-all", onclick: () => { Object.assign(f, { type: "all", playerId: undefined, selected: null }); render(); } }, "Show all")),
        pitchSvg({ marks: shown, selected, onMark: select, label: `Pitch map of ${plural(shown.length, "event")}. Your team attacks to the right.` })),
      h("div", { class: "chips", role: "group", "aria-label": "Team" },
        [["Us", "us"], ["Opposition", "them"], ["Both", "all"]].map(([label, v]) =>
          h("button", { type: "button", class: "chip", "data-team": v, "aria-pressed": String(f.team === v), onclick: () => { f.team = v; if (v === "them") f.playerId = undefined; f.selected = null; render(); } }, label)),
        h("span", { class: "chip-gap" }),
        [["All", "all"], ["Attack", "attack"], ["Defend", "defend"]].map(([label, v]) =>
          h("button", { type: "button", class: "chip", "data-side": v, "aria-pressed": String(f.type === v), onclick: () => { f.type = v; f.selected = null; render(); } }, label))),
      h("h2", {}, "By player"),
      t.byPlayer.size || game.starting.length
        ? [h("p", { class: "muted small" }, "Tap a player, a column or a number to see just those on the map. Mins = minutes on the pitch."),
            statsTable(t, { game, st, minutes: S.playingTime(game), pick, sel: { playerId: f.playerId, type: f.type } })]
        : h("p", { class: "muted" }, "No events yet."),
      h("h2", {}, `Timeline (${picked.length})`),
      picked.length
        ? h("ul", { class: "list timeline", id: "timeline" }, picked.map((e) => eventRow(game, e, { st, readOnly, selected: e.id === selected, onSelect: select })))
        : h("p", { class: "muted" }, "Nothing to show for this selection.")),
    game.subs.length > 0 && h("details", { style: "margin-top:20px" },
      h("summary", { style: "font-weight:700;cursor:pointer;font-size:1.15rem" }, `Substitutions (${game.subs.length})`),
      h("ul", { class: "list", style: "margin-top:8px", id: "subs-list" }, [...game.subs].sort((a, b) => a.half - b.half || a.t - b.t).map((x) => h("li", {},
        h("span", { class: "muted small", style: "width:52px;flex:none" }, S.minuteLabel(x, game.halfLength)),
        h("div", { class: "main" },
          h("div", { class: "primary" }, "Substitution"),
          h("div", { class: "secondary" }, [x.on.length && `On: ${x.on.map((id) => S.gamePlayerLabel(st, game, id)).join(", ")}`, x.off.length && `Off: ${x.off.map((id) => S.gamePlayerLabel(st, game, id)).join(", ")}`].filter(Boolean).join(" · "))),
        !readOnly && h("button", { type: "button", class: "link-btn", onclick: () => commit(() => S.deleteSub(game, x.id)) }, "Delete"))))),
    h("h2", {}, "Game"),
    h("div", { class: "row", style: "flex-wrap:wrap" },
      h("button", { type: "button", class: "btn btn-quiet", onclick: () => download(`${game.date}-vs-${game.opponent.replace(/[^\w-]+/g, "-")}.csv`, S.gameCSV(st, game), "text/csv") }, "Download CSV"),
      owner && h("button", { type: "button", class: "btn btn-quiet", onclick: () => editGame(game) }, "Edit details"),
      owner && h("button", { type: "button", class: "btn btn-danger", id: "reset-game", onclick: () => confirmReset(game) }, "Reset game"),
      owner && h("button", { type: "button", class: "btn btn-danger", id: "delete-game", onclick: () => confirmDelete(game) }, "Delete game")));
}

/** Count per event type, as buttons: tap one to show only that type (again for all). */
function totalsTiles(types, total, current, onPick) {
  return h("div", { class: "totals" }, types.map((et) => h("button", {
    type: "button", class: et.side, "aria-pressed": String(current === et.id), "data-type": et.id, onclick: () => onPick(et.id),
  },
    h("div", { class: "v", "data-total": et.id }, total[et.id]),
    h("div", { class: "k" }, symbolIcon(et.id, 12), et.short))));
}

/** Reset: back to before kick-off, keeping the game's details and team sheet. Undoable. */
function confirmReset(game) {
  openDialog({
    title: `Reset ${S.matchTitle(game, app.state.teamName)}?`,
    body: [
      h("p", {}, `Clears the clock, ${plural(game.events.length, "event")}, subs and starting lineup, as if it never kicked off.`),
      h("p", { class: "muted small" }, "Keeps the opponent, date, half length and team sheet."),
    ],
    okLabel: "Reset", danger: true,
    onOk: () => {
      const cleared = commit(() => S.resetGame(current(game)));
      toast("Game reset.", () => commit(() => Object.assign(current(game), cleared)));
    },
  });
}

/** Delete: removes the game everywhere (your account, and anyone it's shared with). Undoable straight away. */
function confirmDelete(game) {
  openDialog({
    title: `Delete ${S.matchTitle(game, app.state.teamName)}?`,
    body: h("p", {}, `This deletes the game and its ${plural(game.events.length, "event")}, for you and anyone it's shared with.`),
    okLabel: "Delete", danger: true,
    onOk: () => {
      const copy = clone(current(game));
      commit((st) => S.deleteGame(st, game.id), { rerender: false });
      go("#/games");
      toast(`Deleted ${S.matchTitle(copy, app.state.teamName)}.`, () => commit((st) => { if (!st.games.some((g) => g.id === copy.id)) st.games.push(copy); }));
    },
  });
}

/** The ⋯ menu on one of your games in the Games list. */
function gameMenu(game) {
  openDialog({
    title: S.matchTitle(game, app.state.teamName),
    body: h("div", { class: "menu" },
      h("p", { class: "muted small", style: "margin:0 0 8px" }, fmtDate(game.date)),
      h("button", { type: "button", class: "btn btn-quiet btn-block", onclick: () => { dialog.close(); go(`#/game/${game.id}/stats`); } }, "Stats"),
      h("button", { type: "button", class: "btn btn-quiet btn-block", onclick: () => { dialog.close(); editGame(game); } }, "Edit details"),
      h("button", { type: "button", class: "btn btn-danger btn-block", id: "menu-reset", onclick: () => { dialog.close(); confirmReset(game); } }, "Reset game"),
      h("button", { type: "button", class: "btn btn-danger btn-block", id: "menu-delete", onclick: () => { dialog.close(); confirmDelete(game); } }, "Delete game")),
    okLabel: "Close", cancel: false, onOk: () => {},
  });
}

/** Possession for the game (or one half), when it was recorded. */
function possessionSummary(game, half) {
  const t = S.possessionTime(game);
  const pct = S.possessionPercent(half ? t.half[half] : t);
  if (!pct) return null;
  return h("div", { class: "card poss-card", id: "poss-summary" },
    h("div", { class: "step", style: "margin:0 0 6px" }, h("strong", {}, "Possession"), h("span", { class: "muted small" }, half ? `${half === 1 ? "1st" : "2nd"} half` : "whole game")),
    h("div", { class: "poss-meter", role: "img", "aria-label": `Possession: us ${pct.us}%, them ${pct.them}%` },
      h("span", { class: "us", style: `width:${pct.us}%` }, `${pct.us}%`),
      h("span", { class: "them", style: `width:${pct.them}%` }, `${pct.them}%`)),
    h("div", { class: "step small muted", style: "margin:4px 0 0" }, h("span", {}, "Us"), h("span", {}, "Them")));
}

/** The creator picks which coaches can edit this game alongside them. */
function editorsPicker(game) {
  const me = app.user?.email;
  const teamEditors = app.coaches.filter((c) => c.email !== me && c.edits?.includes(app.user?.uid));
  const others = app.coaches.filter((c) => c.email !== me && !teamEditors.includes(c));
  const editors = new Set(game.editors ?? []);
  return h("div", { class: "card editors", id: "editors" },
    h("strong", {}, "Coaches who can edit this game"),
    h("p", { class: "muted small", style: "margin:4px 0 8px" }, "They can log events, run the clock and make subs with you, at the same time. Only you can change this list, share, or delete the game."),
    others.length
      ? others.map((c) => h("label", { class: "editor-row" },
          h("input", {
            type: "checkbox", checked: editors.has(c.email), "data-email": c.email,
            onchange: (e) => commit(() => {
              const g = current(game);
              const set = new Set(g.editors ?? []);
              e.target.checked ? set.add(c.email) : set.delete(c.email);
              if (set.size) g.editors = [...set].sort(); else delete g.editors;
            }),
          }),
          h("span", {}, c.name ? `${c.name} ` : "", h("span", { class: "muted small" }, c.email))))
      : h("p", { class: "muted small", style: "margin:0" }, "No other coaches on the list yet. An admin adds them on the Admin tab."),
    teamEditors.length > 0 && h("p", { class: "muted small", id: "team-editors", style: "margin:8px 0 0" },
      "Also editing all your games (set by an admin): ", teamEditors.map((c) => c.name || c.email).join(", "), "."));
}

/**
 * Players × event types. With a game, players are labelled and sorted by the number they wore in it.
 *   pick(playerId, type): game stats – tap a name, a column heading or a number to filter.
 *   sort + onSort(col):  season – tap a heading to rank players by it; rowHref(id) opens a player.
 */
function statsTable(t, { game, minutes = new Map(), st = app.state, events = game ? game.events : st.games.flatMap((g) => g.events), pick = null, sel = {}, sort = null, onSort = null, rowHref = null, games = null }) {
  const labelFor = (k) => (game ? S.gamePlayerLabel(st, game, k) : S.playerLabel(st, k));
  const numberFor = (k) => game?.roster.find((r) => r.playerId === k)?.number ?? st.players.find((p) => p.id === k)?.number ?? 0;
  const zero = Object.fromEntries(S.EVENT_IDS.map((id) => [id, 0]));
  const types = S.statTypes(events);
  const ids = types.map((t) => t.id);
  const sum = (counts) => ids.reduce((n, id) => n + counts[id], 0);
  const countsOf = (k) => t.byPlayer.get(k) ?? zero;
  const valueOf = (k, col) => (col === "mins" ? minutes.get(k) ?? 0 : col === "games" ? games?.get(k) ?? 0 : col === "all" ? sum(countsOf(k)) : countsOf(k)[col] ?? 0);
  // Everyone who played or did something, even if one without the other.
  const keys = [...new Set([...t.byPlayer.keys(), ...[...minutes].filter(([, s]) => s > 0).map(([id]) => id)])].sort((a, b) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    if (sort && sort.col !== "player") return (valueOf(b, sort.col) - valueOf(a, sort.col)) * sort.dir || numberFor(a) - numberFor(b);
    return (numberFor(a) - numberFor(b)) * (sort?.col === "player" ? sort.dir : 1);
  });
  const typeSelected = (id) => sel.type === id;
  const th = (col, label, { title, num = true } = {}) => {
    const sorted = sort?.col === col;
    const onclick = onSort ? () => onSort(col) : pick && (ids.includes(col) || col === "all") ? () => pick(undefined, col) : null;
    return h("th", {
      class: [num && "num", onclick && "clickable", (sorted || typeSelected(col)) && "active"].filter(Boolean).join(" ") || null,
      title, "data-col": col, onclick,
      "aria-sort": sorted ? (sort.dir > 0 ? "descending" : "ascending") : null,
    }, label, sorted ? (sort.dir > 0 ? " ▾" : " ▴") : "");
  };
  const cell = (k, id, text) => {
    const cls = [pick && "clickable", typeSelected(id) && "col-sel", typeSelected(id) && sel.playerId === k && "cell-sel"].filter(Boolean).join(" ");
    return h("td", { class: `num ${cls}`.trim(), "data-type": id, onclick: pick ? (e) => { e.stopPropagation(); pick(k, id); } : null }, text);
  };
  return h("div", { class: "table-wrap" }, h("table", { class: pick || onSort ? "interactive" : null },
    h("thead", {}, h("tr", {},
      th("player", "Player", { num: false }),
      games && th("games", "Gms", { title: "Games played" }),
      th("mins", "Mins", { title: "Minutes on the pitch" }),
      types.map((et) => th(et.id, et.short, { title: et.label })),
      th("all", "All", { title: "All events" }))),
    h("tbody", {}, keys.map((k) => {
      const counts = countsOf(k);
      const href = rowHref && k !== "unknown" ? rowHref(k) : null;
      return h("tr", {
        class: pick || href ? "clickable" : null,
        "aria-selected": pick ? String(sel.playerId === k) : null,
        onclick: pick ? () => pick(k, undefined) : href ? () => go(href) : null,
      },
        h("td", {}, href ? h("a", { href, onclick: (e) => e.stopPropagation() }, labelFor(k)) : labelFor(k)),
        games && h("td", { class: "num" }, k === "unknown" ? "" : games.get(k) ?? 0),
        h("td", { class: "num" }, k === "unknown" ? "" : S.formatMinutes(minutes.get(k))),
        ids.map((id) => cell(k, id, counts[id] || "·")),
        h("td", { class: "num" }, sum(counts)));
    })),
    h("tfoot", {},
      h("tr", {}, h("td", {}, "Team"), games && h("td", {}), h("td", {}), ids.map((id) => h("td", { class: `num${typeSelected(id) ? " col-sel" : ""}` }, t.total[id])), h("td", { class: "num" }, sum(t.total))),
      game && sum(t.them) > 0 && h("tr", { class: "them-row" }, h("td", {}, "Opposition"), h("td", {}), ids.map((id) => h("td", { class: "num" }, t.them[id] || "·")), h("td", { class: "num" }, sum(t.them))))));
}

// ---- Season: player stats across every game

/** Your own team's season. */
function ownSeason() {
  return {
    st: app.state, title: app.state.teamName || "Your team", base: "#/season", back: "#/games", backLabel: "‹ Games",
    playerHref: (id) => `#/season/${id}`,
    games: app.state.games.map((g) => ({ game: g, href: `#/game/${g.id}/stats` })),
  };
}

/** A shared team's season (or, for a player, their team's). */
function teamSeason(uid) {
  const team = app.sharedTeams.find((t) => t.uid === uid) ?? (app.role === "player" && uid === app.playerTeam ? { uid, players: [] } : null);
  if (!team) return null;
  const shared = app.shared.filter((x) => x.owner === uid);
  let st;
  try {
    st = S.parseState({ players: team.players ?? [], games: shared.map((x) => x.game) });
  } catch {
    st = S.parseState({ players: team.players ?? [], games: [] });
  }
  const base = `#/team/${encodeURIComponent(uid)}`;
  return {
    st, title: team.teamName || `${team.ownerName || "A coach"}'s team`, base: `${base}/season`,
    back: app.role === "player" ? "#/games" : base, backLabel: "‹ Team",
    playerHref: (id) => `${base}/player/${id}`,
    games: st.games.map((g) => ({ game: g, href: `#/shared/${encodeURIComponent(shared.find((x) => x.game.id === g.id)?.docId ?? "")}` })),
  };
}

function viewTeamSeason(r) {
  const ctx = teamSeason(r.uid);
  if (!ctx) {
    return h("section", {}, h("a", { class: "link-btn", href: "#/games" }, "‹ Games"),
      h("h1", {}, "Not available"), h("p", { class: "muted" }, "This team is no longer shared with you."));
  }
  return r.sub === "player" ? viewSeasonPlayer(ctx, r.playerId) : viewSeason(ctx);
}

function viewSeason(ctx) {
  const { st } = ctx;
  const sf = app.season;
  if (sf.key !== ctx.base) Object.assign(sf, { key: ctx.base, sort: { col: "all", dir: 1 } });
  const t = S.seasonTally(st);
  const minutes = S.seasonPlayingTime(st);
  const apps = S.seasonAppearances(st);
  const events = st.games.flatMap((g) => g.events);
  const sortBy = (col) => {
    sf.sort = sf.sort.col === col ? { col, dir: -sf.sort.dir } : { col, dir: col === "player" ? 1 : 1 };
    render();
  };
  // The top three for each stat anyone has.
  const leaders = S.statTypes(events).filter((et) => t.total[et.id] > 0).map((et) => {
    const top = [...t.byPlayer].filter(([k, c]) => k !== "unknown" && c[et.id] > 0).sort((a, b) => b[1][et.id] - a[1][et.id]).slice(0, 3);
    return { et, top };
  }).filter((x) => x.top.length);
  return h("section", { id: "season" },
    h("a", { class: "link-btn", href: ctx.back }, ctx.backLabel),
    h("h1", { style: "margin-bottom:4px" }, "Player stats"),
    h("p", { class: "muted" }, `${ctx.title} · ${plural(st.games.length, "game")}`),
    !t.byPlayer.size && !minutes.size && h("p", { class: "muted" }, "No stats yet. They build up as you log games."),
    leaders.length > 0 && [
      h("h2", {}, "Leaders"),
      h("p", { class: "muted small" }, "Tap a stat to rank everyone by it."),
      h("ul", { class: "list leaders", id: "leaders" }, leaders.map(({ et, top }) => h("li", {
        class: "clickable", "data-type": et.id,
        onclick: () => { sf.sort = { col: et.id, dir: 1 }; render(); document.getElementById("season-table")?.scrollIntoView({ behavior: "smooth", block: "start" }); },
      },
        symbolIcon(et.id, 18),
        h("div", { class: "main" },
          h("div", { class: "primary" }, et.label, h("span", { class: "muted small" }, ` · ${t.total[et.id]} in total`)),
          h("div", { class: "secondary" }, top.map(([k, c]) => `${S.playerLabel(st, k)} ${c[et.id]}`).join(" · ")))))),
    ],
    (t.byPlayer.size > 0 || minutes.size > 0) && [
      h("h2", { id: "season-table" }, "All players"),
      h("p", { class: "muted small" }, "Tap a column to sort by it. Tap a player for their games and pitch map."),
      statsTable(t, { st, minutes, games: apps, sort: sf.sort, onSort: sortBy, rowHref: ctx.playerHref }),
    ]);
}

function viewSeasonPlayer(ctx, id) {
  const { st } = ctx;
  const sf = app.season;
  const key = `${ctx.base}/${id}`;
  if (sf.pkey !== key) Object.assign(sf, { pkey: key, type: "all", selected: null });
  const label = S.playerLabel(st, id);
  const games = [...ctx.games].sort((a, b) => (a.game.date < b.game.date ? -1 : a.game.date > b.game.date ? 1 : a.game.id - b.game.id));
  const mins = new Map(games.map(({ game }) => [game.id, S.playingTime(game).get(id) ?? 0]));
  const mine = games.flatMap(({ game }) => game.events.filter((e) => e.team !== "them" && e.playerId === id).map((e) => ({ e, game })));
  const played = games.filter(({ game }) => mins.get(game.id) > 0 || mine.some((x) => x.game === game));
  const total = S.tally(mine.map((x) => x.e)).total;
  const types = S.statTypes(mine.map((x) => x.e)).filter((et) => total[et.id] > 0);
  const picked = mine.filter((x) => S.typeMatches(sf.type, x.e.type));
  const selected = picked.some((x) => x.e.id === sf.selected) ? sf.selected : null;
  const shown = picked.map((x) => x.e).filter((e) => e.x != null);
  const select = (e) => { sf.selected = sf.selected === e.id ? null : e.id; render(); };
  const setType = (v) => { sf.type = sf.type === v && v !== "all" ? "all" : v; sf.selected = null; render(); };
  const openGame = (game, href) => {
    // Open that game's stats focused on this player.
    Object.assign(app.statsFilter, { gameId: game.id, half: 0, type: "all", playerId: id, team: "us", selected: null });
    go(href);
  };
  const what = sf.type === "all" ? "All events" : sf.type === "attack" ? "Attack events" : sf.type === "defend" ? "Defend events" : S.eventType(sf.type).label;
  const totalMins = [...mins.values()].reduce((a, b) => a + b, 0);
  return h("section", { id: "season-player" },
    h("a", { class: "link-btn", href: ctx.base }, "‹ Player stats"),
    h("h1", { style: "margin-bottom:4px" }, label),
    h("p", { class: "muted" }, `${ctx.title} · ${plural(played.length, "game")}${totalMins ? ` · ${S.formatMinutes(totalMins)} mins` : ""}`),
    !mine.length && h("p", { class: "muted" }, "No events logged for them yet."),
    types.length > 0 && [h("h2", {}, "Totals"), totalsTiles(types, total, sf.type, setType)],
    mine.length > 0 && h("div", { class: "drill", id: "stats-map" },
      h("div", { class: "map-sticky" },
        h("div", { class: "drill-head" },
          h("span", { id: "drill-summary" }, h("strong", {}, what), " · ", plural(picked.length, "event")),
          sf.type !== "all" && h("button", { type: "button", class: "link-btn", id: "show-all", onclick: () => setType("all") }, "Show all")),
        pitchSvg({ marks: shown, selected, onMark: select, label: `Pitch map of ${plural(shown.length, "event")} by ${label}. Attacking to the right.` })),
      h("div", { class: "chips", role: "group", "aria-label": "Events" },
        [["All", "all"], ["Attack", "attack"], ["Defend", "defend"]].map(([text, v]) =>
          h("button", { type: "button", class: "chip", "data-side": v, "aria-pressed": String(sf.type === v), onclick: () => setType(v) }, text))),
      h("h2", {}, "Game by game"),
      h("p", { class: "muted small" }, "Tap a game to open its stats, showing this player."),
      h("div", { class: "table-wrap" }, h("table", { class: "interactive", id: "player-games" },
        h("thead", {}, h("tr", {}, h("th", {}, "Game"), h("th", { class: "num" }, "Mins"), types.map((et) => h("th", { class: `num${sf.type === et.id ? " active" : ""}`, title: et.label }, et.short)))),
        h("tbody", {}, [...played].reverse().map(({ game, href }) => {
          const c = S.tally(mine.filter((x) => x.game === game).map((x) => x.e)).total;
          return h("tr", { class: "clickable", onclick: () => openGame(game, href) },
            h("td", {}, h("div", {}, `vs ${game.opponent}`), h("div", { class: "muted small" }, fmtDate(game.date))),
            h("td", { class: "num" }, S.formatMinutes(mins.get(game.id))),
            types.map((et) => h("td", { class: `num${sf.type === et.id ? " col-sel" : ""}` }, c[et.id] || "·")));
        })))),
      h("h2", {}, `Timeline (${picked.length})`),
      picked.length
        ? h("ul", { class: "list timeline", id: "timeline" }, [...picked].reverse().map(({ e, game }) => eventRow(game, e, {
            st, readOnly: true, selected: e.id === selected, onSelect: select, detail: `vs ${game.opponent} · ${fmtDate(game.date)}`,
          })))
        : h("p", { class: "muted" }, "Nothing to show for this selection.")));
}

function editGame(game) {
  const opp = h("input", { value: game.opponent, maxlength: 60, "aria-label": "Opponent" });
  const half = h("input", { type: "number", min: 1, max: 60, value: game.halfLength, "aria-label": "Half length in minutes" });
  const date = h("input", { type: "date", value: game.date, "aria-label": "Date" });
  openDialog({
    title: "Game details",
    body: [h("div", { class: "field" }, h("label", {}, "Playing against"), opp),
      h("div", { class: "row" }, h("div", { class: "grow" }, h("label", {}, "Date"), date), h("div", { style: "width:120px" }, h("label", {}, "Half (mins)"), half))],
    okLabel: "Save",
    onOk: () => {
      const len = Number(half.value);
      if (!opp.value.trim()) return "Enter the opponent's name";
      if (!Number.isInteger(len) || len < 1 || len > 60) return "Half length must be 1–60 minutes";
      commit(() => { game.opponent = opp.value.trim(); game.halfLength = len; if (S.isValidISODate(date.value)) game.date = date.value; });
    },
  });
}

// ---- Squad

function viewSquad() {
  const players = S.activePlayers(app.state);
  const num = h("input", { id: "p-number", inputmode: "numeric", autocomplete: "off", maxlength: 3, placeholder: "No.", "aria-label": "Shirt number" });
  const name = h("input", { id: "p-name", autocomplete: "off", maxlength: 40, placeholder: "Name", "aria-label": "Name" });
  const error = h("p", { class: "field-error", hidden: true, id: "p-error" });
  const bulk = h("textarea", { id: "bulk", placeholder: "One player per line, e.g.\n1 Sam Keeper\n4, Alex Murphy\n9\tJordan", spellcheck: "false" });
  const file = h("input", { type: "file", id: "squad-file", accept: ".csv,.txt,text/csv,text/plain", class: "visually-hidden",
    onchange: async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) { bulk.value = await f.text(); previewBulk(bulk.value); } } });

  return h("section", {},
    h("h1", {}, app.state.teamName || "Squad"),
    teamNameForm(),
    h("label", { class: "share-toggle" },
      h("input", { type: "checkbox", id: "share-team", checked: app.state.shareTeam === true, onchange: (e) => commit((st) => { if (e.target.checked) st.shareTeam = true; else delete st.shareTeam; }) }),
      h("span", {}, h("strong", {}, "Share my team with coaches"), h("br"),
        h("span", { class: "muted small" }, "Every coach can view your squad, season stats and all your games. Only you, and a game's editors, can change them."))),
    h("p", { class: "muted small" }, "Everyone who might play, with their usual number. For each game you pick who's playing and can change numbers for that day."),
    h("form", {
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        const res = S.addPlayer(app.state, num.value, name.value);
        if (res.error) {
          error.textContent = res.error;
          error.hidden = false;
          return;
        }
        commit(() => {});
        document.getElementById("p-number")?.focus();
      },
    },
      h("label", {}, "Add a player"),
      h("div", { class: "row" }, h("div", { class: "num" }, num), h("div", { class: "grow" }, name), h("button", { type: "submit", class: "btn", id: "add-player" }, "Add")),
      error),
    h("details", { style: "margin:16px 0", open: players.length === 0 ? true : null },
      h("summary", { style: "font-weight:700;cursor:pointer" }, "Paste or upload a list"),
      h("p", { class: "muted small", style: "margin-top:8px" }, "One player per line: number then name. Commas, tabs and spreadsheet CSV files all work."),
      bulk,
      h("div", { class: "row", style: "margin-top:8px;flex-wrap:wrap" },
        file, h("label", { for: "squad-file", class: "btn btn-quiet", style: "margin:0" }, "Upload file…"),
        h("button", { type: "button", class: "btn", id: "bulk-add", onclick: () => previewBulk(bulk.value) }, "Add players"))),
    h("h2", {}, players.length ? `${plural(players.length, "player")}` : "No players yet"),
    players.length > 0 && h("ul", { class: "list", id: "squad-list" }, players.map((p) => h("li", { "data-number": p.number },
      h("span", { class: "shirt" }, p.number),
      h("div", { class: "main" }, h("div", { class: "primary" }, p.name || h("span", { class: "muted" }, "(no name)"))),
      h("button", { type: "button", class: "link-btn", "aria-label": `Edit #${p.number}`, onclick: () => editPlayer(p) }, "Edit"),
      h("button", { type: "button", class: "link-btn", "aria-label": `Remove #${p.number}`, onclick: () => openDialog({
        title: `Remove #${p.number} ${p.name}?`, body: h("p", {}, "They won't be offered for new games. Past games and stats keep them."), okLabel: "Remove", danger: true,
        onOk: () => commit((st) => S.removePlayer(st, p.id)),
      }) }, "Remove")))));
}

function previewBulk(text) {
  const { players, errors } = S.parseSquadText(text);
  const hasSquad = S.activePlayers(app.state).length > 0;
  if (!players.length) {
    openDialog({ title: "No players found", body: [h("p", {}, "Each line needs a shirt number and (optionally) a name."), errors.length && h("p", { class: "small muted" }, errors.slice(0, 5).join("\n"))], cancel: false, onOk: () => {} });
    return;
  }
  const mode = h("select", { "aria-label": "Add or replace" },
    h("option", { value: "add" }, "Add to current squad"),
    h("option", { value: "replace" }, "Replace current squad"));
  openDialog({
    title: `Add ${plural(players.length, "player")}?`,
    body: [
      h("p", { class: "small" }, players.slice(0, 30).map((p) => `#${p.number} ${p.name}`).join(", ") + (players.length > 30 ? "…" : "")),
      errors.length > 0 && h("p", { class: "field-error" }, `Skipped: ${errors.join("; ")}`),
      hasSquad && mode,
    ],
    okLabel: "Add",
    onOk: () => {
      const res = commit((st) => S.importSquad(st, players, hasSquad ? mode.value : "add"));
      toast(`Added ${plural(res.added, "player")}${res.skipped.length ? ` (skipped ${res.skipped.map((n) => "#" + n).join(", ")}: number already used)` : ""}.`);
      const b = document.getElementById("bulk");
      if (b) b.value = "";
    },
  });
}

function editPlayer(p) {
  const num = h("input", { value: p.number, inputmode: "numeric", maxlength: 3, "aria-label": "Shirt number" });
  const name = h("input", { value: p.name, maxlength: 40, "aria-label": "Name" });
  openDialog({
    title: `Edit #${p.number}`,
    body: h("div", { class: "row" }, h("div", { class: "num" }, num), h("div", { class: "grow" }, name)),
    okLabel: "Save",
    onOk: () => {
      const err = S.playerError(app.state, num.value, name.value, p.id);
      if (err) return err;
      commit((st) => S.updatePlayer(st, p.id, num.value, name.value));
    },
  });
}

// ---- Data

function viewData() {
  const st = app.state;
  const m = app.meta;
  const events = st.games.reduce((n, g) => n + g.events.length, 0);
  const account = h("div", { class: "card", id: "account" },
    h("p", {}, "Signed in as ", h("strong", {}, app.user?.email), app.role ? ` (${app.role})` : "", "."),
    h("p", { class: "muted small" }, app.role === "player"
      ? "You can view your team's games and stats, live. Ask your coach if something's missing."
      : cloud
        ? "Your squad and games save to your account after every tap, and a copy is kept on this phone so it works without signal. Changes made offline upload when you reconnect."
        : "Working offline from this phone's copy. Changes will upload next time the app opens with a connection."),
    h("button", { type: "button", class: "btn btn-quiet btn-small", id: "sign-out", onclick: () => cloud?.signOut() }, "Sign out"));
  if (app.role === "player") return h("section", {}, h("h1", {}, "Account"), account);

  const file = h("input", { type: "file", accept: ".json,application/json", id: "import-file", class: "visually-hidden",
    onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); } });
  return h("section", {},
    h("h1", {}, "Account"),
    account,
    h("h2", {}, `Coaches (${app.coaches.length})`),
    h("p", { class: "muted small" }, "Everyone who coaches on Sideline Stats. Share a game or your team with all of them, or pick editors on a game's stats page."),
    app.coaches.length
      ? h("ul", { class: "list", id: "coaches" }, app.coaches.map((c) => h("li", {},
          h("div", { class: "main" },
            h("div", { class: "primary" }, c.name || c.email, c.email === app.user?.email ? " (you)" : "", c.role === "admin" && h("span", { class: "badge", style: "margin-left:6px" }, "Admin")),
            c.name && h("div", { class: "secondary" }, c.email)))))
      : h("p", { class: "muted small" }, "Loading…"),
    h("p", { class: "muted small", style: "margin-top:8px" }, app.role === "admin" ? "Add or remove coaches on the Admin tab." : "Admins add and remove coaches."),
    myPlayersSection(),
    h("h2", {}, "Back up"),
    h("p", {}, "Everything is already saved to your account. For an extra copy outside it, download a JSON file."),
    h("p", { class: "muted small" }, `${plural(S.activePlayers(st).length, "player")}, ${plural(st.games.length, "game")}, ${plural(events, "event")}. `,
      m.lastExportAt
        ? `Last export: ${new Date(m.lastExportAt).toLocaleString()}${m.changesSinceExport ? ` (${plural(m.changesSinceExport, "change")} since)` : " (up to date)"}.`
        : "Not exported yet."),
    h("button", { type: "button", class: "btn", id: "export", onclick: exportData }, "Export JSON"),
    h("h2", {}, "Restore"),
    h("p", {}, "Load a JSON file you exported earlier. It replaces your squad and games, in your account too."),
    file,
    h("label", { for: "import-file", class: "btn btn-quiet", style: "margin:0" }, "Import JSON…"),
    (st.players.length > 0 || st.games.length > 0) && [
      h("h2", {}, "Start over"),
      h("button", { type: "button", class: "btn btn-danger", onclick: () => openDialog({
        title: "Delete all data?", body: h("p", {}, "This removes your squad and every game, from your account too. Export first if you might want it back."),
        okLabel: "Delete everything", danger: true, onOk: () => commit((st) => Object.assign(st, S.emptyState())),
      }) }, "Delete all data")]);
}

/** A coach's own player logins: players see this coach's games and stats, nothing else. */
function myPlayersSection() {
  const mine = app.people.filter((p) => p.role === "player" && p.team === app.user?.uid);
  const email = h("input", { id: "player-email", type: "email", autocomplete: "off", placeholder: "their.gmail@gmail.com", "aria-label": "Player's Gmail address" });
  const name = h("input", { id: "player-name", autocomplete: "off", maxlength: 60, placeholder: "Name", "aria-label": "Player's name" });
  const err = h("p", { class: "field-error", hidden: true, id: "player-error" });
  const add = async () => {
    const e = email.value.trim().toLowerCase();
    const problem = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? "Enter their Google (Gmail) address"
      : app.people.some((p) => p.email === e) ? "That address already has access" : null;
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    try {
      await cloud.addPerson(e, { name: name.value, role: "player", team: app.user.uid }, app.user.email);
      toast(`${name.value.trim() || e} can now view your team.`);
      clearInputs("player-email", "player-name");
    } catch (x) {
      err.textContent = `Couldn't add them: ${x.message}`;
      err.hidden = false;
    }
  };
  return [
    h("h2", {}, `Player logins (${mine.length})`),
    h("p", { class: "muted small" }, "Players can view your games and stats, live, and nothing else. They sign in with their Google account."),
    mine.length > 0 && h("ul", { class: "list", id: "my-players" }, mine.map((p) => h("li", {},
      h("div", { class: "main" }, h("div", { class: "primary" }, p.name || p.email), p.name && h("div", { class: "secondary" }, p.email)),
      h("button", { type: "button", class: "link-btn", "aria-label": `Remove ${p.email}`, onclick: () => openDialog({
        title: `Remove ${p.name || p.email}?`, body: h("p", {}, "They'll no longer be able to sign in."), okLabel: "Remove", danger: true,
        onOk: () => { cloud.removePerson(p.email).then(() => toast(`Removed ${p.name || p.email}.`), (x) => toast(`Couldn't remove: ${x.message}`)); },
      }) }, "Remove")))),
    h("div", { class: "row", style: "flex-wrap:wrap;margin-top:8px" },
      h("div", { class: "grow", style: "min-width:200px" }, email), h("div", { class: "grow", style: "min-width:120px" }, name),
      h("button", { type: "button", class: "btn", id: "add-player-login", onclick: add }, "Add player")),
    err,
  ];
}

// ---- Admin

function viewAdmin() {
  if (app.role !== "admin") return h("section", {}, h("h1", {}, "Admin"), h("p", { class: "muted" }, "Only admins can see this."));
  const email = h("input", { id: "admin-email", type: "email", autocomplete: "off", placeholder: "coach@gmail.com", "aria-label": "Gmail address" });
  const name = h("input", { id: "admin-name", autocomplete: "off", maxlength: 60, placeholder: "Name", "aria-label": "Name" });
  const role = h("select", { id: "admin-role", "aria-label": "Role" },
    h("option", { value: "coach" }, "Coach"), h("option", { value: "admin" }, "Admin (coach who manages people)"));
  const err = h("p", { class: "field-error", hidden: true, id: "admin-error" });
  const add = async () => {
    const e = email.value.trim().toLowerCase();
    const problem = !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? "Enter their Google (Gmail) address"
      : app.people.some((p) => p.email === e) ? "That address is already on the list" : null;
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    try {
      await cloud.addPerson(e, { name: name.value, role: role.value }, app.user.email);
      toast(`Added ${name.value.trim() || e}.`);
      clearInputs("admin-email", "admin-name");
    } catch (x) {
      err.textContent = `Couldn't add: ${x.message}`;
      err.hidden = false;
    }
  };
  const coachName = (uid) => {
    const team = app.sharedTeams.find((t) => t.uid === uid);
    return team?.teamName || team?.ownerName || (uid === app.user.uid ? (app.state.teamName || "you") : "a coach");
  };
  const teamLabel = (uid) => {
    const t = app.allTeams.find((x) => x.uid === uid);
    return t ? (t.teamName || `${t.ownerName || "A coach"}'s team`) : null;
  };
  const row = (p) => {
    const me = p.email === app.user.email;
    const edits = p.role === "player" ? [] : p.edits.map(teamLabel).filter(Boolean);
    return h("li", { "data-email": p.email },
      h("div", { class: "main" },
        h("div", { class: "primary" }, p.name || p.email, me ? " (you)" : ""),
        h("div", { class: "secondary" }, [p.name && p.email, p.role === "player" && `player · ${coachName(p.team)}`].filter(Boolean).join(" · ")),
        edits.length > 0 && h("div", { class: "secondary edits-line" }, `Edits live: ${edits.join(", ")}`)),
      p.role !== "player" && h("button", {
        type: "button", class: "link-btn", "aria-label": `Live editing for ${p.email}`, onclick: () => liveEditingDialog(p),
      }, "Live editing"),
      p.role !== "player" && !me && h("button", {
        type: "button", class: "link-btn", "aria-label": `${p.role === "admin" ? "Remove admin from" : "Make admin"} ${p.email}`,
        onclick: () => cloud.setRole(p.email, p.role === "admin" ? "coach" : "admin").catch((x) => toast(`Couldn't change: ${x.message}`)),
      }, p.role === "admin" ? "Make coach" : "Make admin"),
      !me && h("button", { type: "button", class: "link-btn", "aria-label": `Remove ${p.email}`, onclick: () => openDialog({
        title: `Remove ${p.name || p.email}?`, body: h("p", {}, "They'll no longer be able to sign in. Their games stay in their account."), okLabel: "Remove", danger: true,
        onOk: () => { cloud.removePerson(p.email).then(() => toast(`Removed ${p.name || p.email}.`), (x) => toast(`Couldn't remove: ${x.message}`)); },
      }) }, "Remove"));
  };
  const group = (title, id, list) => [h("h2", {}, `${title} (${list.length})`), list.length ? h("ul", { class: "list", id }, list.map(row)) : h("p", { class: "muted small" }, "None.")];
  return h("section", { id: "admin" },
    h("h1", {}, "Admin"),
    h("p", { class: "muted" }, "Add coaches and admins here. ", h("strong", {}, "Live editing"), " lets a coach log events, run the clock and make subs in every game of the teams you pick, as they happen. Coaches add their own player logins on the Account tab."),
    h("div", { class: "card" },
      h("label", { for: "admin-email" }, "Add a coach"),
      h("div", { class: "field" }, email),
      h("div", { class: "row field" }, h("div", { class: "grow" }, name), h("div", { class: "grow" }, role)),
      h("button", { type: "button", class: "btn btn-block", id: "admin-add", onclick: add }, "Add"),
      err),
    group("Admins", "admins", app.people.filter((p) => p.role === "admin")),
    group("Coaches", "coach-list", app.people.filter((p) => p.role === "coach")),
    group("Players", "players", app.people.filter((p) => p.role === "player")));
}

/** Admins: pick the teams whose games a coach can edit live. */
function liveEditingDialog(p) {
  const teams = [...app.allTeams].sort((a, b) => (a.teamName || a.ownerName).localeCompare(b.teamName || b.ownerName));
  const has = new Set(p.edits);
  openDialog({
    title: `Live editing for ${p.name || p.email}`,
    body: [
      h("p", { class: "muted small" }, "They can log events, run the clock, change possession and make subs in every game of these teams, at the same time as the team's coach. Only the team's coach can share, change the team sheet or delete games."),
      teams.length
        ? h("div", { id: "edit-teams" }, teams.map((t) => h("label", { class: "editor-row" },
            h("input", { type: "checkbox", checked: has.has(t.uid), "data-uid": t.uid }),
            h("span", {}, t.teamName || "(no team name yet)", " ", h("span", { class: "muted small" }, t.ownerName)))))
        : h("p", { class: "muted small" }, "No teams yet. A team appears here once its coach has added a squad."),
    ],
    okLabel: "Save",
    onOk: () => {
      const picked = [...document.querySelectorAll("#edit-teams input:checked")].map((x) => x.dataset.uid);
      // Keep any teams not listed here (e.g. not loaded yet), unless they were unticked.
      const listed = new Set(teams.map((t) => t.uid));
      const uids = [...new Set([...p.edits.filter((u) => !listed.has(u)), ...picked])].sort();
      cloud.setEdits(p.email, uids).then(() => toast(`Saved live editing for ${p.name || p.email}.`), (x) => toast(`Couldn't save: ${x.message}`));
    },
  });
}

// ---------------------------------------------------------------- clock & screen

function tick() {
  const r = app.route;
  if (r.name !== "live" && r.name !== "co") return;
  const game = r.name === "live" ? findGame(r.id) : app.coGames.find((x) => x.docId === r.docId)?.game;
  const el = document.getElementById("clock");
  if (game && el) el.textContent = S.formatClock(S.clock(game).seconds);
}
setInterval(tick, 500);

// Keep the screen awake while a half is running, so the phone doesn't lock mid-game.
let wakeLock = null;
async function updateWakeLock(want) {
  try {
    if (want && !wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener("visibilitychange", () => {
  // Coming back to the live screen: refresh the clock and re-acquire the wake lock.
  if (document.visibilityState === "visible" && ["live", "co"].includes(app.route.name)) render();
});

window.addEventListener("storage", (e) => {
  if (e.key !== storage.dataKey() || cloud) return; // with the cloud, Firestore keeps tabs in sync
  const fresh = storage.loadState();
  if (!fresh.problem) {
    app.state = fresh.state;
    render();
  }
});

storage.requestPersistence().then((ok) => {
  app.persisted = ok;
  if (app.route.name === "data") render();
});

app.route = parseRoute();
if (cloud) {
  cloud.onUser((user) => startAccount(user));
  // Test hook (emulator only): sign in as any account.
  if (cloud.isEmulator) window.__sideline = { signInAs: cloud.testSignIn };
} else if (app.meta.lastUser && app.meta.allowed?.[app.meta.lastUser.uid]) {
  startAccount(app.meta.lastUser);
} else {
  app.access = "no-cloud";
  render();
}
