const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Settings } = require('../settings');

test('standalone settings persist connection and solo state in their own profile', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-timer-settings-'));
  const settings = new Settings(profile);
  settings.save({ connection: { address: 'wss://archipelago.gg:12345/', name: 'Player1', session: 'main' } });
  settings.save({ solo: { startedAt: 1000, finishedAt: null } });
  settings.flush();
  const restored = new Settings(profile);
  assert.equal(restored.value.connection.name, 'Player1');
  assert.equal(restored.value.solo.startedAt, 1000);
  assert.equal(path.basename(restored.file), 'settings.json');
  assert.deepEqual(fs.readdirSync(profile), ['settings.json']);
});

test('damaged primary settings recover the last readable backup', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-timer-settings-'));
  const settings = new Settings(profile);
  settings.save({ solo: { startedAt: 1000, finishedAt: null } });
  settings.flush();
  settings.save({ solo: { startedAt: 1000, finishedAt: 2000 } });
  settings.flush();
  fs.writeFileSync(settings.file, '{broken');
  const restored = new Settings(profile);
  assert.deepEqual(restored.value.solo, { startedAt: 1000, finishedAt: null });
});
