const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TimerAlerts } = require('../timer-alerts');

function harness() {
  const alerts = new TimerAlerts();
  const state = { context: 'run', ready: true, enabled: true, events: [], runnerBKs: [], ownSlot: 1, serverNow: 100000, now: 0 };
  return patch => alerts.update(Object.assign(state, patch));
}
const event = (id, type = 'goal', at = 100000) => ({ id, type, at, message: `${id} happened.` });

test('compact alerts suppress history, deduplicate updates, and expire after eight seconds', () => {
  const update = harness();
  const old = event('old');
  const fresh = event('fresh');
  assert.equal(update({ events: [old] }), null);
  assert.equal(update({ events: [old, fresh], now: 100 }).id, 'fresh');
  assert.equal(update({ now: 8099 }).id, 'fresh');
  assert.equal(update({ now: 8100 }), null);
  assert.equal(update({ now: 10000 }), null);
});

test('finish alerts lead burst queues and stale queued messages are discarded', () => {
  const update = harness();
  update({});
  const events = [event('check', 'checks'), event('goal'), event('done', 'finish')];
  assert.equal(update({ events }).id, 'done');
  assert.equal(update({ now: 8000 }), null, 'leave a short gap between alerts');
  assert.equal(update({ now: 8600 }).id, 'goal');
  assert.equal(update({ now: 31000 }), null, 'old low-priority checks never form a long backlog');
});

test('full view, reconnects, and new race contexts do not replay previous events', () => {
  const update = harness();
  update({ enabled: false });
  assert.equal(update({ events: [event('full-view')] }), null);
  assert.equal(update({ enabled: true }), null);
  assert.equal(update({ events: [event('full-view'), event('live')] }).id, 'live');
  assert.equal(update({ ready: false }), null);
  assert.equal(update({ ready: true, events: [event('missed-during-gap')] }), null);
  assert.equal(update({ context: 'another-run', events: [event('historical')] }), null);
});

test('scheduled start appears at zero and unknown or delayed historical events stay quiet', () => {
  const update = harness();
  const start = event('start', 'start', 101000);
  update({ events: [start] });
  assert.equal(update({ serverNow: 100999 }), null);
  assert.equal(update({ serverNow: 101000 }).type, 'start');
  update({ enabled: false });
  assert.equal(update({ enabled: true, events: [start, event('unknown', 'goal', null), event('stale', 'release', 1)] }), null);
});

test('personal BK never generates popup reminders', () => {
  const update = harness();
  const runnerBKs = [{ slot: 1, name: 'You', since: 0 }];
  assert.equal(update({ runnerBKs, serverNow: 300000 }), null);
  assert.equal(update({ serverNow: 600000, now: 300000 }), null);
  assert.equal(update({ serverNow: 1200000, now: 900000 }), null);
});

test('other runners get BK alerts at ten minutes and at most once per ten minutes', () => {
  const update = harness();
  const runnerBKs = [{ slot: 1, name: 'You', since: 0 }, { slot: 2, name: 'Samus', since: 0 }];
  assert.equal(update({ runnerBKs, serverNow: 599999 }), null);
  const alert = update({ serverNow: 600000, now: 1 });
  assert.equal(alert.type, 'bk');
  assert.equal(alert.slot, 2);
  assert.equal(alert.name, 'Samus');
  assert.equal(update({ now: 8000 }).slot, 2);
  assert.equal(update({ now: 8001 }), null);
  assert.equal(update({ now: 600000, serverNow: 1199999 }), null);
  assert.equal(update({ now: 600001, serverNow: 1200000 }).slot, 2);
});

test('other-runner BK resets on a check and disappears on finish or release', () => {
  const update = harness();
  const runner = { slot: 2, name: 'Samus', since: 0 };
  assert.equal(update({ runnerBKs: [runner], serverNow: 600000 }).type, 'bk');
  assert.equal(update({ runnerBKs: [{ ...runner, since: 600000 }], now: 100 }), null);
  assert.equal(update({ serverNow: 1200000, now: 600100 }).type, 'bk');
  assert.equal(update({ runnerBKs: [] }), null);
});

test('switching views or reconnecting does not reset another runner reminder interval', () => {
  const update = harness();
  const runnerBKs = [{ slot: 2, name: 'Samus', since: 0 }];
  assert.equal(update({ runnerBKs, serverNow: 600000 }).type, 'bk');
  assert.equal(update({ enabled: false, now: 1000 }), null);
  assert.equal(update({ enabled: true, now: 2000 }), null);
  assert.equal(update({ ready: false, now: 3000 }), null);
  assert.equal(update({ ready: true, now: 4000 }), null);
  assert.equal(update({ now: 600000, serverNow: 1200000 }).slot, 2);
});
