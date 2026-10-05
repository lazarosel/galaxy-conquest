import { randomInt, randomUUID } from 'node:crypto';

const MAX_PLAYERS = 8;
const DEFAULT_ROUNDS = 10;
const UNITS = 5;
const SECTOR_COUNT = 12;
const TALK_MS = 8_000;
const DEPLOY_MS = 30_000;
const PRESENCE_TOUCH_MS = 5_000;
const PRESENCE_TIMEOUT_MS = 25_000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = ['#72e4dd', '#ff9d74', '#b1a0ff', '#f4d35e', '#f28ca8', '#78a9ff', '#b6e188', '#ffbd69'];
const SECTOR_NAMES = ['NOVA PRIME', 'THE VEIL', 'HELIOS', 'DUSK REACH', 'KEPLER-9', 'PALE COMET', 'ORION GATE', 'EMBER BELT', 'MIRAGE', 'TITAN’S WAKE', 'LUMEN', 'DEEP FIELD'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanName(value) {
  const result = String(value || 'Pilot').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
  return result || 'Pilot';
}

function makeCode() {
  return Array.from({ length: 5 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
}

function createPlayer(id, name, index, now) {
  return {
    id,
    name: cleanName(name),
    color: COLORS[index % COLORS.length],
    tieOrder: null,
    sectorRounds: 0,
    orders: Array(SECTOR_COUNT).fill(0),
    locked: false,
    lastSeenAt: now,
  };
}

function ownerCounts(room) {
  const counts = Object.fromEntries(room.players.map((player) => [player.id, 0]));
  for (const sector of room.sectors) {
    if (sector.ownerId && counts[sector.ownerId] !== undefined) counts[sector.ownerId] += 1;
  }
  return counts;
}

function playerHasPact(room, playerId) {
  return room.alliances.some((alliance) => alliance.players.includes(playerId));
}

function stateFor(room, viewerId, now) {
  const counts = ownerCounts(room);
  const viewer = room.players.find((player) => player.id === viewerId);
  return {
    code: room.code,
    hostId: room.hostId,
    viewerId,
    phase: room.phase,
    round: room.round,
    roundsTotal: room.roundsTotal || DEFAULT_ROUNDS,
    deadline: room.deadline,
    unitsPerRound: UNITS,
    sectors: room.sectors.map((sector, index) => ({ ...sector, index, name: SECTOR_NAMES[index] })),
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      online: now - player.lastSeenAt <= PRESENCE_TIMEOUT_MS,
      locked: player.locked,
      sectors: counts[player.id] || 0,
      sectorRounds: player.sectorRounds,
    })),
    myOrders: viewer?.orders || Array(SECTOR_COUNT).fill(0),
    myLocked: Boolean(viewer?.locked),
    myAlliance: room.alliances.find((alliance) => alliance.players.includes(viewerId)) || null,
    eligibleAllianceTargets: room.players.filter((player) => player.id !== viewerId && !playerHasPact(room, player.id)).map((player) => player.id),
    incomingOffers: room.allianceOffers.filter((offer) => offer.to === viewerId),
    outgoingOffer: room.allianceOffers.find((offer) => offer.from === viewerId) || null,
    lastResolved: room.lastResolved,
    winnerId: room.winnerId,
  };
}

function shuffle(values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [values[index], values[target]] = [values[target], values[index]];
  }
  return values;
}

function startNegotiation(room, round, now) {
  room.round = round;
  room.phase = 'negotiation';
  room.deadline = now + TALK_MS;
  room.alliances = [];
  room.allianceOffers = [];
  room.players.forEach((player) => {
    player.orders = Array(SECTOR_COUNT).fill(0);
    player.locked = false;
  });
}

function startDeployment(room, now) {
  room.phase = 'deployment';
  room.deadline = now + DEPLOY_MS;
  room.allianceOffers = [];
}

function chooseController(room, contenders, previousOwner) {
  const largest = Math.max(...contenders.map((item) => item.strength));
  const leaders = contenders.filter((item) => item.strength === largest);
  if (leaders.length === 1) {
    const winner = leaders[0];
    if (winner.players.length === 1) return winner.players[0];
    const contributors = winner.players.map((id) => ({ id, units: winner.contributions[id] || 0 }));
    contributors.sort((a, b) => b.units - a.units || room.players.find((player) => player.id === a.id).tieOrder - room.players.find((player) => player.id === b.id).tieOrder);
    return contributors[0].id;
  }
  return previousOwner;
}

function resolveRound(room) {
  if (room.phase !== 'deployment') return;
  const before = room.sectors.map((sector) => sector.ownerId);
  const revealedOrders = Object.fromEntries(room.players.map((player) => [player.id, [...player.orders]]));
  const allianceByTarget = new Map(room.alliances.map((alliance) => [alliance.target, alliance]));
  const changes = [];

  for (let sectorIndex = 0; sectorIndex < SECTOR_COUNT; sectorIndex += 1) {
    const contenders = [];
    const grouped = new Set();
    const alliance = allianceByTarget.get(sectorIndex);
    if (alliance) {
      const [a, b] = alliance.players;
      const playerA = room.players.find((player) => player.id === a);
      const playerB = room.players.find((player) => player.id === b);
      const aUnits = playerA?.orders[sectorIndex] || 0;
      const bUnits = playerB?.orders[sectorIndex] || 0;
      if (aUnits > 0 && bUnits > 0) {
        contenders.push({ players: [a, b], strength: aUnits + bUnits, contributions: { [a]: aUnits, [b]: bUnits } });
        grouped.add(a);
        grouped.add(b);
      }
    }

    for (const player of room.players) {
      if (grouped.has(player.id)) continue;
      const units = player.orders[sectorIndex];
      if (units > 0) contenders.push({ players: [player.id], strength: units, contributions: { [player.id]: units } });
    }

    if (!contenders.length) continue;
    const oldOwner = room.sectors[sectorIndex].ownerId;
    const largest = Math.max(...contenders.map((item) => item.strength));
    const leaders = contenders.filter((item) => item.strength === largest);
    const newOwner = leaders.length === 1 ? chooseController(room, leaders, oldOwner) : oldOwner;
    if (newOwner !== oldOwner) {
      room.sectors[sectorIndex].ownerId = newOwner;
      changes.push({ sector: sectorIndex, from: oldOwner, to: newOwner, strength: largest, contested: false });
    } else if (leaders.length > 1) {
      changes.push({ sector: sectorIndex, from: oldOwner, to: oldOwner, strength: largest, contested: true });
    }
  }

  const counts = ownerCounts(room);
  room.players.forEach((player) => { player.sectorRounds += counts[player.id] || 0; });
  room.lastResolved = {
    round: room.round,
    before,
    after: room.sectors.map((sector) => sector.ownerId),
    orders: revealedOrders,
    changes,
    score: counts,
  };
  room.deadline = null;

  if (room.round === room.roundsTotal) {
    const ranking = [...room.players].sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0) || b.sectorRounds - a.sectorRounds || a.tieOrder - b.tieOrder);
    room.winnerId = ranking[0]?.id || null;
    room.phase = 'gameover';
  } else {
    room.phase = 'results';
  }
}

function advanceDuePhase(room, now) {
  if (!room.deadline || now < room.deadline) return false;
  if (room.phase === 'negotiation') {
    startDeployment(room, now);
    return true;
  }
  if (room.phase === 'deployment') {
    resolveRound(room);
    return true;
  }
  return false;
}

function findPlayer(room, playerId) {
  const player = room.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new HttpError(403, 'That player is not in this room.');
  return player;
}

function requireHost(room, playerId) {
  findPlayer(room, playerId);
  if (room.hostId !== playerId) throw new HttpError(403, 'Only the room host can do that.');
}

function handleAction(room, body, now) {
  const player = findPlayer(room, body.playerId);
  switch (body.action) {
    case 'start': {
      requireHost(room, player.id);
      if (room.phase !== 'lobby') throw new HttpError(409, 'This game has already started.');
      if (room.players.length < 2) throw new HttpError(409, 'Invite at least one more player to start.');
      shuffle(room.players).forEach((candidate, index) => { candidate.tieOrder = index; });
      startNegotiation(room, 1, now);
      break;
    }
    case 'skipNegotiation': {
      requireHost(room, player.id);
      if (room.phase !== 'negotiation') throw new HttpError(409, 'Negotiation is already over.');
      startDeployment(room, now);
      break;
    }
    case 'offerAlliance': {
      if (room.phase !== 'negotiation') throw new HttpError(409, 'Alliances can only be made during negotiation.');
      const target = room.players.find((candidate) => candidate.id === body.targetId);
      const sector = Number(body.sector);
      if (!target || target.id === player.id) throw new HttpError(400, 'Choose another player.');
      if (!Number.isInteger(sector) || sector < 0 || sector >= SECTOR_COUNT) throw new HttpError(400, 'Choose a valid sector.');
      if (playerHasPact(room, player.id) || playerHasPact(room, target.id)) throw new HttpError(409, 'A player can have one alliance per round.');
      room.allianceOffers = room.allianceOffers.filter((offer) => offer.from !== player.id && offer.to !== player.id && offer.to !== target.id);
      room.allianceOffers.push({ id: randomUUID(), from: player.id, to: target.id, target: sector });
      break;
    }
    case 'respondAlliance': {
      if (room.phase !== 'negotiation') throw new HttpError(409, 'Alliances can only be made during negotiation.');
      const offer = room.allianceOffers.find((candidate) => candidate.id === body.offerId && candidate.to === player.id);
      if (!offer) throw new HttpError(404, 'That offer is no longer available.');
      room.allianceOffers = room.allianceOffers.filter((candidate) => candidate.id !== offer.id);
      if (body.accept) {
        if (playerHasPact(room, player.id) || playerHasPact(room, offer.from)) throw new HttpError(409, 'A player can have one alliance per round.');
        room.alliances.push({ players: [offer.from, offer.to], target: offer.target });
      }
      break;
    }
    case 'place': {
      if (room.phase !== 'deployment') throw new HttpError(409, 'Fleet orders are closed.');
      if (player.locked) throw new HttpError(409, 'Your fleet is already locked.');
      const sector = Number(body.sector);
      const change = Number(body.change);
      if (!Number.isInteger(sector) || sector < 0 || sector >= SECTOR_COUNT || ![-1, 1].includes(change)) throw new HttpError(400, 'Invalid fleet order.');
      const total = player.orders.reduce((sum, count) => sum + count, 0);
      if (change > 0 && total >= UNITS) throw new HttpError(409, `You have assigned all ${UNITS} fleet units.`);
      if (change < 0 && player.orders[sector] <= 0) throw new HttpError(409, 'There is no fleet unit to remove from that sector.');
      player.orders[sector] += change;
      break;
    }
    case 'lock': {
      if (room.phase !== 'deployment') throw new HttpError(409, 'Fleet orders are closed.');
      if (player.orders.reduce((sum, count) => sum + count, 0) !== UNITS) throw new HttpError(409, `Assign all ${UNITS} fleet units before locking.`);
      player.locked = true;
      if (room.players.every((candidate) => candidate.locked)) resolveRound(room);
      break;
    }
    case 'nextRound': {
      requireHost(room, player.id);
      if (room.phase !== 'results') throw new HttpError(409, 'There are no results to advance from.');
      startNegotiation(room, room.round + 1, now);
      break;
    }
    default:
      throw new HttpError(400, 'Unknown game action.');
  }
}

function createRoom(code, playerId, name, now, roundsTotal) {
  return {
    code,
    hostId: playerId,
    players: [createPlayer(playerId, name, 0, now)],
    phase: 'lobby',
    round: 0,
    roundsTotal,
    deadline: null,
    sectors: Array.from({ length: SECTOR_COUNT }, () => ({ ownerId: null })),
    alliances: [],
    allianceOffers: [],
    lastResolved: null,
    winnerId: null,
  };
}

function responseJson(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

export function createGameHandler({ getStore, roundsTotal = DEFAULT_ROUNDS, now = () => Date.now() }) {
  async function updateRoom(code, playerId, mutate) {
    const store = getStore();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const entry = await store.getWithMetadata(code, { type: 'json', consistency: 'strong' });
      if (!entry?.data) throw new HttpError(404, 'Room code not found. Check it and try again.');
      const room = entry.data;
      const currentTime = now();
      let changed = advanceDuePhase(room, currentTime);
      if (playerId) {
        const player = findPlayer(room, playerId);
        if (currentTime - player.lastSeenAt >= PRESENCE_TOUCH_MS) {
          player.lastSeenAt = currentTime;
          changed = true;
        }
      }
      const result = mutate ? mutate(room, currentTime) : undefined;
      if (mutate) changed = true;
      if (!changed) return { room, etag: entry.etag, result };
      const write = await store.setJSON(code, room, { onlyIfMatch: entry.etag });
      if (write.modified) return { room, etag: write.etag, result };
    }
    throw new HttpError(409, 'The room changed at the same time. Please try again.');
  }

  async function createNewRoom(body) {
    const playerId = String(body.playerId || randomUUID()).slice(0, 80);
    const name = cleanName(body.name);
    const store = getStore();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = makeCode();
      const room = createRoom(code, playerId, name, now(), roundsTotal);
      const write = await store.setJSON(code, room, { onlyIfNew: true });
      if (write.modified) return { code, playerId };
    }
    throw new HttpError(503, 'Could not create a room. Please try again.');
  }

  async function joinRoom(body) {
    const code = String(body.code || '').trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) throw new HttpError(400, 'Enter a valid five-character room code.');
    const playerId = String(body.playerId || randomUUID()).slice(0, 80);
    const name = cleanName(body.name);
    await updateRoom(code, null, (room, currentTime) => {
      const existing = room.players.find((player) => player.id === playerId);
      if (existing) {
        existing.name = name || existing.name;
        existing.lastSeenAt = currentTime;
        return;
      }
      if (room.phase !== 'lobby') throw new HttpError(409, 'This game has already started.');
      if (room.players.length >= MAX_PLAYERS) throw new HttpError(409, 'This room is full.');
      room.players.push(createPlayer(playerId, name, room.players.length, currentTime));
    });
    return { code, playerId };
  }

  return async function game(request) {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url);
        const code = (url.searchParams.get('code') || '').trim().toUpperCase();
        const playerId = url.searchParams.get('playerId') || '';
        if (!playerId) throw new HttpError(400, 'Missing player ID.');
        const { room, etag } = await updateRoom(code, playerId);
        const headers = etag ? { etag } : {};
        if (etag && request.headers.get('if-none-match') === etag) {
          return new Response(null, { status: 304, headers: { 'cache-control': 'no-store', ...headers } });
        }
        return responseJson(stateFor(room, playerId, now()), 200, headers);
      }

      if (request.method !== 'POST') return responseJson({ error: 'Method not allowed.' }, 405, { allow: 'GET, POST' });
      const body = await request.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Invalid request body.');
      if (body.action === 'create') return responseJson(await createNewRoom(body), 201);
      if (body.action === 'join') return responseJson(await joinRoom(body));

      const code = String(body.code || '').trim().toUpperCase();
      const playerId = String(body.playerId || '');
      if (!playerId) throw new HttpError(400, 'Missing player ID.');
      const { room, etag } = await updateRoom(code, playerId, (currentRoom, currentTime) => handleAction(currentRoom, body, currentTime));
      return responseJson({ ok: true }, 200, etag ? { etag } : {});
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500;
      const message = error instanceof SyntaxError ? 'Invalid JSON request body.' : status === 500 ? 'The game service could not complete that request.' : error.message;
      return responseJson({ error: message }, status);
    }
  };
}
