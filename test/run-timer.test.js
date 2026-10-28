const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { once, EventEmitter } = require('node:events');
const { RunTimer, serverAddress, sessionName, roomCountdownSeconds } = require('../src/run-timer');

async function until(predicate, message = 'condition', timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// A real TCP/WebSocket fixture implementing the AP commands used by the timer.
// The server has an independent clock; clients can have arbitrary local clock origins.
async function room(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
  await once(server, 'listening');
  const fixture = {
    time: 1800000000000, store: new Map(), statuses: { 1: 0, 2: 0, 3: 0 }, packets: [], timers: [], locationInfo: {}, initialReplies: [],
    address: `ws://127.0.0.1:${server.address().port}`,
  };
  const players = [1, 2, 3].map(slot => ({ team: 0, slot, name: `Player${slot}`, alias: `Player${slot}` }));
  const slot_info = { 1: { type: 1, game: 'A Link to the Past' }, 2: { type: 1, game: 'Super Metroid' }, 3: { type: 2, game: 'Group' } };
  const send = (ws, packet) => { if (ws.readyState === 1) ws.send(JSON.stringify([packet])); };
  const broadcast = (key, value) => {
    for (const ws of server.clients) if (ws.keys?.has(key)) send(ws, { cmd: 'SetReply', key, value });
  };
  server.on('connection', ws => {
    ws.keys = new Set();
    send(ws, { cmd: 'RoomInfo', seed_name: 'test-seed', time: fixture.time / 1000 });
    ws.on('message', data => {
      for (const packet of JSON.parse(data)) {
        fixture.packets.push(packet);
        if (packet.cmd === 'Connect') {
          if (packet.name === 'bad') { send(ws, { cmd: 'ConnectionRefused', errors: ['InvalidSlot'] }); continue; }
          ws.slot = Number(packet.name.replace('Player', ''));
          send(ws, { cmd: 'Connected', team: 0, slot: ws.slot, players, slot_info, ...fixture.locationInfo[ws.slot] });
        } else if (packet.cmd === 'SetNotify') packet.keys.forEach(key => ws.keys.add(key));
        else if (packet.cmd === 'Get') {
          if (packet.timerReadyStart) fixture.beforeReadyRead?.();
          const keys = Object.fromEntries(packet.keys.map(key => [key, key.startsWith('_read_client_status_0_') ? fixture.statuses[Number(key.split('_').at(-1))] : fixture.store.get(key) ?? null]));
          const reply = () => send(ws, { ...packet, cmd: 'Retrieved', keys });
          if (fixture.holdInitial && packet.timerInitial) fixture.initialReplies.push(reply);
          else reply();
        } else if (packet.cmd === 'Set') {
          let value = fixture.store.has(packet.key) ? fixture.store.get(packet.key) : packet.default;
          for (const operation of packet.operations) {
            if (operation.operation === 'min') value = Math.min(value, operation.value);
            else if (operation.operation === 'update') value = { ...value, ...operation.value };
            else if (operation.operation === 'replace') value = operation.value;
            else assert.equal(operation.operation, 'default');
          }
          fixture.store.set(packet.key, value);
          broadcast(packet.key, value);
        } else if (packet.cmd !== 'Say' || !fixture.allowSay) assert.fail(`Unexpected gameplay command: ${packet.cmd}`);
      }
    });
  });
  fixture.goal = slot => {
    fixture.statuses[slot] = 30;
    broadcast(`_read_client_status_0_${slot}`, 30);
    for (const ws of server.clients) send(ws, { cmd: 'PrintJSON', type: 'Goal', team: 0, slot });
  };
  fixture.broadcast = packet => { for (const ws of server.clients) send(ws, packet); };
  fixture.countdown = seconds => fixture.broadcast({ cmd: 'PrintJSON', type: 'Countdown', countdown: seconds,
    data: [{ text: `[Server]: Starting countdown of ${seconds}s` }] });
  fixture.flushInitial = () => { fixture.holdInitial = false; fixture.initialReplies.splice(0).forEach(reply => reply()); };
  fixture.event = (type, slot, team = 0) => {
    for (const ws of server.clients) send(ws, { cmd: 'PrintJSON', type, team, slot });
  };
  fixture.check = (slot, location, receiving = slot) => {
    for (const ws of server.clients) send(ws, { cmd: 'PrintJSON', type: 'ItemSend', receiving,
      item: { class: 'NetworkItem', player: slot, location, item: 123, flags: 0 } });
  };
  fixture.join = async (name = 'Player1', session = 'main', offset = 0) => {
    const timer = new RunTimer({ ...fixture.timerOptions, clock: () => fixture.time + offset });
    if (fixture.expectedRun) timer.expectedRun = fixture.expectedRun;
    fixture.timers.push(timer);
    timer.connect({ address: fixture.address, name, session, password: 'secret' });
    try { await until(() => timer.connection === 'connected' || timer.connection === 'error', 'connection'); }
    catch (error) { throw new Error(`${error.message}: ${timer.message}`); }
    return timer;
  };
  t.after(async () => {
    fixture.timers.forEach(timer => timer.disconnect());
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  return fixture;
}

test('connection input accepts AP addresses and rejects credentials and other URL schemes', () => {
  assert.equal(serverAddress('archipelago.gg:12345'), 'wss://archipelago.gg:12345/');
  assert.equal(serverAddress('ARCHIPELAGO.GG:53391'), 'wss://archipelago.gg:53391/');
  assert.equal(serverAddress('ws://archipelago.gg:53391'), 'ws://archipelago.gg:53391/');
  assert.equal(serverAddress('my-archipelago.gg.example:53391'), 'ws://my-archipelago.gg.example:53391/');
  assert.equal(serverAddress('localhost'), 'ws://localhost:38281/');
  assert.equal(serverAddress('wss://example.test/ap'), 'wss://example.test/ap');
  for (const value of ['', 'https://example.test', 'ws://user:password@example.test', 'ws://example.test/#secret']) assert.throws(() => serverAddress(value));
  assert.equal(sessionName(' Friday Run '), 'friday run');
  assert.throws(() => sessionName('<script>'));
});

test('a reset plaintext handshake upgrades to TLS before sending slot credentials', async t => {
  const sockets = [];
  class Socket extends EventEmitter {
    constructor(address) {
      super(); this.address = address; this.readyState = 1; this.sent = []; sockets.push(this);
      if (address.startsWith('ws://')) queueMicrotask(() => {
        this.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
        this.emit('close');
      });
    }
    send(data) { this.sent.push(...JSON.parse(data)); }
    terminate() { this.readyState = 3; this.emit('close'); }
  }
  const timer = new RunTimer({ Socket });
  t.after(() => timer.disconnect());
  timer.connect({ address: 'ws://archipelago.gg:53391/', name: 'JC', password: 'secret', session: 'main' });
  await until(() => sockets.length === 2, 'TLS upgrade');
  assert.equal(sockets[0].sent.length, 0);
  assert.equal(sockets[1].address, 'wss://archipelago.gg:53391/');
  sockets[1].emit('message', Buffer.from(JSON.stringify([{ cmd: 'RoomInfo', time: Date.now() / 1000, seed_name: 'tls-test' }])));
  assert.equal(sockets[1].sent[0].cmd, 'Connect');
  assert.equal(sockets[1].sent[0].name, 'JC');
  assert.ok(!JSON.stringify(timer.snapshot()).includes('secret'));
  sockets[1].emit('error', Object.assign(new Error('certificate rejected'), { code: 'CERT_HAS_EXPIRED' }));
  sockets[1].emit('close');
  assert.equal(timer.options.address, 'wss://archipelago.gg:53391/', 'TLS failures never downgrade to plaintext');
  assert.match(timer.message, /CERT_HAS_EXPIRED/);
});

test('shared start converges across clients; AP goals stop individuals and the group', async t => {
  const r = await room(t);
  const a = await r.join();
  const b = await r.join('Player2', 'MAIN', 999999);
  assert.equal(a.players.length, 2, 'item-link groups are excluded');
  assert.equal(a.key, b.key);
  assert.equal(a.now(), b.now(), 'local clock origins do not affect server time');
  assert.ok(!JSON.stringify(a.snapshot()).includes('secret'));
  a.start([1, 2], 5);
  await until(() => a.run && b.run, 'shared start');
  // Order competing writes at the server; two sockets can arrive in either order.
  b.send({ cmd: 'Set', key: b.key, default: { ...b.run, players: [b.players[1]], startedAt: r.time + 10000 },
    want_reply: true, operations: [{ operation: 'default', value: null }] });
  await until(() => r.packets.filter(p => p.cmd === 'Set' && p.key === b.key).length === 2);
  assert.equal(a.run.startedAt, b.run.startedAt);
  assert.deepEqual(b.run.players.map(p => p.slot), [1, 2], 'first start wins atomically');
  assert.equal(a.run.startedAt, r.time + 5000);
  r.time += 17000;
  r.goal(1);
  await until(() => a.finishes[1] && b.finishes[1], 'individual completion');
  assert.equal(a.finishes[1] - a.run.startedAt, 12000);
  assert.equal(a.snapshot().allFinished, false);
  const first = a.finishes[1];
  r.time += 4000;
  r.goal(1);
  r.goal(2);
  await until(() => a.snapshot().groupFinishedAt && b.snapshot().groupFinishedAt, 'group completion');
  assert.equal(a.finishes[1], first, 'duplicate goal cannot move a finish');
  assert.equal(a.snapshot().groupFinishedAt - a.run.startedAt, 16000);
  assert.deepEqual(a.snapshot().players, b.snapshot().players);
  assert.ok(r.packets.filter(p => p.cmd === 'Connect').every(p => p.tags.includes('Tracker') && p.items_handling === 0));
});

test('late join restores shared start and prior times; unobserved goals stay unknown', async t => {
  const r = await room(t);
  const a = await r.join();
  a.start([1, 2], 5);
  await until(() => a.run);
  r.time += 15000;
  r.goal(1);
  await until(() => a.finishes[1]);
  const first = a.finishes[1];
  a.disconnect();
  await until(() => [...r.timers].every(timer => !timer.socket));
  r.time += 7000;
  r.goal(2);
  const b = await r.join('Player2');
  assert.equal(b.run.startedAt, a.run.startedAt);
  assert.equal(b.finishes[1], first);
  assert.equal(b.finishes[2], undefined, 'status recovery must not invent a finish time');
  assert.equal(b.snapshot().allFinished, true);
  assert.equal(b.snapshot().groupFinishedAt, null);
});

test('automatic reconnect restores the session without recording goals missed during the gap', async t => {
  const r = await room(t);
  const a = await r.join();
  a.start([1], 5);
  await until(() => a.run);
  const started = a.run.startedAt;
  a.socket.terminate();
  await until(() => a.connection === 'reconnecting');
  r.time += 20000;
  r.goal(1);
  await until(() => a.connection === 'connected', 'automatic reconnect');
  assert.equal(a.run.startedAt, started);
  assert.equal(a.finishes[1], undefined);
  assert.equal(a.snapshot().allFinished, true);
});

test('selection limits group completion, and sessions stay separate', async t => {
  const r = await room(t);
  const a = await r.join();
  const b = await r.join('Player2', 'another run');
  assert.notEqual(a.key, b.key);
  assert.throws(() => a.start([], 5));
  assert.throws(() => a.start([3], 5));
  assert.throws(() => a.start([1, 1], 5));
  assert.throws(() => a.start([1], 0));
  a.start([1], 5);
  await until(() => a.run);
  assert.equal(b.run, null);
  r.time += 6000;
  r.goal(1);
  await until(() => a.finishes[1]);
  assert.equal(a.snapshot().allFinished, true);
  assert.equal(a.snapshot().players.length, 1);
  assert.throws(() => b.start([1], 5), /completed/);
});

test('already completed players cannot enter a new timed run', async t => {
  const r = await room(t);
  r.statuses[1] = 30;
  const a = await r.join();
  assert.throws(() => a.start([1, 2], 5), /completed/);
  assert.equal(Object.keys(a.finishes).length, 0);
});

test('host and player release events stop timers, converge, and restore across sessions', async t => {
  const r = await room(t);
  const a = await r.join();
  const b = await r.join('Player2');
  a.start([1, 2], 5);
  await until(() => a.run && b.run);
  r.time += 12000;
  // Both /release <player> and !release produce this same server event.
  r.event('Release', 1);
  await until(() => a.finishes[1] && b.finishes[1]);
  const first = a.finishes[1];
  assert.equal(a.snapshot().players[0].released, true);
  assert.equal(a.snapshot().players[0].completed, false);
  assert.equal(a.statuses[1], 0, 'release does not claim AP goal status');
  assert.equal(a.snapshot().allFinished, false);
  r.time += 4000;
  r.event('Release', 1);
  r.event('Release', 2);
  await until(() => a.snapshot().groupFinishedAt && b.snapshot().groupFinishedAt);
  assert.equal(a.finishes[1], first, 'repeated release cannot move the stop time');
  assert.equal(a.snapshot().groupFinishedAt - a.run.startedAt, 11000);
  const late = await r.join();
  assert.deepEqual(late.snapshot().players, a.snapshot().players);
  const other = await r.join('Player2', 'new session');
  assert.equal(other.snapshot().players[0].released, true);
  assert.throws(() => other.start([1], 5), /released/);
});

test('goal completion takes priority over automatic release and preserves the earliest time', async t => {
  const r = await room(t);
  const a = await r.join();
  a.start([1, 2], 5);
  await until(() => a.run);
  r.time += 10000;
  r.goal(1);
  r.event('Release', 1);
  r.event('Release', 2);
  await until(() => a.finishes[1] && a.finishes[2]);
  const first = a.finishes[2];
  assert.equal(a.snapshot().players[0].completed, true);
  r.time += 2000;
  r.goal(2);
  await until(() => a.snapshot().players[1].completed);
  assert.equal(a.snapshot().players[1].finishedAt, first);
});

test('status notifications and polling detect completion without a Goal print event', async t => {
  const r = await room(t);
  const a = await r.join();
  a.start([1, 2], 5);
  await until(() => a.run);
  r.time += 9000;
  a.receive({ cmd: 'SetReply', key: a.statusKey(1), value: 30 });
  a.receive({ cmd: 'Retrieved', keys: { [a.statusKey(2)]: 30 } });
  await until(() => a.finishes[1] && a.finishes[2]);
  assert.equal(a.snapshot().allFinished, true);
  assert.equal(a.snapshot().groupFinishedAt - a.run.startedAt, 4000);
});

test('release ignores other teams, unknown slots, chat and collect events', async t => {
  const r = await room(t);
  const a = await r.join();
  r.event('Release', 1, 1);
  r.event('Release', 3);
  r.event('Release', 999);
  r.event('Chat', 1);
  r.event('Collect', 1);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(a.releases, {});
  assert.equal(a.snapshot().players.some(p => p.stopped), false);
});

test('release during hydration or countdown is retained without inventing elapsed time', async t => {
  const r = await room(t);
  const a = await r.join();
  a.start([1], 10);
  await until(() => a.run);
  a.hydrated = false;
  r.time += 1000;
  a.receive({ cmd: 'PrintJSON', type: 'Release', team: 0, slot: 1 });
  a.receive({ cmd: 'Retrieved', timerInitial: true, keys: {} });
  assert.equal(a.snapshot().allFinished, true);
  assert.equal(a.snapshot().players[0].finishedAt, null);
  assert.equal(a.snapshot().groupFinishedAt, null);
  const b = await r.join();
  assert.equal(b.snapshot().players[0].released, true);
  assert.equal(b.snapshot().players[0].finishedAt, null);
});

test('a goal during countdown is complete but has no invented elapsed time', async t => {
  const r = await room(t);
  const a = await r.join();
  a.start([1], 10);
  await until(() => a.run);
  r.time += 1000;
  r.goal(1);
  await until(() => a.statuses[1] === 30);
  assert.equal(a.finishes[1], undefined);
  assert.equal(a.snapshot().groupFinishedAt, null);
});

test('authentication errors stop reconnecting and show a useful error', async t => {
  const r = await room(t);
  const a = await r.join('bad');
  assert.equal(a.connection, 'error');
  assert.match(a.message, /InvalidSlot/);
  assert.equal(a.socket, null);
});

test('solo stopwatch persists, restores and resets independently of AP', () => {
  let saved;
  const a = new RunTimer({ saveSolo: value => { saved = value; } });
  assert.throws(() => a.soloAction('finish'));
  a.soloAction('start');
  assert.ok(saved.startedAt);
  assert.throws(() => a.soloAction('start'));
  const restored = new RunTimer({ solo: structuredClone(saved) });
  restored.soloAction('finish');
  assert.ok(restored.solo.finishedAt >= a.solo.startedAt);
  restored.soloAction('reset');
  assert.equal(restored.solo, null);
  assert.equal(a.snapshot().run, null);
});

test('results chat is explicit, finished-only, connected-only and sent once per run', async t => {
  const r = await room(t);
  r.allowSay = true;
  const a = await r.join();
  assert.throws(() => a.postResults(), /once every/);
  a.start([1, 2], 5);
  await until(() => a.run);
  assert.throws(() => a.postResults(), /once every/);
  r.time += 11000;
  r.goal(1);
  r.event('Release', 2);
  await until(() => a.snapshot().allFinished);
  assert.equal(r.packets.filter(p => p.cmd === 'Say').length, 0, 'finishing never posts automatically');
  a.postResults();
  await until(() => r.packets.filter(p => p.cmd === 'Say').length === 3);
  const messages = r.packets.filter(p => p.cmd === 'Say');
  assert.match(messages[0].text, /Total Group Time: 00:00:06/);
  assert.match(messages[1].text, /Player1 \(Completed\).*Checks: 0.*Longest BK: N\/A/);
  assert.match(messages[2].text, /Player2 \(Released\).*Longest BK: N\/A/);
  assert.ok(messages.every(p => p.text.startsWith('[Race results]') && !/[\p{C}\p{Zl}\p{Zp}]/u.test(p.text)));
  assert.equal(a.snapshot().resultsPosted, true);
  assert.throws(() => a.postResults(), /already been posted/);
  a.disconnect();
  assert.throws(() => a.postResults(), /Connect to/);
  assert.ok(!r.packets.some(p => ['StatusUpdate', 'LocationChecks'].includes(p.cmd)));
});

test('run statistics count unique finder locations and calculate individual and group BK', async t => {
  const r = await room(t);
  const a = await r.join();
  const b = await r.join('Player2');
  r.check(1, 99);
  await new Promise(resolve => setTimeout(resolve, 30));
  a.start([1, 2], 5);
  await until(() => a.run && b.run);
  r.check(1, 100); // Countdown checks do not count.
  await new Promise(resolve => setTimeout(resolve, 30));
  r.time += 7000; // Start + 2s.
  r.check(1, 101, 2);
  await until(() => a.snapshot().stats.checksCompleted === 1 && b.snapshot().stats.checksCompleted === 1);
  r.time += 3000; // Start + 5s.
  r.check(2, 101, 1); // Same location ID in a different world is a distinct check.
  r.check(1, 101, 2); // Duplicate does not move the timestamp.
  await until(() => a.snapshot().stats.checksCompleted === 2 && b.snapshot().stats.checksCompleted === 2);
  r.time += 4000; // Start + 9s.
  r.check(1, 102);
  await until(() => a.snapshot().stats.checksCompleted === 3 && b.snapshot().stats.checksCompleted === 3);
  assert.equal(a.snapshot().stats.longestBKMs, null, 'BK finalizes at finish');
  assert.equal(a.snapshot().players[0].stats.recordedLongestBKMs, 7000, 'recorded gaps are available before finishing');
  assert.equal(a.snapshot().players[0].stats.lastCheckAt, a.run.startedAt + 9000);
  r.time += 1000; // Start + 10s.
  r.goal(1);
  await until(() => a.finishes[1] && b.finishes[1]);
  r.check(1, 103); // Post-goal check is excluded.
  r.time += 2000; // Start + 12s.
  r.event('Release', 2);
  r.check(2, 102); // Release-generated checks are excluded.
  await until(() => a.finishes[2] && b.finishes[2]);
  assert.deepEqual(a.snapshot().players.map(p => p.stats), [
    { checksCompleted: 2, elapsedMs: 10000, longestBKMs: 7000, recordedLongestBKMs: 7000, lastCheckAt: a.run.startedAt + 9000 },
    { checksCompleted: 1, elapsedMs: 12000, longestBKMs: 7000, recordedLongestBKMs: 7000, lastCheckAt: a.run.startedAt + 5000 },
  ]);
  assert.deepEqual(a.snapshot().stats, { checksCompleted: 3, elapsedMs: 12000, longestBKMs: 4000, recordedLongestBKMs: 4000, lastCheckAt: a.run.startedAt + 9000 });
  const late = await r.join();
  assert.deepEqual(late.snapshot().stats, a.snapshot().stats);
  assert.deepEqual(late.snapshot().players, a.snapshot().players);
});

test('no recorded checks uses the entire run as BK; unknown finishes stay unknown', async t => {
  const r = await room(t);
  const a = await r.join();
  a.start([1, 2], 5);
  await until(() => a.run);
  r.time += 11000;
  r.goal(1);
  await until(() => a.finishes[1]);
  assert.deepEqual(a.snapshot().players[0].stats, { checksCompleted: 0, elapsedMs: 6000, longestBKMs: 6000, recordedLongestBKMs: 6000, lastCheckAt: a.run.startedAt });
  a.disconnect();
  r.goal(2);
  const b = await r.join();
  assert.equal(b.snapshot().players[1].stats.longestBKMs, null);
  assert.equal(b.snapshot().stats.longestBKMs, null);
});

test('invalid checks, other teams, and runners outside the selected roster are ignored', async t => {
  const r = await room(t);
  const a = await r.join();
  a.start([1], 5);
  await until(() => a.run);
  r.time += 6000;
  r.check(2, 101);
  r.check(1, -1);
  r.check(1, 'bad');
  a.receive({ cmd: 'PrintJSON', type: 'ItemSend', team: 1, item: { player: 1, location: 101 } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(a.snapshot().stats.checksCompleted, 0);
});

test('ready checks require the same roster and synchronize one server-clock start', async t => {
  const r = await room(t);
  const a = await r.join();
  const b = await r.join('Player2', 'main', 999999);
  assert.throws(() => a.start([1, 2], 5, true), /ready/);
  assert.throws(() => a.ready([2], true), /own player/);
  a.ready([1], true);
  b.ready([1, 2], true);
  await until(() => a.readies[1]?.ready && a.readies[2]?.ready);
  assert.throws(() => a.start([1, 2], 5, true), /ready/);
  a.ready([2, 1], true);
  await until(() => a.isReady(1, [1, 2]) && b.isReady(1, [1, 2]));
  a.start([1, 2], 5, true);
  b.start([1, 2], 10, true);
  await until(() => a.run && b.run);
  assert.equal(a.run.startedAt, b.run.startedAt);
  assert.equal(a.run.requireReady, true);
  assert.ok([5000, 10000].includes(a.run.startedAt - r.time));
  r.time = a.run.startedAt - 1000;
  assert.equal(a.now(), b.now());
  assert.equal(Math.ceil((a.run.startedAt - a.now()) / 1000), 1);
  assert.throws(() => a.ready([1, 2], false), /before/);
  assert.ok(!r.packets.some(p => ['StatusUpdate', 'LocationChecks'].includes(p.cmd)));
});

test('ready confirmations expire, clear on disconnect, and do not cross sessions', async t => {
  const r = await room(t);
  const a = await r.join();
  const b = await r.join('Player2');
  a.ready([1, 2], true); b.ready([1, 2], true);
  await until(() => a.isReady(1, [1, 2]) && a.isReady(2, [1, 2]));
  const other = await r.join('Player1', 'another');
  assert.equal(other.isReady(1, [1, 2]), false);
  r.time += 45001;
  assert.throws(() => a.start([1, 2], 5, true), /ready/);
  a.ready([1, 2], true); b.ready([1, 2], true);
  await until(() => b.isReady(1, [1, 2]) && b.isReady(2, [1, 2]));
  a.disconnect();
  await until(() => b.readies[1]?.ready === false);
  assert.throws(() => b.start([1, 2], 5, true), /ready/);
});

test('start rechecks server readiness instead of trusting a stale notification cache', async t => {
  const r = await room(t);
  const a = await r.join();
  const b = await r.join('Player2');
  a.ready([1, 2], true); b.ready([1, 2], true);
  await until(() => a.isReady(1, [1, 2]) && a.isReady(2, [1, 2]));
  r.beforeReadyRead = () => r.store.set(a.readyKey(2), { ...a.readies[2], ready: false });
  a.start([1, 2], 5, true);
  await until(() => !a.pendingStart);
  assert.equal(a.run, null);
  assert.match(a.message, /Start canceled/);
  assert.equal(a.connection, 'connected');
});

test('personal BK uses only the connected runner, resets on checks, and stops on release', async t => {
  const r = await room(t);
  const a = await r.join();
  const b = await r.join('Player2');
  a.start([1, 2], 5);
  await until(() => a.run && b.run);
  r.time = a.run.startedAt + 299999;
  assert.equal(a.now() - a.snapshot().bk.since, 299999);
  r.time += 1;
  assert.equal(a.now() - a.snapshot().bk.since, 300000);
  r.check(2, 101);
  await until(() => a.checks[2]?.[101]);
  assert.equal(a.now() - a.snapshot().bk.since, 300000, 'someone else checking cannot reset your BK');
  assert.equal(b.now() - b.snapshot().bk.since, 0);
  assert.equal(a.snapshot().runnerBKs.find(p => p.slot === 2).since, r.time);
  assert.equal(a.snapshot().runnerBKs.find(p => p.slot === 1).since, a.run.startedAt);
  r.check(1, 102);
  await until(() => a.checks[1]?.[102]);
  assert.equal(a.now() - a.snapshot().bk.since, 0);
  r.event('Release', 1);
  await until(() => a.releases[1]);
  assert.equal(a.snapshot().bk, null);
  assert.equal(a.snapshot().runnerBKs.some(p => p.slot === 1), false, 'released runners leave the live BK list');
  assert.ok(a.snapshot().events.some(e => e.type === 'release' && e.message.includes('Player1')));
});

test('halfway events need a known total, are strict over-half, and survive reconnect', async t => {
  const r = await room(t);
  r.locationInfo[1] = { checked_locations: [], missing_locations: [101, 102, 103, 104] };
  const a = await r.join();
  a.start([1, 2], 5);
  await until(() => a.run && a.locations[1]);
  r.time += 6000;
  r.check(1, 101); r.check(1, 102);
  await until(() => Object.keys(a.checks[1] || {}).length === 2);
  assert.equal(a.snapshot().events.some(e => e.type === 'half'), false, 'exactly half is not over half');
  r.time += 1000;
  r.check(1, 103);
  r.check(2, 101); r.check(2, 102); r.check(2, 103);
  await until(() => a.halfChecks[1] && Object.keys(a.checks[2] || {}).length === 3);
  const half = a.snapshot().events.filter(e => e.type === 'half');
  assert.equal(half.length, 1, 'unknown player totals never produce guessed percentages');
  assert.match(half[0].message, /Player1.*over half/);
  r.goal(1);
  r.event('Release', 2);
  await until(() => a.snapshot().allFinished);
  assert.ok(a.snapshot().events.some(e => e.type === 'goal'));
  assert.ok(a.snapshot().events.some(e => e.type === 'finish'));
  const late = await r.join('Player2');
  assert.deepEqual(late.snapshot().events, a.snapshot().events);
});

test('release-generated RoomUpdate checks do not create a halfway event', async t => {
  const r = await room(t);
  r.locationInfo[1] = { checked_locations: [], missing_locations: [101, 102] };
  const a = await r.join();
  a.start([1], 5);
  await until(() => a.run && a.locations[1]);
  r.time += 6000;
  a.receive({ cmd: 'PrintJSON', type: 'Release', team: 0, slot: 1 });
  a.receive({ cmd: 'RoomUpdate', checked_locations: [101, 102] });
  await until(() => a.finishes[1]);
  assert.equal(a.snapshot().events.some(e => e.type === 'half'), false);
  assert.equal(a.snapshot().players[0].checkProgress.checked, 0);
});

test('saved-profile roster resolution is applied before following a room countdown', async t => {
  const r = await room(t); r.timerOptions = { resolveRoster: () => [2] };
  const a = await r.join();
  assert.deepEqual(a.selectedSlots, [2]); r.countdown(5);
  await until(() => a.run);
  assert.deepEqual(a.run.players.map(p => p.slot), [2]);
});

test('historical resume rejects the wrong room and a changed shared start without replacing it', async t => {
  const r = await room(t), a = await r.join(); a.start([1, 2], 5); await until(() => a.run);
  const start = a.run.startedAt;
  r.expectedRun = { seed: 'wrong-seed', team: 0, startedAt: start };
  const wrongRoom = await r.join(); assert.equal(wrongRoom.connection, 'error'); assert.match(wrongRoom.message, /original room/);
  r.expectedRun = { seed: 'test-seed', team: 0, startedAt: start + 1 };
  const wrongStart = await r.join(); assert.equal(wrongStart.connection, 'error'); assert.match(wrongStart.message, /historical shared start/);
  assert.equal(r.store.get(a.key).startedAt, start);
  r.expectedRun.startedAt = start;
  const resumed = await r.join(); assert.equal(resumed.run.startedAt, start); assert.equal(resumed.hydrated, true);
});

test('countdown parsing trusts server countdowns and exact announcements, never player chat', () => {
  assert.equal(roomCountdownSeconds({ cmd: 'PrintJSON', type: 'Countdown', countdown: 30 }, 0), 30);
  assert.equal(roomCountdownSeconds({ cmd: 'PrintJSON', type: 'Countdown', countdown: 0 }, 0), 0);
  assert.equal(roomCountdownSeconds({ cmd: 'PrintJSON', type: 'ServerChat', data: [{ text: '[Server]: Starting countdown of ' }, { text: '12s', type: 'text' }] }, 0), 12);
  assert.equal(roomCountdownSeconds({ cmd: 'PrintJSON', data: [{ text: '[Server]: Starting countdown of 3600s' }] }, 0), 3600);
  for (const packet of [null, {},
    { cmd: 'PrintJSON', type: 'Chat', data: [{ text: '[Server]: Starting countdown of 10s' }] },
    { cmd: 'PrintJSON', type: 'CommandResult', data: [{ text: 'Starting countdown of 10s' }] },
    { cmd: 'PrintJSON', data: [{ text: 'Starting countdown of 10s' }] },
    { cmd: 'PrintJSON', data: [{ text: '[Server]: Starting countdown of 10s', type: 'player_id' }] },
    { cmd: 'PrintJSON', type: 'Countdown', countdown: 10, team: 1 },
    { cmd: 'PrintJSON', type: 'ServerChat', message: 'Someone said Starting countdown of 10s' },
    ...[-1, 1.5, '10', 3601, Infinity].map(countdown => ({ cmd: 'PrintJSON', type: 'Countdown', countdown })),
  ]) assert.equal(roomCountdownSeconds(packet, 0), null);
});

test('room countdown starts one shared timer without app ready confirmations; ticks never restart it', async t => {
  const r = await room(t);
  const a = await r.join();
  const b = await r.join('Player2', 'main', 999999);
  const start = r.time + 15000;
  assert.equal(a.isReady(1, [1, 2]), false);
  r.countdown(15);
  r.countdown(15); // AP sends the announcement and first numbered tick together.
  await until(() => a.run && b.run);
  assert.equal(a.run.startedAt, start);
  assert.equal(b.run.startedAt, start);
  assert.equal(a.run.source, 'archipelago-countdown');
  assert.equal(a.run.requireReady, false);
  r.time += 4000;
  r.countdown(11);
  const late = await r.join('Player2');
  assert.equal(late.run.startedAt, start);
  r.time = start;
  r.countdown(0);
  r.time += 60000;
  r.countdown(30);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(a.run.startedAt, start);
  assert.equal(b.run.startedAt, start);
  assert.equal(late.run.startedAt, start);
  assert.equal(a.now(), b.now());
  assert.ok(r.packets.filter(p => p.cmd === 'Set' && p.key === a.key).length <= 2, 'duplicate countdowns do not write new starts');
  assert.ok(!r.packets.some(p => ['Say', 'StatusUpdate', 'LocationChecks'].includes(p.cmd)));
});

test('text-only room announcements follow the selected roster and allow short server countdowns', async t => {
  const r = await room(t);
  const a = await r.join();
  a.select([2]);
  r.broadcast({ cmd: 'PrintJSON', data: [{ text: '[Server]: Starting countdown of ' }, { text: '2s' }] });
  await until(() => a.run);
  assert.equal(a.run.startedAt, r.time + 2000);
  assert.deepEqual(a.run.players.map(p => p.slot), [2]);
  assert.equal(a.run.countdownSeconds, 2);
});

test('room countdown following can be disabled and ordinary chat cannot start the timer', async t => {
  const r = await room(t);
  const a = await r.join();
  a.followCountdown(false);
  r.countdown(10);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(a.run, null);
  a.followCountdown(true);
  r.broadcast({ cmd: 'PrintJSON', type: 'Chat', data: [{ text: '[Server]: Starting countdown of 10s' }] });
  r.countdown(0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(a.run, null);
  r.countdown(9);
  await until(() => a.run);
  assert.equal(a.run.startedAt, r.time + 9000);
});

test('empty selection blocks automatic start and completed runners are excluded', async t => {
  const r = await room(t);
  r.statuses[1] = 30;
  const a = await r.join();
  a.select([]);
  r.countdown(10);
  await until(() => a.message.includes('no eligible'));
  assert.equal(a.run, null);
  a.select([1, 2]);
  r.time += 1000;
  r.countdown(9);
  await until(() => a.run);
  assert.deepEqual(a.run.players.map(p => p.slot), [2]);
  assert.equal(a.run.startedAt, r.time + 9000);
});

test('countdowns received during initial hydration keep their original target start', async t => {
  const r = await room(t);
  r.holdInitial = true;
  const joining = r.join();
  await until(() => r.initialReplies.length);
  const a = r.timers[0];
  const target = r.time + 10000;
  r.countdown(10);
  await until(() => a.pendingCountdown);
  r.time += 3000;
  r.countdown(7);
  r.flushInitial();
  await joining;
  await until(() => a.run);
  assert.equal(a.run.startedAt, target, 'hydration delay must not add extra countdown time');
});

test('saved manual starts win over a countdown received during another observer hydration', async t => {
  const r = await room(t);
  const a = await r.join();
  a.start([1, 2], 5);
  await until(() => a.run);
  const target = a.run.startedAt;
  r.holdInitial = true;
  const joining = r.join('Player2');
  await until(() => r.initialReplies.length);
  const b = r.timers[1];
  r.countdown(30);
  await until(() => b.pendingCountdown);
  r.flushInitial();
  await joining;
  assert.equal(b.run.startedAt, target);
  assert.equal(b.run.source, 'app');
  assert.equal(b.pendingCountdown, null);
});
