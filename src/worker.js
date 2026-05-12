// ===== Constants =====
const PHASES = {
  LOBBY: "lobby",
  BIDDING: "bidding",
  REVEAL: "reveal",
};
const MAX_PLAYERS = 8;
const GRACE_MS = 15_000;

// 35-card deck. Values picked to mirror the well-known Coyote-style sum game
// but the name / art / packaging are our own (rules / math are not copyrightable).
const CARD_TEMPLATE = [
  // negatives
  { count: 1, kind: "num", value: -10 },
  { count: 2, kind: "num", value: -5 },
  // zeros
  { count: 3, kind: "num", value: 0 },
  // low positives
  { count: 4, kind: "num", value: 1 },
  { count: 4, kind: "num", value: 2 },
  { count: 4, kind: "num", value: 3 },
  { count: 3, kind: "num", value: 4 },
  { count: 3, kind: "num", value: 5 },
  // high positives
  { count: 2, kind: "num", value: 10 },
  { count: 2, kind: "num", value: 15 },
  { count: 1, kind: "num", value: 20 },
  // specials
  { count: 2, kind: "double" },   // ×2: doubles the final sum
  { count: 2, kind: "maxzero" },  // MAX→0: removes the highest number from the sum
  { count: 2, kind: "draw" },     // ?: draw 1 extra from the deck and add to play
];

function buildDeck() {
  const deck = [];
  for (const tpl of CARD_TEMPLATE) {
    for (let i = 0; i < tpl.count; i++) {
      const c = { kind: tpl.kind };
      if (tpl.kind === "num") c.value = tpl.value;
      deck.push(c);
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Resolve all cards in play (including "?" draws) and compute the final sum.
// Order of operations: nums + extras → MAX→0 removal → ×2 multiplication.
function resolveRound(orderedIds, players, deck) {
  const inPlay = orderedIds
    .map(id => players.get(id)?.card)
    .filter(Boolean);
  const extras = [];

  // Resolve "?" cards by drawing extras (cascading: extras can also be specials)
  const toProcess = [...inPlay];
  let drawCount = 0;
  for (let i = 0; i < toProcess.length && drawCount < 5; i++) {
    if (toProcess[i].kind === "draw") {
      const extra = deck.pop();
      if (!extra) break;
      extras.push(extra);
      toProcess.push(extra);
      drawCount++;
    }
  }
  const allCards = [...inPlay, ...extras];

  const nums = allCards.filter(c => c.kind === "num");
  const base = nums.reduce((s, c) => s + c.value, 0);

  // MAX→0: subtract the highest number value (one MAX→0 in play is enough;
  // multiple MAX→0 cards still only zero the top card).
  const maxZeroCount = allCards.filter(c => c.kind === "maxzero").length;
  let maxValRemoved = 0;
  let sumAfterMaxZero = base;
  if (maxZeroCount > 0 && nums.length > 0) {
    maxValRemoved = Math.max(...nums.map(c => c.value));
    sumAfterMaxZero = base - maxValRemoved;
  }

  // ×2: compound (each ×2 doubles again).
  const doubleCount = allCards.filter(c => c.kind === "double").length;
  let finalSum = sumAfterMaxZero;
  for (let i = 0; i < doubleCount; i++) finalSum *= 2;

  return {
    sum: finalSum,
    extras,
    breakdown: { base, maxZeroCount, maxValRemoved, sumAfterMaxZero, doubleCount },
  };
}

// ===== Worker entry =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z0-9]{4,6}$/.test(room)) {
        return new Response("Invalid room code", { status: 400 });
      }
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// ===== GameRoom Durable Object =====
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
    this.players = new Map(); // playerId -> { name, card, drinkCount, removeTimer }
    this.phase = PHASES.LOBBY;
    this.hostId = null;
    this.timer = null;
    this.lastResult = null;
    this.order = [];               // turn order for the current round
    this.currentBidderIdx = 0;     // index into this.order
    this.currentBid = null;        // { playerId, value } or null
    this.starterId = null;         // who starts the next round (= last loser)
    this.deck = null;              // remaining deck after deal (for "?" draws)
  }

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "").trim().slice(0, 20);
    const clientId = (url.searchParams.get("clientId") || "").trim();
    if (!name) return new Response("Missing name", { status: 400 });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) {
      return new Response("Missing or invalid clientId", { status: 400 });
    }

    const existing = this.players.get(clientId);

    let rejectCode = 0;
    let rejectReason = "";
    if (!existing) {
      if (this.players.size >= MAX_PLAYERS) {
        rejectCode = 4030; rejectReason = "Room full";
      } else if (this.phase !== PHASES.LOBBY && this.phase !== PHASES.REVEAL) {
        // Allow joining in LOBBY or between-rounds (REVEAL). Rejoin during active
        // bidding is only for clients we already know (existing seat).
        rejectCode = 4023; rejectReason = "Game in progress";
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (rejectCode) {
      try { server.close(rejectCode, rejectReason); } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }

    if (existing) {
      if (existing.removeTimer) {
        clearTimeout(existing.removeTimer);
        existing.removeTimer = null;
      }
      existing.name = name;
    } else {
      this.players.set(clientId, {
        name,
        card: null,
        drinkCount: 0,
        removeTimer: null,
      });
      if (!this.hostId) this.hostId = clientId;
    }

    const prior = existing ? this.sessions.get(clientId) : null;
    this.sessions.set(clientId, { ws: server, playerId: clientId });

    server.addEventListener("message", async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      await this.handleMessage(clientId, msg);
    });
    const onClose = () => {
      const sess = this.sessions.get(clientId);
      if (sess && sess.ws === server) this.handleDisconnect(clientId);
    };
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    if (prior) {
      try { prior.ws.close(4002, "Replaced by new connection"); } catch {}
    }

    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(playerId, msg) {
    switch (msg.type) {
      case "ping": {
        const sess = this.sessions.get(playerId);
        if (sess) {
          try { sess.ws.send(JSON.stringify({ type: "pong" })); } catch {}
        }
        break;
      }
      case "hello": {
        const sess = this.sessions.get(playerId);
        if (sess) {
          try { sess.ws.send(JSON.stringify(this.viewForPlayer(playerId))); } catch {}
        }
        break;
      }
      case "start":
        if (playerId === this.hostId && this.phase === PHASES.LOBBY) {
          if (this.players.size < 2) return;
          this.startRound();
        }
        break;
      case "bid": {
        if (this.phase !== PHASES.BIDDING) return;
        if (this.order[this.currentBidderIdx] !== playerId) return;
        const value = parseInt(msg.value, 10);
        if (!Number.isFinite(value)) return;
        // First bid (currentBid===null) can be any integer; later bids must be strictly higher.
        if (this.currentBid !== null && value <= this.currentBid.value) return;
        this.currentBid = { playerId, value };
        this.currentBidderIdx = (this.currentBidderIdx + 1) % this.order.length;
        this.broadcast();
        break;
      }
      case "bluff": {
        if (this.phase !== PHASES.BIDDING) return;
        if (this.order[this.currentBidderIdx] !== playerId) return;
        if (this.currentBid === null) return; // can't bluff on the opening turn
        this.resolveBluff(playerId);
        break;
      }
      case "next":
        if (playerId === this.hostId && this.phase === PHASES.REVEAL) {
          if (this.players.size < 2) {
            this.resetToLobby();
            return;
          }
          this.startRound();
        }
        break;
    }
  }

  handleDisconnect(clientId) {
    this.sessions.delete(clientId);
    const player = this.players.get(clientId);
    if (!player) return;

    if (this.phase === PHASES.LOBBY) {
      this.removePlayer(clientId);
      this.broadcast();
      return;
    }

    if (player.removeTimer) clearTimeout(player.removeTimer);
    player.removeTimer = setTimeout(() => {
      player.removeTimer = null;
      if (this.sessions.has(clientId)) return; // reconnected during grace
      this.removePlayerFromGame(clientId);
    }, GRACE_MS);
    this.broadcast();
  }

  removePlayerFromGame(clientId) {
    this.removePlayer(clientId);
    // Strip from turn order; adjust currentBidderIdx so the same NEXT player
    // still gets to act.
    const idx = this.order.indexOf(clientId);
    if (idx !== -1) {
      this.order.splice(idx, 1);
      if (this.order.length === 0) {
        this.resetToLobby();
        return;
      }
      if (idx < this.currentBidderIdx) this.currentBidderIdx--;
      if (this.currentBidderIdx >= this.order.length) this.currentBidderIdx = 0;
    }
    if (this.currentBid && this.currentBid.playerId === clientId) {
      // The active declaration was made by a player who's now gone. Drop it so
      // play can resume; whoever's turn it is can open with a fresh bid.
      this.currentBid = null;
    }
    if (this.players.size < 2) {
      this.resetToLobby();
      return;
    }
    this.broadcast();
  }

  removePlayer(clientId) {
    this.players.delete(clientId);
    if (this.hostId === clientId) {
      this.hostId = this.players.keys().next().value || null;
    }
  }

  startRound() {
    this.phase = PHASES.BIDDING;
    this.lastResult = null;
    this.deck = buildDeck();

    // Order: starterId (= last loser) first, then the rest in insertion order.
    const ids = [...this.players.keys()];
    if (this.starterId && ids.includes(this.starterId)) {
      const i = ids.indexOf(this.starterId);
      this.order = [...ids.slice(i), ...ids.slice(0, i)];
    } else {
      this.order = ids;
    }

    for (const id of this.order) {
      this.players.get(id).card = this.deck.pop();
    }

    this.currentBidderIdx = 0;
    this.currentBid = null;
    this.broadcast();
  }

  resolveBluff(challengerId) {
    const declarer = this.currentBid.playerId;
    const declared = this.currentBid.value;
    const res = resolveRound(this.order, this.players, this.deck);

    // Real sum < declared → declarer was bluffing (declarer loses).
    // Real sum ≥ declared → challenge was wrong (challenger loses).
    const loserId = res.sum < declared ? declarer : challengerId;
    this.players.get(loserId).drinkCount += 1;
    this.starterId = loserId;

    this.phase = PHASES.REVEAL;
    this.lastResult = {
      declared,
      declarerId: declarer,
      challengerId,
      sum: res.sum,
      loserId,
      extras: res.extras,
      breakdown: res.breakdown,
      hands: Object.fromEntries(
        this.order
          .filter(id => this.players.has(id))
          .map(id => [id, this.players.get(id).card])
      ),
    };
    this.broadcast();
  }

  resetToLobby() {
    this.phase = PHASES.LOBBY;
    this.clearTimer();
    for (const p of this.players.values()) p.card = null;
    this.lastResult = null;
    this.order = [];
    this.currentBidderIdx = 0;
    this.currentBid = null;
    this.broadcast();
  }

  clearTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  broadcast() {
    for (const [, session] of this.sessions) {
      try {
        session.ws.send(JSON.stringify(this.viewForPlayer(session.playerId)));
      } catch {}
    }
  }

  viewForPlayer(playerId) {
    const isReveal = this.phase === PHASES.REVEAL;
    const players = [...this.players.entries()].map(([id, p]) => {
      const isYou = id === playerId;
      // BIDDING: every other player's card is visible to you, never your own.
      // REVEAL: everyone's card is visible.
      let card = null;
      if (this.phase === PHASES.BIDDING && !isYou) card = p.card;
      if (isReveal) card = p.card;
      return {
        id,
        name: p.name,
        drinkCount: p.drinkCount,
        card,
        isYou,
      };
    });
    return {
      type: "state",
      state: {
        phase: this.phase,
        players,
        hostId: this.hostId,
        you: playerId,
        order: this.order,
        currentBidderId: this.order[this.currentBidderIdx] || null,
        currentBid: this.currentBid,
        result: isReveal ? this.lastResult : null,
      },
    };
  }
}
