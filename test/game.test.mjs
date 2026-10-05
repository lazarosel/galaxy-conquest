import assert from 'node:assert/strict';
import test from 'node:test';
import { createGameHandler } from '../game-core.js';

class MemoryStore {
  rooms = new Map();
  revision = 0;
  reads = [];
  writes = [];

  async getWithMetadata(key, options) {
    assert.equal(options.consistency, 'strong');
    assert.equal(options.type, 'json');
    this.reads.push(options.consistency);
    const value = this.rooms.get(key);
    return value ? { data: structuredClone(value.data), etag: value.etag } : null;
  }

  async setJSON(key, data, options) {
    this.writes.push(options);
    const previous = this.rooms.get(key);
    if (options.onlyIfNew && previous) return { modified: false, etag: previous.etag };
    if (options.onlyIfMatch !== undefined && options.onlyIfMatch !== previous?.etag) {
      return { modified: false, etag: previous?.etag };
    }
    const etag = `"r${++this.revision}"`;
    this.rooms.set(key, { data: structuredClone(data), etag });
    return { modified: true, etag };
  }
}

test('two players finish three rounds with scoring and a single winner', async () => {
  const store = new MemoryStore();
  const handler = createGameHandler({ getStore: () => store, roundsTotal: 3, now: () => 1_000 });
  const call = async (method, body, query = '') => {
    const response = await handler(new Request(`https://game.test/.netlify/functions/game${query}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }));
    const data = response.status === 304 ? null : await response.json();
    assert.ok(response.ok || response.status === 304, JSON.stringify(data));
    return { response, data };
  };
  const action = (code, playerId, name) => async (verb, extra = {}) => call('POST', { code, playerId, action: verb, ...extra });
  const created = await call('POST', { action: 'create', playerId: 'p1', name: 'Nova' });
  const code = created.data.code;
  assert.equal(created.response.status, 201);
  await call('POST', { action: 'join', code, playerId: 'p2', name: 'Orion' });
  const p1 = action(code, 'p1');
  const p2 = action(code, 'p2');
  await p1('start');

  const rounds = [
    { p1: 0, p2: 1, expected: { p1: 1, p2: 1 } },
    { p1: 2, p2: 3, expected: { p1: 2, p2: 2 } },
    { p1: 4, p2: 3, expected: { p1: 3, p2: 2 } },
  ];
  for (let index = 0; index < rounds.length; index += 1) {
    const round = rounds[index];
    if (index > 0) await p1('nextRound');
    await p1('skipNegotiation');
    for (let unit = 0; unit < 5; unit += 1) {
      await p1('place', { sector: round.p1, change: 1 });
      await p2('place', { sector: round.p2, change: 1 });
    }
    await p1('lock');
    await p2('lock');
    const { data: s1 } = await call('GET', null, `?code=${code}&playerId=p1`);
    const { data: s2 } = await call('GET', null, `?code=${code}&playerId=p2`);
    assert.equal(s1.phase, index === 2 ? 'gameover' : 'results');
    assert.equal(s1.round, index + 1);
    assert.deepEqual(s1.lastResolved.score, round.expected);
    assert.equal(s1.players.find((player) => player.id === 'p1').sectors, round.expected.p1);
    assert.equal(s2.players.find((player) => player.id === 'p2').sectors, round.expected.p2);
    assert.equal(s1.lastResolved.orders.p1.reduce((sum, n) => sum + n, 0), 5);
    assert.equal(s1.lastResolved.orders.p2.reduce((sum, n) => sum + n, 0), 5);
  }

  const { data: final } = await call('GET', null, `?code=${code}&playerId=p1`);
  assert.equal(final.winnerId, 'p1');
  assert.equal(final.players.find((player) => player.id === 'p1').sectors, 3);
  assert.equal(final.players.find((player) => player.id === 'p2').sectors, 2);
  assert.ok(store.reads.length > 0);
  assert.ok(store.writes.some((options) => options.onlyIfNew === true));
  assert.ok(store.writes.some((options) => typeof options.onlyIfMatch === 'string'));
});
