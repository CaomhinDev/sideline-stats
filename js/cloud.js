// Firebase: Google sign-in, the coaches allowlist check, and syncing data to
// Firestore (with Firestore's offline cache, so the sideline works without signal).
//
// Data layout (see firestore.rules):
//   allow/{email}        the allowlist, managed in the Firebase console
//   users/{uid}          { players, nextId }  – your squad
//   games/{uid}_{id}     { owner, ownerName, shared, names, game } – one doc per game

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  signOut as fbSignOut, connectAuthEmulator, signInWithCredential,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, where, serverTimestamp, arrayUnion, arrayRemove, deleteField,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

// Tests set this before the page loads to use the local emulators instead of the real project.
const EMULATOR = window.__SIDELINE_EMULATOR === true && ["127.0.0.1", "localhost"].includes(location.hostname);

const config = EMULATOR
  ? { apiKey: "demo-key", authDomain: "demo-sideline.firebaseapp.com", projectId: "demo-sideline", appId: "demo" }
  : {
      apiKey: "AIzaSyBqV-_6b3XNV0-dg839aMg3L8Ow7ZgVUcY",
      authDomain: "sideline-stats-ab0dd.firebaseapp.com",
      projectId: "sideline-stats-ab0dd",
      storageBucket: "sideline-stats-ab0dd.firebasestorage.app",
      messagingSenderId: "705882747527",
      appId: "1:705882747527:web:3e464bed1b7621cce7fe22",
    };

const app = initializeApp(config);
const auth = getAuth(app);
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch {
  db = initializeFirestore(app, {}); // no IndexedDB (e.g. private mode): online-only
}
if (EMULATOR) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8085);
}

export const isEmulator = EMULATOR;

export function onUser(cb) {
  return onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: (u.email ?? "").toLowerCase(), name: u.displayName || u.email || "" } : null));
}

export async function signIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e?.code === "auth/popup-blocked" || e?.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
    } else if (e?.code !== "auth/popup-closed-by-user" && e?.code !== "auth/cancelled-popup-request") {
      throw e;
    }
  }
}

export const signOut = () => fbSignOut(auth);

/** Emulator only: sign in as any Google account, for automated tests. */
export async function testSignIn(email) {
  if (!EMULATOR) throw new Error("testSignIn is only available with the emulator");
  const token = JSON.stringify({ sub: email.replace(/\W/g, "_"), email, email_verified: true });
  await signInWithCredential(auth, GoogleAuthProvider.credential(token));
}

/**
 * This account's access: { role: "admin" | "coach" | "player", team } when it's on
 * the list, false when it isn't, or null when it can't be checked (offline).
 */
export async function getAccess(user) {
  try {
    const snap = await getDoc(doc(db, "allow", user.email));
    if (!snap.exists()) return false;
    const d = snap.data();
    const role = ["admin", "coach", "player"].includes(d.role) ? d.role : "coach";
    return { role, team: role === "player" ? String(d.team ?? "") : null };
  } catch (e) {
    if (e?.code === "permission-denied") return false;
    return null;
  }
}

export async function isAllowed(user) {
  const a = await getAccess(user);
  return a === null ? null : a !== false;
}

/** Adds (or replaces) someone on the list. Email is stored lowercase. */
export function addPerson(email, { name, role, team }, addedBy) {
  const entry = { name: String(name ?? "").trim().slice(0, 60), role };
  if (role === "player") entry.team = team;
  if (addedBy) entry.addedBy = addedBy;
  return setDoc(doc(db, "allow", email.trim().toLowerCase()), entry);
}

export const setRole = (email, role) => updateDoc(doc(db, "allow", email), { role });
export const removePerson = (email) => deleteDoc(doc(db, "allow", email));

/** For a player: their team's squad doc and games, live. cb(team | null, games). */
export function watchTeam(teamUid, cb, onError) {
  let team;
  let games;
  const emit = () => { if (team !== undefined && games !== undefined) cb(team, games); };
  const u1 = onSnapshot(doc(db, "users", teamUid), (snap) => { team = snap.exists() ? snap.data() : null; emit(); }, onError);
  const u2 = onSnapshot(query(collection(db, "games"), where("owner", "==", teamUid)), (snap) => {
    games = snap.docs.map((d) => ({ docId: d.id, ...d.data() }));
    emit();
  }, onError);
  return () => { u1(); u2(); };
}

/** Live updates of your squad and your games. Calls back with ({ players, shared } | null, [game], fromServer). */
export function watchMine(uid, cb, onError) {
  let user;
  let games;
  let userFromServer = false;
  let gamesFromServer = false;
  const emit = () => {
    if (user !== undefined && games !== undefined) cb(user, games, userFromServer && gamesFromServer);
  };
  const u1 = onSnapshot(doc(db, "users", uid), { includeMetadataChanges: true }, (snap) => {
    user = snap.exists() ? snap.data() : null;
    userFromServer = !snap.metadata.fromCache;
    emit();
  }, onError);
  const u2 = onSnapshot(query(collection(db, "games"), where("owner", "==", uid)), { includeMetadataChanges: true }, (snap) => {
    games = snap.docs.map((d) => d.data().game).filter(Boolean);
    gamesFromServer = !snap.metadata.fromCache;
    emit();
  }, onError);
  return () => { u1(); u2(); };
}

/** Live list of games other coaches have shared (view only). */
export function watchShared(uid, cb, onError) {
  return onSnapshot(query(collection(db, "games"), where("shared", "==", true)), (snap) => {
    cb(snap.docs.filter((d) => d.data().owner !== uid).map((d) => ({ docId: d.id, ...d.data() })));
  }, onError);
}

/** Live list of whole teams other coaches have shared: [{ uid, ownerName, players }]. */
export function watchSharedTeams(uid, cb, onError) {
  return onSnapshot(query(collection(db, "users"), where("shared", "==", true)), (snap) => {
    cb(snap.docs.filter((d) => d.id !== uid).map((d) => ({ uid: d.id, ...d.data() })));
  }, onError);
}

// Firestore rejects undefined; a JSON round trip drops it (our data is plain JSON anyway).
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Your squad. shared = your whole team is visible to every coach (view only). */
export function saveUser(user, { players, shared, teamName }) {
  return setDoc(doc(db, "users", user.uid), plain({ players, shared: shared === true, ownerName: user.name, teamName: teamName ?? "" }));
}

export const gameDocId = (uid, gameId) => `${uid}_${gameId}`;

/** Creates (or wholly replaces) one of your games. shared: its own switch, or your whole team's. */
export function saveGame(user, game, names, shared = game.shared === true) {
  return setDoc(doc(db, "games", gameDocId(user.uid, game.id)), {
    owner: user.uid,
    ownerName: user.name,
    shared,
    editors: game.editors ?? [],
    names: plain(names),
    game: plain(game),
    updated: serverTimestamp(),
  });
}

/**
 * Applies field-level changes to a game doc, e.g. { "game.events": add([...]) }.
 * Adding and removing individual events means two coaches logging at the same
 * moment both keep their entries, instead of one overwriting the other.
 */
export function updateGame(docId, fields) {
  return updateDoc(doc(db, "games", docId), { ...fields, updated: serverTimestamp() });
}
export const add = (items) => arrayUnion(...plain(items));
export const remove = (items) => arrayRemove(...plain(items));
export const unset = () => deleteField();

/** Live list of everyone on the allowlist: [{ email, name, role, team }] (coaches and admins only can read it). */
export function watchPeople(cb, onError) {
  return onSnapshot(collection(db, "allow"), (snap) => {
    cb(snap.docs.map((d) => {
      const x = d.data();
      const role = ["admin", "coach", "player"].includes(x.role) ? x.role : "coach";
      return { email: d.id, name: String(x.name ?? ""), role, team: x.team ?? null };
    }).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email)));
  }, onError);
}

/** Live list of other coaches' games you've been made an editor of. */
export function watchEditable(user, cb, onError) {
  return onSnapshot(query(collection(db, "games"), where("editors", "array-contains", user.email)), (snap) => {
    cb(snap.docs.filter((d) => d.data().owner !== user.uid).map((d) => ({ docId: d.id, ...d.data() })));
  }, onError);
}

export function removeGame(uid, gameId) {
  return deleteDoc(doc(db, "games", `${uid}_${gameId}`));
}
