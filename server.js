'use strict';

/**
 * WebDial signaling server.
 *
 * The server never touches audio. It only:
 *   1. hands every browser a phone-style number,
 *   2. relays WebRTC offers / answers / ICE candidates between two numbers,
 *   3. tracks call state (ringing / active) so it can report busy, offline,
 *      no-answer and disconnects.
 * Audio then flows peer-to-peer between the browsers.
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const NUMBER_RE = /^\d{6}$/;
const DIAL_RE = /^\d{1,15}$/;
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_SDP_LENGTH = 20000;
const MAX_CANDIDATE_LENGTH = 2000;
const CALL_RATE_WINDOW_MS = 10000;
const CALL_RATE_MAX = 5;

function loadIceServers(env) {
  if (env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(env.ICE_SERVERS);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      console.warn('[webdial] ICE_SERVERS is not valid JSON; using defaults');
    }
  }
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (env.TURN_URL) {
    servers.push({
      urls: env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean),
      username: env.TURN_USERNAME,
      credential: env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

function isValidDescription(desc, type) {
  return Boolean(desc)
    && typeof desc === 'object'
    && desc.type === type
    && typeof desc.sdp === 'string'
    && desc.sdp.length > 0
    && desc.sdp.length <= MAX_SDP_LENGTH;
}

function sanitizeCandidate(c) {
  if (!c || typeof c !== 'object' || typeof c.candidate !== 'string') return null;
  if (c.candidate.length > MAX_CANDIDATE_LENGTH) return null;
  return {
    candidate: c.candidate,
    sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid : null,
    sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
    usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment : null,
  };
}

function createServer({ env = process.env, ringTimeoutMs } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 1e5,
    cors: env.CORS_ORIGIN ? { origin: env.CORS_ORIGIN.split(',') } : undefined,
  });

  const iceServers = loadIceServers(env);
  const ringTimeout = ringTimeoutMs ?? (Number(env.RING_TIMEOUT_MS) || 45000);

  /** number -> { socketId, deviceId } */
  const users = new Map();
  /** number -> session { caller, callee, state: 'ringing' | 'active', timer } (both parties map to the same object) */
  const calls = new Map();

  // ---------- HTTP ----------
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        + "media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; "
        + "base-uri 'self'; form-action 'self'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    next();
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', online: users.size, activeCalls: calls.size / 2, uptime: Math.round(process.uptime()) });
  });
  app.get('/api/config', (req, res) => res.json({ iceServers }));
  app.use(express.static(path.join(__dirname, 'public')));

  // ---------- helpers ----------
  const emitTo = (number, event, data) => {
    const user = users.get(number);
    if (user) io.to(user.socketId).emit(event, data);
  };

  const peerOf = (number) => {
    const s = calls.get(number);
    if (!s) return null;
    return s.caller === number ? s.callee : s.caller;
  };

  const endSession = (session) => {
    clearTimeout(session.timer);
    calls.delete(session.caller);
    calls.delete(session.callee);
  };

  function generateNumber() {
    for (let i = 0; i < 1000; i += 1) {
      const n = String(crypto.randomInt(100000, 1000000));
      if (!users.has(n)) return n;
    }
    throw new Error('number space exhausted');
  }

  /** Free a number, ending any call it is part of. */
  function releaseNumber(number, { replaced = false } = {}) {
    const holder = users.get(number);
    if (!holder) return;
    const session = calls.get(number);
    if (session) {
      const peer = peerOf(number);
      endSession(session);
      emitTo(peer, 'call-ended', { from: number, reason: 'disconnected' });
    }
    users.delete(number);
    const oldSocket = io.sockets.sockets.get(holder.socketId);
    if (oldSocket) {
      oldSocket.data.number = null;
      if (replaced) oldSocket.emit('session-replaced');
    }
  }

  /** Wraps a handler so a missing ack or a thrown error can't crash the server. */
  const safe = (fn) => (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      fn(payload && typeof payload === 'object' ? payload : {}, reply);
    } catch (err) {
      console.error('[webdial] handler error', err);
      reply({ ok: false, error: 'server-error' });
    }
  };

  // ---------- sockets ----------
  io.on('connection', (socket) => {
    socket.data.number = null;
    socket.data.callTimes = [];

    socket.on('register', safe((payload, reply) => {
      if (socket.data.number) return reply({ ok: true, number: socket.data.number });

      const deviceId = typeof payload.deviceId === 'string' && DEVICE_RE.test(payload.deviceId) ? payload.deviceId : null;
      const requested = typeof payload.number === 'string' && NUMBER_RE.test(payload.number) ? payload.number : null;

      let number = null;
      if (requested) {
        const holder = users.get(requested);
        if (!holder) {
          number = requested;
        } else if (!io.sockets.sockets.has(holder.socketId) || (deviceId && holder.deviceId === deviceId)) {
          // Stale socket, or the same browser reconnecting / opening a new tab: take the number over.
          releaseNumber(requested, { replaced: true });
          number = requested;
        }
      }
      if (!number) number = generateNumber();

      users.set(number, { socketId: socket.id, deviceId });
      socket.data.number = number;
      return reply({ ok: true, number });
    }));

    socket.on('call', safe(({ to, offer }, reply) => {
      const me = socket.data.number;
      if (!me) return reply({ ok: false, error: 'not-registered' });

      const now = Date.now();
      socket.data.callTimes = socket.data.callTimes.filter((t) => now - t < CALL_RATE_WINDOW_MS);
      if (socket.data.callTimes.length >= CALL_RATE_MAX) return reply({ ok: false, error: 'rate-limited' });
      socket.data.callTimes.push(now);

      if (typeof to !== 'string' || !DIAL_RE.test(to)) return reply({ ok: false, error: 'invalid-number' });
      if (to === me) return reply({ ok: false, error: 'self-call' });
      if (!isValidDescription(offer, 'offer')) return reply({ ok: false, error: 'invalid-offer' });
      if (calls.has(me)) return reply({ ok: false, error: 'already-in-call' });
      if (!users.has(to)) return reply({ ok: false, error: 'offline' });
      if (calls.has(to)) return reply({ ok: false, error: 'busy' });

      const session = { caller: me, callee: to, state: 'ringing', timer: null };
      session.timer = setTimeout(() => {
        if (calls.get(me) !== session || session.state !== 'ringing') return;
        endSession(session);
        emitTo(me, 'call-ended', { from: to, reason: 'no-answer' });
        emitTo(to, 'call-ended', { from: me, reason: 'missed' });
      }, ringTimeout);
      calls.set(me, session);
      calls.set(to, session);

      emitTo(to, 'incoming-call', { from: me, offer: { type: offer.type, sdp: offer.sdp } });
      return reply({ ok: true });
    }));

    socket.on('answer', safe(({ to, answer }, reply) => {
      const me = socket.data.number;
      const session = me && calls.get(me);
      if (!session || session.callee !== me || session.caller !== to || session.state !== 'ringing') {
        return reply({ ok: false, error: 'no-such-call' });
      }
      if (!isValidDescription(answer, 'answer')) return reply({ ok: false, error: 'invalid-answer' });

      clearTimeout(session.timer);
      session.state = 'active';
      emitTo(to, 'call-answered', { from: me, answer: { type: answer.type, sdp: answer.sdp } });
      return reply({ ok: true });
    }));

    socket.on('ice-candidate', safe(({ to, candidate }, reply) => {
      const me = socket.data.number;
      if (!me || peerOf(me) !== to) return reply({ ok: false, error: 'no-such-call' });
      const clean = sanitizeCandidate(candidate);
      if (!clean) return reply({ ok: false, error: 'invalid-candidate' });
      emitTo(to, 'ice-candidate', { from: me, candidate: clean });
      return reply({ ok: true });
    }));

    // Used for hang up, cancel (caller, while ringing) and decline (callee, while ringing).
    socket.on('hangup', safe(({ to }, reply) => {
      const me = socket.data.number;
      const session = me && calls.get(me);
      if (!session || peerOf(me) !== to) return reply({ ok: false, error: 'no-such-call' });

      let reason = 'hangup';
      if (session.state === 'ringing') reason = session.caller === me ? 'cancelled' : 'rejected';
      endSession(session);
      emitTo(to, 'call-ended', { from: me, reason });
      return reply({ ok: true });
    }));

    socket.on('disconnect', () => {
      const number = socket.data.number;
      if (number && users.get(number)?.socketId === socket.id) releaseNumber(number);
    });
  });

  return { app, server, io, state: { users, calls } };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server, io } = createServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`[webdial] listening on http://localhost:${port}`);
  });
  const shutdown = () => {
    console.log('[webdial] shutting down');
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer };
