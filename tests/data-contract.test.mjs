import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const loadJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('N5 and N4 vocabulary records have stable Japanese learning fields', async () => {
  const words = await loadJson('../data/words.json');
  assert.ok(words.length >= 100, 'the first usable release needs at least 100 words');
  assert.ok(words.some((word) => word.level === 'N5'));
  assert.ok(words.some((word) => word.level === 'N4'));

  const ids = new Set();
  for (const word of words) {
    assert.match(word.id, /^j-(n5|n4)-\d{4}$/);
    assert.ok(!ids.has(word.id), `duplicate id: ${word.id}`);
    ids.add(word.id);
    assert.ok(['N5', 'N4'].includes(word.level));
    assert.ok(word.written.trim());
    assert.ok(word.reading.trim());
    assert.ok(word.meaningKo.trim());
    assert.ok(word.partOfSpeech.trim());
    assert.ok(Array.isArray(word.acceptedAnswers) && word.acceptedAnswers.length > 0);
    assert.ok(word.example?.japanese?.trim());
    assert.ok(word.example?.reading?.trim());
    assert.ok(word.example?.korean?.trim());
  }
});

test('placement diagnostic has exactly 30 balanced questions', async () => {
  const questions = await loadJson('../data/diagnostic.json');
  assert.equal(questions.length, 30);
  const expected = { vocabulary: 8, reading: 5, particle: 6, conjugation: 6, sentence: 5 };
  const actual = Object.fromEntries(Object.keys(expected).map((skill) => [
    skill,
    questions.filter((question) => question.skill === skill).length,
  ]));
  assert.deepEqual(actual, expected);

  const ids = new Set();
  for (const question of questions) {
    assert.ok(!ids.has(question.id), `duplicate id: ${question.id}`);
    ids.add(question.id);
    assert.equal(typeof question.prompt, 'string');
    assert.ok(question.prompt.trim());
    assert.equal(question.level, 'N5');
    assert.ok(['choice', 'typing', 'ordering'].includes(question.responseMode));
    assert.ok(question.answer !== undefined);
    assert.ok(question.explanationKo.trim());
  }
  const katakanaReading = questions.find(({ id }) => id === 'diag-reading-04');
  assert.equal(katakanaReading.responseMode, 'typing');
  assert.equal(katakanaReading.answer, 'ほてる');
  const katakanaWriting = questions.find(({ id }) => id === 'diag-reading-05');
  assert.equal(katakanaWriting.answer, 'アルバイト');
  assert.ok(katakanaWriting.choices.every((choice) => /[ァ-ヶー]/u.test(choice)));
});

test('katakana supplement covers long vowels, small tsu, contracted sounds, and lookalikes', async () => {
  const questions = await loadJson('../data/katakana.json');
  assert.ok(questions.length >= 12);
  const subskills = new Set(questions.map((question) => question.subskill));
  for (const required of ['long-vowel', 'small-tsu', 'contracted-sound', 'lookalike-shi-tsu', 'lookalike-so-n']) {
    assert.ok(subskills.has(required), `missing katakana subskill: ${required}`);
  }
  assert.ok(questions.some((question) => question.responseMode === 'typing'));
  for (const question of questions) {
    assert.equal(question.skill, 'reading');
    assert.ok(question.prompt?.trim());
    assert.ok(!question.prompt.includes('뜻'), `${question.id} must test reading rather than meaning recall`);
    assert.ok(question.answer !== undefined);
    assert.ok(question.explanationKo?.trim());
  }
});

test('ordering diagnostic explicitly asks for the canonical neutral order', async () => {
  const questions = await loadJson('../data/diagnostic.json');
  for (const question of questions.filter(({ responseMode }) => responseMode === 'ordering')) {
    assert.match(question.prompt, /기본적인 중립 어순/);
  }
});

test('curated Japanese records preserve script and beginner-natural labels', async () => {
  const words = Object.fromEntries((await loadJson('../data/words.json')).map((word) => [word.id, word]));
  assert.match(words['j-n5-0008'].example.reading, /トイレ/);
  assert.match(words['j-n5-0029'].example.reading, /パン/);
  assert.match(words['j-n5-0046'].example.reading, /ホテル/);
  assert.match(words['j-n4-0005'].example.reading, /パン/);
  assert.equal(words['j-n5-0038'].written, 'いる');
  assert.deepEqual(words['j-n5-0038'].acceptedAnswers, ['いる', '居る']);
  assert.equal(words['j-n4-0024'].partOfSpeech, '명사·する동사·형용동사');
  assert.equal(words['j-n4-0025'].partOfSpeech, '명사·する동사·형용동사');
  assert.equal(words['j-n4-0029'].partOfSpeech, '명사·する동사');
  assert.equal(words['j-n4-0030'].partOfSpeech, '명사·する동사');
  assert.equal(words['j-n4-0033'].example.japanese, '電車が10分遅れています。');
  assert.equal(words['j-n4-0033'].example.korean, '전철이 10분 지연되고 있습니다.');
  assert.equal(words['j-n5-0040'].example.korean, '이 말의 뜻을 이해합니다.');
});

test('katakana lookalike explanations describe the real stroke orientation', async () => {
  const questions = Object.fromEntries((await loadJson('../data/katakana.json')).map((question) => [question.id, question]));
  assert.match(questions['kata-lookalike-01'].explanationKo, /위아래/);
  assert.match(questions['kata-lookalike-02'].explanationKo, /좌우/);
});
