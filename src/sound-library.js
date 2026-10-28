const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const MAX_BYTES = 10 * 1024 * 1024;
const formats = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.webm': 'audio/webm' };
class SoundLibrary {
  constructor(directory) {
    this.directory = path.join(directory, 'sounds');
    this.manifest = path.join(this.directory, 'library.json');
    this.items = [];
    try { this.items = JSON.parse(fs.readFileSync(this.manifest, 'utf8')).filter(item => /^custom:[a-f0-9]{64}$/.test(item.id) && formats[item.extension] && typeof item.name === 'string'); }
    catch (error) { if (error.code !== 'ENOENT') this.error = 'The saved sound library could not be read. Restart after restoring its library.json backup.'; }
  }
  list() { return this.items.map(({ id, name }) => ({ id, name })); }
  file(item) { return path.join(this.directory, item.id.slice(7) + item.extension); }
  save() {
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.manifest + '.tmp', JSON.stringify(this.items, null, 2));
    fs.renameSync(this.manifest + '.tmp', this.manifest);
  }
  import(file) {
    if (this.error) throw new Error(this.error);
    const extension = path.extname(file).toLowerCase();
    if (!formats[extension]) throw new Error('Choose WAV, MP3, OGG, FLAC, M4A or WebM audio.');
    const stat = fs.statSync(file);
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw new Error('Choose an audio file between 1 byte and 10 MB.');
    const data = fs.readFileSync(file);
    if (data.length > MAX_BYTES) throw new Error('Audio files must be 10 MB or smaller.');
    const header = data.subarray(0, 12);
    const valid = extension === '.wav' ? header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE'
      : extension === '.mp3' ? header.toString('ascii', 0, 3) === 'ID3' || (header[0] === 255 && (header[1] & 224) === 224)
      : extension === '.ogg' ? header.toString('ascii', 0, 4) === 'OggS'
      : extension === '.flac' ? header.toString('ascii', 0, 4) === 'fLaC'
      : extension === '.m4a' ? header.toString('ascii', 4, 8) === 'ftyp'
      : header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!valid) throw new Error('This file does not contain the expected audio format.');
    const id = 'custom:' + createHash('sha256').update(data).digest('hex');
    const existing = this.items.find(item => item.id === id);
    if (existing) return { id, name: existing.name };
    const item = { id, extension, name: path.basename(file, path.extname(file)).slice(0, 80) };
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.file(item), data);
    this.items.push(item);
    try { this.save(); } catch (error) { this.items.pop(); throw error; }
    return { id, name: item.name };
  }
  read(id) {
    const item = this.items.find(item => item.id === id);
    if (!item) throw new Error('Custom sound not found. Import it on this computer or choose a built-in sound.');
    if (fs.statSync(this.file(item)).size > MAX_BYTES) throw new Error('Saved audio is too large.');
    return { data: fs.readFileSync(this.file(item)).toString('base64') };
  }
  remove(id) {
    if (this.error) throw new Error(this.error);
    const item = this.items.find(item => item.id === id);
    if (!item) throw new Error('Custom sound not found.');
    const previous = this.items;
    this.items = this.items.filter(item => item.id !== id);
    try { this.save(); } catch (error) { this.items = previous; throw error; }
    try { fs.unlinkSync(this.file(item)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
module.exports = { SoundLibrary };
