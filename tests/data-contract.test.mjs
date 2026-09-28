import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

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

test('expanded N4 bank preserves the original 101 records exactly', async () => {
  const words = await loadJson('../data/words.json');
  const originalHash = createHash('sha256').update(JSON.stringify(words.slice(0, 101))).digest('hex');
  assert.equal(originalHash, '02da6c7d8bdfdf1f6d46e2bde84c616a8bd31f418806b5f525986c53bd70d8bf');
  assert.ok(words.filter(({ level }) => level === 'N4').length >= 550);
  assert.ok(words.length >= 611);
});

test('expanded N4 records are sequential, unique, readable, and source-traceable', async () => {
  const words = await loadJson('../data/words.json');
  const expanded = words.slice(101);
  assert.equal(expanded.length, 560);
  assert.equal(words.filter(({ level }) => level === 'N4').length, 600);
  const forms = new Set();
  const allWritten = new Set();
  for (const word of words) {
    assert.ok(!allWritten.has(word.written), `duplicate headword across levels: ${word.written}`);
    allWritten.add(word.written);
  }
  for (const [offset, word] of expanded.entries()) {
    assert.equal(word.id, `j-n4-${String(offset + 41).padStart(4, '0')}`);
    const key = `${word.written}\u0000${word.reading}`;
    assert.ok(!forms.has(key), `duplicate expanded form: ${word.written} / ${word.reading}`);
    forms.add(key);
    assert.ok(word.acceptedAnswers.includes(word.written));
    assert.ok(word.acceptedAnswers.includes(word.reading));
    assert.doesNotMatch(word.reading, /\//u, `${word.id} reading contains unresolved alternatives`);
    if (!word.written.endsWith('する')) assert.doesNotMatch(word.reading, /する$/u, `${word.id} noun reading contains する`);
    assert.doesNotMatch(word.example.reading, /[一-龯々]/u, `${word.id} reading still has kanji`);
    // Inflected Japanese examples need lemma-aware review; exact headword substring checks
    // reject valid forms such as 割れた and 召し上がって while accepting wrong senses.
    assert.doesNotMatch(word.meaningKo, /(?:이라는|라는|은|는)\s*(?:명사|대명사|동사|형용사|부사|감탄사|접두사|접미사|표현)$/u);
    assert.match(word.source.vocabulary, /c42fd9fa3777bfc1775446f7c418d549dfd6e4cf/);
  }
});

test('expanded N4 examples teach the listed headword sense and preserve equivalent answers', async () => {
  const words = Object.fromEntries((await loadJson('../data/words.json')).map((word) => [word.id, word]));
  const expectedExamples = {
    'j-n4-0041': ['あ、雨だ。', 'あ、あめだ。', '아, 비가 온다.'],
    'j-n4-0215': ['卵が割れた。', 'たまごがわれた。', '계란이 깨졌다.'],
    'j-n4-0230': ['学校の帰りに本屋へ寄った。', 'がっこうのかえりにほんやへよった。', '학교에서 돌아오는 길에 서점에 들렀다.'],
    'j-n4-0363': ['どうぞ召し上がってください。', 'どうぞめしあがってください。', '어서 드세요.'],
    'j-n4-0426': ['庭に草が生えている。', 'にわにくさがはえている。', '마당에 풀이 자라고 있다.'],
    'j-n4-0439': ['私が彼の代わりに行きます。', 'わたしがかれのかわりにいきます。', '제가 그를 대신해서 갑니다.'],
    'j-n4-0499': ['今日は暑い日です。', 'きょうはあついひです。', '오늘은 더운 날입니다.'],
    'j-n4-0526': ['磁石が冷蔵庫に付く。', 'じしゃくがれいぞうこにつく。', '자석이 냉장고에 붙는다.'],
    'j-n4-0578': ['遊びの時間です。', 'あそびのじかんです。', '놀이 시간입니다.'],
    'j-n4-0585': ['この踊りは簡単です。', 'このおどりはかんたんです。', '이 춤은 간단합니다.'],
    'j-n4-0590': ['旗を立てる。', 'はたをたてる。', '깃발을 세운다.'],
  };
  for (const [id, [japanese, reading, korean]] of Object.entries(expectedExamples)) {
    assert.deepEqual(words[id].example, { japanese, reading, korean }, `${id} example drifted`);
  }
  assert.ok(words['j-n4-0067'].acceptedAnswers.includes('金持ち'));
  assert.ok(words['j-n4-0293'].acceptedAnswers.includes('高等学校'));
  assert.ok(words['j-n4-0295'].acceptedAnswers.includes('高校'));
  for (const id of ['j-n4-0238', 'j-n4-0265', 'j-n4-0298', 'j-n4-0389', 'j-n4-0587']) {
    assert.ok(words[id].source.normalization?.includes('normalized'), `${id} must document source normalization`);
  }
  assert.match(words['j-n4-0389'].source.example, /Tatoeba.*normalized 真中→真ん中/);
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
  assert.equal(questions.length, 50);
  const subskills = new Set(questions.map((question) => question.subskill));
  for (const required of ['long-vowel', 'small-tsu', 'contracted-sound', 'lookalike', 'daily-loanword']) {
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
  const questions = await loadJson('../data/katakana.json');
  const findPrompt = (kana) => questions.find(({ subskill, prompt }) => subskill === 'lookalike' && prompt.includes(`「${kana}」`));
  assert.match(findPrompt('シ').explanationKo, /위아래/);
  assert.match(findPrompt('ツ').explanationKo, /좌우/);
  assert.match(findPrompt('ソ').explanationKo, /위에서/);
  assert.match(findPrompt('ン').explanationKo, /아래에서 위/);
});
