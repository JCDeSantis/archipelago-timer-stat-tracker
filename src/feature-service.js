const fs = require('fs');
const { randomUUID } = require('crypto');
const { RaceLibrary, recordId } = require('./race-library');
const { SoundLibrary } = require('./sound-library');
const { featurePreferences } = require('./race-features');
const { raceResultLines } = require('./race-results');
const { serverAddress, sessionName } = require('./run-timer');

const actions = new Set(['library-meta', 'history-list', 'history-get', 'history-track', 'history-rename', 'history-import', 'history-export', 'history-resume',
  'racer-create', 'alias-add', 'alias-remove', 'runner-assign', 'profile-save', 'profile-delete', 'profile-apply', 'profile-export', 'profile-import',
  'feature-settings', 'sound-list', 'sound-import', 'sound-read', 'sound-remove', 'preview-results', 'copy-preview', 'post-preview', 'copy-results', 'post-results', 'save-card']);

class FeatureService {
  constructor({ directory, settings, timer, getWindow, backgroundTest = false, desktop }) {
    this.settings = settings; this.timer = timer; this.getWindow = getWindow; this.backgroundTest = backgroundTest;
    this.sounds = new SoundLibrary(directory);
    this.desktop = desktop || require('electron'); this.previews = new Map(); this.rosterIssues = []; this.activeRoster = null;
    try { this.library = new RaceLibrary(directory); } catch (error) { this.storageError = error.message; }
  }
  handles(action) { return actions.has(action); }
  requiredLibrary() { if (!this.library || this.storageError) throw new Error(`History storage unavailable: ${this.storageError || 'unknown error'}`); return this.library; }
  preferences() { return featurePreferences(this.settings.value.features); }
  observe(state) {
    try { this.library?.observe({ ...state, resumeConnection: this.timer.options ? { address: this.timer.options.address, name: this.timer.options.name } : null }); } catch (error) { this.storageError = error.message; }
  }
  decorate(state) {
    const id = recordId(state); let row = null, data = null;
    try { row = id && this.library?.row(id); data = row && JSON.parse(row.data); }
    catch (error) { this.storageError = error.message; }
    const quality = { uncertain: !!this.storageError || !!data?.lateJoin || !!data?.importedLegacy || !!data?.gaps.length,
      lateJoin: !!data?.lateJoin, gaps: data?.gaps || [], lastSeenAt: data?.lastSeenAt || null };
    return { ...state, featureSettings: this.preferences(), activeHistoryId: id, trackingExcluded: !!row?.excluded,
      recordQuality: quality, libraryRevision: this.library?.revision || 0, historyError: this.storageError || '',
      profileRosterIssues: this.rosterIssues, preferredTimerOnly: this.settings.value.profileTimerOnly === true,
      backgroundTest: this.backgroundTest };
  }
  beforeConnect(input) {
    const target = this.settings.value.profileTarget;
    this.activeRoster = target && serverAddress(input.address) === target ? this.settings.value.preferredRoster || null : null;
    const resume = this.settings.value.resumeTarget;
    this.timer.expectedRun = resume && resume.address === serverAddress(input.address) && resume.session === sessionName(input.session || 'main') ? resume : null;
    this.rosterIssues = [];
  }
  resolveRoster(players) {
    if (!this.activeRoster?.length) return null;
    if (!this.library || this.storageError) { this.rosterIssues = ['Saved roster cannot be resolved while history storage is unavailable']; return []; }
    const result = this.library.resolveRoster(this.activeRoster, players); this.rosterIssues = result.issues;
    return result.slots;
  }
  record(id) {
    const current = this.timer.snapshot();
    if (!id) id = recordId(current);
    if (!id) throw new Error('Results can be shared once every selected runner has finished or released.');
    if (id === recordId(current)) this.observe(current);
    return this.requiredLibrary().get(id);
  }
  shareOptions(record, input = {}) {
    if (!['slots', 'identities', undefined].includes(input.names)) throw new Error('Invalid result name preference.');
    for (const key of ['checks', 'bk', 'awards']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('Invalid result fields.');
    return { checks: input.checks !== false, bk: input.bk !== false, awards: input.awards === true, qualityUncertain: record.quality.uncertain,
      labels: Object.fromEntries(record.players.map(p => [p.slot, input.names === 'identities' && p.identity ? p.identity.name : p.originalName])) };
  }
  async chooseJSON(maxBytes = 20 * 1024 * 1024) {
    const result = await this.desktop.dialog.showOpenDialog(this.getWindow(), { properties: ['openFile'], filters: [{ name: 'Timer JSON', extensions: ['json'] }] });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if (fs.statSync(file).size > maxBytes) throw new Error('This file is too large.');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  async saveJSON(value, name) {
    const result = await this.desktop.dialog.showSaveDialog(this.getWindow(), { defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!result.canceled && result.filePath) fs.writeFileSync(result.filePath, JSON.stringify(value, null, 2));
    return { saved: !result.canceled };
  }
  async handle(action, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid feature request.');
    if (action === 'sound-list') return { sounds: this.sounds.list(), soundError: this.sounds.error || '' };
    if (action === 'sound-import') {
      const result = await this.desktop.dialog.showOpenDialog(this.getWindow(), { properties: ['openFile'], filters: [{ name: 'Audio (10 MB maximum)', extensions: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'webm'] }] });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      return { sound: this.sounds.import(result.filePaths[0]), sounds: this.sounds.list() };
    }
    if (action === 'sound-read') return this.sounds.read(input.id);
    if (action === 'sound-remove') {
      this.sounds.remove(input.id);
      const prefs = this.preferences();
      if (prefs.sounds.countdownId === input.id) prefs.sounds.countdownId = 'classic';
      if (prefs.sounds.goId === input.id) prefs.sounds.goId = 'bell';
      for (const rule of Object.values(prefs.alerts.categories)) if (rule.soundId === input.id) rule.soundId = 'classic';
      this.settings.save({ features: prefs });
      return { sounds: this.sounds.list() };
    }
    if (action === 'library-meta') return { racers: this.requiredLibrary().racers(), profiles: this.library.profiles() };
    if (action === 'history-list') return { records: this.requiredLibrary().list(input) };
    if (action === 'history-get') return { record: this.requiredLibrary().get(input.id) };
    if (action === 'history-track') {
      this.requiredLibrary().setTracked(input.id, input.tracked);
      if (input.tracked && recordId(this.timer.snapshot()) === input.id) this.observe(this.timer.snapshot());
      return { record: this.library.get(input.id) };
    }
    if (action === 'history-rename') return { record: this.requiredLibrary().rename(input.id, input.title) };
    if (action === 'history-resume') {
      if (['connected', 'connecting', 'reconnecting'].includes(this.timer.snapshot().connection)) throw new Error('Disconnect before preparing a historical session.');
      const record = this.requiredLibrary().get(input.id);
      if (record.allFinished || record.excluded || !record.resumeConnection) throw new Error('This run cannot be resumed automatically. Restore tracking or reconnect to its original room manually.');
      const draft = { ...record.resumeConnection, session: record.session };
      this.settings.save({ connection: draft, preferredRoster: null, profileTarget: null,
        resumeTarget: { address: draft.address, session: draft.session, seed: record.seed, team: record.team, startedAt: record.run.startedAt } });
      return { draft: { address: draft.address, slotName: draft.name, session: draft.session } };
    }
    if (action === 'racer-create') return { racer: this.requiredLibrary().createRacer(input.name) };
    if (action === 'alias-add') { this.requiredLibrary().addAlias(input); return {}; }
    if (action === 'alias-remove') { this.requiredLibrary().removeAlias(input); return {}; }
    if (action === 'runner-assign') { this.requiredLibrary().assign(input); return {}; }
    if (action === 'history-export') return this.saveJSON(this.requiredLibrary().exportRecord(input.id), `archipelago-${input.id.slice(0, 8)}.race.json`);
    if (action === 'history-import') { const value = await this.chooseJSON(); return value ? { record: this.requiredLibrary().importRecord(value) } : { canceled: true }; }
    if (action === 'feature-settings') { this.settings.save({ features: featurePreferences(input) }); return {}; }
    if (action === 'profile-save') return { profile: this.requiredLibrary().saveProfile(input) };
    if (action === 'profile-delete') { this.requiredLibrary().deleteProfile(input.id); return {}; }
    if (action === 'profile-apply') {
      const s = this.timer.snapshot();
      if (['connected', 'connecting', 'reconnecting'].includes(s.connection)) throw new Error('Disconnect before applying a profile. The current shared race is not changed.');
      const draft = this.requiredLibrary().profileDraft(input.id);
      this.settings.save({ connection: { address: draft.address, name: draft.slotName, session: draft.session },
        features: draft.features, preferredRoster: draft.roster, profileTarget: draft.address, profileTimerOnly: draft.timerOnly,
        resumeTarget: null,
        followRoomCountdown: draft.followRoomCountdown, alwaysOnTop: draft.alwaysOnTop });
      this.timer.followCountdown(draft.followRoomCountdown);
      this.getWindow()?.setAlwaysOnTop(draft.alwaysOnTop, process.platform === 'win32' ? 'pop-up-menu' : 'floating');
      return { draft };
    }
    if (action === 'profile-export') {
      const p = this.requiredLibrary().profiles().find(p => p.id === input.id); if (!p) throw new Error('Profile not found.');
      const { id, ...profile } = p;
      if (input.includeConnection !== true) { profile.address = ''; profile.slotName = ''; }
      return this.saveJSON({ type: 'archipelago-race-profile', schema: 1, profile }, 'archipelago.profile.json');
    }
    if (action === 'profile-import') {
      const value = await this.chooseJSON(1024 * 1024);
      if (!value) return { canceled: true };
      if (value.type !== 'archipelago-race-profile' || value.schema !== 1 || !value.profile || typeof value.profile !== 'object') throw new Error('Invalid race profile.');
      const { id, password, ...profileDraft } = value.profile; return { profileDraft };
    }
    if (action === 'preview-results') {
      const record = this.record(input.id), options = this.shareOptions(record, input.options);
      const lines = raceResultLines(record, options), token = randomUUID();
      for (const [key, preview] of this.previews) if (Date.now() - preview.created > 900000) this.previews.delete(key);
      while (this.previews.size >= 30) this.previews.delete(this.previews.keys().next().value);
      this.previews.set(token, { id: record.id, optionsInput: input.options || {}, options, lines, created: Date.now() });
      const current = this.timer.snapshot();
      return { preview: { token, id: record.id, title: record.title, text: lines.join('\n'), lines: lines.length,
        canPost: recordId(current) === record.id && current.connection === 'connected' && current.hydrated && !current.resultsPosted,
        target: `${record.seed} · team ${record.team + 1} · ${record.session}`, record } };
    }
    if (action === 'copy-preview' || action === 'post-preview') {
      const preview = this.previews.get(input.token);
      if (!preview || Date.now() - preview.created > 900000) throw new Error('This preview expired. Refresh it before sharing.');
      const record = this.record(preview.id);
      if (record.excluded) throw new Error('This run has been called off. Restore tracking before sharing completed results.');
      if (action === 'copy-preview') { this.desktop.clipboard.writeText(preview.lines.join('\n')); return {}; }
      const current = this.timer.snapshot();
      if (recordId(current) !== preview.id) throw new Error('Connect to this run’s original room, team and session before posting.');
      const options = this.shareOptions(record, preview.optionsInput);
      if (JSON.stringify(raceResultLines(record, options)) !== JSON.stringify(preview.lines)) throw new Error('Results changed. Refresh the preview before posting.');
      this.timer.postResults(options); return {};
    }
    if (action === 'copy-results' || action === 'post-results') {
      const record = this.record(), options = this.shareOptions(record);
      if (record.excluded) throw new Error('Called-off runs are excluded from shared results.');
      if (action === 'post-results') this.timer.postResults(options);
      else this.desktop.clipboard.writeText(raceResultLines(record, options).join('\n'));
      return {};
    }
    if (action === 'save-card') {
      if (typeof input.png !== 'string' || input.png.length > 16 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.png)) throw new Error('Invalid finish card image.');
      const record = this.record(input.id);
      if (!record.allFinished || record.excluded) throw new Error('Finish cards require a tracked, completed run.');
      const image = this.desktop.nativeImage.createFromDataURL(input.png), size = image.getSize();
      if (image.isEmpty() || size.width > 5000 || size.height > 5000) throw new Error('Invalid finish card dimensions.');
      const result = await this.desktop.dialog.showSaveDialog(this.getWindow(), { defaultPath: 'archipelago-finish-card.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
      if (!result.canceled && result.filePath) fs.writeFileSync(result.filePath, image.toPNG());
      return { saved: !result.canceled };
    }
    throw new Error('Unknown feature action.');
  }
  close() { this.library?.close(); }
}
module.exports = { FeatureService };
