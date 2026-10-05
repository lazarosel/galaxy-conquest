const screen = document.querySelector('#screen');
const toastNode = document.querySelector('#toast');
const GAME_ENDPOINT = '/.netlify/functions/game';
const playerId = sessionStorage.getItem('gc-player') || crypto.randomUUID();
sessionStorage.setItem('gc-player', playerId);

let roomCode = sessionStorage.getItem('gc-room') || '';
let playerName = sessionStorage.getItem('gc-name') || '';
let state = null;
let pollTimer = null;
let pollController = null;
let roomEtag = '';
let toastTimeout = null;
let timerLoop = null;
let bootTimeout = null;
let flightCueKey = '';
let flightCueStartedAt = 0;

const SECTOR_POSITIONS = [
  [50, 18], [76, 23], [82, 50], [76, 77], [50, 78], [24, 77], [18, 50], [24, 23],
  [42, 38], [58, 38], [58, 62], [42, 62],
];
const SECTOR_LABEL_SIDES = ['top', 'right', 'right', 'right', 'bottom', 'left', 'left', 'left', 'left', 'right', 'right', 'left'];
const PLANET_COLORS = ['#3cabae', '#498bd1', '#a478ce', '#c07d59', '#d2a451', '#55a995', '#5b91aa', '#bd7187', '#7d9b5e', '#c27f50', '#678fc6', '#a36db4'];

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const playerById = (id) => state?.players.find((player) => player.id === id);
const isHost = () => state?.viewerId === state?.hostId;
const getName = () => document.querySelector('#pilot-name')?.value.trim() || playerName || 'Pilot';

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastNode.classList.remove('show'), 2600);
}

async function post(body) {
  const response = await fetch(GAME_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

function openRoom(code, name) {
  roomCode = code;
  playerName = name;
  sessionStorage.setItem('gc-room', code);
  sessionStorage.setItem('gc-name', name);
  connectRoomPolling();
}

function connectRoomPolling() {
  clearTimeout(pollTimer);
  pollController?.abort();
  roomEtag = '';
  const poll = async () => {
    if (!roomCode) return;
    pollController = new AbortController();
    const query = new URLSearchParams({ code: roomCode, playerId });
    const headers = roomEtag ? { 'if-none-match': roomEtag } : {};
    try {
      const response = await fetch(`${GAME_ENDPOINT}?${query}`, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.any([pollController.signal, AbortSignal.timeout(10000)]),
      });
      if (response.status === 304) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Connection interrupted.');
      roomEtag = response.headers.get('etag') || '';
      state = data;
      render();
    } catch (error) {
      if (error.name !== 'AbortError') {
        if (state) toast('Connection interrupted. Reconnecting…');
        else renderHome(error.message);
      }
    } finally {
      if (roomCode) pollTimer = setTimeout(poll, 850);
    }
  };
  poll();
}

function renderHome(errorMessage = '') {
  clearTimeout(bootTimeout);
  bootTimeout = null;
  clearInterval(timerLoop);
  screen.innerHTML = `
    <div class="home-layout">
      <div class="hero-copy">
        <div class="hero-orb" aria-hidden="true"></div>
        <div class="eyebrow">A hidden-move strategy party game</div>
        <h1>Galaxy <span>Conquest</span></h1>
        <p class="hero-subtitle">Build a fleet. Make a deal. Decide if you’ll keep it. Ten rounds to claim the galaxy.</p>
        <div class="feature-row"><span>2–8 pilots</span><span>secret orders</span><span>one winner</span></div>
      </div>
      <div class="join-panel">
        <div class="eyebrow">Your command begins here</div>
        <h2>Enter the galaxy</h2>
        <p class="panel-hint">Create a room and share the code, or join a friend already waiting.</p>
        <form data-form="create">
          <label class="field-label" for="pilot-name">Pilot name</label>
          <input class="text-field" id="pilot-name" maxlength="18" autocomplete="nickname" placeholder="What should we call you?" value="${escapeHtml(playerName)}" required />
          <button class="button button-primary button-block" type="submit" style="margin-top:12px">Create a room <span aria-hidden="true">↗</span></button>
        </form>
        <div class="divider">OR JOIN WITH A CODE</div>
        <form data-form="join">
          <label class="field-label" for="join-name">Pilot name</label>
          <input class="text-field" id="join-name" maxlength="18" autocomplete="nickname" placeholder="Your name" value="${escapeHtml(playerName)}" required />
          <label class="field-label" for="room-code">Room code</label>
          <div class="join-row">
            <input class="text-field code-field" id="room-code" maxlength="5" autocomplete="off" placeholder="ABCDE" required />
            <button class="button button-secondary" type="submit">Join</button>
          </div>
        </form>
        <p class="form-error">${escapeHtml(errorMessage)}</p>
      </div>
    </div>`;
}

function renderPlayerRows() {
  return state.players.map((player) => `
    <li class="player-row" style="--player:${player.color}">
      <span class="player-dot"></span>
      <span class="player-name">${escapeHtml(player.name)}${player.id === state.viewerId ? ' <span class="player-tag">YOU</span>' : ''}</span>
      ${player.id === state.hostId ? '<span class="player-tag host-tag">HOST</span>' : ''}
      <span class="online-dot ${player.online ? '' : 'offline'}" title="${player.online ? 'Connected' : 'Disconnected'}"></span>
    </li>`).join('');
}

function renderLobby() {
  clearTimeout(bootTimeout);
  bootTimeout = null;
  clearInterval(timerLoop);
  screen.innerHTML = `
    <div class="game-wrap">
      <div class="game-header">
        <div class="game-title"><div class="eyebrow">Flight deck / waiting room</div><h1>Gather your fleet.</h1></div>
        <div class="room-chip"><div><small>ROOM CODE</small><strong>${state.code}</strong></div><button data-action="copy" title="Copy room code" aria-label="Copy room code">⧉</button></div>
      </div>
      <div class="lobby-layout">
        <section class="panel panel-pad">
          <div class="panel-head"><div><h2>Ready room</h2><p>Send the code to your crew. At least two pilots are needed to launch.</p></div><span class="player-count">${state.players.length} / 8 PILOTS</span></div>
          <ul class="player-list">${renderPlayerRows()}</ul>
        </section>
        <aside class="panel panel-pad">
          <div class="eyebrow">Mission brief</div>
          <h2 style="margin-top:7px">Ten rounds. No safe orbit.</h2>
          <div class="invite-code"><div><small>INVITE YOUR CREW</small><strong>${state.code}</strong></div><button class="button button-quiet" data-action="copy">Copy code</button></div>
          <div class="room-steps"><span><b>01</b> Negotiate a pact—or fake one.</span><span><b>02</b> Secretly deploy five fleet units.</span><span><b>03</b> Claim sectors. Keep your promises optional.</span></div>
          ${isHost() ? `<button class="button button-primary button-block" data-action="start" ${state.players.length < 2 ? 'disabled' : ''}>Launch the game <span aria-hidden="true">↗</span></button>` : '<p class="lobby-note">Waiting for the host to launch the game.</p>'}
          <p class="lobby-note">Share the room code with your crew. Each pilot joins from their own device.</p>
        </aside>
      </div>
    </div>`;
}

function renderScoreboard() {
  const sorted = [...state.players].sort((a, b) => b.sectors - a.sectors || b.sectorRounds - a.sectorRounds);
  return sorted.map((player) => `
    <div class="score-row ${player.id === state.viewerId ? 'self-score' : ''}" style="--player:${player.color}">
      <span class="player-dot"></span><span>${escapeHtml(player.name)}${player.id === state.viewerId ? ' · you' : ''}</span><strong>${player.sectors}</strong>
    </div>`).join('');
}

function sectorAllocation(sector) {
  if (!state.lastResolved || !['results', 'gameover'].includes(state.phase)) return '';
  const units = state.players.map((player) => ({ player, count: state.lastResolved.orders[player.id]?.[sector.index] || 0 })).filter((item) => item.count > 0);
  if (!units.length) return '';
  return `<span class="result-detail">${units.map(({ player, count }) => `${escapeHtml(player.name)} ${count}`).join(' · ')}</span>`;
}

function renderSector(sector) {
  const owner = playerById(sector.ownerId);
  const mine = sector.ownerId === state.viewerId;
  const myCount = state.myOrders[sector.index] || 0;
  const assigned = state.myOrders.reduce((sum, count) => sum + count, 0);
  const canEdit = state.phase === 'deployment' && !state.myLocked;
  const target = state.myAlliance?.target === sector.index;
  const cssColor = owner?.color || '#54aeb2';
  const label = owner ? escapeHtml(owner.name) : 'Unclaimed';
  const [x, y] = SECTOR_POSITIONS[sector.index];
  return `
    <article class="sector-node ${mine ? 'is-mine' : ''} ${target ? 'is-target' : ''}" style="--owner-color:${cssColor};--terrain:${PLANET_COLORS[sector.index]};--x:${x}%;--y:${y}%" data-sector="${sector.index}" data-label="${SECTOR_LABEL_SIDES[sector.index]}">
      <div class="planet" aria-hidden="true"><span class="planet-moon"></span></div>
      <div class="sector-meta">
        <div class="sector-top"><span>${String(sector.index + 1).padStart(2, '0')} / SECTOR</span><span class="sector-state">${owner ? 'HELD' : 'OPEN'}</span></div>
        <div class="sector-name">${escapeHtml(sector.name)}</div>
        <div class="sector-owner">${label}</div>
        ${canEdit ? `<div class="sector-controls"><button data-action="place" data-sector="${sector.index}" data-change="-1" ${myCount < 1 ? 'disabled' : ''} aria-label="Remove a fleet from ${escapeHtml(sector.name)}">−</button><span class="fleet-count">${myCount}</span><button data-action="place" data-sector="${sector.index}" data-change="1" ${assigned >= state.unitsPerRound ? 'disabled' : ''} aria-label="Send a fleet to ${escapeHtml(sector.name)}">+</button></div>` : ''}
      </div>
    </article>`;
}

function flightGeometry(player, destination) {
  const [endX, endY] = SECTOR_POSITIONS[destination];
  const previousOwners = state.lastResolved.before || [];
  const owned = previousOwners.map((ownerId, index) => ({ ownerId, index }))
    .filter(({ ownerId, index }) => ownerId === player.id && index !== destination);
  let startX;
  let startY;
  if (owned.length) {
    owned.sort((a, b) => {
      const [ax, ay] = SECTOR_POSITIONS[a.index];
      const [bx, by] = SECTOR_POSITIONS[b.index];
      return Math.hypot(ax - endX, ay - endY) - Math.hypot(bx - endX, by - endY);
    });
    [startX, startY] = SECTOR_POSITIONS[owned[0].index];
  } else {
    const playerIndex = state.players.findIndex((item) => item.id === player.id);
    const angle = (-90 + 360 * playerIndex / state.players.length) * Math.PI / 180;
    startX = 50 + Math.cos(angle) * 48;
    startY = 50 + Math.sin(angle) * 45;
  }
  if (Math.hypot(startX - endX, startY - endY) < 3) {
    startX = 50 + (startX - 50) * 1.28;
    startY = 50 + (startY - 50) * 1.28;
  }
  const playerIndex = state.players.findIndex((item) => item.id === player.id);
  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.hypot(dx, dy) || 1;
  const bend = (playerIndex % 2 ? 1 : -1) * Math.min(12, length * .18);
  const midX = (startX + endX) / 2 + (-dy / length) * bend;
  const midY = (startY + endY) / 2 + (dx / length) * bend;
  return {
    start: { x: startX * 10, y: startY * 6.5 },
    control: { x: midX * 10, y: midY * 6.5 },
    end: { x: endX * 10, y: endY * 6.5 },
  };
}

function renderFleetFlights() {
  if (!state.lastResolved || !['results', 'gameover'].includes(state.phase)) return '';
  const orders = state.lastResolved.orders || {};
  const cueKey = `${state.code}:${state.lastResolved.round}`;
  if (flightCueKey !== cueKey) {
    flightCueKey = cueKey;
    flightCueStartedAt = performance.now();
  }
  const paths = [];
  const ships = [];
  state.players.forEach((player, playerIndex) => {
    (orders[player.id] || []).forEach((count, sectorIndex) => {
      if (!count) return;
      const { start, control, end } = flightGeometry(player, sectorIndex);
      const id = `flight-${playerIndex}-${sectorIndex}`;
      const path = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
      paths.push(`<path id="${id}" d="${path}" class="flight-route" style="--player:${player.color}"/>`);
      ships.push(`<g class="fleet-ship" data-sector="${sectorIndex}" data-start-x="${start.x}" data-start-y="${start.y}" data-control-x="${control.x}" data-control-y="${control.y}" data-end-x="${end.x}" data-end-y="${end.y}" style="--player:${player.color}" opacity="0">
        <path class="ship-trail" d="M -32 0 L -13 0"/>
        <path class="ship-hull" d="M 22 0 L 3 -8 L -16 -6 L -8 0 L -16 6 L 3 8 Z"/>
        <path class="ship-wing" d="M -7 -4 L -16 -12 L 1 -7 M -7 4 L -16 12 L 1 7"/>
        <path class="ship-cockpit" d="M 11 0 L 3 -3 L 1 0 L 3 3 Z"/>
        <circle class="ship-engine" cx="-13" cy="0" r="2.6"/>
        <circle class="ship-counter" cx="-5" cy="14" r="8"/><text class="ship-count" x="-5" y="17">${count}</text>
      </g>`);
    });
  });
  if (!ships.length) return '';
  return `<svg class="flight-layer" viewBox="0 0 1000 650" preserveAspectRatio="none" aria-hidden="true"><defs><filter id="ship-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${paths.join('')}${ships.join('')}</svg>`;
}

function animateFleetFlights() {
  const scene = document.querySelector('.orbital-map');
  if (!scene) return;
  const ships = [...scene.querySelectorAll('.fleet-ship')];
  const startedAt = flightCueStartedAt;
  const launchDelay = 180;
  const duration = 2550;
  const update = (now) => {
    if (!scene.isConnected) return;
    const elapsed = now - startedAt;
    const progress = Math.min(1, Math.max(0, (elapsed - launchDelay) / duration));
    const eased = 1 - Math.pow(1 - progress, 2.2);
    for (const ship of ships) {
      const x0 = Number(ship.dataset.startX), y0 = Number(ship.dataset.startY);
      const cx = Number(ship.dataset.controlX), cy = Number(ship.dataset.controlY);
      const x2 = Number(ship.dataset.endX), y2 = Number(ship.dataset.endY);
      const x = (1 - eased) ** 2 * x0 + 2 * (1 - eased) * eased * cx + eased ** 2 * x2;
      const y = (1 - eased) ** 2 * y0 + 2 * (1 - eased) * eased * cy + eased ** 2 * y2;
      const dx = 2 * (1 - eased) * (cx - x0) + 2 * eased * (x2 - cx);
      const dy = 2 * (1 - eased) * (cy - y0) + 2 * eased * (y2 - cy);
      ship.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1)}) scale(1.35)`);
      ship.setAttribute('opacity', String(Math.min(1, Math.max(0, elapsed / 140))));
    }
    if (progress < 1) requestAnimationFrame(update);
    else {
      for (const ship of ships) {
        const sector = scene.querySelector(`.sector-node[data-sector="${ship.dataset.sector}"]`);
        sector?.classList.add('fleet-arrived');
      }
    }
  };
  requestAnimationFrame(update);
}

function renderDiplomacy() {
  const alliance = state.myAlliance;
  const partner = alliance && playerById(alliance.players.find((id) => id !== state.viewerId));
  const targetSector = alliance && state.sectors[alliance.target];
  const incoming = state.incomingOffers.map((offer) => {
    const sender = playerById(offer.from);
    const sector = state.sectors[offer.target];
    return `<div class="offer"><p><strong>${escapeHtml(sender?.name || 'A pilot')}</strong> offers a pact on <b>${escapeHtml(sector?.name || 'a sector')}</b>.</p><div class="offer-actions"><button class="button button-primary button-small" data-action="respond" data-offer="${offer.id}" data-accept="true">Accept</button><button class="button button-quiet button-small" data-action="respond" data-offer="${offer.id}" data-accept="false">Decline</button></div></div>`;
  }).join('');
  const canOffer = state.phase === 'negotiation' && !alliance && !state.outgoingOffer;
  let content = '';
  if (alliance) {
    const active = ['negotiation', 'deployment'].includes(state.phase);
    content = `<div class="pact-box"><strong>PACT ${active ? 'ACTIVE' : 'CLOSED'} · ROUND ${state.round}</strong><p>You and ${escapeHtml(partner?.name || 'your partner')} ${active ? 'can combine fleets' : 'made a pact'} at ${escapeHtml(targetSector?.name || 'the selected sector')}. A deal is only as good as its follow-through.</p></div>`;
  } else if (state.outgoingOffer) {
    const recipient = playerById(state.outgoingOffer.to);
    const sector = state.sectors[state.outgoingOffer.target];
    content += `<div class="offer"><p>Pact offered to <strong>${escapeHtml(recipient?.name || 'a pilot')}</strong> for <b>${escapeHtml(sector?.name || 'a sector')}</b>. Your orders remain secret.</p></div>`;
  } else if (state.phase === 'negotiation') {
    content += `<p class="mini-muted">Offer one player a one-round pact. If both send fleets to the agreed sector, your strength combines. The larger contributor claims it if you win.</p>`;
  } else {
    content += `<p class="mini-muted">Pacts expire after each round. Next round brings a new chance to deal—or deceive.</p>`;
  }
  if (incoming) content += incoming;
  if (canOffer) {
    const eligible = new Set(state.eligibleAllianceTargets || []);
    const others = state.players.filter((player) => eligible.has(player.id));
    if (others.length) {
      content += `<form class="diplomacy-form" data-form="alliance">
        <label for="ally-target">Propose a pact to</label>
        <select class="select-field" id="ally-target" name="targetId">${others.map((player) => `<option value="${player.id}">${escapeHtml(player.name)}</option>`).join('')}</select>
        <label for="ally-sector">Shared target</label>
        <select class="select-field" id="ally-sector" name="sector">${state.sectors.map((sector) => `<option value="${sector.index}">${escapeHtml(sector.name)}</option>`).join('')}</select>
        <button class="button button-secondary button-small" type="submit">Propose alliance</button>
      </form>`;
    } else {
      content += '<p class="mini-muted">Every other pilot is already in a pact this round.</p>';
    }
  }
  return content;
}

function renderRoundPanel() {
  const labels = {
    negotiation: ['NEGOTIATION', 'Make an alliance offer, or wait for the deployment window.'],
    deployment: ['SECRET DEPLOYMENT', state.myLocked ? 'Fleet locked. Waiting for the other pilots.' : 'Assign all five fleet units, then lock your orders.'],
    results: ['ROUND RESOLVED', 'The board has changed. Host can launch the next round.'],
    gameover: ['GAME OVER', 'Ten rounds are complete. The galaxy has a new ruler.'],
  };
  const [label, detail] = labels[state.phase];
  return `<div class="round-strip"><div class="round-left"><div class="round-number">${String(state.round).padStart(2, '0')}<small> / ${state.roundsTotal}</small></div><div><div class="phase-title">${label}</div><div class="phase-detail">${detail}</div></div></div><div class="timer" id="timer">--:--</div></div>`;
}

function renderResultBanner() {
  if (!['results', 'gameover'].includes(state.phase) || !state.lastResolved) return '';
  const changed = state.lastResolved.changes.filter((change) => change.from !== change.to);
  const report = changed.length
    ? changed.map((change) => `${escapeHtml(state.sectors[change.sector].name)}: ${escapeHtml(playerById(change.to)?.name || 'Unclaimed')}`).join(' · ')
    : 'No sector changed hands this round.';
  if (state.phase === 'gameover') {
    const winner = playerById(state.winnerId);
    const winnerScore = winner?.sectors || 0;
    const tieBreakUsed = state.players.filter((player) => player.sectors === winnerScore).length > 1;
    return `<div class="result-banner gameover-banner"><div><strong>✦ ${escapeHtml(winner?.name || 'A pilot')} wins the galaxy</strong><div class="result-detail">${winnerScore} sectors controlled${tieBreakUsed ? ' · tiebreaks settled it' : ''}</div></div><span>ONE WINNER</span></div>`;
  }
  return `<div class="result-banner"><div><strong>Round ${state.round} revealed</strong><div class="result-detail">${report}</div></div><span>ORDERS UNSEALED</span></div>`;
}

function renderSidePanel() {
  const diplomacy = state.phase === 'negotiation' || state.myAlliance || state.incomingOffers.length || state.outgoingOffer;
  return `<aside class="sidebar">
    <section class="panel"><div class="sidebar-heading"><h2>Territory standings</h2><span>SECTORS</span></div><div class="score-list">${renderScoreboard()}</div></section>
    ${diplomacy ? `<section class="panel"><div class="sidebar-heading"><h2>Diplomacy</h2><span>${state.phase === 'negotiation' ? 'PRIVATE PACTS' : 'THIS ROUND'}</span></div>${renderDiplomacy()}</section>` : ''}
    <section class="panel"><div class="sidebar-heading"><h2>Command status</h2><span>${state.players.filter((p) => p.locked).length}/${state.players.length} LOCKED</span></div>
      <p class="mini-muted">${state.phase === 'negotiation' ? 'Your deployments stay hidden until the whole round resolves.' : state.phase === 'deployment' ? 'No one can see how you split your five units.' : 'Territory points are counted from the sectors you control.'}</p>
      ${state.phase === 'results' && isHost() ? `<button class="button button-primary button-block button-small" data-action="next">Begin round ${state.round + 1} ↗</button>` : ''}
      ${state.phase === 'gameover' ? '<p class="mini-muted">The room stays open for review. Refreshing the page will reconnect you.</p>' : ''}
    </section>
  </aside>`;
}

function renderGame() {
  clearTimeout(bootTimeout);
  bootTimeout = null;
  const assigned = state.myOrders.reduce((sum, count) => sum + count, 0);
  const canLock = state.phase === 'deployment' && !state.myLocked && assigned === state.unitsPerRound;
  const needsLock = state.phase === 'deployment' && !state.myLocked;
  const allLocked = state.players.every((player) => player.locked);
  const hostAction = state.phase === 'negotiation' && isHost() ? '<button class="button button-quiet button-small" data-action="skip-talk">Skip talk</button>' : '';
  let rightAction = '';
  if (needsLock) rightAction = `<button class="button button-primary button-small" data-action="lock" ${canLock ? '' : 'disabled'}>Lock fleet</button>`;
  else if (state.phase === 'deployment') rightAction = `<span class="mini-muted">${allLocked ? 'Resolving…' : 'Orders locked'}</span>`;
  else if (state.phase === 'results' && isHost()) rightAction = `<button class="button button-primary button-small" data-action="next">Next round ↗</button>`;
  const resultOrders = ['results', 'gameover'].includes(state.phase) && state.lastResolved
    ? `<div class="result-orders"><h3>LAST ROUND · FLEET ORDERS REVEALED</h3>${state.players.map((player) => {
      const deployed = state.lastResolved.orders[player.id] || [];
      const line = deployed.map((count, index) => count ? `${state.sectors[index].name} ${count}` : '').filter(Boolean).join(' · ') || 'No fleets deployed';
      return `<div class="result-line"><b style="color:${player.color}">${escapeHtml(player.name)}</b> — ${escapeHtml(line)}</div>`;
    }).join('')}</div>` : '';
  screen.innerHTML = `
    <div class="game-wrap">
      <div class="game-header">
        <div class="game-title"><div class="eyebrow">Fleet command / ${state.players.length} pilots online</div><h1>Claim your orbit.</h1></div>
        <div class="room-chip"><div><small>ROOM CODE</small><strong>${state.code}</strong></div><button data-action="copy" title="Copy room code" aria-label="Copy room code">⧉</button></div>
      </div>
      ${renderResultBanner()}
      ${renderRoundPanel()}
      <div class="game-layout">
        <section class="main-game">
          <div class="orbital-map" aria-label="Galaxy map showing twelve sectors around the galactic core">
            <div class="nebula-cloud cloud-one"></div><div class="nebula-cloud cloud-two"></div>
            <div class="orbit-ring orbit-outer"></div><div class="orbit-ring orbit-inner"></div>
            <div class="galactic-core"><span></span><small>GALACTIC CORE</small></div>
            ${state.sectors.map(renderSector).join('')}
            ${renderFleetFlights()}
          </div>
          ${state.phase === 'deployment' ? `<div class="allocation-bar"><span class="units-left">FLEET REMAINING <strong>${state.unitsPerRound - assigned}</strong> / ${state.unitsPerRound}</span><div>${rightAction}</div></div>` : ''}
          ${hostAction ? `<div style="display:flex;justify-content:flex-end;margin-top:9px">${hostAction}</div>` : ''}
          ${resultOrders}
        </section>
        ${renderSidePanel()}
      </div>
    </div>`;
  animateFleetFlights();
  startTimer();
}

function render() {
  if (!state) return renderHome();
  if (state.phase === 'lobby') return renderLobby();
  return renderGame();
}

function startTimer() {
  clearInterval(timerLoop);
  const tick = () => {
    const timer = document.querySelector('#timer');
    if (!timer) return;
    if (!state.deadline) {
      timer.textContent = state.phase === 'gameover' ? 'DONE' : '—';
      return;
    }
    const remaining = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    timer.textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    timer.style.color = remaining <= 5 ? 'var(--coral)' : '';
  };
  tick();
  timerLoop = setInterval(tick, 250);
}

async function doAction(action, extra = {}) {
  try {
    await post({ code: roomCode, playerId, action, ...extra });
  } catch (error) {
    toast(error.message);
  }
}

screen.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  if (kind === 'alliance') {
    const data = new FormData(form);
    await doAction('offerAlliance', { targetId: data.get('targetId'), sector: Number(data.get('sector')) });
    return;
  }
  const name = kind === 'create' ? document.querySelector('#pilot-name').value.trim() : document.querySelector('#join-name').value.trim();
  if (!name) return toast('Add a pilot name first.');
  try {
    playerName = name.slice(0, 18);
    if (kind === 'create') {
      const result = await post({ action: 'create', playerId, name: playerName });
      openRoom(result.code, playerName);
    } else {
      const code = document.querySelector('#room-code').value.trim().toUpperCase();
      const result = await post({ action: 'join', code, playerId, name: playerName });
      openRoom(result.code, playerName);
    }
  } catch (error) {
    renderHome(error.message);
  }
});

screen.addEventListener('input', (event) => {
  if (event.target.id === 'room-code') event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
});

screen.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(state.code);
      toast('Room code copied.');
    } catch {
      toast(`Room code: ${state.code}`);
    }
  } else if (action === 'place') {
    await doAction('place', { sector: Number(button.dataset.sector), change: Number(button.dataset.change) });
  } else if (action === 'lock') {
    await doAction('lock');
  } else if (action === 'start') {
    await doAction('start');
  } else if (action === 'skip-talk') {
    await doAction('skipNegotiation');
  } else if (action === 'next') {
    await doAction('nextRound');
  } else if (action === 'respond') {
    await doAction('respondAlliance', { offerId: button.dataset.offer, accept: button.dataset.accept === 'true' });
  }
});

async function reconnectSavedRoom() {
  if (!roomCode || !playerName) return renderHome();
  try {
    const result = await post({ action: 'join', code: roomCode, playerId, name: playerName });
    openRoom(result.code, playerName);
  } catch (error) {
    sessionStorage.removeItem('gc-room');
    roomCode = '';
    const missingRoom = /room code not found/i.test(error.message);
    renderHome(missingRoom
      ? 'Your previous room is no longer available. Create a new room or join one with a fresh code.'
      : 'Could not reconnect. Check your connection, then try again.');
  }
}

bootTimeout = setTimeout(() => {
  if (screen.querySelector('.loading')) {
    sessionStorage.removeItem('gc-room');
    roomCode = '';
    renderHome('Reconnecting took too long. Create a new room or try joining again.');
  }
}, 6000);

reconnectSavedRoom();
