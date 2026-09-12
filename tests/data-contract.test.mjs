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
    assert.ok(question.prompt.trim());
    assert.ok(['choice', 'typing', 'ordering'].includes(question.responseMode));
    assert.ok(question.answer !== undefined);
    assert.ok(question.explanationKo.trim());
  }
});
