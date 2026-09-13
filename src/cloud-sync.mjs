const ACCOUNT_ID_PATTERN = /^[a-z0-9_]{4,20}$/;
const PIN_PATTERN = /^\d{6}$/;
const DEFAULT_EMAIL_DOMAIN = 'accounts.kotoba-no-ki.invalid';
const STORAGE_PREFIX = 'kotoba-no-ki:progress';
const ROOT_PROGRESS_KEYS = new Set([
  'version', 'schemaVersion', 'resetAt', 'updatedAt', 'studyStartDate',
  'diagnostic', 'days', 'reviews', 'nextIndex', 'cohorts', 'settings', 'carryWordIds',
]);

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const finiteNumber = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const nonNegativeInteger = (value, fallback = 0) => Number.isInteger(value) && value >= 0 ? value : fallback;
const unique = (values = []) => [...new Set(Array.isArray(values) ? values : [])];
const asRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isValidDateString = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

function sanitizeFirestoreValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (Array.isArray(item)) return [];
      const sanitized = sanitizeFirestoreValue(item);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const sanitized = sanitizeFirestoreValue(item);
      return sanitized === undefined ? [] : [[key, sanitized]];
    }));
  }
  return undefined;
}
const stableStringify = (value) => JSON.stringify(value, (_, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
});

function mergeFieldsDeterministically(left = {}, right = {}) {
  const result = {};
  const keys = [...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])].sort();
  for (const key of keys) {
    const hasLeft = Object.prototype.hasOwnProperty.call(left, key);
    const hasRight = Object.prototype.hasOwnProperty.call(right, key);
    let selected;
    if (!hasLeft) selected = right[key];
    else if (!hasRight) selected = left[key];
    else selected = stableStringify(left[key]) >= stableStringify(right[key]) ? left[key] : right[key];
    const sanitized = sanitizeFirestoreValue(selected);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

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

function attemptKey(attempt) {
  if (typeof attempt?.id === 'string' && attempt.id) return attempt.id;
  if (typeof attempt?.attemptId === 'string' && attempt.attemptId) return attempt.attemptId;
  return '';
}

function mergeAttempt(left, right, key = '') {
  left = asRecord(sanitizeFirestoreValue(left));
  right = asRecord(sanitizeFirestoreValue(right));
  const canonicalKey = key || attemptKey(left) || attemptKey(right);
  if (!canonicalKey) return undefined;
  const result = mergeFieldsDeterministically(left, right);
  result.id = canonicalKey;
  delete result.attemptId;
  result.completed = Boolean(left.completed || right.completed);
  const isTimestamp = (value) => typeof value === 'string' && value.length > 0;
  const starts = [left.startedAt, right.startedAt].filter(isTimestamp).sort();
  const finishes = [left.completedAt, left.finishedAt, right.completedAt, right.finishedAt]
    .filter(isTimestamp)
    .sort();
  delete result.startedAt;
  delete result.completedAt;
  delete result.finishedAt;
  if (starts.length) result.startedAt = starts[0];
  if (finishes.length) result.completedAt = finishes.at(-1);
  result.wordIds = unique([
    ...(Array.isArray(left.wordIds) ? left.wordIds : []),
    ...(Array.isArray(right.wordIds) ? right.wordIds : []),
  ]).filter((value) => typeof value === 'string').sort();
  const byWord = new Map();
  const hadResults = left.results !== undefined || right.results !== undefined;
  for (const entry of [...(Array.isArray(left.results) ? left.results : []), ...(Array.isArray(right.results) ? right.results : [])]) {
    if (!isRecord(entry) || typeof entry.wordId !== 'string' || !entry.wordId) continue;
    const previous = byWord.get(entry.wordId);
    if (!previous || Boolean(entry.correct) > Boolean(previous.correct)
      || (Boolean(entry.correct) === Boolean(previous.correct) && stableStringify(entry) > stableStringify(previous))) {
      byWord.set(entry.wordId, sanitizeFirestoreValue(entry));
    }
  }
  delete result.results;
  delete result.totalCount;
  delete result.correctCount;
  if (hadResults) {
    result.results = [...byWord.values()].sort((a, b) => String(a.wordId).localeCompare(String(b.wordId)));
    result.totalCount = result.results.length;
    result.correctCount = result.results.filter((entry) => entry.correct).length;
  }
  return result;
}

function mergeAttempts(left = [], right = []) {
  const attempts = new Map();
  for (const attempt of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    if (!isRecord(attempt)) continue;
    const sanitized = asRecord(sanitizeFirestoreValue(attempt));
    const key = attemptKey(sanitized);
    if (!key) continue;
    attempts.set(key, mergeAttempt(attempts.get(key), sanitized, key));
  }
  return [...attempts.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const cohortIds = (cohort) => unique([cohort?.id, ...(Array.isArray(cohort?.legacyIds) ? cohort.legacyIds : [])])
  .filter((value) => typeof value === 'string' && value).sort();
const cohortDates = (cohort) => unique([cohort?.learnedDate, ...(Array.isArray(cohort?.legacyDates) ? cohort.legacyDates : [])])
  .filter(isValidDateString).sort();

function mergeCohort(left, right) {
  left = asRecord(left);
  right = asRecord(right);
  const result = mergeFieldsDeterministically(left, right);
  const ids = unique([...cohortIds(left), ...cohortIds(right)]).sort();
  const learnedDates = unique([...cohortDates(left), ...cohortDates(right)]).sort();
  if (ids.length) result.id = ids[0];
  else delete result.id;
  if (ids.length > 1) result.legacyIds = ids;
  else delete result.legacyIds;
  if (learnedDates.length) result.learnedDate = learnedDates[0];
  else delete result.learnedDate;
  if (learnedDates.length > 1) result.legacyDates = learnedDates;
  else delete result.legacyDates;
  result.wordIds = unique([
    ...(Array.isArray(left.wordIds) ? left.wordIds : []),
    ...(Array.isArray(right.wordIds) ? right.wordIds : []),
  ]).filter((value) => typeof value === 'string').sort();
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
  const merged = [];
  const source = [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]
    .filter(isRecord)
    .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  const matches = (a, b) => Boolean(
    cohortIds(a).some((id) => cohortIds(b).includes(id))
    || cohortDates(a).some((date) => cohortDates(b).includes(date))
    || (!a.id && !b.id && !a.learnedDate && !b.learnedDate && stableStringify(a) === stableStringify(b))
  );
  for (const cohort of source) {
    let candidate = mergeCohort(cohort, {});
    let matchIndex = merged.findIndex((existing) => matches(existing, candidate));
    while (matchIndex >= 0) {
      candidate = mergeCohort(merged.splice(matchIndex, 1)[0], candidate);
      matchIndex = merged.findIndex((existing) => matches(existing, candidate));
    }
    merged.push(candidate);
  }
  return merged.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function mergeDays(left = {}, right = {}) {
  left = asRecord(left);
  right = asRecord(right);
  const result = {};
  for (const date of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    if (!isValidDateString(date)) continue;
    const leftDay = left[date];
    const rightDay = right[date];
    if (!isRecord(leftDay) && !isRecord(rightDay)) continue;
    const a = asRecord(leftDay);
    const b = asRecord(rightDay);
    result[date] = {
      ...mergeFieldsDeterministically(a, b),
      date,
      wordIds: unique([
        ...(Array.isArray(a.wordIds) ? a.wordIds : []),
        ...(Array.isArray(b.wordIds) ? b.wordIds : []),
      ]).filter((value) => typeof value === 'string').sort(),
      learned: Boolean(a.learned || b.learned),
      coverageComplete: Boolean(a.coverageComplete || b.coverageComplete),
      recallAttempts: mergeAttempts(a.recallAttempts, b.recallAttempts),
    };
  }
  return result;
}

function mergeReviews(left = {}, right = {}) {
  left = asRecord(left);
  right = asRecord(right);
  const result = {};
  for (const wordId of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const leftReview = left[wordId];
    const rightReview = right[wordId];
    if (!isRecord(leftReview) && !isRecord(rightReview)) continue;
    const a = isRecord(leftReview) && isValidDateString(leftReview.learnedDate) ? leftReview : {};
    const b = isRecord(rightReview) && isValidDateString(rightReview.learnedDate) ? rightReview : {};
    const learnedDates = [a.learnedDate, b.learnedDate].filter(isValidDateString).sort();
    if (!learnedDates.length) continue;
    result[wordId] = {
      ...mergeFieldsDeterministically(a, b),
      learnedDate: learnedDates[0],
      completedIntervals: unique([
        ...(Array.isArray(a.completedIntervals) ? a.completedIntervals : []),
        ...(Array.isArray(b.completedIntervals) ? b.completedIntervals : []),
      ]).filter(Number.isFinite).sort((x, y) => x - y),
    };
  }
  return result;
}

export function mergeProgress(left = {}, right = {}) {
  let a = asRecord(sanitizeFirestoreValue(left));
  let b = asRecord(sanitizeFirestoreValue(right));
  const aReset = nonNegativeInteger(a.resetAt, 0);
  const bReset = nonNegativeInteger(b.resetAt, 0);
  if (aReset < bReset) a = {};
  if (bReset < aReset) b = {};

  const mergedFields = mergeFieldsDeterministically(a, b);
  const result = Object.fromEntries(Object.entries(mergedFields).filter(([key]) => ROOT_PROGRESS_KEYS.has(key)));
  result.resetAt = Math.max(aReset, bReset);
  result.nextIndex = Math.max(nonNegativeInteger(a.nextIndex), nonNegativeInteger(b.nextIndex));
  if (a.schemaVersion !== undefined || b.schemaVersion !== undefined) {
    result.schemaVersion = Math.max(nonNegativeInteger(a.schemaVersion), nonNegativeInteger(b.schemaVersion));
  }
  if (a.version !== undefined || b.version !== undefined) {
    result.version = Math.max(nonNegativeInteger(a.version), nonNegativeInteger(b.version));
  }
  const startDates = [a.studyStartDate, b.studyStartDate].filter(isValidDateString).sort();
  if (startDates.length) result.studyStartDate = startDates[0];
  else delete result.studyStartDate;
  if (a.cohorts !== undefined || b.cohorts !== undefined) result.cohorts = mergeCohorts(a.cohorts, b.cohorts);
  if (a.days !== undefined || b.days !== undefined) result.days = mergeDays(a.days, b.days);
  if (a.reviews !== undefined || b.reviews !== undefined) result.reviews = mergeReviews(a.reviews, b.reviews);
  const diagnostics = [a.diagnostic, b.diagnostic].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  if (diagnostics.length) result.diagnostic = chooseDiagnostic(diagnostics[0], diagnostics[1]);
  else delete result.diagnostic;
  const settings = [a.settings, b.settings].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  if (settings.length) {
    result.settings = chooseRevisioned(settings[0], settings[1]);
  } else {
    delete result.settings;
  }
  if (a.carryWordIds !== undefined || b.carryWordIds !== undefined) {
    result.carryWordIds = unique([
      ...(Array.isArray(a.carryWordIds) ? a.carryWordIds : []),
      ...(Array.isArray(b.carryWordIds) ? b.carryWordIds : []),
    ]).filter((value) => typeof value === 'string').sort();
  }
  const timestamps = [a.updatedAt, b.updatedAt].filter((value) => typeof value === 'string');
  if (timestamps.length) result.updatedAt = timestamps.sort().at(-1);
  else delete result.updatedAt;
  return sanitizeFirestoreValue(result);
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
      const credential = await auth.createUser(accountEmail(accountId, emailDomain), validatePin(pin));
      const credentialUser = credential?.user?.uid ? credential.user : (credential?.uid ? credential : null);
      if (credentialUser) selectAccount(credentialUser);
      return credential;
    },
    async signIn(accountId, pin) {
      const credential = await auth.signIn(accountEmail(accountId, emailDomain), validatePin(pin));
      const credentialUser = credential?.user?.uid ? credential.user : (credential?.uid ? credential : null);
      if (credentialUser) selectAccount(credentialUser);
      return credential;
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
