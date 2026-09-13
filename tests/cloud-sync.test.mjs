import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  accountEmail,
  anonymousStorageKey,
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

test('malformed root and nested collection shapes collapse to Firestore-safe maps', () => {
  assert.deepEqual(mergeProgress([null], {}), { resetAt: 0, nextIndex: 0 });
  const merged = mergeProgress({
    bogus: true,
    version: 1.5,
    schemaVersion: '2',
    resetAt: 1.5,
    nextIndex: -2,
    studyStartDate: 42,
    settings: null,
    carryWordIds: [['x']],
    days: { bad: 42, '2026-01-01': [['x']] },
    reviews: { a: 42, b: [['x']] },
    cohorts: [['x']],
  }, {});
  assert.equal('bogus' in merged, false);
  assert.equal(Number.isInteger(merged.version), true);
  assert.equal(Number.isInteger(merged.schemaVersion), true);
  assert.equal(Number.isInteger(merged.resetAt), true);
  assert.equal(merged.nextIndex, 0);
  assert.equal('studyStartDate' in merged, false);
  assert.equal('settings' in merged, false);
  assert.deepEqual(merged.carryWordIds, []);
  assert.deepEqual(merged.days, {});
  assert.deepEqual(merged.reviews, {});
  assert.deepEqual(merged.cohorts, []);

  const nested = mergeProgress({
    studyStartDate: '2026-02-30',
    cohorts: [{
      id: 'legacy', learnedDate: '2026-02-30', extra: [['nested']],
      attempts: [{ id: 'a', extra: [['nested']], results: [{ wordId: 'w', extra: [['nested']] }] }],
    }],
    days: { '2026-01-01': { extra: [['nested']], wordIds: ['w'] } },
    reviews: { w: { learnedDate: '2026-01-01', extra: [['nested']], completedIntervals: [1] } },
  }, {});
  assert.equal('studyStartDate' in nested, false);
  assert.equal('learnedDate' in nested.cohorts[0], false);
  assert.deepEqual(nested.cohorts[0].extra, []);
  assert.deepEqual(nested.cohorts[0].attempts[0].extra, []);
  assert.deepEqual(nested.cohorts[0].attempts[0].results[0].extra, []);
  assert.deepEqual(nested.days['2026-01-01'].extra, []);
  assert.deepEqual(nested.reviews.w.extra, []);
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

test('malformed fields on the same attempt are sanitized before deterministic comparison', () => {
  const attempt = (extra) => ({
    id: 'same-attempt',
    completed: false,
    completedAt: '',
    wordIds: ['w'],
    results: [],
    extra,
  });
  const left = { days: { '2026-09-12': { recallAttempts: [attempt([])] } } };
  const right = { days: { '2026-09-12': { recallAttempts: [attempt([[{}], true])] } } };

  const forward = mergeProgress(left, right);
  const reverse = mergeProgress(right, left);

  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.days['2026-09-12'].recallAttempts[0].extra, [true]);
});

test('malformed attempt identifiers are discarded without breaking commutativity', () => {
  const attempt = (marker) => ({ id: { x: 1 }, marker });
  const left = { days: { '2026-09-12': { recallAttempts: [attempt('A')] } } };
  const right = { days: { '2026-09-12': { recallAttempts: [attempt('B')] } } };

  const forward = mergeProgress(left, right);
  const reverse = mergeProgress(right, left);

  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.days['2026-09-12'].recallAttempts, []);
});

test('duplicate same-ID attempts merge associatively after sanitization', () => {
  const malformed = {
    id: 'b',
    wordIds: [['bad']],
    results: [{ wordId: 'w', correct: false, extra: [[1]] }],
  };
  const completed = { id: 'b', completed: true, extra: [true], wordIds: ['x'], results: [] };
  const left = { days: { '2026-09-12': { recallAttempts: [malformed, malformed] } } };
  const right = { days: { '2026-09-12': { recallAttempts: [completed] } } };

  const forward = mergeProgress(left, right);
  const reverse = mergeProgress(right, left);

  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.days['2026-09-12'].recallAttempts[0].extra, [true]);
});

test('invalid-date reviews cannot influence valid review metadata across merge grouping', () => {
  const valid = { reviews: { w: { learnedDate: '2026-01-02', completedIntervals: [1], extra: 'valid' } } };
  const invalidA = { reviews: { w: { learnedDate: '2026-02-30', completedIntervals: [3], extra: 16 } } };
  const invalidB = { reviews: { w: { learnedDate: 'bad', completedIntervals: [7], extra: 'x' } } };

  const leftGrouped = mergeProgress(mergeProgress(valid, invalidA), invalidB);
  const rightGrouped = mergeProgress(valid, mergeProgress(invalidA, invalidB));

  assert.deepEqual(leftGrouped, rightGrouped);
  assert.deepEqual(leftGrouped.reviews.w, { learnedDate: '2026-01-02', completedIntervals: [1], extra: 'valid' });
});

test('all progress fields are sanitized before comparisons across reset grouping', () => {
  const day = (extra) => ({ resetAt: 2, days: { '2026-01-02': { extra } } });
  const a = day([[{}], true]);
  const older = { resetAt: 0 };
  const c = day([]);

  const leftGrouped = mergeProgress(mergeProgress(a, older), c);
  const rightGrouped = mergeProgress(a, mergeProgress(older, c));

  assert.deepEqual(leftGrouped, rightGrouped);
  assert.deepEqual(leftGrouped.days['2026-01-02'].extra, [true]);
});

test('malformed attempt timestamps cannot influence merge direction', () => {
  const a = { id: 'x', completed: '2026-01-02T00:00:00Z', startedAt: [[]], completedAt: { x: 1 }, finishedAt: { x: 1 }, results: [{ wordId: 'w', correct: false }] };
  const b = { id: 'x', completed: '', startedAt: { x: 1 }, completedAt: {}, finishedAt: 0, results: [{ wordId: 'w', correct: true }] };
  const wrap = (attempt) => ({ days: { '2026-01-01': { recallAttempts: [attempt] } } });

  const forward = mergeProgress(wrap(a), wrap(b));
  const reverse = mergeProgress(wrap(b), wrap(a));

  assert.deepEqual(forward, reverse);
  const merged = forward.days['2026-01-01'].recallAttempts[0];
  assert.equal(merged.startedAt, undefined);
  assert.equal(merged.completedAt, undefined);
  assert.equal(merged.finishedAt, undefined);
  assert.equal(merged.results[0].correct, true);
});

test('attempt alias chains keep a stable canonical key across repeated merges', () => {
  const source = {
    days: {
      '2026-01-01': {
        recallAttempts: [
          { id: null, attemptId: 'a' },
          { id: 'a', attemptId: 'b' },
          { id: 'b', attemptId: 'b' },
        ],
      },
    },
  };
  const empty = {};

  const leftGrouped = mergeProgress(mergeProgress(source, empty), empty);
  const rightGrouped = mergeProgress(source, mergeProgress(empty, empty));

  assert.deepEqual(leftGrouped, rightGrouped);
  assert.deepEqual(leftGrouped.days['2026-01-01'].recallAttempts.map(({ id }) => id), ['a', 'b']);
  assert.equal(leftGrouped.days['2026-01-01'].recallAttempts.some(({ attemptId }) => attemptId !== undefined), false);
});

test('singleton attempts receive the same timestamp canonicalization as merged attempts', () => {
  const source = {
    days: {
      '2026-01-01': {
        recallAttempts: [{ id: 'same', startedAt: { bad: 1 }, completedAt: [], finishedAt: 0 }],
      },
    },
  };

  const merged = mergeProgress(source, {});
  const attempt = merged.days['2026-01-01'].recallAttempts[0];
  assert.equal(attempt.startedAt, undefined);
  assert.equal(attempt.completedAt, undefined);
  assert.equal(attempt.finishedAt, undefined);
});

test('legacy cohort merge resolves schema, metadata, and partial keys deterministically', () => {
  const left = {
    schemaVersion: 1,
    cohorts: [{ id: 'same', level: 'N4', wordIds: ['a'] }],
    days: { '2026-09-12': { date: 'wrong-left', note: 'z', wordIds: ['a'] } },
    reviews: { a: { learnedDate: '2026-09-12', strength: 'z' } },
  };
  const right = {
    schemaVersion: 2,
    cohorts: [{ id: 'same', learnedDate: '2026-09-12', level: 'N5', wordIds: ['b'] }],
    days: { '2026-09-12': { date: 'wrong-right', note: 'a', wordIds: ['b'] } },
    reviews: { a: { learnedDate: '2026-09-12', strength: 'a' } },
  };
  const forward = mergeProgress(left, right);
  const reverse = mergeProgress(right, left);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.schemaVersion, 2);
  assert.equal(forward.cohorts.length, 1);
  assert.equal(forward.cohorts[0].learnedDate, '2026-09-12');
  assert.deepEqual(forward.cohorts[0].wordIds, ['a', 'b']);
  assert.equal(forward.days['2026-09-12'].date, '2026-09-12');
});

test('legacy cohort merge chooses a deterministic ID regardless of device order', () => {
  const left = { cohorts: [{ id: 'z-device', learnedDate: '2026-09-12', wordIds: ['b'] }] };
  const right = { cohorts: [{ id: 'a-device', learnedDate: '2026-09-12', wordIds: ['a'] }] };
  const leftRight = mergeProgress(left, right);
  const rightLeft = mergeProgress(right, left);
  assert.deepEqual(leftRight, rightLeft);
  assert.equal(leftRight.cohorts[0].id, 'a-device');
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

test('sign-up credential selects its UID before a delayed auth observer so claim reaches cloud', async () => {
  let observer;
  const auth = {
    onAuthStateChanged(callback) { observer = callback; return () => {}; },
    async createUser() { return { user: { uid: 'new-user' } }; },
    async signIn() { return { user: { uid: 'new-user' } }; },
    async signOut() {},
  };
  let writtenUid;
  let remote = {};
  const cloud = {
    async runTransaction(uid, update) { writtenUid = uid; remote = update(remote); return remote; },
    subscribe: () => () => {},
  };
  const storage = memoryStorage({ [anonymousStorageKey]: JSON.stringify({ nextIndex: 7, days: {} }) });
  const sync = createCloudSync({ auth, cloud, storage, applyState: () => {} });
  const starting = sync.start();
  observer(null);
  await starting;

  await sync.signUp('mother1', '123456');
  await sync.save({ nextIndex: 7, days: {} });
  await sync.whenIdle();

  assert.equal(sync.currentUid, 'new-user');
  assert.equal(writtenUid, 'new-user');
  assert.equal(remote.nextIndex, 7);
  sync.stop();
});

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
  assert.match(worker, /kotoba-no-ki-v3/);
  for (const asset of ['./index.html', './app.mjs', './src/core.mjs', './src/cloud-sync.mjs', './styles.css', './data/words.json', './data/katakana.json']) {
    assert.ok(worker.includes(asset), `service worker must cache ${asset}`);
  }
  assert.match(worker, /Promise\.all/);
  assert.match(worker, /caches\.delete\(CACHE_NAME\)/);
  assert.doesNotMatch(worker, /firebase-config\.mjs['"]/i, 'optional config must not make precache installation fail');
  assert.match(rules, /request\.auth\.uid == userId/);
  assert.match(rules, /progress\/\{documentId\}/);
  assert.doesNotMatch(rules, /resetAt[^\n]+timestamp/);
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
