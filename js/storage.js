// Browser storage wrapper. Every access is guarded: storage can be disabled,
// full, or cleared (private windows, site-data clearing, browser eviction).

import { emptyState, parseState } from "./store.js";

// Before accounts, data lived under one key; signed-in data is kept per account
// so two people on the same phone never see each other's copy.
const LEGACY_DATA_KEY = "sideline.data.v1";
let DATA_KEY = LEGACY_DATA_KEY;
const META_KEY = "sideline.meta.v1";

/** Switches the local copy to this account's (uid) or back to the shared legacy key (null). */
export function useAccount(uid) {
  DATA_KEY = uid ? `sideline.data.${uid}` : LEGACY_DATA_KEY;
}

/** The pre-accounts local data, if any, for a one-time upload. Returns { state } or null. */
export function loadLegacy() {
  const raw = read(LEGACY_DATA_KEY);
  if (raw == null) return null;
  try {
    return { state: parseState(raw) };
  } catch {
    return null;
  }
}

/** Keeps the pre-accounts data under a new name once it has been uploaded. */
export function retireLegacy(uid) {
  const raw = read(LEGACY_DATA_KEY);
  if (raw == null) return;
  write(`${LEGACY_DATA_KEY}.uploaded-${uid}`, raw);
  try {
    localStorage.removeItem(LEGACY_DATA_KEY);
  } catch {}
}

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function storageAvailable() {
  const probe = "sideline.probe";
  if (!write(probe, "1")) return false;
  try {
    localStorage.removeItem(probe);
  } catch {}
  return true;
}

/**
 * Returns { state, problem }. A stored copy that can't be read is kept under a
 * backup key instead of being overwritten, and reported as a problem.
 */
export function loadState() {
  const raw = read(DATA_KEY);
  if (raw == null) return { state: emptyState(), problem: null };
  try {
    const state = parseState(raw);
    return { state, problem: null };
  } catch (e) {
    write(`${DATA_KEY}.unreadable-${Date.now()}`, raw);
    return { state: emptyState(), problem: `Saved data couldn't be read (${e.message}) A copy was kept in browser storage.` };
  }
}

export function saveState(state) {
  return write(DATA_KEY, JSON.stringify(state));
}

/** Small per-browser extras: export tracking and remembered view settings. */
export function loadMeta() {
  try {
    return { changesSinceExport: 0, lastExportAt: null, ui: {}, ...JSON.parse(read(META_KEY) ?? "{}") };
  } catch {
    return { changesSinceExport: 0, lastExportAt: null, ui: {} };
  }
}

export function saveMeta(meta) {
  write(META_KEY, JSON.stringify(meta));
}

/** Asks the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return await navigator.storage?.persisted?.() ?? false;
  } catch {
    return false;
  }
}

export const dataKey = () => DATA_KEY;
