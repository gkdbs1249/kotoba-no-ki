import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORAGE_KEY,
  REVIEW_INTERVALS,
  normalizeAnswer,
  isAcceptedAnswer,
  scoreDiagnostic,
  createInitialProgress,
  normalizeDailyWordCount,
  assignDailyWords,
  recordRecallAttempt,
  getRecallQueue,
  scheduleReviews,
  getDueWordIds,
  buildMonthGrid,
  getDayStatus,
  isCalendarInactiveDate,
  createOptionalPractice,
  selectPracticeBatch,
  getLearnedWordIds,
  selectCumulativeReviewIds,
  loadProgress,
  saveProgress,
} from '../src/core.mjs';

const catalogWords = JSON.parse(await readFile(new URL('../data/words.json', import.meta.url), 'utf8'));

const words = Array.from({ length: 14 }, (_, index) => ({
  id: `j-n5-${String(index + 1).padStart(4, '0')}`,
  level: 'N5',
  written: index === 0 ? '学校' : `語${index + 1}`,
  reading: index === 0 ? 'がっこう' : `ご${index + 1}`,
  meaningKo: `뜻 ${index + 1}`,
  acceptedAnswers: index === 0 ? ['学校', 'がっこう'] : [`語${index + 1}`, `ご${index + 1}`],
}));

test('typed Japanese answers normalize NFKC, whitespace, and Latin case', () => {
  assert.equal(normalizeAnswer('  ＡＢＣ　 学 校  '), 'abc学校');
  assert.equal(normalizeAnswer(' がっこう。 '), 'がっこう');
  assert.equal(isAcceptedAnswer(words[0], ' がっこう '), true);
  assert.equal(isAcceptedAnswer(words[0], '学校'), true);
  assert.equal(isAcceptedAnswer(words[0], 'がこう'), false);
});

test('diagnostic scoring reports each skill and persists weak skills below 70%', () => {
  const questions = [
    { id: 'a', skill: 'reading', answer: 'あ' },
    { id: 'b', skill: 'reading', answer: 'い' },
    { id: 'c', skill: 'particle', answer: 'を' },
  ];
  const result = scoreDiagnostic(questions, { a: 'あ', b: 'x', c: 'を' });
  assert.deepEqual(result.skills.reading, { correct: 1, total: 2, accuracy: 0.5 });
  assert.deepEqual(result.skills.particle, { correct: 1, total: 1, accuracy: 1 });
  assert.deepEqual(result.weakSkills, ['reading']);
  assert.equal(result.correct, 2);
  assert.equal(result.total, 3);
});

test('daily word setting accepts 1 to 30 and defaults invalid values to ten', () => {
  assert.equal(createInitialProgress().settings.dailyWordCount, 10);
  assert.equal(normalizeDailyWordCount('1'), 1);
  assert.equal(normalizeDailyWordCount('30'), 30);
  for (const invalid of [0, 31, 1.5, '2.5', '', 'ten', null]) {
    assert.equal(normalizeDailyWordCount(invalid), 10);
  }
});

test('changing the setting never resizes an already assigned daily cohort', () => {
  const words = Array.from({ length: 12 }, (_, index) => ({ id: `w${index + 1}`, level: 'N5' }));
  const progress = createInitialProgress();
  const first = assignDailyWords(progress, words, '2026-09-22', 3);
  progress.settings.dailyWordCount = 7;
  const resumed = assignDailyWords(progress, words, '2026-09-22', progress.settings.dailyWordCount);
  assert.equal(first.wordIds.length, 3);
  assert.deepEqual(resumed.wordIds, first.wordIds);
});

test('an empty unstarted day is repaired with the configured word count', () => {
  const progress = createInitialProgress();
  progress.days['2026-09-23'] = {
    date: '2026-09-23', level: 'N5', wordIds: [], learned: false,
    learnedWordIds: [], coverageComplete: false, coveredWordIds: [], recallAttempts: [],
  };
  const repaired = assignDailyWords(progress, words, '2026-09-23', 5);
  assert.equal(repaired.wordIds.length, 5);
  assert.deepEqual(progress.days['2026-09-23'].wordIds, repaired.wordIds);
});

test('empty current day is repaired without altering a prior unfinished cohort', () => {
  const progress = createInitialProgress();
  const priorIds = words.slice(0, 3).map(({ id }) => id);
  progress.days['2026-09-22'] = {
    date: '2026-09-22', level: 'N5', wordIds: priorIds, learned: true,
    learnedWordIds: priorIds, coverageComplete: false, coveredWordIds: [priorIds[0]], recallAttempts: [],
  };
  progress.days['2026-09-23'] = {
    date: '2026-09-23', level: 'N5', wordIds: [], learned: false,
    learnedWordIds: [], coverageComplete: false, coveredWordIds: [], recallAttempts: [],
  };
  const priorSnapshot = structuredClone(progress.days['2026-09-22']);
  const repaired = assignDailyWords(progress, words, '2026-09-23', 5);
  assert.equal(repaired.date, '2026-09-23');
  assert.equal(repaired.wordIds.length, 5);
  assert.equal(repaired.wordIds.some((id) => priorIds.includes(id)), false);
  assert.deepEqual(progress.days['2026-09-22'], priorSnapshot);
});

test('empty days with out-of-order learning evidence are never overwritten', () => {
  const progress = createInitialProgress();
  const evidenceOnly = {
    date: '2026-09-23', level: 'N5', wordIds: [], learned: false,
    learnedWordIds: ['remote-word'], coverageComplete: false, coveredWordIds: [], recallAttempts: [],
  };
  progress.days['2026-09-23'] = evidenceOnly;
  const preserved = assignDailyWords(progress, words, '2026-09-23', 5);
  assert.equal(preserved, evidenceOnly);
  assert.deepEqual(progress.days['2026-09-23'].learnedWordIds, ['remote-word']);
});

test('daily assignment stores exactly ten unseen N5 words without mutating input', () => {
  const progress = createInitialProgress();
  const original = structuredClone(words);
  const cohort = assignDailyWords(progress, words, '2026-09-12');
  assert.equal(cohort.wordIds.length, 10);
  assert.deepEqual(words, original);
  assert.deepEqual(progress.days['2026-09-12'].wordIds, cohort.wordIds);
  assert.strictEqual(assignDailyWords(progress, words, '2026-09-13'), cohort, 'unfinished cohort must be resumed');
  cohort.coverageComplete = true;
  const next = assignDailyWords(progress, words, '2026-09-13');
  assert.equal(next.wordIds.length, 4);
  assert.equal(new Set([...cohort.wordIds, ...next.wordIds]).size, 14);
  assert.strictEqual(assignDailyWords(progress, words, '2026-09-12'), cohort);
});

test('a learner who completed the original 101 words receives five expanded N4 words', () => {
  const progress = createInitialProgress();
  const originalIds = catalogWords.slice(0, 101).map(({ id }) => id);
  progress.days['2026-09-24'] = {
    date: '2026-09-24', level: 'N4', wordIds: originalIds,
    learned: true, learnedWordIds: originalIds, coverageComplete: true,
    coveredWordIds: originalIds, recallAttempts: [],
  };
  const next = assignDailyWords(progress, catalogWords, '2026-09-25', 5);
  assert.equal(next.wordIds.length, 5);
  assert.equal(next.wordIds.every((id) => id.startsWith('j-n4-') && !originalIds.includes(id)), true);
});

test('N4 words unlock only after every available N5 word has been completed', () => {
  const progress = createInitialProgress();
  const mixed = [
    ...words.slice(0, 2),
    { id: 'j-n4-0001', level: 'N4', written: '経験', reading: 'けいけん', meaningKo: '경험', acceptedAnswers: ['経験', 'けいけん'] },
    { id: 'j-n4-0002', level: 'N4', written: '予約', reading: 'よやく', meaningKo: '예약', acceptedAnswers: ['予約', 'よやく'] },
  ];
  const first = assignDailyWords(progress, mixed, '2026-09-12', 10);
  assert.deepEqual(first.wordIds, mixed.slice(0, 2).map(({ id }) => id));
  assert.strictEqual(assignDailyWords(progress, mixed, '2026-09-13', 10), first);
  first.coverageComplete = true;
  const second = assignDailyWords(progress, mixed, '2026-09-13', 10);
  assert.deepEqual(second.wordIds, ['j-n4-0001', 'j-n4-0002']);
  assert.equal(second.level, 'N4');
});

test('recall queue preserves word-level coverage imported from another device', () => {
  const progress = createInitialProgress();
  progress.days['2026-09-23'] = {
    date: '2026-09-23',
    wordIds: ['w1', 'w2', 'w3'],
    learned: true,
    learnedWordIds: ['w1', 'w2', 'w3'],
    coverageComplete: false,
    coveredWordIds: ['w1'],
    recallAttempts: [],
  };
  assert.deepEqual(getRecallQueue(progress.days['2026-09-23']), ['w2', 'w3']);
  recordRecallAttempt(progress, '2026-09-23', [
    { wordId: 'w2', correct: true },
    { wordId: 'w3', correct: false },
  ], '2026-09-23T12:00:00Z');
  assert.deepEqual(progress.days['2026-09-23'].coveredWordIds, ['w1', 'w2']);
  assert.deepEqual(getRecallQueue(progress.days['2026-09-23']), ['w3']);
  assert.equal(progress.days['2026-09-23'].coverageComplete, false);
});

test('productive recall retries only uncovered words until cumulative coverage completes', () => {
  const progress = createInitialProgress();
  const day = assignDailyWords(progress, words, '2026-09-12', 3);
  const [a, b, c] = day.wordIds;
  recordRecallAttempt(progress, '2026-09-12', [
    { wordId: a, answer: 'ok', correct: true },
    { wordId: b, answer: 'no', correct: false },
    { wordId: c, answer: 'no', correct: false },
  ], '2026-09-12T10:00:00Z');
  assert.deepEqual(getRecallQueue(day), [b, c]);
  recordRecallAttempt(progress, '2026-09-12', [
    { wordId: b, answer: 'ok', correct: true },
    { wordId: c, answer: 'ok', correct: true },
  ], '2026-09-12T10:05:00Z');
  assert.deepEqual(getRecallQueue(day), []);
  assert.equal(day.coverageComplete, true);
  assert.equal(day.recallAttempts[1].number, 2);
});

test('cumulative review selects the requested number from every learned word', () => {
  const progress = createInitialProgress();
  progress.days['2026-09-20'] = {
    date: '2026-09-20', wordIds: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'],
    learned: true, learnedWordIds: [], coverageComplete: true, coveredWordIds: [], recallAttempts: [],
  };
  progress.days['2026-09-21'] = {
    date: '2026-09-21', wordIds: ['w7', 'w8', 'w9', 'w10', 'w11', 'w12'],
    learned: true, learnedWordIds: ['w7', 'w8', 'w9', 'w10', 'w11', 'w12'], coverageComplete: false, coveredWordIds: [], recallAttempts: [],
  };
  progress.days['2026-09-22'] = {
    date: '2026-09-22', wordIds: ['assigned-only'], learned: false,
    learnedWordIds: [], coverageComplete: false, coveredWordIds: [], recallAttempts: [],
  };
  progress.reviews['legacy-review'] = { learnedDate: '2026-09-19', completedIntervals: [] };
  assert.deepEqual(getLearnedWordIds(progress), [...Array.from({ length: 12 }, (_, index) => `w${index + 1}`), 'legacy-review']);
  const first = selectCumulativeReviewIds(progress, 5, [], () => 0.5);
  const second = selectCumulativeReviewIds(progress, 5, first, () => 0.5);
  assert.equal(first.length, 5);
  assert.equal(new Set(first).size, 5);
  assert.equal(second.length, 5);
  assert.equal(second.some((id) => first.includes(id)), false);
  assert.equal(first.includes('assigned-only'), false);
  assert.equal(selectCumulativeReviewIds(progress, 99).length, 13);
});

test('reviews are due at 1, 3, 7, 14, 30, and 60 days', () => {
  assert.deepEqual(REVIEW_INTERVALS, [1, 3, 7, 14, 30, 60]);
  const progress = createInitialProgress();
  scheduleReviews(progress, ['a'], '2026-01-30');
  assert.deepEqual(getDueWordIds(progress, '2026-02-02'), ['a']);
  assert.deepEqual(getDueWordIds(progress, '2026-01-31'), ['a']);
  progress.reviews.a.completedIntervals = [1, 3];
  assert.deepEqual(getDueWordIds(progress, '2026-02-02'), []);
  assert.deepEqual(getDueWordIds(progress, '2026-02-06'), ['a']);
});

test('deeply malformed review dates never trap app startup', () => {
  const progress = createInitialProgress('2026-09-01');
  progress.reviews['j-n5-0001'] = { learnedDate: {}, completedIntervals: [] };
  progress.reviews['j-n5-0002'] = { learnedDate: '2026-02-31', completedIntervals: [] };
  assert.deepEqual(getDueWordIds(progress, '2026-09-13'), []);
});

test('calendar is a conventional Sunday-first 7-column 42-cell month grid', () => {
  const grid = buildMonthGrid(2026, 8);
  assert.equal(grid.length, 42);
  assert.equal(grid[0], null);
  assert.equal(grid[1], null);
  assert.equal(grid[2].date, '2026-09-01');
  assert.equal(grid[31].date, '2026-09-30');
});

test('calendar status distinguishes future, missed, studied, and mastered days', () => {
  const progress = createInitialProgress();
  progress.days['2026-09-10'] = { wordIds: ['a'], learned: true, coverageComplete: false };
  progress.days['2026-09-11'] = { wordIds: ['b'], learned: true, coverageComplete: true };
  assert.equal(getDayStatus(progress, '2026-09-09', '2026-09-12', '2026-09-01'), 'missed');
  assert.equal(getDayStatus(progress, '2026-09-10', '2026-09-12', '2026-09-01'), 'studied');
  assert.equal(getDayStatus(progress, '2026-09-11', '2026-09-12', '2026-09-01'), 'mastered');
  assert.equal(getDayStatus(progress, '2026-09-13', '2026-09-12', '2026-09-01'), 'future');
  assert.equal(getDayStatus(progress, '2026-08-31', '2026-09-12', '2026-09-01'), 'inactive');
});

test('uzs1008 calendar excludes only the September 24–27 maintenance window', () => {
  for (const date of ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']) {
    assert.equal(isCalendarInactiveDate('uzs1008', date), true);
  }
  assert.equal(isCalendarInactiveDate('uzs1008', '2026-09-23'), false);
  assert.equal(isCalendarInactiveDate('uzs1008', '2026-09-28'), false);
  assert.equal(isCalendarInactiveDate('another_user', '2026-09-24'), false);
});

test('practice batches draw ten unique questions and avoid the immediately previous batch', () => {
  const bank = Array.from({ length: 50 }, (_, index) => ({ id: `q-${index + 1}` }));
  const original = structuredClone(bank);
  const first = selectPracticeBatch(bank, 10, [], () => 0.5);
  const second = selectPracticeBatch(bank, 10, first.map(({ id }) => id), () => 0.5);
  assert.equal(first.length, 10);
  assert.equal(second.length, 10);
  assert.equal(new Set(first.map(({ id }) => id)).size, 10);
  assert.equal(new Set(second.map(({ id }) => id)).size, 10);
  assert.equal(second.some(({ id }) => first.some((item) => item.id === id)), false);
  assert.deepEqual(bank, original);
});

test('optional particle/conjugation practice does not mutate regular progress', () => {
  const progress = createInitialProgress();
  progress.diagnostic = { weakSkills: ['particle'] };
  const before = JSON.stringify(progress);
  const questions = [
    { id: 'p', skill: 'particle' },
    { id: 'c', skill: 'conjugation' },
    { id: 'v', skill: 'vocabulary' },
  ];
  assert.deepEqual(createOptionalPractice(questions, ['particle', 'conjugation']).map((q) => q.id), ['p', 'c']);
  assert.equal(JSON.stringify(progress), before);
});

test('progress persistence tolerates missing and malformed localStorage values', () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };
  assert.deepEqual(loadProgress(storage), createInitialProgress());
  memory.set('kotoba-no-ki-progress-v1', '{bad');
  assert.deepEqual(loadProgress(storage), createInitialProgress());
  const progress = createInitialProgress();
  progress.diagnostic = { completed: true };
  saveProgress(storage, progress);
  assert.deepEqual(loadProgress(storage), progress);
});

test('legacy anonymous progress migrates to the account-safe anonymous key', () => {
  const legacyKey = 'kotoba-no-ki-progress-v1';
  const progress = createInitialProgress();
  progress.diagnostic = { completed: true };
  const memory = new Map([[legacyKey, JSON.stringify(progress)]]);
  const storage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };
  assert.deepEqual(loadProgress(storage), progress);
  saveProgress(storage, progress);
  assert.equal(memory.has(legacyKey), false);
  assert.deepEqual(JSON.parse(memory.get(STORAGE_KEY)), progress);
});
