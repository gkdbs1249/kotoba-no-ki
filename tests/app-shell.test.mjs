import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('HTML exposes install metadata and account controls', async () => {
  const html = await read('../index.html');
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /id="account-button"/);
  assert.match(html, /id="sync-status"/);
});

test('app wires cloud account sync and service-worker registration', async () => {
  const source = await read('../app.mjs');
  assert.match(source, /createCloudSync/);
  assert.match(source, /setupCloudSync/);
  assert.match(source, /cloudSync\.save\(progress\)/);
  assert.match(source, /serviceWorker\.register\('\.\/sw\.js'\)/);
  assert.match(source, /signUp/);
  assert.match(source, /signIn/);
  assert.match(source, /signOut/);
});

test('app exposes a dedicated katakana weakness drill without regular progress writes', async () => {
  const source = await read('../app.mjs');
  assert.match(source, /data\/katakana\.json/);
  assert.match(source, /startKatakanaPractice/);
  assert.match(source, /가타카나 빠르게 읽기/);
});

test('manifest has installable 192 and 512 pixel icons', async () => {
  const manifest = JSON.parse(await read('../manifest.webmanifest'));
  assert.deepEqual(manifest.icons.map(({ sizes }) => sizes), ['192x192', '512x512']);
  for (const icon of manifest.icons) assert.match(icon.src, /^\.\/icons\//);
});
