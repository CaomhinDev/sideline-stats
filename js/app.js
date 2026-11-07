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
  coaches: [], // the allowlist: [{ email, name }]
  route: { name: "games" },
  pending: null, // live entry: { gameId, x, y, type, playerId } – playerId undefined = not chosen, null = unknown
  statsFilter: { half: 0, types: new Set(S.EVENT_IDS), playerId: undefined },
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
    if (key === "events" || key === "subs") continue;
    if (stable(prev[key]) !== stable(cur[key])) set[`game.${key}`] = cur[key] === undefined ? cloud.unset() : clone(cur[key]);
  }
  const ops = Object.keys(set).length ? [set] : [];
  for (const key of ["events", "subs"]) {
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

function track(promise) {
  inFlight++;
  promise.catch(syncFailed).finally(() => {
    inFlight--;
    if (inFlight === 0) {
      if (heldBack) { const args = heldBack; heldBack = null; receive(...args); }
      if (heldBackCo) { const list = heldBackCo; heldBackCo = null; receiveEditable(list); }
    }
  });
}

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
  if (!app.user || app.access !== "allowed") return;
  if (!cloud) {
    app.meta.unsynced = { ...app.meta.unsynced, [app.user.uid]: true };
    saveMeta();
    return;
  }
  const uid = app.user.uid;
  const teamShared = app.state.shareTeam === true;
  const players = JSON.stringify({ players: app.state.players, teamShared });
  if (players !== sent.players) {
    sent.players = players;
    track(cloud.saveUser(app.user, { players: app.state.players, shared: teamShared }));
  }
  const live = new Set();
  for (const g of app.state.games) {
    const docId = cloud.gameDocId(uid, g.id);
    live.add(docId);
    const top = topFields(g, teamShared);
    const topJson = stable(top);
    const prev = sent.games.get(docId);
    if (!prev) {
      track(cloud.saveGame(app.user, g, top.names, top.shared));
    } else {
      const ops = gameOps(prev.game, g);
      if (topJson !== prev.top) ops.unshift(top);
      for (const fields of ops) track(cloud.updateGame(docId, fields));
    }
    sent.games.set(docId, { game: clone(g), top: topJson });
  }
  for (const docId of [...sent.games.keys()]) {
    if (!live.has(docId)) {
      sent.games.delete(docId);
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
    const unsynced = app.meta.unsynced?.[app.user.uid];
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
      // Changes made while Firebase couldn't load: keep them, and anything only in the cloud.
      const mine = new Set(app.state.games.map((g) => g.id));
      app.state.games.push(...parseGames(games).filter((g) => !mine.has(g.id)));
      app.meta.unsynced = { ...app.meta.unsynced, [app.user.uid]: false };
      saveMeta();
      pushChanges();
      render();
      return;
    }
  }
  let incoming;
  try {
    incoming = S.parseState({ players: user?.players ?? [], games, shareTeam: user?.shared === true });
  } catch (e) {
    console.warn("Ignoring unreadable cloud data:", e);
    return;
  }
  // Remember the server's copy as the base for future field-level updates.
  const teamShared = incoming.shareTeam === true;
  sent.players = JSON.stringify({ players: incoming.players, teamShared });
  sent.games = new Map(incoming.games.map((g) => [cloud.gameDocId(app.user.uid, g.id), { game: clone(g), top: stable(topFields(g, teamShared)) }]));
  // Usually this is just our own write coming back: keep the same objects (open
  // dialogs and Undo buttons hold references to them) unless something really changed.
  if (canonical(incoming) === canonical(app.state)) return;
  incoming.nextId = Math.max(incoming.nextId, app.state.nextId);
  app.state = incoming;
  storage.saveState(app.state);
  render();
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
  if (changed || ["games", "co", "costats"].includes(app.route.name)) render();
}

/** Squad and games in a fixed shape and order, for comparing two copies. */
function canonical(state) {
  try {
    const st = S.parseState({ players: state.players, games: state.games, shareTeam: state.shareTeam === true });
    st.games.sort((a, b) => a.id - b.id);
    return stable({ players: st.players, games: st.games, shareTeam: st.shareTeam === true });
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
  app.coaches = [];
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

  let ok = cloud ? await cloud.isAllowed(user) : null;
  if (ok === null) ok = app.meta.allowed?.[user.uid] ?? null; // offline: trust the last answer
  if (app.user !== user) return; // signed out meanwhile
  if (ok !== true) {
    app.access = ok === false ? "denied" : "unverifiable";
    render();
    return;
  }
  app.meta.allowed = { ...app.meta.allowed, [user.uid]: true };
  app.meta.lastUser = user;
  saveMeta();
  app.access = "allowed";
  render();
  if (!cloud) {
    document.body.dataset.sync = "ready";
    return;
  }
  const warn = (what) => (e) => console.warn(`${what} unavailable:`, e);
  const rerenderOn = (...routes) => () => { if (routes.includes(app.route.name)) render(); };
  const sharedChanged = rerenderOn("games", "shared", "team");
  const teamsChanged = rerenderOn("games", "team");
  const coachesChanged = rerenderOn("data", "stats");
  stopWatching.push(
    cloud.watchMine(user.uid, receive, syncFailed),
    cloud.watchShared(user.uid, (list) => { app.shared = list; sharedChanged(); }, warn("Shared games")),
    cloud.watchSharedTeams(user.uid, (list) => { app.sharedTeams = list; teamsChanged(); }, warn("Shared teams")),
    cloud.watchEditable(user, receiveEditable, warn("Games you can edit")),
    cloud.watchCoaches((list) => { app.coaches = list; coachesChanged(); }, warn("Coaches list")),
  );
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
      hasData && h("p", {}, `It will replace what's in this browser now (${summary(cur)}). Export first if you want to keep a copy.`),
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
  if (parts[0] === "team" && parts[1]) return { name: "team", uid: decodeURIComponent(parts[1]) };
  if (parts[0] === "co" && parts[1]) return { name: parts[2] === "stats" ? "costats" : "co", docId: decodeURIComponent(parts[1]) };
  if (["games", "squad", "data", "new", "help"].includes(parts[0])) return { name: parts[0] };
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
  const tab = ["new", "stats", "shared", "team", "co", "costats"].includes(r.name) ? "games" : r.name;
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  renderBanner(live);
  const notEditable = () => h("section", {}, h("a", { class: "link-btn", href: "#/games" }, "‹ Games"),
    h("h1", {}, "Not available"), h("p", { class: "muted" }, "You can't edit this game (anymore). The coach who created it may have removed you."));
  const views = {
    games: viewGames, new: viewNewGame, live: () => viewLive(game), stats: () => viewStats(game), shared: viewShared, team: viewTeam, squad: viewSquad, data: viewData, help: viewHelp,
    co: () => (coEntry ? viewLive(coEntry.game) : notEditable()),
    costats: () => (coEntry ? viewStats(coEntry.game, { st: coEntry.st, co: coEntry }) : notEditable()),
  };
  view.replaceChildren(views[r.name]());
  updateWakeLock(live && S.clock(game).running);
  tick();
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
  return h("section", { class: "help", id: "help" },
    h("h1", {}, "Help"),
    h("p", { class: "muted" }, "Log what happens in a match in three taps, then see who did what, where."),
    section("1. Set up your squad", true, ul(
      ["Go to ", b("Squad"), ". Type a shirt number and name, press Enter, repeat."],
      ["Or ", b("Paste or upload a list"), ": one player per line, like ", h("code", {}, "7 Sam"), ". Spreadsheet CSV files work too."],
      "Numbers here are each player's usual number. You can change them for any single game.")),
    section("2. Start a game", false, ul(
      [b("Games → + New game"), ". Enter the opponent, date and half length."],
      ["Untick anyone not playing, and change a shirt number for that day if needed."],
      [b("Start game"), " asks who's starting: tap players onto the pitch, then ", b("Kick off"), "."])),
    section("3. Log events (three taps)", false, ul(
      ["Tap ", b("where"), " on the pitch, ", b("what"), " happened, and ", b("who"), ". Any order. It saves on the third tap."],
      ["Your team always attacks to the ", b("right"), ", in both halves."],
      ["Green buttons are good for your team, red are bad."],
      [b("?"), " = one of yours but you didn't see who. ", b("Them"), " = the opposition (a Goal for Them is a goal conceded)."],
      ["Mistake? Tap ", b("Undo"), " under the clock, or ", b("Delete"), " in the Latest list."]),
      h("p", { class: "tip" }, "Tip: add the app to your phone's home screen (browser menu → Add to Home Screen) so it's one tap away.")),
    section("4. Clock, subs and team sheet", false, ul(
      ["The big button runs the match: ", b("Start game → Half time → Start 2nd half → Full time"), ". Each step can be undone."],
      ["The clock keeps correct time even if the phone locks."],
      [b("Subs"), ": tap who's coming off and who's going on, then ", b("Done"), ". Minutes played are counted for you."],
      [b("Players"), ": change today's numbers or add someone who turned up."])),
    section("5. See the stats", false, ul(
      ["Tap ", b("stats →"), " on a game: score, totals, a pitch map, and a table by player with minutes."],
      ["Filter the map by half, team, or event type. Tap a player in the table to see only theirs."],
      [b("Download CSV"), " opens in any spreadsheet. ", b("Season totals"), " are on the Games screen."])),
    section("6. Share with other coaches", false, ul(
      [b("One game, view only"), ": on its stats page, tick ", b("Share with coaches"), "."],
      [b("Your whole team, view only"), ": on ", b("Squad"), ", tick ", b("Share my team with coaches"), ". Covers every game, now and later."],
      [b("Let a coach edit a game"), ": on its stats page, under ", b("Coaches who can edit this game"), ", tick their name. You can both log events at the same time."],
      ["Only you can share, choose editors, change the team sheet or delete your games."],
      ["Games others share or let you edit appear on your ", b("Games"), " screen."]),
      h("p", { class: "tip" }, "The full coaches list is on the Account tab.")),
    section("7. Accounts, offline and backups", false, ul(
      ["Everything saves to your Google account after every tap, and syncs to your other devices."],
      ["No signal? Keep going. It saves on the phone and uploads when you're back online."],
      [b("Account → Export JSON"), " downloads a spare copy of everything."],
      [b("New coach?"), " The app's owner adds them in the Firebase console: Firestore → ", h("code", {}, "allow"), " → a document named with their Gmail address in lowercase."])));
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

function viewTeam() {
  const team = app.sharedTeams.find((t) => t.uid === app.route.uid);
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
  const season = S.seasonTally(st);
  const players = S.activePlayers(st);
  return h("section", {},
    h("a", { class: "link-btn", href: "#/games" }, "‹ Games"),
    h("h1", { style: "margin-bottom:4px" }, `${team.ownerName || "A coach"}'s team`),
    h("p", { class: "muted" }, "Shared with you by another coach, view only."),
    h("h2", {}, `Games (${games.length})`),
    games.length
      ? h("ul", { class: "list", id: "team-games" }, games.map((x) => {
          const sc = S.score(x.game);
          return h("li", {},
            h("a", { class: "main", href: `#/shared/${encodeURIComponent(x.docId)}` },
              h("div", { class: "primary" }, `vs ${x.game.opponent}`),
              h("div", { class: "secondary" }, fmtDate(x.game.date))),
            h("span", { class: "badge" }, `${sc.us}–${sc.them} · ${PHASE_LABEL[S.phase(x.game)]}`));
        }))
      : h("p", { class: "muted" }, "No games yet."),
    season.byPlayer.size > 0 && [h("h2", {}, "Season totals"), statsTable(season, { selectable: false, st, minutes: S.seasonPlayingTime(st) })],
    h("h2", {}, `Squad (${players.length})`),
    players.length
      ? h("ul", { class: "list", id: "team-squad" }, players.map((p) => h("li", {}, h("span", { class: "shirt" }, p.number), h("div", { class: "main" }, h("div", { class: "primary" }, p.name || h("span", { class: "muted" }, "(no name)"))))))
      : h("p", { class: "muted" }, "No players yet."));
}

// ---- Games list

/** Shared games that aren't already shown under a shared team. */
const sharedGamesOnly = () => {
  const teams = new Set(app.sharedTeams.map((t) => t.uid));
  return app.shared.filter((x) => !teams.has(x.owner));
};

function viewGames() {
  const st = app.state;
  const games = [...st.games].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  const season = S.seasonTally(st);
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
              h("div", { class: "primary" }, `vs ${g.opponent}`),
              h("div", { class: "secondary" }, `${fmtDate(g.date)} · ${plural(g.events.length, "event")}`)),
            g.shared && h("span", { class: "badge", title: "Shared with coaches (view only)" }, "Shared"),
            h("span", { class: `badge${c.running ? " live" : ""}` }, status),
            h("a", { class: "link-btn", href: `#/game/${g.id}/stats` }, "Stats"));
        }))
      : h("p", { class: "muted", style: "margin-top:16px" }, "No games yet."),
    app.coGames.length > 0 && [
      h("h2", {}, "Games you can edit"),
      h("p", { class: "muted small" }, "Other coaches' games you've been added to. Log events with them as it happens."),
      h("ul", { class: "list", id: "co-list" }, [...app.coGames].sort((a, b) => (a.game.date < b.game.date ? 1 : -1)).map((x) => {
        const c = S.clock(x.game);
        const sc = S.score(x.game);
        return h("li", {},
          h("a", { class: "main", href: `#/co/${encodeURIComponent(x.docId)}` },
            h("div", { class: "primary" }, `vs ${x.game.opponent}`),
            h("div", { class: "secondary" }, `${fmtDate(x.game.date)} · ${x.ownerName || "another coach"}'s game`)),
          h("span", { class: `badge${c.running ? " live" : ""}` }, `${sc.us}–${sc.them} · ${c.running ? `${PHASE_LABEL[c.phase]} ${S.formatClock(c.seconds)}` : PHASE_LABEL[c.phase]}`));
      }))],
    app.sharedTeams.length > 0 && [
      h("h2", {}, "Teams shared with me"),
      h("ul", { class: "list", id: "shared-teams" }, app.sharedTeams.map((t) => {
        const n = app.shared.filter((x) => x.owner === t.uid).length;
        return h("li", {},
          h("a", { class: "main", href: `#/team/${encodeURIComponent(t.uid)}` },
            h("div", { class: "primary" }, `${t.ownerName || "A coach"}'s team`),
            h("div", { class: "secondary" }, `${plural((t.players ?? []).filter((p) => !p.removed).length, "player")} · ${plural(n, "game")} · view only`)));
      }))],
    sharedGamesOnly().length > 0 && [
      h("h2", {}, "Games shared with me"),
      h("p", { class: "muted small" }, "Single games other coaches have shared. View only."),
      h("ul", { class: "list", id: "shared-list" }, sharedGamesOnly().sort((a, b) => (a.game.date < b.game.date ? 1 : -1)).map((x) => {
        const sc = S.score(x.game);
        return h("li", {},
          h("a", { class: "main", href: `#/shared/${encodeURIComponent(x.docId)}` },
            h("div", { class: "primary" }, `vs ${x.game.opponent}`),
            h("div", { class: "secondary" }, `${fmtDate(x.game.date)} · by ${x.ownerName || "another coach"}`)),
          h("span", { class: "badge" }, `${sc.us}–${sc.them} · ${PHASE_LABEL[S.phase(x.game)]}`));
      }))],
    season.byPlayer.size > 0 && [h("h2", {}, "Season totals"), statsTable(season, { selectable: false, minutes: S.seasonPlayingTime(st) })],
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

  return h("section", {},
    h("h1", {}, "New game"),
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

// ---- Live entry

/**
 * Where a game lives: your own (st = your squad and games) or another coach's
 * that you can edit (co = that entry, st = its player names).
 */
function ctxFor(game) {
  const co = app.coGames.find((x) => x.game.id === game.id) ?? null;
  return { st: co ? co.st : app.state, co };
}
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
    h("div", { class: "live-head" },
      h("a", { class: "back", href: "#/games", "aria-label": "Back to games" }, "‹"),
      h("div", { class: "title" },
        // A long opponent name truncates; the goal count never does.
        h("div", { class: "opp-line" }, h("span", { class: "opp" }, `vs ${game.opponent}`),
          h("span", { class: "score", id: "score", "aria-label": `Score: us ${S.score(game).us}, them ${S.score(game).them}` }, `${S.score(game).us}–${S.score(game).them}`)),
        h("div", { class: "clock-line" }, h("span", { class: "clock", id: "clock" }, S.formatClock(c.seconds)),
          h("span", { class: "phase-label", id: "phase-label" }, PHASE_LABEL[c.phase]))),
      next
        ? h("button", { type: "button", class: "btn phase-btn", id: "phase-btn", onclick: () => phaseAction(game) }, next)
        : h("a", { class: "btn btn-quiet phase-btn", href: `${liveHref(game)}/stats` }, "Stats")),
    h("div", { class: "live-status", id: "live-status", role: "status", "aria-live": "polite" }, liveStatusContent()),
    h("div", { class: "pitch-wrap" }, pitch),
    [true, false].map((positive) => h("div", {
      class: `events ${positive ? "good" : "bad"}`, role: "group", "aria-label": positive ? "Good for the team" : "Bad for the team",
    }, S.EVENT_TYPES.filter((t) => t.positive === positive).map((t) => h("button", {
        type: "button", class: "ev-btn", "aria-pressed": String(pend.type === t.id), "data-event": t.id,
        onclick: () => { pend.type = pend.type === t.id ? undefined : t.id; afterPick(game); },
      }, symbolIcon(t.id, 18), h("span", {}, t.label))))),
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
      }, h("span", { class: "n" }, "Them"), h("span", { class: "nm" }, "Opposition"))),
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

function eventRow(game, e, { st = ctxFor(game).st, readOnly = false } = {}) {
  return h("li", { "data-event-id": e.id },
    h("span", { class: "muted small", style: "width:52px;flex:none;font-variant-numeric:tabular-nums" }, S.minuteLabel(e, game.halfLength)),
    symbolIcon(e.type, 18),
    h("div", { class: "main" },
      h("div", { class: "primary" }, S.eventType(e.type).label, e.team === "them" && h("span", { class: "badge them-badge" }, "Them")),
      h("div", { class: "secondary" }, S.eventPlayerLabel(st, e))),
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
  const mins = S.playingTime(game);
  const before = new Set(S.onPitch(game));
  const on = new Set(before);
  const body = h("div", {});
  const chip = (p) => h("button", {
    type: "button", class: `sub-chip${on.has(p.id) !== before.has(p.id) ? " changed" : ""}`, "data-number": p.number,
    "aria-label": `#${p.number} ${p.name}, ${on.has(p.id) ? "on the pitch" : "on the bench"}`,
    onclick: () => { on.has(p.id) ? on.delete(p.id) : on.add(p.id); draw(); },
  }, h("span", { class: "n" }, p.number), h("span", { class: "nm" }, p.name), S.phase(game) !== "pre" && h("span", { class: "mins" }, S.formatMinutes(mins.get(p.id))));
  const draw = () => {
    const pitch = players.filter((p) => on.has(p.id));
    const bench = players.filter((p) => !on.has(p.id));
    const goingOn = [...on].filter((id) => !before.has(id)).length;
    const goingOff = [...before].filter((id) => !on.has(id)).length;
    body.replaceChildren(
      h("p", { class: "muted small" }, kickOff ? "Tap players to move them between bench and pitch." : "Tap who's coming off and who's going on, then Done. Minutes are recorded at that moment."),
      h("div", { class: "step" }, h("h2", {}, `On the pitch (${pitch.length})`)),
      h("div", { class: "sub-grid", id: "sub-on" }, pitch.map(chip)),
      h("div", { class: "step" }, h("h2", {}, `Bench (${bench.length})`),
        kickOff && h("button", { type: "button", class: "link-btn small", onclick: () => { players.forEach((p) => on.add(p.id)); draw(); } }, "Everyone on")),
      h("div", { class: "sub-grid", id: "sub-bench" }, bench.map(chip)),
      !kickOff && (goingOn || goingOff) ? h("p", { class: "small", style: "margin-top:8px" }, `${goingOff} off, ${goingOn} on`) : null);
  };
  draw();
  openDialog({
    title: kickOff ? "Who's starting?" : "Substitutions",
    body,
    okLabel: kickOff ? "Kick off" : "Done",
    onOk: () => {
      const sub = commit(() => S.setOnPitch(ctxFor(game).st, current(game), [...on]));
      if (kickOff) {
        kickOff();
      } else if (sub) {
        const names = (ids) => ids.map((id) => `#${game.roster.find((r) => r.playerId === id)?.number}`).join(", ");
        toast(`Sub ${S.minuteLabel(sub, game.halfLength)}${sub.on.length ? ` · on ${names(sub.on)}` : ""}${sub.off.length ? ` · off ${names(sub.off)}` : ""}`,
          () => commit(() => S.deleteSub(current(game), sub.id)));
      }
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

function pitchSvg({ marks, pending, onTap, label, highlight }) {
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
    marks.map((e) => {
      const dim = highlight && !highlight(e);
      return symbolShape(e.type, e.x * W, e.y * H, 1.7, { class: "mark", opacity: dim ? 0.25 : 1 });
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
  if (f.gameId !== game.id) Object.assign(f, { gameId: game.id, half: 0, types: new Set(S.EVENT_IDS), playerId: undefined, team: "us" });
  const inHalf = game.events.filter((e) => !f.half || e.half === f.half);
  const t = S.tally(inHalf);
  const teamOf = (e) => e.team ?? "us";
  const shown = inHalf.filter((e) => e.x != null && f.types.has(e.type)
    && (f.team === "all" || teamOf(e) === f.team)
    && (f.playerId === undefined || (teamOf(e) === "us" && (e.playerId ?? "unknown") === f.playerId)));
  const c = S.clock(game);

  return h("section", {},
    h("div", { class: "step", style: "margin:4px 0 12px" },
      readOnly ? h("a", { class: "link-btn", href: "#/games" }, "‹ Games") : h("a", { class: "link-btn", href: liveHref(game) }, "‹ Back to game"),
      h("span", { class: `badge${c.running ? " live" : ""}` }, c.running ? `${PHASE_LABEL[c.phase]} ${S.formatClock(c.seconds)}` : PHASE_LABEL[c.phase])),
    h("h1", { style: "margin-bottom:4px" }, `vs ${game.opponent}`, " ", h("span", { class: "score big", id: "stats-score" }, `${S.score(game).us}–${S.score(game).them}`)),
    h("p", { class: "muted" }, fmtDate(game.date), sharedBy && ` · shared by ${sharedBy} (view only)`, co && ` · ${co.ownerName || "another coach"}'s game, you can edit`),
    owner && h("label", { class: "share-toggle" },
      h("input", { type: "checkbox", id: "share-toggle", checked: game.shared === true, onchange: (e) => commit(() => { current(game).shared = e.target.checked; if (!e.target.checked) delete current(game).shared; }) }),
      h("span", {}, h("strong", {}, "Share with coaches"), h("br"), h("span", { class: "muted small" }, "Every coach can view this game. Only you, and editors below, can change it."))),
    owner && editorsPicker(game),
    h("div", { class: "chips", role: "group", "aria-label": "Half" },
      [["Both halves", 0], ["1st half", 1], ["2nd half", 2]].map(([label, v]) =>
        h("button", { type: "button", class: "chip", "aria-pressed": String(f.half === v), onclick: () => { f.half = v; render(); } }, label))),
    h("h2", {}, "Team totals"),
    h("div", { class: "totals" }, S.EVENT_TYPES.map((et) => h("div", { class: et.positive ? "good" : "bad" },
      h("div", { class: "v", "data-total": et.id }, t.total[et.id]),
      h("div", { class: "k" }, symbolIcon(et.id, 12), et.short)))),
    h("h2", {}, "Where it happened"),
    h("div", { class: "chips", role: "group", "aria-label": "Team" },
      [["Us", "us"], ["Opposition", "them"], ["Both", "all"]].map(([label, v]) =>
        h("button", { type: "button", class: "chip", "data-team": v, "aria-pressed": String(f.team === v), onclick: () => { f.team = v; if (v === "them") f.playerId = undefined; render(); } }, label))),
    h("div", { class: "chips", role: "group", "aria-label": "Show events" },
      S.EVENT_TYPES.map((et) => h("button", {
        type: "button", class: "chip", "aria-pressed": String(f.types.has(et.id)),
        onclick: () => { f.types.has(et.id) ? f.types.delete(et.id) : f.types.add(et.id); render(); },
      }, symbolIcon(et.id, 14), et.label))),
    f.playerId !== undefined && h("p", { class: "small" }, `Showing ${S.gamePlayerLabel(st, game, f.playerId)} only. `,
      h("button", { type: "button", class: "link-btn", onclick: () => { f.playerId = undefined; render(); } }, "Show everyone")),
    pitchSvg({ marks: shown, label: `Pitch map of ${plural(shown.length, "event")}. Your team attacks to the right.` }),
    h("p", { class: "muted small", style: "margin-top:6px" }, "Attacking →. Filled = won / on target, hollow = lost / off target."),
    h("h2", {}, "By player"),
    t.byPlayer.size || game.starting.length
      ? [h("p", { class: "muted small" }, "Tap a player to show only their events on the map. Mins = minutes on the pitch."), statsTable(t, { selectable: true, game, st, minutes: S.playingTime(game) })]
      : h("p", { class: "muted" }, "No events yet."),
    game.subs.length > 0 && h("details", { style: "margin-top:20px" },
      h("summary", { style: "font-weight:700;cursor:pointer;font-size:1.15rem" }, `Substitutions (${game.subs.length})`),
      h("ul", { class: "list", style: "margin-top:8px", id: "subs-list" }, [...game.subs].sort((a, b) => a.half - b.half || a.t - b.t).map((x) => h("li", {},
        h("span", { class: "muted small", style: "width:52px;flex:none" }, S.minuteLabel(x, game.halfLength)),
        h("div", { class: "main" },
          h("div", { class: "primary" }, "Substitution"),
          h("div", { class: "secondary" }, [x.on.length && `On: ${x.on.map((id) => S.gamePlayerLabel(st, game, id)).join(", ")}`, x.off.length && `Off: ${x.off.map((id) => S.gamePlayerLabel(st, game, id)).join(", ")}`].filter(Boolean).join(" · "))),
        !readOnly && h("button", { type: "button", class: "link-btn", onclick: () => commit(() => S.deleteSub(game, x.id)) }, "Delete"))))),
    game.events.length > 0 && h("details", { style: "margin-top:20px" },
      h("summary", { style: "font-weight:700;cursor:pointer;font-size:1.15rem" }, `All events (${game.events.length})`),
      h("ul", { class: "list", style: "margin-top:8px" }, [...game.events].sort((a, b) => b.half - a.half || b.t - a.t).map((e) => eventRow(game, e, { st, readOnly })))),
    h("h2", {}, "Game"),
    h("div", { class: "row", style: "flex-wrap:wrap" },
      h("button", { type: "button", class: "btn btn-quiet", onclick: () => download(`${game.date}-vs-${game.opponent.replace(/[^\w-]+/g, "-")}.csv`, S.gameCSV(st, game), "text/csv") }, "Download CSV"),
      owner && h("button", { type: "button", class: "btn btn-quiet", onclick: () => editGame(game) }, "Edit details"),
      owner && h("button", { type: "button", class: "btn btn-danger", onclick: () => openDialog({
        title: `Delete game vs ${game.opponent}?`, body: h("p", {}, `This deletes its ${plural(game.events.length, "event")}. It can't be undone unless you have an export.`),
        okLabel: "Delete", danger: true, onOk: () => { commit(() => S.deleteGame(st, game.id), { rerender: false }); go("#/games"); },
      }) }, "Delete game")));
}

/** The creator picks which coaches can edit this game alongside them. */
function editorsPicker(game) {
  const me = app.user?.email;
  const others = app.coaches.filter((c) => c.email !== me);
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
      : h("p", { class: "muted small", style: "margin:0" }, "No other coaches on the list yet. Add them in the Firebase console (see Account)."));
}

/** With a game, players are labelled and sorted by the number they wore in it. */
function statsTable(t, { selectable, game, minutes = new Map(), st = app.state }) {
  const labelFor = (k) => (game ? S.gamePlayerLabel(st, game, k) : S.playerLabel(st, k));
  const numberFor = (k) => game?.roster.find((r) => r.playerId === k)?.number ?? st.players.find((p) => p.id === k)?.number ?? 0;
  const f = app.statsFilter;
  // Everyone who played or did something, even if one without the other.
  const keys = [...new Set([...t.byPlayer.keys(), ...[...minutes].filter(([, s]) => s > 0).map(([id]) => id)])].sort((a, b) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return numberFor(a) - numberFor(b);
  });
  const sum = (counts) => S.EVENT_IDS.reduce((n, id) => n + counts[id], 0);
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Player"), h("th", { class: "num" }, "Mins"), S.EVENT_TYPES.map((et) => h("th", { class: "num", title: et.label }, et.short)), h("th", { class: "num" }, "All"))),
    h("tbody", {}, keys.map((k) => {
      const counts = t.byPlayer.get(k) ?? Object.fromEntries(S.EVENT_IDS.map((id) => [id, 0]));
      return h("tr", {
        class: selectable ? "clickable" : null,
        "aria-selected": selectable ? String(f.playerId === k) : null,
        onclick: selectable ? () => { f.playerId = f.playerId === k ? undefined : k; render(); } : null,
      }, h("td", {}, labelFor(k)), h("td", { class: "num" }, k === "unknown" ? "" : S.formatMinutes(minutes.get(k))), S.EVENT_IDS.map((id) => h("td", { class: "num" }, counts[id] || "·")), h("td", { class: "num" }, sum(counts)));
    })),
    h("tfoot", {},
      h("tr", {}, h("td", {}, "Team"), h("td", {}), S.EVENT_IDS.map((id) => h("td", { class: "num" }, t.total[id])), h("td", { class: "num" }, sum(t.total))),
      game && sum(t.them) > 0 && h("tr", { class: "them-row" }, h("td", {}, "Opposition"), h("td", {}), S.EVENT_IDS.map((id) => h("td", { class: "num" }, t.them[id] || "·")), h("td", { class: "num" }, sum(t.them))))));
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
    h("h1", {}, "Squad"),
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
  const file = h("input", { type: "file", accept: ".json,application/json", id: "import-file", class: "visually-hidden",
    onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); } });
  return h("section", {},
    h("h1", {}, "Account"),
    h("div", { class: "card", id: "account" },
      h("p", {}, "Signed in as ", h("strong", {}, app.user?.email), "."),
      h("p", { class: "muted small" }, cloud
        ? "Your squad and games save to your account after every tap, and a copy is kept on this phone so it works without signal. Changes made offline upload when you reconnect."
        : "Working offline from this phone's copy. Changes will upload next time the app opens with a connection."),
      h("button", { type: "button", class: "btn btn-quiet btn-small", id: "sign-out", onclick: () => cloud?.signOut() }, "Sign out")),
    h("h2", {}, `Coaches (${app.coaches.length})`),
    h("p", { class: "muted small" }, "Everyone who can use Sideline Stats. Share a game or your team with all of them, or pick editors on a game's stats page."),
    app.coaches.length
      ? h("ul", { class: "list", id: "coaches" }, app.coaches.map((c) => h("li", {},
          h("div", { class: "main" }, h("div", { class: "primary" }, c.name || c.email, c.email === app.user?.email ? " (you)" : ""), c.name && h("div", { class: "secondary" }, c.email)))))
      : h("p", { class: "muted small" }, "Loading…"),
    h("p", { class: "muted small", style: "margin-top:8px" }, "To add or remove a coach: Firebase console → Firestore → ", h("code", {}, "allow"),
      " collection. Add a document whose ID is their Gmail address in lowercase, with a ", h("code", {}, "name"), " field."),
    h("div", { class: "card" },
      h("p", { class: "muted small", style: "margin:0" }, `${plural(S.activePlayers(st).length, "player")}, ${plural(st.games.length, "game")}, ${plural(events, "event")}.`)),
    h("h2", {}, "Back up"),
    h("p", {}, "Download everything as a JSON file, as an extra copy outside your account."),
    h("p", { class: "muted small" }, m.lastExportAt
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
