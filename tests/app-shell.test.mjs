import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('HTML exposes install metadata and account controls', async () => {
  const html = await read('../index.html');
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /id="account-button"/);
  assert.match(html, /id="sync-status"/);
  assert.match(html, /복구할 수 없/);
  assert.match(html, /진도를 읽거나 삭제/);
});

test('app wires cloud account sync and service-worker registration', async () => {
  const source = await read('../app.mjs');
  assert.match(source, /createCloudSync/);
  assert.match(source, /shouldDeferRemote:\s*\(\)\s*=>\s*viewMode === 'active'/);
  assert.doesNotMatch(source, /shouldDeferRemote:[^\n]+querySelector/);
  assert.match(source, /meta\.reason === 'profile'/);
  assert.match(source, /setupCloudSync/);
  assert.match(source, /cloudSync\.save\(progress\)/);
  assert.match(source, /serviceWorker\.register\('\.\/sw\.js'\)/);
  assert.match(source, /signUp/);
  assert.match(source, /signIn/);
  assert.match(source, /signOut/);
});

test('dashboard nests settings under account, drills under extra practice, and renders calendar inline', async () => {
  const [html, source] = await Promise.all([read('../index.html'), read('../app.mjs')]);
  assert.match(html, /id="account-settings"/);
  assert.match(html, /id="daily-word-count-form"/);
  assert.match(source, /function renderExtraPracticeHub/);
  assert.match(source, /id="extra-particle-button"/);
  assert.match(source, /id="extra-katakana-button"/);
  assert.match(source, /class="dashboard-calendar"/);
  assert.match(source, /signedIn \|\| !authAvailable/);
  assert.match(source, /accountSettingsChanged && viewMode === 'dashboard'/);
  assert.doesNotMatch(source, /id="settings-button"/);
  assert.doesNotMatch(source, /id="calendar-button"/);
  assert.doesNotMatch(source, /id="katakana-button"/);
});

test('app exposes adjustable daily word settings and randomized fifty-question banks', async () => {
  const [html, source] = await Promise.all([read('../index.html'), read('../app.mjs')]);
  assert.match(source, /normalizeDailyWordCount/);
  assert.match(html, /daily-word-count/);
  assert.match(source, /progress\.settings\.dailyWordCount/);
  assert.match(source, /data\/extra-practice\.json/);
  assert.match(source, /selectPracticeBatch/);
  assert.match(source, /previousExtraQuestionIds/);
  assert.match(source, /previousKatakanaQuestionIds/);
});

test('app exposes a dedicated katakana weakness drill without regular progress writes', async () => {
  const source = await read('../app.mjs');
  assert.match(source, /data\/katakana\.json/);
  assert.match(source, /startKatakanaPractice/);
  assert.match(source, /가타카나 빠르게 읽기/);
});

test('weekly practice banks are precached and copied into the Pages artifact', async () => {
  const worker = await read('../sw.js');
  const workflow = await read('../.github/workflows/pages.yml');
  assert.match(worker, /data\/extra-practice\.json/);
  assert.match(worker, /data\/katakana\.json/);
  assert.match(workflow, /data\/extra-practice\.json/);
  assert.match(workflow, /data\/katakana\.json/);
});

test('manifest has installable 192 and 512 pixel icons', async () => {
  const manifest = JSON.parse(await read('../manifest.webmanifest'));
  assert.deepEqual(manifest.icons.map(({ sizes }) => sizes), ['192x192', '512x512']);
  for (const icon of manifest.icons) assert.match(icon.src, /^\.\/icons\//);
});
