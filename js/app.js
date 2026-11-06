import * as S from "./store.js";
import * as storage from "./storage.js";

// ---------------------------------------------------------------- state

const loaded = storage.loadState();
const app = {
  state: loaded.state,
  meta: storage.loadMeta(),
  loadProblem: loaded.problem,
  storageOk: storage.storageAvailable(),
  persisted: null,
  route: { name: "games" },
  pending: null, // live entry: { gameId, x, y, type, playerId } – playerId undefined = not chosen, null = unknown
  statsFilter: { half: 0, types: new Set(S.EVENT_IDS), playerId: undefined },
};

function commit(mutate, { rerender = true } = {}) {
  const result = mutate(app.state);
  app.storageOk = storage.saveState(app.state);
  app.meta.changesSinceExport = (app.meta.changesSinceExport ?? 0) + 1;
  storage.saveMeta(app.meta);
  if (rerender) render();
  return result;
}

const saveMeta = () => storage.saveMeta(app.meta);
const findGame = (id) => app.state.games.find((g) => g.id === id);

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

/** Event symbol: colour = group, shape = group (circle/triangle/square), hollow = negative outcome. */
function symbolShape(type, cx, cy, r, extra = {}) {
  const t = S.eventType(type);
  const cls = `sym-${t.group}${t.positive ? "" : " sym-hollow"} ${extra.class ?? ""}`.trim();
  if (t.group === 0) return s("circle", { ...extra, class: cls, cx, cy, r: r * 0.95 });
  if (t.group === 1) {
    const pts = [[cx, cy - r * 1.1], [cx + r * 1.05, cy + r * 0.75], [cx - r * 1.05, cy + r * 0.75]];
    return s("polygon", { ...extra, class: cls, points: pts.map((p) => p.join(",")).join(" "), "stroke-linejoin": "round" });
  }
  return s("rect", { ...extra, class: cls, x: cx - r * 0.85, y: cy - r * 0.85, width: r * 1.7, height: r * 1.7, rx: r * 0.2 });
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
  if (["games", "squad", "data", "new"].includes(parts[0])) return { name: parts[0] };
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
  const r = app.route;
  const game = r.id != null ? findGame(r.id) : null;
  if ((r.name === "live" || r.name === "stats") && !game) {
    app.route = { name: "games" };
    history.replaceState(null, "", "#/games");
    return render();
  }
  const live = r.name === "live";
  document.body.classList.toggle("live", live);
  document.getElementById("tabs").hidden = live;
  const tab = r.name === "new" || r.name === "stats" ? "games" : r.name;
  for (const a of document.querySelectorAll(".tabs a")) {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  renderBanner(live);
  const views = { games: viewGames, new: viewNewGame, live: () => viewLive(game), stats: () => viewStats(game), squad: viewSquad, data: viewData };
  view.replaceChildren(views[r.name]());
  updateWakeLock(live && S.clock(game).running);
  tick();
}

function renderBanner(live) {
  const banner = document.getElementById("banner");
  const m = app.meta;
  let content = null;
  if (!app.storageOk) {
    content = [h("span", {}, "This browser isn't saving your data (storage is blocked or full). Export to keep it."),
      h("button", { type: "button", class: "btn btn-small", onclick: exportData }, "Export now")];
  } else if (app.loadProblem) {
    content = [h("span", {}, app.loadProblem), h("button", { type: "button", class: "btn btn-small btn-quiet", onclick: () => { app.loadProblem = null; render(); } }, "Dismiss")];
  } else if (!live && m.changesSinceExport > 0) {
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

// ---- Games list

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
          const status = c.running ? `${PHASE_LABEL[c.phase]} · ${S.formatClock(c.seconds)}` : PHASE_LABEL[c.phase];
          return h("li", {},
            h("a", { class: "main", href: `#/game/${g.id}` },
              h("div", { class: "primary" }, `vs ${g.opponent}`),
              h("div", { class: "secondary" }, `${fmtDate(g.date)} · ${plural(g.events.length, "event")}`)),
            h("span", { class: `badge${c.running ? " live" : ""}` }, status),
            h("a", { class: "link-btn", href: `#/game/${g.id}/stats` }, "Stats"));
        }))
      : h("p", { class: "muted", style: "margin-top:16px" }, "No games yet."),
    season.byPlayer.size > 0 && [h("h2", {}, "Season totals"), statsTable(season, { selectable: false })]);
}

// ---- New game

function viewNewGame() {
  const players = S.activePlayers(app.state);
  const opponent = h("input", { id: "opponent", name: "opponent", autocomplete: "off", maxlength: 60, placeholder: "e.g. Rovers U12", required: true });
  const date = h("input", { type: "date", id: "game-date", value: S.todayISO() });
  const half = h("input", { type: "number", id: "half-length", inputmode: "numeric", min: 1, max: 60, value: app.meta.lastHalfLength ?? 30 });
  const error = h("p", { class: "field-error", hidden: true, id: "new-game-error" });
  const checks = players.map((p) => h("input", { type: "checkbox", checked: true, value: p.id }));

  return h("section", {},
    h("h1", {}, "New game"),
    h("form", {
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        const res = S.createGame(app.state, {
          opponent: opponent.value, date: date.value, halfLength: Number(half.value),
          squad: checks.filter((c) => c.checked).map((c) => Number(c.value)),
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
      players.length
        ? h("div", { class: "field" },
            h("div", { class: "step" }, h("label", {}, "Who's playing?"),
              h("button", { type: "button", class: "link-btn", onclick: () => { const all = checks.every((c) => c.checked); checks.forEach((c) => (c.checked = !all)); } }, "All / none")),
            h("div", { class: "checks" }, players.map((p, i) => h("label", {}, checks[i], `#${p.number} ${p.name}`))))
        : h("p", { class: "muted" }, "No squad yet. You can still log events against \"Unknown\", or add your squad first."),
      error,
      h("button", { type: "submit", class: "btn btn-block", id: "create-game" }, "Create game")));
}

// ---- Live entry

function matchdayPlayers(game) {
  const ids = new Set(game.squad);
  return S.activePlayers(app.state).filter((p) => ids.has(p.id));
}

function viewLive(game) {
  if (app.pending?.gameId !== game.id) app.pending = { gameId: game.id };
  const pend = app.pending;
  const c = S.clock(game);
  const next = S.NEXT_ACTION[c.phase];
  const players = matchdayPlayers(game);
  const recent = [...game.events].sort((a, b) => b.id - a.id).slice(0, 5);

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
        h("div", { class: "opp" }, `vs ${game.opponent}`),
        h("div", {}, h("span", { class: "clock", id: "clock" }, S.formatClock(c.seconds)), " ",
          h("span", { class: "phase-label", id: "phase-label" }, PHASE_LABEL[c.phase]))),
      next
        ? h("button", { type: "button", class: "btn phase-btn", id: "phase-btn", onclick: () => phaseAction(game) }, next)
        : h("a", { class: "btn btn-quiet phase-btn", href: `#/game/${game.id}/stats` }, "Stats")),
    h("div", { class: "live-status", id: "live-status", role: "status", "aria-live": "polite" }, liveStatusContent()),
    h("div", { class: "pitch-wrap" }, pitch),
    h("div", { class: "events", role: "group", "aria-label": "Event" },
      S.EVENT_TYPES.map((t) => h("button", {
        type: "button", class: "ev-btn", "aria-pressed": String(pend.type === t.id), "data-event": t.id,
        onclick: () => { pend.type = pend.type === t.id ? undefined : t.id; afterPick(game); },
      }, symbolIcon(t.id, 18), t.label))),
    h("div", { class: "players", role: "group", "aria-label": "Player" },
      players.map((p) => h("button", {
        type: "button", class: "pl-btn", "aria-pressed": String(pend.playerId === p.id), "data-number": p.number,
        "aria-label": `#${p.number} ${p.name}`,
        onclick: () => { pend.playerId = pend.playerId === p.id ? undefined : p.id; afterPick(game); },
      }, h("span", { class: "n" }, p.number), p.name && h("span", { class: "nm" }, p.name))),
      h("button", {
        type: "button", class: "pl-btn", "aria-pressed": String(pend.playerId === null), "data-number": "unknown", "aria-label": "Unknown player",
        onclick: () => { pend.playerId = pend.playerId === null ? undefined : null; afterPick(game); },
      }, h("span", { class: "n" }, "?"), h("span", { class: "nm" }, "Unknown"))),
    h("div", { class: "row", style: "justify-content:space-between" },
      h("button", { type: "button", class: "btn btn-quiet btn-small", disabled: !(pend.x != null || pend.type || pend.playerId !== undefined),
        onclick: () => { app.pending = { gameId: game.id }; render(); } }, "Clear selection"),
      h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => editMatchday(game) }, "Edit players")),
    h("div", { class: "recent" },
      h("div", { class: "step" }, h("h2", {}, "Latest"), h("a", { class: "link-btn small", href: `#/game/${game.id}/stats`, id: "to-stats" }, `All ${game.events.length} · stats →`)),
      recent.length
        ? h("ul", { class: "list", id: "recent" }, recent.map((e) => eventRow(game, e)))
        : h("p", { class: "muted small" }, "Tap where, what and who, in any order. It saves when all three are chosen.")));
}

function afterPick(game) {
  const p = app.pending;
  if (p.x != null && p.type && p.playerId !== undefined) {
    const ev = commit((st) => S.addEvent(st, game, { type: p.type, playerId: p.playerId, x: p.x, y: p.y }), { rerender: false });
    app.pending = { gameId: game.id };
    navigator.vibrate?.(30);
    render();
    toast(`${S.minuteLabel(ev, game.halfLength)} ${S.playerLabel(app.state, ev.playerId)} · ${S.eventType(ev.type).label}`,
      () => commit(() => S.deleteEvent(game, ev.id)));
  } else {
    render();
  }
}

function eventRow(game, e) {
  return h("li", { "data-event-id": e.id },
    h("span", { class: "muted small", style: "width:52px;flex:none;font-variant-numeric:tabular-nums" }, S.minuteLabel(e, game.halfLength)),
    symbolIcon(e.type, 18),
    h("div", { class: "main" },
      h("div", { class: "primary" }, S.eventType(e.type).label),
      h("div", { class: "secondary" }, S.playerLabel(app.state, e.playerId))),
    h("button", {
      type: "button", class: "link-btn", "aria-label": `Delete ${S.eventType(e.type).label} at ${S.minuteLabel(e, game.halfLength)}`,
      onclick: () => {
        const copy = { ...e };
        commit(() => S.deleteEvent(game, e.id));
        toast("Event deleted.", () => commit(() => game.events.push(copy)));
      },
    }, "Delete"));
}

function phaseAction(game) {
  const p = S.phase(game);
  const doIt = () => {
    commit(() => S.advancePhase(game));
    const label = PHASE_LABEL[S.phase(game)];
    toast(p === "pre" ? "Kick-off! Clock running." : p === "half" ? "Second half started." : `${label}.`, () => commit(() => S.undoPhase(game)));
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

function editMatchday(game) {
  const players = S.activePlayers(app.state);
  if (!players.length) {
    openDialog({ title: "No squad yet", body: h("p", {}, "Add players on the Squad tab first."), cancel: false, onOk: () => {} });
    return;
  }
  const set = new Set(game.squad);
  const checks = players.map((p) => h("input", { type: "checkbox", checked: set.has(p.id), value: p.id }));
  openDialog({
    title: "Who's playing?",
    body: h("div", { class: "checks" }, players.map((p, i) => h("label", {}, checks[i], `#${p.number} ${p.name}`))),
    okLabel: "Save",
    onOk: () => commit(() => { game.squad = checks.filter((c) => c.checked).map((c) => Number(c.value)); }),
  });
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

function viewStats(game) {
  const f = app.statsFilter;
  if (f.gameId !== game.id) Object.assign(f, { gameId: game.id, half: 0, types: new Set(S.EVENT_IDS), playerId: undefined });
  const inHalf = game.events.filter((e) => !f.half || e.half === f.half);
  const t = S.tally(inHalf);
  const shown = inHalf.filter((e) => f.types.has(e.type) && (f.playerId === undefined || (e.playerId ?? "unknown") === f.playerId));
  const c = S.clock(game);

  return h("section", {},
    h("div", { class: "step", style: "margin:4px 0 12px" },
      h("a", { class: "link-btn", href: `#/game/${game.id}` }, "‹ Back to game"),
      h("span", { class: "badge" }, PHASE_LABEL[c.phase])),
    h("h1", { style: "margin-bottom:4px" }, `vs ${game.opponent}`),
    h("p", { class: "muted" }, fmtDate(game.date)),
    h("div", { class: "chips", role: "group", "aria-label": "Half" },
      [["Both halves", 0], ["1st half", 1], ["2nd half", 2]].map(([label, v]) =>
        h("button", { type: "button", class: "chip", "aria-pressed": String(f.half === v), onclick: () => { f.half = v; render(); } }, label))),
    h("div", { class: "totals" }, S.EVENT_TYPES.map((et) => h("div", {},
      h("div", { class: "v", "data-total": et.id }, t.total[et.id]),
      h("div", { class: "k" }, symbolIcon(et.id, 12), et.short)))),
    h("h2", {}, "Where it happened"),
    h("div", { class: "chips", role: "group", "aria-label": "Show events" },
      S.EVENT_TYPES.map((et) => h("button", {
        type: "button", class: "chip", "aria-pressed": String(f.types.has(et.id)),
        onclick: () => { f.types.has(et.id) ? f.types.delete(et.id) : f.types.add(et.id); render(); },
      }, symbolIcon(et.id, 14), et.label))),
    f.playerId !== undefined && h("p", { class: "small" }, `Showing ${S.playerLabel(app.state, f.playerId)} only. `,
      h("button", { type: "button", class: "link-btn", onclick: () => { f.playerId = undefined; render(); } }, "Show everyone")),
    pitchSvg({ marks: shown, label: `Pitch map of ${plural(shown.length, "event")}. Your team attacks to the right.` }),
    h("p", { class: "muted small", style: "margin-top:6px" }, "Attacking →. Filled = won / on target, hollow = lost / off target."),
    h("h2", {}, "By player"),
    t.byPlayer.size
      ? [h("p", { class: "muted small" }, "Tap a player to show only their events on the map."), statsTable(t, { selectable: true })]
      : h("p", { class: "muted" }, "No events yet."),
    game.events.length > 0 && h("details", { style: "margin-top:20px" },
      h("summary", { style: "font-weight:700;cursor:pointer;font-size:1.15rem" }, `All events (${game.events.length})`),
      h("ul", { class: "list", style: "margin-top:8px" }, [...game.events].sort((a, b) => b.half - a.half || b.t - a.t).map((e) => eventRow(game, e)))),
    h("h2", {}, "Game"),
    h("div", { class: "row", style: "flex-wrap:wrap" },
      h("button", { type: "button", class: "btn btn-quiet", onclick: () => download(`${game.date}-vs-${game.opponent.replace(/[^\w-]+/g, "-")}.csv`, S.gameCSV(app.state, game), "text/csv") }, "Download CSV"),
      h("button", { type: "button", class: "btn btn-quiet", onclick: () => editGame(game) }, "Edit details"),
      h("button", { type: "button", class: "btn btn-danger", onclick: () => openDialog({
        title: `Delete game vs ${game.opponent}?`, body: h("p", {}, `This deletes its ${plural(game.events.length, "event")}. It can't be undone unless you have an export.`),
        okLabel: "Delete", danger: true, onOk: () => { commit(() => S.deleteGame(app.state, game.id), { rerender: false }); go("#/games"); },
      }) }, "Delete game")));
}

function statsTable(t, { selectable }) {
  const f = app.statsFilter;
  const keys = [...t.byPlayer.keys()].sort((a, b) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    const pa = app.state.players.find((p) => p.id === a);
    const pb = app.state.players.find((p) => p.id === b);
    return (pa?.number ?? 0) - (pb?.number ?? 0);
  });
  const sum = (counts) => S.EVENT_IDS.reduce((n, id) => n + counts[id], 0);
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Player"), S.EVENT_TYPES.map((et) => h("th", { class: "num", title: et.label }, et.short)), h("th", { class: "num" }, "All"))),
    h("tbody", {}, keys.map((k) => {
      const counts = t.byPlayer.get(k);
      return h("tr", {
        class: selectable ? "clickable" : null,
        "aria-selected": selectable ? String(f.playerId === k) : null,
        onclick: selectable ? () => { f.playerId = f.playerId === k ? undefined : k; render(); } : null,
      }, h("td", {}, S.playerLabel(app.state, k)), S.EVENT_IDS.map((id) => h("td", { class: "num" }, counts[id] || "·")), h("td", { class: "num" }, sum(counts)));
    })),
    h("tfoot", {}, h("tr", {}, h("td", {}, "Team"), S.EVENT_IDS.map((id) => h("td", { class: "num" }, t.total[id])), h("td", { class: "num" }, sum(t.total))))));
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
        title: `Remove #${p.number} ${p.name}?`, body: h("p", {}, "Their stats in past games are kept."), okLabel: "Remove", danger: true,
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
    h("h1", {}, "Your data"),
    h("div", { class: "card" },
      h("p", {}, "Everything is stored in this browser on this device only. Nothing is sent anywhere."),
      h("p", { class: "muted small" },
        app.storageOk ? "✓ Saving automatically after every tap." : "✗ Browser storage isn't available. Export to keep your data.",
        app.persisted === true ? " The browser has agreed not to clear it automatically." : "",
        app.persisted === false ? " The browser may clear it if space runs low or site data is cleared." : ""),
      h("p", { class: "muted small", style: "margin:0" }, `${plural(S.activePlayers(st).length, "player")}, ${plural(st.games.length, "game")}, ${plural(events, "event")}.`)),
    h("h2", {}, "Back up"),
    h("p", {}, "Download everything as a JSON file. Keep it safe, or use it to move to another phone or browser."),
    h("p", { class: "muted small" }, m.lastExportAt
      ? `Last export: ${new Date(m.lastExportAt).toLocaleString()}${m.changesSinceExport ? ` (${plural(m.changesSinceExport, "change")} since)` : " (up to date)"}.`
      : "Not exported yet."),
    h("button", { type: "button", class: "btn", id: "export", onclick: exportData }, "Export JSON"),
    h("h2", {}, "Restore"),
    h("p", {}, "Load a JSON file you exported earlier. It replaces the data in this browser."),
    file,
    h("label", { for: "import-file", class: "btn btn-quiet", style: "margin:0" }, "Import JSON…"),
    (st.players.length > 0 || st.games.length > 0) && [
      h("h2", {}, "Start over"),
      h("button", { type: "button", class: "btn btn-danger", onclick: () => openDialog({
        title: "Delete all data?", body: h("p", {}, "This removes the squad and every game from this browser. Export first if you might want it back."),
        okLabel: "Delete everything", danger: true, onOk: () => commit((st) => Object.assign(st, S.emptyState())),
      }) }, "Delete all data")]);
}

// ---------------------------------------------------------------- clock & screen

function tick() {
  if (app.route.name !== "live") return;
  const game = findGame(app.route.id);
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
  if (document.visibilityState === "visible" && app.route.name === "live") render();
});

window.addEventListener("storage", (e) => {
  if (e.key !== storage.STORAGE_KEYS.DATA_KEY) return;
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
render();
