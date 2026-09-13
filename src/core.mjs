export const STORAGE_KEY = 'kotoba-no-ki:progress:anonymous';
const LEGACY_STORAGE_KEY = 'kotoba-no-ki-progress-v1';
export const REVIEW_INTERVALS = Object.freeze([1, 3, 7, 14, 30, 60]);

export function normalizeAnswer(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase()
    .replace(/\s+/gu, '')
    .replace(/[。、！？!?.,]/gu, '');
}

export function isAcceptedAnswer(word, answer) {
  const candidate = normalizeAnswer(answer);
  const accepted = new Set([word?.written, word?.reading, ...(word?.acceptedAnswers ?? [])].map(normalizeAnswer));
  return candidate.length > 0 && accepted.has(candidate);
}

function answersEqual(expected, actual) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((item, index) => normalizeAnswer(item) === normalizeAnswer(actual[index]));
  }
  return normalizeAnswer(expected) === normalizeAnswer(actual);
}

export function scoreDiagnostic(questions, responses) {
  const skills = {};
  let correct = 0;
  for (const question of questions) {
    const skill = skills[question.skill] ?? { correct: 0, total: 0, accuracy: 0 };
    skill.total += 1;
    if (answersEqual(question.answer, responses?.[question.id])) {
      skill.correct += 1;
      correct += 1;
    }
    skills[question.skill] = skill;
  }
  for (const skill of Object.values(skills)) skill.accuracy = skill.total ? skill.correct / skill.total : 0;
  return {
    correct,
    total: questions.length,
    accuracy: questions.length ? correct / questions.length : 0,
    skills,
    weakSkills: Object.entries(skills).filter(([, value]) => value.accuracy < 0.7).map(([name]) => name),
  };
}

export function createInitialProgress() {
  return {
    version: 1,
    studyStartDate: null,
    diagnostic: null,
    days: {},
    reviews: {},
  };
}

export function assignDailyWords(progress, words, date, count = 10) {
  if (progress.days[date]) return progress.days[date];
  const unfinished = Object.values(progress.days)
    .filter((day) => Array.isArray(day?.wordIds) && day.wordIds.length > 0 && !day.coverageComplete)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  if (unfinished) return unfinished;
  const assigned = new Set(Object.values(progress.days).flatMap((day) => Array.isArray(day?.wordIds) ? day.wordIds : []));
  const n5 = words.filter((word) => word.level === 'N5' && !assigned.has(word.id));
  const level = n5.length ? 'N5' : 'N4';
  const wordIds = (level === 'N5' ? n5 : words.filter((word) => word.level === 'N4' && !assigned.has(word.id)))
    .slice(0, count)
    .map((word) => word.id);
  const cohort = {
    date,
    level,
    wordIds,
    learned: false,
    coverageComplete: false,
    recallAttempts: [],
  };
  progress.days[date] = cohort;
  progress.studyStartDate ??= date;
  return cohort;
}

function correctlyCovered(day) {
  return new Set((day.recallAttempts ?? []).filter((attempt) => attempt.completed).flatMap((attempt) =>
    attempt.results.filter((result) => result.correct).map((result) => result.wordId)));
}

export function getRecallQueue(day) {
  const covered = correctlyCovered(day);
  return (day.wordIds ?? []).filter((id) => !covered.has(id));
}

export function recordRecallAttempt(progress, date, results, completedAt = new Date().toISOString()) {
  const day = progress.days[date];
  if (!day) throw new Error(`학습 기록을 찾을 수 없습니다: ${date}`);
  day.recallAttempts ??= [];
  const attempt = {
    id: `${date}-${day.recallAttempts.length + 1}`,
    number: day.recallAttempts.filter((entry) => entry.completed).length + 1,
    startedAt: completedAt,
    completedAt,
    completed: true,
    wordIds: results.map((result) => result.wordId),
    totalCount: results.length,
    correctCount: results.filter((result) => result.correct).length,
    results: results.map((result) => ({ ...result, answeredAt: result.answeredAt ?? completedAt })),
  };
  day.recallAttempts.push(attempt);
  day.coverageComplete = getRecallQueue(day).length === 0;
  return attempt;
}

function addUtcDays(dateString, days) {
  if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;
  const date = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateString) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function scheduleReviews(progress, wordIds, learnedDate) {
  for (const wordId of wordIds) {
    progress.reviews[wordId] ??= { learnedDate, completedIntervals: [] };
  }
  return progress.reviews;
}

export function getDueWordIds(progress, today) {
  return Object.entries(progress.reviews).filter(([, review]) => REVIEW_INTERVALS.some((interval) => {
    const dueDate = addUtcDays(review.learnedDate, interval);
    return dueDate && !review.completedIntervals?.includes(interval) && dueDate <= today;
  })).map(([wordId]) => wordId);
}

export function completeDueReview(progress, wordId, today) {
  const review = progress.reviews[wordId];
  if (!review) return false;
  review.completedIntervals ??= [];
  const interval = REVIEW_INTERVALS.find((days) => {
    const dueDate = addUtcDays(review.learnedDate, days);
    return dueDate && !review.completedIntervals.includes(days) && dueDate <= today;
  });
  if (interval === undefined) return false;
  review.completedIntervals.push(interval);
  return true;
}

export function buildMonthGrid(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells = Array(42).fill(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    cells[first.getUTCDay() + day - 1] = { day, date };
  }
  return cells;
}

export function getDayStatus(progress, date, today, studyStartDate = progress.studyStartDate) {
  if (studyStartDate && date < studyStartDate) return 'inactive';
  if (date > today) return 'future';
  const day = progress.days?.[date];
  if (!day) return date < today ? 'missed' : 'today';
  if (day.coverageComplete) return 'mastered';
  if (day.learned || day.wordIds?.length) return 'studied';
  return 'missed';
}

export function createOptionalPractice(questions, skills = ['particle', 'conjugation']) {
  const allowed = new Set(skills);
  return questions.filter((question) => allowed.has(question.skill)).map((question) => structuredClone(question));
}

function parseProgress(raw) {
  try {
    if (raw === null || raw === undefined) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.days && parsed.reviews ? parsed : null;
  } catch {
    return null;
  }
}

function hasLearningProgress(progress) {
  return Boolean(progress?.diagnostic?.completed || Object.keys(progress?.days ?? {}).length || Object.keys(progress?.reviews ?? {}).length);
}

export function loadProgress(storage = globalThis.localStorage) {
  try {
    const current = parseProgress(storage?.getItem?.(STORAGE_KEY));
    const legacy = parseProgress(storage?.getItem?.(LEGACY_STORAGE_KEY));
    if (legacy && (!current || (!hasLearningProgress(current) && hasLearningProgress(legacy)))) return legacy;
    return current ?? legacy ?? createInitialProgress();
  } catch {
    return createInitialProgress();
  }
}

export function saveProgress(storage = globalThis.localStorage, progress) {
  storage?.setItem?.(STORAGE_KEY, JSON.stringify(progress));
  storage?.removeItem?.(LEGACY_STORAGE_KEY);
  return progress;
}
