const ACCOUNT_ID_PATTERN = /^[a-z0-9_]{4,20}$/;
const PIN_PATTERN = /^\d{6}$/;
const DEFAULT_EMAIL_DOMAIN = 'accounts.kotoba-no-ki.invalid';
const STORAGE_PREFIX = 'kotoba-no-ki:progress';

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const finiteNumber = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const unique = (values = []) => [...new Set(Array.isArray(values) ? values : [])];
const stableStringify = (value) => JSON.stringify(value, (_, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
});

export function normalizeAccountId(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(normalized)) {
    throw new TypeError('아이디는 영문 소문자, 숫자, 밑줄로 된 4–20자여야 합니다.');
  }
  return normalized;
}

export function accountEmail(accountId, domain = DEFAULT_EMAIL_DOMAIN) {
  const safeDomain = String(domain).trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(safeDomain) || !safeDomain.includes('.')) {
    throw new TypeError('계정 이메일 도메인이 올바르지 않습니다.');
  }
  return `${normalizeAccountId(accountId)}@${safeDomain}`;
}

export function validatePin(value) {
  const pin = String(value ?? '');
  if (!PIN_PATTERN.test(pin)) throw new TypeError('PIN은 정확히 6자리 숫자여야 합니다.');
  return pin;
}

export function storageKeyForUid(uid) {
  if (typeof uid !== 'string' || uid.length === 0) throw new TypeError('UID가 필요합니다.');
  return `${STORAGE_PREFIX}:user:${encodeURIComponent(uid)}`;
}

export const anonymousStorageKey = `${STORAGE_PREFIX}:anonymous`;

function chooseRevisioned(left, right) {
  if (left === undefined) return clone(right);
  if (right === undefined) return clone(left);
  const leftRevision = finiteNumber(left?.revision, 0);
  const rightRevision = finiteNumber(right?.revision, 0);
  if (leftRevision !== rightRevision) return clone(leftRevision > rightRevision ? left : right);
  // Deterministic tie-break preserves commutativity without trusting client clocks.
  return clone(stableStringify(left) >= stableStringify(right) ? left : right);
}

function chooseDiagnostic(left, right) {
  if (left === undefined) return clone(right);
  if (right === undefined) return clone(left);
  if (Boolean(left?.completed) !== Boolean(right?.completed)) return clone(left?.completed ? left : right);
  const leftTime = String(left?.completedAt || left?.updatedAt || '');
  const rightTime = String(right?.completedAt || right?.updatedAt || '');
  if (leftTime !== rightTime) return clone(leftTime > rightTime ? left : right);
  return clone(stableStringify(left) >= stableStringify(right) ? left : right);
}

function cohortKey(cohort, index) {
  return cohort?.learnedDate || cohort?.id || `unknown:${index}`;
}

function mergeAttempt(left, right) {
  if (!left) return clone(right);
  if (!right) return clone(left);
  const leftTime = String(left.completedAt || left.finishedAt || left.updatedAt || '');
  const rightTime = String(right.completedAt || right.finishedAt || right.updatedAt || '');
  const preferred = leftTime === rightTime
    ? (stableStringify(left) >= stableStringify(right) ? left : right)
    : (leftTime > rightTime ? left : right);
  const result = { ...clone(preferred), completed: Boolean(left.completed || right.completed) };
  const starts = [left.startedAt, right.startedAt].filter(Boolean).sort();
  const finishes = [left.completedAt || left.finishedAt, right.completedAt || right.finishedAt].filter(Boolean).sort();
  if (starts.length) result.startedAt = starts[0];
  if (finishes.length) result.completedAt = finishes.at(-1);
  result.wordIds = unique([...(left.wordIds || []), ...(right.wordIds || [])]).sort();
  const byWord = new Map();
  for (const entry of [...(left.results || []), ...(right.results || [])]) {
    if (!entry?.wordId) continue;
    const previous = byWord.get(entry.wordId);
    if (!previous || Boolean(entry.correct) > Boolean(previous.correct)
      || (Boolean(entry.correct) === Boolean(previous.correct) && stableStringify(entry) > stableStringify(previous))) {
      byWord.set(entry.wordId, clone(entry));
    }
  }
  if (byWord.size) {
    result.results = [...byWord.values()].sort((a, b) => String(a.wordId).localeCompare(String(b.wordId)));
    result.totalCount = result.results.length;
    result.correctCount = result.results.filter((entry) => entry.correct).length;
  }
  return result;
}

function mergeAttempts(left = [], right = []) {
  const attempts = new Map();
  for (const attempt of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    if (!attempt || typeof attempt !== 'object') continue;
    const key = attempt.id || attempt.attemptId;
    if (!key) continue;
    attempts.set(key, mergeAttempt(attempts.get(key), attempt));
  }
  return [...attempts.values()].sort((a, b) => String(a.id || a.attemptId).localeCompare(String(b.id || b.attemptId)));
}

function mergeCohort(left, right) {
  if (!left) return clone(right);
  if (!right) return clone(left);
  const result = { ...clone(left), ...clone(right) };
  result.id = left.id || right.id;
  result.learnedDate = left.learnedDate || right.learnedDate;
  result.wordIds = unique([...(left.wordIds || []), ...(right.wordIds || [])]).sort();
  if (left.attempts || right.attempts) result.attempts = mergeAttempts(left.attempts, right.attempts);
  for (const field of ['completed', 'mastered', 'learningCompleted', 'reviewCompleted']) {
    if (field in left || field in right) result[field] = Boolean(left[field] || right[field]);
  }
  if ('newCount' in left || 'newCount' in right) {
    result.newCount = Math.max(finiteNumber(left.newCount), finiteNumber(right.newCount), result.wordIds.length);
  }
  return result;
}

function mergeCohorts(left = [], right = []) {
  const byKey = new Map();
  [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])].forEach((cohort, index) => {
    if (!cohort || typeof cohort !== 'object') return;
    const key = cohortKey(cohort, index);
    byKey.set(key, mergeCohort(byKey.get(key), cohort));
  });
  return [...byKey.values()].sort((a, b) => String(a.learnedDate || a.id).localeCompare(String(b.learnedDate || b.id)));
}

function mergeDays(left = {}, right = {}) {
  const result = {};
  for (const date of [...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])].sort()) {
    const a = left?.[date];
    const b = right?.[date];
    if (!a) { result[date] = clone(b); continue; }
    if (!b) { result[date] = clone(a); continue; }
    result[date] = {
      ...clone(a),
      ...clone(b),
      date: a.date || b.date || date,
      wordIds: unique([...(a.wordIds || []), ...(b.wordIds || [])]).sort(),
      learned: Boolean(a.learned || b.learned),
      coverageComplete: Boolean(a.coverageComplete || b.coverageComplete),
      recallAttempts: mergeAttempts(a.recallAttempts, b.recallAttempts),
    };
  }
  return result;
}

function mergeReviews(left = {}, right = {}) {
  const result = {};
  for (const wordId of [...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])].sort()) {
    const a = left?.[wordId];
    const b = right?.[wordId];
    if (!a) { result[wordId] = clone(b); continue; }
    if (!b) { result[wordId] = clone(a); continue; }
    result[wordId] = {
      ...clone(a),
      ...clone(b),
      learnedDate: [a.learnedDate, b.learnedDate].filter(Boolean).sort()[0],
      completedIntervals: unique([...(a.completedIntervals || []), ...(b.completedIntervals || [])]).sort((x, y) => x - y),
    };
  }
  return result;
}

export function mergeProgress(left = {}, right = {}) {
  const a = left && typeof left === 'object' ? left : {};
  const b = right && typeof right === 'object' ? right : {};
  const aReset = finiteNumber(a.resetAt, 0);
  const bReset = finiteNumber(b.resetAt, 0);
  if (aReset !== bReset) return clone(aReset > bReset ? a : b);

  const result = { ...clone(a), ...clone(b), resetAt: Math.max(aReset, bReset) };
  result.nextIndex = Math.max(finiteNumber(a.nextIndex), finiteNumber(b.nextIndex));
  if (a.version !== undefined || b.version !== undefined) {
    result.version = Math.max(finiteNumber(a.version), finiteNumber(b.version));
  }
  const startDates = [a.studyStartDate, b.studyStartDate].filter(Boolean).sort();
  if (startDates.length) result.studyStartDate = startDates[0];
  if (a.cohorts || b.cohorts) result.cohorts = mergeCohorts(a.cohorts, b.cohorts);
  if (a.days || b.days) result.days = mergeDays(a.days, b.days);
  if (a.reviews || b.reviews) result.reviews = mergeReviews(a.reviews, b.reviews);
  if (a.diagnostic !== undefined || b.diagnostic !== undefined) result.diagnostic = chooseDiagnostic(a.diagnostic, b.diagnostic);
  if (a.settings !== undefined || b.settings !== undefined) {
    result.settings = chooseRevisioned(a.settings, b.settings);
  } else {
    delete result.settings;
  }
  if (a.carryWordIds || b.carryWordIds) {
    result.carryWordIds = unique([...(a.carryWordIds || []), ...(b.carryWordIds || [])]).sort();
  }
  const timestamps = [a.updatedAt, b.updatedAt].filter((value) => typeof value === 'string');
  if (timestamps.length) result.updatedAt = timestamps.sort().at(-1);
  return result;
}

function emptyProgress() {
  return { resetAt: 0, nextIndex: 0, cohorts: [] };
}

function parseStored(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return emptyProgress();
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : emptyProgress();
  } catch {
    return emptyProgress();
  }
}

/** Build the tiny adapter surface consumed by createCloudSync from Firebase's modular SDK. */
export function createFirebaseAdapters({ authSdk, firestoreSdk, authInstance, db } = {}) {
  if (!authSdk || !firestoreSdk || !authInstance || !db) {
    throw new TypeError('Firebase Auth and Firestore SDK instances are required');
  }
  const progressRef = (uid) => firestoreSdk.doc(db, 'users', uid, 'progress', 'current');
  return {
    auth: {
      onAuthStateChanged: (callback, error) => authSdk.onAuthStateChanged(authInstance, callback, error),
      createUser: (email, pin) => authSdk.createUserWithEmailAndPassword(authInstance, email, pin),
      signIn: (email, pin) => authSdk.signInWithEmailAndPassword(authInstance, email, pin),
      signOut: () => authSdk.signOut(authInstance),
    },
    cloud: {
      runTransaction: (uid, update) => firestoreSdk.runTransaction(db, async (transaction) => {
        const ref = progressRef(uid);
        const snapshot = await transaction.get(ref);
        const remote = snapshot.exists() ? snapshot.data() : {};
        const merged = update(remote);
        transaction.set(ref, merged);
        return merged;
      }),
      subscribe: (uid, callback, error) => firestoreSdk.onSnapshot(
        progressRef(uid),
        (snapshot) => {
          // Own local echoes need no re-application; the transaction path applies its committed value.
          if (!snapshot.exists() || snapshot.metadata?.hasPendingWrites) return;
          callback(snapshot.data());
        },
        error,
      ),
    },
  };
}

/**
 * Framework-neutral sync coordinator. `auth` and `cloud` are small adapters so
 * this module stays testable and the app can keep working without Firebase.
 */
export function createCloudSync({
  auth,
  cloud,
  storage = globalThis.localStorage,
  applyState = () => {},
  shouldDeferRemote = () => false,
  eventTarget = globalThis.window,
  documentTarget = globalThis.document,
  emailDomain = DEFAULT_EMAIL_DOMAIN,
  onStatus = () => {},
} = {}) {
  if (!auth?.onAuthStateChanged) throw new TypeError('auth adapter is required');
  if (!cloud?.runTransaction || !cloud?.subscribe) throw new TypeError('cloud adapter is required');
  if (!storage?.getItem || !storage?.setItem) throw new TypeError('storage adapter is required');

  let uid;
  let storageKey = anonymousStorageKey;
  let accountGeneration = 0;
  let mutationGeneration = 0;
  let pending = null;
  let deferred = null;
  let unsubscribeAuth = null;
  let unsubscribeSnapshot = null;
  let started = false;
  let stopped = false;
  let firstAuthResolved = false;
  let resolveFirstAuth;
  const firstAuthReady = new Promise((resolve) => { resolveFirstAuth = resolve; });
  const operations = new Set();
  let drainPromise = null;
  const removers = [];

  const persist = (state, key = storageKey) => {
    try {
      storage.setItem(key, JSON.stringify(state));
      return true;
    } catch (error) {
      onStatus('storage-error', error);
      return false;
    }
  };

  const track = (promise) => {
    operations.add(promise);
    promise.finally(() => operations.delete(promise));
    return promise;
  };

  const applyMerged = (incoming, generation, reason) => {
    if (stopped || generation !== accountGeneration) return null;
    const reconciled = mergeProgress(parseStored(storage, storageKey), incoming);
    persist(reconciled);
    if (shouldDeferRemote({ reason, state: clone(reconciled) })) {
      deferred = reconciled;
    } else {
      deferred = null;
      applyState(clone(reconciled), { reason, uid });
    }
    return reconciled;
  };

  const transact = async (local, generation, reason) => {
    const capturedUid = uid;
    if (!capturedUid || generation !== accountGeneration) return null;
    onStatus('syncing');
    const committed = await cloud.runTransaction(capturedUid, (remote) => mergeProgress(remote || {}, local));
    if (generation !== accountGeneration || capturedUid !== uid) return null;
    const applied = applyMerged(committed, generation, reason);
    onStatus('synced');
    return applied;
  };

  const pull = (reason = 'pull') => {
    if (!uid || stopped) return Promise.resolve(null);
    const generation = accountGeneration;
    const operation = transact(parseStored(storage, storageKey), generation, reason)
      .catch((error) => { onStatus('offline', error); return null; });
    return track(operation);
  };

  const drain = () => {
    if (drainPromise || stopped || !uid) return drainPromise || Promise.resolve();
    drainPromise = (async () => {
      while (pending && !stopped) {
        const owned = pending;
        pending = null;
        try {
          await transact(owned.state, owned.accountGeneration, 'save');
        } catch (error) {
          onStatus('offline', error);
          if (!pending) {
            pending = owned;
            break; // retain it for the next deterministic lifecycle/manual retry
          }
          // A newer pending state already exists; never replace it with the failed older state.
        }
      }
    })().finally(() => { drainPromise = null; });
    return track(drainPromise);
  };

  const save = (state) => {
    if (!state || typeof state !== 'object') return Promise.reject(new TypeError('progress state is required'));
    persist(state);
    if (!uid) return Promise.resolve(clone(state));
    pending = { state: clone(state), mutationGeneration: ++mutationGeneration, accountGeneration };
    return drain();
  };

  const installLifecycle = () => {
    const listen = (target, type, callback) => {
      if (!target?.addEventListener) return;
      target.addEventListener(type, callback);
      removers.push(() => target.removeEventListener(type, callback));
    };
    listen(eventTarget, 'online', () => { if (pending) drain(); else pull('online'); });
    listen(eventTarget, 'focus', () => pull('focus'));
    listen(documentTarget, 'visibilitychange', () => {
      if (documentTarget.visibilityState === 'visible') pull('visible');
    });
    listen(eventTarget, 'pageshow', (event) => { if (event.persisted) pull('bfcache'); });
  };

  const selectAccount = (user) => {
    const nextUid = user?.uid || null;
    const nextKey = nextUid ? storageKeyForUid(nextUid) : anonymousStorageKey;
    const changed = nextUid !== uid || nextKey !== storageKey;
    if (changed) {
      accountGeneration += 1;
      mutationGeneration = 0;
      pending = null;
      deferred = null;
      unsubscribeSnapshot?.();
      unsubscribeSnapshot = null;
      uid = nextUid;
      storageKey = nextKey;
      const selected = parseStored(storage, storageKey);
      persist(selected);
      applyState(clone(selected), { reason: 'profile', uid });
    }

    if (!firstAuthResolved) {
      firstAuthResolved = true;
      resolveFirstAuth(); // identity barrier ends before remote I/O
    }
    if (!changed || !uid || stopped) return;

    const generation = accountGeneration;
    const capturedUid = uid;
    unsubscribeSnapshot = cloud.subscribe(capturedUid, (snapshot) => {
      if (generation !== accountGeneration || capturedUid !== uid) return;
      applyMerged(snapshot, generation, 'snapshot');
    }, (error) => onStatus('offline', error));
    pull('startup');
  };

  return {
    get currentUid() { return uid; },
    get currentStorageKey() { return storageKey; },
    start() {
      if (!started) {
        started = true;
        installLifecycle();
        unsubscribeAuth = auth.onAuthStateChanged(selectAccount);
      }
      return firstAuthReady;
    },
    save,
    pull,
    retry() { return pending ? drain() : pull('retry'); },
    applyDeferred() {
      if (!deferred) return false;
      const state = deferred;
      deferred = null;
      applyState(clone(state), { reason: 'deferred', uid });
      return true;
    },
    async signUp(accountId, pin) {
      return auth.createUser(accountEmail(accountId, emailDomain), validatePin(pin));
    },
    async signIn(accountId, pin) {
      return auth.signIn(accountEmail(accountId, emailDomain), validatePin(pin));
    },
    signOut() { return auth.signOut(); },
    async whenIdle() {
      // New follow-up operations can be created while awaiting an existing one.
      while (operations.size) await Promise.allSettled([...operations]);
    },
    stop() {
      stopped = true;
      unsubscribeSnapshot?.();
      unsubscribeAuth?.();
      removers.splice(0).forEach((remove) => remove());
    },
  };
}
