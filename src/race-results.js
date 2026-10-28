// One printable line per Say packet: Archipelago rejects newline-containing chat.
function elapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'Unavailable';
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}

function raceResultLines(state, options = {}) {
  if (!state.run || !state.allFinished) throw new Error('Results can be shared once every selected runner has finished or released.');
  if (state.excluded) throw new Error('Called-off runs are excluded from shared results. Restore tracking first.');
  const count = n => Number.isSafeInteger(n) && n >= 0 ? String(n) : 'Unavailable';
  const lines = [`[Race results] Total Group Time: ${elapsed(state.stats.elapsedMs)}${options.checks === false ? '' : ' | Group checks: ' + count(state.stats.checksCompleted)}`];
  if (state.quality?.uncertain || options.qualityUncertain) lines.push('[Race results] Recording warning: possible missing checks or finish observations.');
  for (const player of state.players) {
    const display = options.labels?.[player.slot] || player.originalName || player.name;
    const name = Array.from(display.replace(/[\p{C}\p{Z}]/gu, ' ').replace(/ +/g, ' ').trim()).slice(0, 128).join('') || `Runner ${player.slot}`;
    const bk = player.stats.longestBKMs;
    const longestBK = Number.isFinite(bk) && bk >= 0 && bk < 300000 ? 'N/A' : elapsed(bk);
    const status = player.released && !player.completed ? 'Released' : 'Completed';
    lines.push(`[Race results] ${name} (${status}) | Time: ${elapsed(player.stats.elapsedMs)}${options.checks === false ? '' : ' | Checks: ' + count(player.stats.checksCompleted)}${options.bk === false ? '' : ' | Longest BK: ' + longestBK}`);
  }
  if (options.awards) {
    const { raceAwards } = require('./race-features');
    for (const award of raceAwards({ ...state, quality: { uncertain: !!state.quality?.uncertain || !!options.qualityUncertain } })) if (award.winners.length && !(award.type === 'checks' && options.checks === false) && !(award.type === 'steady' && options.bk === false)) {
      const names = award.winners.map(p => Array.from(String(options.labels?.[p.slot] || p.name).replace(/[\p{C}\p{Z}]/gu, ' ')).slice(0, 128).join('')).join(', ');
      const value = award.type === 'checks' ? `${award.value} checks` : award.type === 'steady' && award.value < 300000 ? 'No BK over five minutes' : elapsed(award.value);
      lines.push(`[Race highlights] ${award.title}${award.winners.length > 1 ? ' (shared)' : ''}: ${names} | ${value}`);
    }
  }
  return lines;
}

module.exports = { raceResultLines };
