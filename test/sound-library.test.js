const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SoundLibrary } = require('../src/sound-library');
const { featurePreferences } = require('../src/race-features');

function wav() {
  const data = Buffer.alloc(44 + 1600);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(1600, 40);
  return data;
}
test('imported sounds survive moved originals and restart; duplicate content shares one saved sound', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-sounds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'My chime.wav'); fs.writeFileSync(file, wav());
  const library = new SoundLibrary(dir), sound = library.import(file);
  assert.equal(sound.name, 'My chime');
  assert.deepEqual(library.import(file), sound);
  fs.unlinkSync(file);
  const restarted = new SoundLibrary(dir);
  assert.deepEqual(restarted.list(), [sound]);
  assert.deepEqual(Buffer.from(restarted.read(sound.id).data, 'base64'), wav());
  assert.throws(() => restarted.read('../../settings.json'), /not found/);
  restarted.remove(sound.id);
  assert.deepEqual(new SoundLibrary(dir).list(), []);
  assert.throws(() => restarted.read(sound.id), /not found/);
});
test('unsupported, fake, empty and oversized imports do not enter the library', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-sounds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const library = new SoundLibrary(dir);
  for (const [name, data] of [['file.exe', wav()], ['fake.wav', Buffer.from('not audio')], ['empty.mp3', Buffer.alloc(0)], ['huge.wav', Buffer.alloc(10 * 1024 * 1024 + 1)]]) {
    const file = path.join(dir, name); fs.writeFileSync(file, data);
    assert.throws(() => library.import(file));
  }
  assert.deepEqual(library.list(), []);
});
test('sound choices persist through preference normalization and invalid choices use built-ins', () => {
  const id = 'custom:' + 'a'.repeat(64);
  const prefs = featurePreferences({ sounds: { countdownId: 'arcade', goId: id }, alerts: { categories: { goal: { sound: true, soundId: 'soft' }, bk: { soundId: id } } } });
  assert.deepEqual(featurePreferences(prefs), prefs);
  assert.equal(prefs.sounds.countdownId, 'arcade'); assert.equal(prefs.sounds.goId, id);
  assert.equal(prefs.alerts.categories.goal.soundId, 'soft'); assert.equal(prefs.alerts.categories.bk.soundId, id);
  assert.equal(featurePreferences({ sounds: { countdownId: '../../file' } }).sounds.countdownId, 'classic');
});
module.exports = { wav };
