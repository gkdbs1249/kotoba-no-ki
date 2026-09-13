import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  accountEmail,
  createCloudSync,
  createFirebaseAdapters,
  mergeProgress,
  normalizeAccountId,
  storageKeyForUid,
  validatePin,
} from '../src/cloud-sync.mjs';

test('account IDs map to an app-only email namespace and PINs are exactly six digits', () => {
  assert.equal(normalizeAccountId('  Hana_25  '), 'hana_25');
  assert.equal(accountEmail('Hana_25'), 'hana_25@accounts.kotoba-no-ki.invalid');
  assert.throws(() => normalizeAccountId('한나'), /4–20/);
  assert.equal(validatePin('012345'), '012345');
  assert.throws(() => validatePin('12345'), /6자리/);
  assert.throws(() => validatePin('12345a'), /6자리/);
});

test('UID local storage keys are isolated and encode unsafe UID characters', () => {
  assert.equal(storageKeyForUid('abc/def'), 'kotoba-no-ki:progress:user:abc%2Fdef');
  assert.throws(() => storageKeyForUid(''), /UID/);
});

test('progress merge unions date cohorts and keeps completion monotonic', () => {
  const local = {
    resetAt: 10,
    nextIndex: 8,
    settings: { revision: 2, dailyGoal: 10 },
    cohorts: [{ id: 'local-id', learnedDate: '2026-09-11', wordIds: ['a', 'b'], completed: false }],
  };
  const remote = {
    resetAt: 10,
    nextIndex: 5,
    settings: { revision: 1, dailyGoal: 5 },
    cohorts: [{ id: 'remote-id', learnedDate: '2026-09-11', wordIds: ['b', 'c'], completed: true, mastered: true }],
  };

  const merged = mergeProgress(local, remote);
  assert.equal(merged.nextIndex, 8);
  assert.deepEqual(merged.settings, local.settings);
  assert.equal(merged.cohorts.length, 1, 'same learnedDate is one cohort even when IDs differ');
  assert.deepEqual(merged.cohorts[0].wordIds, ['a', 'b', 'c']);
  assert.equal(merged.cohorts[0].completed, true);
  assert.equal(merged.cohorts[0].mastered, true);
});

test('current days/reviews schema merges by date with union and monotonic completion', () => {
  const merged = mergeProgress(
    {
      version: 1,
      studyStartDate: '2026-09-12',
      days: { '2026-09-12': { date: '2026-09-12', wordIds: ['a'], learned: true, recallAttempts: [{ id: 'a1', completed: true }] } },
      reviews: { a: { learnedDate: '2026-09-12', completedIntervals: [1, 3] } },
    },
    {
      version: 1,
      studyStartDate: '2026-09-10',
      days: { '2026-09-12': { date: '2026-09-12', wordIds: ['b'], coverageComplete: true, recallAttempts: [{ id: 'a2', completed: true }] } },
      reviews: { a: { learnedDate: '2026-09-12', completedIntervals: [3, 7] } },
    },
  );
  assert.equal(merged.studyStartDate, '2026-09-10');
  assert.deepEqual(merged.days['2026-09-12'].wordIds, ['a', 'b']);
  assert.equal(merged.days['2026-09-12'].learned, true);
  assert.equal(merged.days['2026-09-12'].coverageComplete, true);
  assert.deepEqual(merged.days['2026-09-12'].recallAttempts.map(({ id }) => id), ['a1', 'a2']);
  assert.deepEqual(merged.reviews.a.completedIntervals, [1, 3, 7]);
});

test('merge output omits absent optional fields instead of sending undefined to Firestore', () => {
  const merged = mergeProgress({ version: 1, days: {}, reviews: {} }, {});
  assert.equal(Object.hasOwn(merged, 'settings'), false);
  assert.equal(JSON.stringify(merged).includes('undefined'), false);
});

test('newer reset generation discards all progress from an older generation', () => {
  const beforeReset = {
    resetAt: 3,
    nextIndex: 99,
    cohorts: [{ learnedDate: '2026-09-01', wordIds: ['old'], completed: true }],
  };
  const afterReset = { resetAt: 4, nextIndex: 0, cohorts: [], settings: { revision: 1, dailyGoal: 7 } };

  assert.deepEqual(mergeProgress(beforeReset, afterReset), afterReset);
  assert.deepEqual(mergeProgress(afterReset, beforeReset), afterReset);
});

test('attempt merge deduplicates IDs and prefers completed evidence', () => {
  const interrupted = { id: 'try-1', completed: false, finishedAt: null, results: [{ wordId: 'a', correct: false }] };
  const completed = { id: 'try-1', completed: true, finishedAt: '2026-09-12T10:00:00Z', results: [{ wordId: 'a', correct: true }] };
  const merged = mergeProgress(
    { cohorts: [{ learnedDate: '2026-09-12', wordIds: ['a'], attempts: [interrupted] }] },
    { cohorts: [{ learnedDate: '2026-09-12', wordIds: ['a'], attempts: [completed] }] },
  );
  assert.equal(merged.cohorts[0].attempts[0].completed, true);
  assert.equal(merged.cohorts[0].attempts[0].results[0].correct, true);
});

test('same attempt merged from two devices is commutative and preserves correct evidence', () => {
  const left = { days: { '2026-09-12': { date: '2026-09-12', wordIds: ['w'], recallAttempts: [{ id: '2026-09-12-1', completed: true, completedAt: '2026-09-12T10:00:00Z', results: [{ wordId: 'w', answer: 'x', correct: false }] }] } } };
  const right = { days: { '2026-09-12': { date: '2026-09-12', wordIds: ['w'], recallAttempts: [{ id: '2026-09-12-1', completed: true, completedAt: '2026-09-12T10:00:00Z', results: [{ wordId: 'w', answer: '正解', correct: true }] }] } } };
  const leftRight = mergeProgress(left, right);
  const rightLeft = mergeProgress(right, left);
  assert.deepEqual(leftRight, rightLeft);
  assert.equal(leftRight.days['2026-09-12'].recallAttempts[0].results[0].correct, true);
});

test('whole progress merge is commutative for word order and diagnostic conflicts', () => {
  const left = {
    updatedAt: '2026-09-12T10:00:00Z',
    diagnostic: { completed: true, completedAt: '2026-09-12T09:00:00Z', weakSkills: ['reading'] },
    days: { '2026-09-12': { wordIds: ['b', 'a'], recallAttempts: [] } },
    carryWordIds: ['b', 'a'],
  };
  const right = {
    updatedAt: '2026-09-12T11:00:00Z',
    diagnostic: { completed: true, completedAt: '2026-09-12T10:00:00Z', weakSkills: ['particle'] },
    days: { '2026-09-12': { wordIds: ['c', 'b'], recallAttempts: [] } },
    carryWordIds: ['c', 'b'],
  };
  const leftRight = mergeProgress(left, right);
  const rightLeft = mergeProgress(right, left);
  assert.deepEqual(leftRight, rightLeft);
  assert.deepEqual(leftRight.days['2026-09-12'].wordIds, ['a', 'b', 'c']);
  assert.deepEqual(leftRight.diagnostic.weakSkills, ['particle']);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    read: (key) => JSON.parse(values.get(key)),
  };
}

function fakeAuth() {
  let listener;
  return {
    onAuthStateChanged(callback) { listener = callback; return () => { listener = undefined; }; },
    emit(user) { listener?.(user); },
    createUser: async (email, pin) => ({ email, pin }),
    signIn: async (email, pin) => ({ email, pin }),
    signOut: async () => {},
  };
}

test('startup waits for the first auth callback but not a stalled Firestore merge', async () => {
  const auth = fakeAuth();
  const storage = memoryStorage({
    [storageKeyForUid('u1')]: JSON.stringify({ resetAt: 0, nextIndex: 2, cohorts: [] }),
  });
  let releaseTransaction;
  const cloud = {
    runTransaction: () => new Promise((resolve) => { releaseTransaction = resolve; }),
    subscribe: () => () => {},
  };
  const applied = [];
  const sync = createCloudSync({ auth, cloud, storage, applyState: (state, meta) => applied.push([state, meta]) });
  let ready = false;
  const starting = sync.start().then(() => { ready = true; });
  await tick();
  assert.equal(ready, false);

  auth.emit({ uid: 'u1' });
  await starting;
  assert.equal(ready, true, 'remote I/O must continue in the background');
  assert.equal(sync.currentUid, 'u1');
  assert.equal(applied[0][0].nextIndex, 2);
  releaseTransaction?.({ resetAt: 0, nextIndex: 2, cohorts: [] });
  sync.stop();
});

test('every transaction result is applied locally or deferred by the active-screen hook', async () => {
  const auth = fakeAuth();
  const storage = memoryStorage();
  let remote = { resetAt: 0, nextIndex: 7, cohorts: [{ learnedDate: '2026-09-12', wordIds: ['x'], completed: true }] };
  const cloud = {
    async runTransaction(_uid, update) { remote = update(remote); return remote; },
    subscribe: () => () => {},
  };
  let active = true;
  const applied = [];
  const sync = createCloudSync({
    auth, cloud, storage,
    shouldDeferRemote: () => active,
    applyState: (state) => applied.push(state),
  });
  const starting = sync.start();
  auth.emit({ uid: 'u1' });
  await starting;
  await sync.whenIdle();
  assert.equal(applied.at(-1).nextIndex ?? 0, 0, 'active screen is not replaced');
  assert.equal(storage.read(storageKeyForUid('u1')).nextIndex, 7, 'merged result is still durable locally');

  active = false;
  sync.applyDeferred();
  assert.equal(applied.at(-1).nextIndex, 7);
  sync.stop();
});

test('a failed older write cannot replace newer pending state', async () => {
  const auth = fakeAuth();
  const storage = memoryStorage();
  const attempted = [];
  let call = 0;
  const cloud = {
    async runTransaction(_uid, update) {
      const candidate = update({ resetAt: 0, nextIndex: 0, cohorts: [] });
      attempted.push(candidate.nextIndex);
      if (call++ === 1) throw new Error('offline'); // startup is call zero; write A fails
      return candidate;
    },
    subscribe: () => () => {},
  };
  const sync = createCloudSync({ auth, cloud, storage, applyState: () => {} });
  const starting = sync.start(); auth.emit({ uid: 'u1' }); await starting; await sync.whenIdle();

  const first = sync.save({ resetAt: 0, nextIndex: 1, cohorts: [] });
  sync.save({ resetAt: 0, nextIndex: 2, cohorts: [] });
  await first;
  await sync.whenIdle();
  assert.deepEqual(attempted.slice(-2), [1, 2]);
  assert.equal(storage.read(storageKeyForUid('u1')).nextIndex, 2);
  sync.stop();
});

test('account switching unsubscribes and generation-guards late realtime callbacks', async () => {
  const auth = fakeAuth();
  const storage = memoryStorage();
  const listeners = [];
  const unsubscribed = [];
  const cloud = {
    async runTransaction(_uid, update) { return update({ resetAt: 0, nextIndex: 0, cohorts: [] }); },
    subscribe(uid, callback) {
      listeners.push({ uid, callback });
      return () => unsubscribed.push(uid);
    },
  };
  const sync = createCloudSync({ auth, cloud, storage, applyState: () => {} });
  const starting = sync.start(); auth.emit({ uid: 'A' }); await starting; await sync.whenIdle();
  auth.emit({ uid: 'A' }); await sync.whenIdle();
  assert.equal(listeners.filter((entry) => entry.uid === 'A').length, 1, 'same-account auth refresh must not duplicate listeners');
  auth.emit({ uid: 'B' }); await sync.whenIdle();
  assert.deepEqual(unsubscribed, ['A']);

  listeners.find((entry) => entry.uid === 'A').callback({ resetAt: 0, nextIndex: 99, cohorts: [] });
  await tick();
  assert.equal(storage.read(storageKeyForUid('B')).nextIndex, 0);
  sync.stop();
});

test('Firebase adapters use the UID-owned progress path and a Firestore transaction', async () => {
  const calls = [];
  const authInstance = {};
  const db = {};
  const authSdk = {
    onAuthStateChanged: (auth, callback) => { calls.push(['observe', auth, callback]); return () => {}; },
    createUserWithEmailAndPassword: (...args) => calls.push(['create', ...args]),
    signInWithEmailAndPassword: (...args) => calls.push(['signIn', ...args]),
    signOut: (...args) => calls.push(['signOut', ...args]),
  };
  const reference = { path: 'users/u1/progress/current' };
  let snapshotCallback;
  const firestoreSdk = {
    doc: (_db, ...parts) => ({ ...reference, parts }),
    runTransaction: async (_db, body) => body({
      get: async () => ({ exists: () => true, data: () => ({ nextIndex: 2 }) }),
      set: (ref, state) => calls.push(['set', ref.path, state]),
    }),
    onSnapshot: (ref, callback) => { calls.push(['snapshot', ref.path]); snapshotCallback = callback; return () => {}; },
  };
  const { auth, cloud } = createFirebaseAdapters({ authSdk, firestoreSdk, authInstance, db });
  auth.onAuthStateChanged(() => {});
  await auth.createUser('id@example.invalid', '123456');
  const committed = await cloud.runTransaction('u1', (remote) => ({ nextIndex: remote.nextIndex + 1 }));
  assert.equal(committed.nextIndex, 3);
  assert.deepEqual(calls.find((call) => call[0] === 'set').slice(1), ['users/u1/progress/current', { nextIndex: 3 }]);

  let received;
  cloud.subscribe('u1', (state) => { received = state; });
  snapshotCallback({ exists: () => true, data: () => ({ nextIndex: 4 }), metadata: { hasPendingWrites: false } });
  assert.deepEqual(received, { nextIndex: 4 });
});

test('PWA, Firebase rules, config example, and Pages workflow keep the static app deployable', async () => {
  const root = new URL('../', import.meta.url);
  const [manifestText, worker, rules, config, workflow] = await Promise.all([
    readFile(new URL('manifest.webmanifest', root), 'utf8'),
    readFile(new URL('sw.js', root), 'utf8'),
    readFile(new URL('firestore.rules', root), 'utf8'),
    readFile(new URL('firebase-config.mjs.example', root), 'utf8'),
    readFile(new URL('.github/workflows/pages.yml', root), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.name, 'ことばの木 / Kotoba no Ki');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.display, 'standalone');
  assert.match(worker, /kotoba-no-ki-v2/);
  for (const asset of ['./index.html', './app.mjs', './src/core.mjs', './src/cloud-sync.mjs', './styles.css', './data/words.json', './data/katakana.json']) {
    assert.ok(worker.includes(asset), `service worker must cache ${asset}`);
  }
  assert.match(worker, /Promise\.all/);
  assert.match(worker, /caches\.delete\(CACHE_NAME\)/);
  assert.doesNotMatch(worker, /firebase-config\.mjs['"]/i, 'optional config must not make precache installation fail');
  assert.match(rules, /request\.auth\.uid == userId/);
  assert.match(rules, /progress\/\{documentId\}/);
  assert.match(config, /REPLACE_WITH_/);
  assert.doesNotMatch(config, /AIza[0-9A-Za-z_-]{20,}/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(workflow, /npm test/);
});

test('online, focus, visible, and persisted pageshow pull even with no pending write', async () => {
  const auth = fakeAuth();
  const storage = memoryStorage();
  const events = new EventTarget();
  const documentTarget = new EventTarget();
  documentTarget.visibilityState = 'hidden';
  let pulls = 0;
  const cloud = {
    async runTransaction(_uid, update) { pulls += 1; return update({ resetAt: 0, nextIndex: pulls, cohorts: [] }); },
    subscribe: () => () => {},
  };
  const sync = createCloudSync({ auth, cloud, storage, applyState: () => {}, eventTarget: events, documentTarget });
  const starting = sync.start(); auth.emit({ uid: 'u1' }); await starting; await sync.whenIdle();
  const initial = pulls;
  events.dispatchEvent(new Event('online'));
  await sync.whenIdle();
  events.dispatchEvent(new Event('focus'));
  await sync.whenIdle();
  documentTarget.visibilityState = 'visible';
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  await sync.whenIdle();
  const ordinaryPageShow = new Event('pageshow');
  Object.defineProperty(ordinaryPageShow, 'persisted', { value: false });
  events.dispatchEvent(ordinaryPageShow);
  await sync.whenIdle();
  const beforeBfcache = pulls;
  const bfcache = new Event('pageshow');
  Object.defineProperty(bfcache, 'persisted', { value: true });
  events.dispatchEvent(bfcache);
  await sync.whenIdle();

  assert.equal(beforeBfcache, initial + 3);
  assert.equal(pulls, beforeBfcache + 1);
  sync.stop();
});
