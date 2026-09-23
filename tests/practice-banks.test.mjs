import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

function validateQuestionBank(bank, label) {
  assert.equal(bank.length, 50, `${label} must contain exactly 50 questions`);
  assert.equal(new Set(bank.map(({ id }) => id)).size, 50, `${label} IDs must be unique`);
  assert.equal(new Set(bank.map(({ prompt, answer }) => `${prompt}\u0000${answer}`)).size, 50, `${label} prompt and answer pairs must be unique`);
  for (const question of bank) {
    assert.equal(typeof question.id, 'string');
    assert.ok(question.id.length > 0);
    assert.ok(['N5', 'N4'].includes(question.level), `${question.id}: level`);
    assert.equal(typeof question.prompt, 'string');
    assert.ok(question.prompt.trim().length > 0, `${question.id}: prompt`);
    assert.equal(typeof question.answer, 'string');
    assert.ok(question.answer.trim().length > 0, `${question.id}: answer`);
    assert.equal(typeof question.explanationKo, 'string');
    assert.ok(question.explanationKo.trim().length > 0, `${question.id}: explanation`);
    assert.ok(['choice', 'typing'].includes(question.responseMode), `${question.id}: responseMode`);
    if (question.responseMode === 'choice') {
      assert.equal(question.choices.length, 4, `${question.id}: four choices`);
      assert.equal(new Set(question.choices).size, 4, `${question.id}: unique choices`);
      assert.equal(question.choices.filter((choice) => choice === question.answer).length, 1, `${question.id}: answer membership`);
    } else {
      assert.equal('choices' in question, false, `${question.id}: typing question must omit choices`);
    }
  }
}

test('weekly extra-practice bank has fifty balanced particle and conjugation questions', async () => {
  const bank = await readJson('../data/extra-practice.json');
  validateQuestionBank(bank, 'extra practice');
  const counts = Object.groupBy(bank, ({ skill }) => skill);
  assert.equal(counts.particle?.length, 25);
  assert.equal(counts.conjugation?.length, 25);
  assert.deepEqual(Object.keys(counts).sort(), ['conjugation', 'particle']);
});

test('weekly katakana bank has fifty balanced direct-reading questions', async () => {
  const bank = await readJson('../data/katakana.json');
  validateQuestionBank(bank, 'katakana');
  assert.ok(bank.every(({ skill }) => skill === 'reading'));
  const counts = Object.groupBy(bank, ({ subskill }) => subskill);
  assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([key, values]) => [key, values.length])), {
    'contracted-sound': 10,
    'daily-loanword': 10,
    'long-vowel': 10,
    'lookalike': 10,
    'small-tsu': 10,
  });
});
