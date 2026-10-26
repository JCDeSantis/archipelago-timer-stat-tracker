const fs = require('fs');
const path = require('path');

class Settings {
  constructor(directory) {
    this.file = path.join(directory, 'settings.json');
    this.value = {};
    for (const file of [this.file, this.file + '.bak']) {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value && typeof value === 'object' && !Array.isArray(value)) { this.value = value; break; }
      } catch { /* New profile or damaged file: try the backup. */ }
    }
  }
  save(patch) {
    this.value = { ...this.value, ...patch };
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.flush(), 200);
  }
  flush() {
    clearTimeout(this.pending);
    this.pending = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.value, null, 2));
    if (fs.existsSync(this.file)) {
      try {
        JSON.parse(fs.readFileSync(this.file, 'utf8'));
        fs.copyFileSync(this.file, this.file + '.bak');
      } catch { /* Preserve the last readable backup. */ }
    }
    fs.renameSync(temporary, this.file);
  }
}

module.exports = { Settings };
