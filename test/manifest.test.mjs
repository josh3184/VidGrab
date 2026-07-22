import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8')
);

test('incognito mode is split so downloads stay in the incognito profile', () => {
  // Without this key Chrome defaults to "spanning": one service worker in the
  // regular profile handles incognito tabs, so chrome.downloads.download()
  // records downloads in the regular profile's download list.
  assert.equal(manifest.incognito, 'split');
});

test('downloads permission is present', () => {
  assert.ok(manifest.permissions.includes('downloads'));
});
