// Security rules tests, run against the local Firestore emulator:
//   npm run test:rules
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs } from "firebase/firestore";

let env;
const ME = { uid: "me", email: "me@example.com" };
const BRO = { uid: "bro", email: "Brother@Example.com" }; // mixed case on purpose
const STRANGER = { uid: "x", email: "stranger@example.com" };

const as = (u, verified = true) => env.authenticatedContext(u.uid, { email: u.email, email_verified: verified }).firestore();
const game = (owner, shared = false, extra = {}) => ({ owner, shared, ownerName: owner, game: { opponent: "Rovers" }, ...extra });

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-sideline",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8085 },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "allow/me@example.com"), {});
    await setDoc(doc(db, "allow/brother@example.com"), {});
    await setDoc(doc(db, "users/me"), { players: [] });
    await setDoc(doc(db, "games/me_1"), game("me", false));
    await setDoc(doc(db, "games/me_2"), game("me", true));
    await setDoc(doc(db, "games/bro_3"), game("bro", true));
  });
});

test("you can check your own allowlist entry, but not anyone else's or the list", async () => {
  await assertSucceeds(getDoc(doc(as(ME), "allow/me@example.com")));
  await assertSucceeds(getDoc(doc(as(BRO), "allow/brother@example.com")));
  await assertFails(getDoc(doc(as(ME), "allow/brother@example.com")));
  await assertFails(getDocs(collection(as(ME), "allow")));
});

test("nobody can change the allowlist from the app", async () => {
  await assertFails(setDoc(doc(as(ME), "allow/friend@example.com"), {}));
  await assertFails(setDoc(doc(as(STRANGER), "allow/stranger@example.com"), {}));
  await assertFails(deleteDoc(doc(as(ME), "allow/brother@example.com")));
});

test("a stranger and a signed-out visitor get nothing", async () => {
  for (const db of [as(STRANGER), env.unauthenticatedContext().firestore()]) {
    await assertFails(getDoc(doc(db, "games/me_2")));
    await assertFails(getDoc(doc(db, "users/me")));
    await assertFails(getDocs(query(collection(db, "games"), where("shared", "==", true))));
    await assertFails(setDoc(doc(db, "games/x_9"), game("x")));
  }
});

test("an unverified email is treated as a stranger", async () => {
  await assertFails(getDoc(doc(as(ME, false), "games/me_1")));
});

test("your squad is yours alone", async () => {
  await assertSucceeds(getDoc(doc(as(ME), "users/me")));
  await assertSucceeds(setDoc(doc(as(ME), "users/me"), { players: [{ id: 1 }] }));
  await assertFails(getDoc(doc(as(BRO), "users/me")));
  await assertFails(setDoc(doc(as(BRO), "users/me"), { players: [] }));
});

test("you can create, edit and delete your own games", async () => {
  const db = as(ME);
  await assertSucceeds(setDoc(doc(db, "games/me_10"), game("me")));
  await assertSucceeds(updateDoc(doc(db, "games/me_10"), { shared: true }));
  await assertSucceeds(getDoc(doc(db, "games/me_1")));
  await assertSucceeds(deleteDoc(doc(db, "games/me_10")));
  // Your list of games (query on owner) is allowed.
  await assertSucceeds(getDocs(query(collection(db, "games"), where("owner", "==", "me"))));
});

test("you can't create games in someone else's name or id space", async () => {
  const db = as(ME);
  await assertFails(setDoc(doc(db, "games/bro_11"), game("me")));
  await assertFails(setDoc(doc(db, "games/me_12"), game("bro")));
  await assertFails(setDoc(doc(db, "games/me_13"), game("me", "yes")));
});

test("family can view a shared game but not change it", async () => {
  const db = as(BRO);
  await assertSucceeds(getDoc(doc(db, "games/me_2")));
  await assertFails(updateDoc(doc(db, "games/me_2"), { "game.opponent": "Changed" }));
  await assertFails(setDoc(doc(db, "games/me_2"), game("bro", true)));
  await assertFails(deleteDoc(doc(db, "games/me_2")));
  // Listing shared games works.
  const shared = await assertSucceeds(getDocs(query(collection(db, "games"), where("shared", "==", true))));
  if (shared.size !== 2) throw new Error(`expected 2 shared games, got ${shared.size}`);
});

test("family can't see games that aren't shared", async () => {
  const db = as(BRO);
  await assertFails(getDoc(doc(db, "games/me_1")));
  await assertFails(getDocs(query(collection(db, "games"), where("owner", "==", "me"))));
});

test("the owner can't hand a game to someone else", async () => {
  await assertFails(updateDoc(doc(as(ME), "games/me_1"), { owner: "bro" }));
});

test("removing someone from the allowlist cuts off access, even to their own games", async () => {
  await env.withSecurityRulesDisabled((ctx) => deleteDoc(doc(ctx.firestore(), "allow/brother@example.com")));
  await assertFails(getDoc(doc(as(BRO), "games/bro_3")));
  await assertFails(getDoc(doc(as(BRO), "games/me_2")));
});
