'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server');

const OFFER = { type: 'offer', sdp: 'v=0 fake-offer' };
const ANSWER = { type: 'answer', sdp: 'v=0 fake-answer' };

let srv;
let url;
const clients = [];

before(async () => {
  srv = createServer({ env: {}, ringTimeoutMs: 300 });
  await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${srv.server.address().port}`;
});

after(async () => {
  clients.forEach((c) => c.close());
  srv.io.close();
  await new Promise((resolve) => srv.server.close(resolve));
});

function client() {
  const c = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(c);
  return c;
}

const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

async function registered(payload = {}) {
  const c = client();
  await once(c, 'connect');
  const res = await emit(c, 'register', payload);
  assert.equal(res.ok, true);
  return { socket: c, number: res.number };
}

test('health and config endpoints respond', async () => {
  const health = await (await fetch(`${url}/health`)).json();
  assert.equal(health.status, 'ok');
  const res = await fetch(`${url}/api/config`);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const cfg = await res.json();
  assert.ok(Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0);
});

test('serves the web app', async () => {
  const html = await (await fetch(url)).text();
  assert.match(html, /<title>WebDial<\/title>/);
});

test('register assigns a 6-digit number and keeps a requested free number', async () => {
  const a = await registered();
  assert.match(a.number, /^\d{6}$/);
  const b = await registered({ number: '555123', deviceId: 'device-b-123' });
  assert.equal(b.number, '555123');
});

test('a different device cannot take a number that is in use', async () => {
  await registered({ number: '777000', deviceId: 'owner-device-1' });
  const thief = await registered({ number: '777000', deviceId: 'other-device-2' });
  assert.notEqual(thief.number, '777000');
});

test('the same device takes its number over and the old tab is notified', async () => {
  const first = await registered({ number: '888000', deviceId: 'same-device-01' });
  const replaced = once(first.socket, 'session-replaced');
  const second = await registered({ number: '888000', deviceId: 'same-device-01' });
  assert.equal(second.number, '888000');
  await replaced;
});

test('full call flow: offer, answer, ICE relay, hang up', async () => {
  const a = await registered();
  const b = await registered();

  const incoming = once(b.socket, 'incoming-call');
  assert.deepEqual(await emit(a.socket, 'call', { to: b.number, offer: OFFER }), { ok: true });
  const inc = await incoming;
  assert.equal(inc.from, a.number);
  assert.deepEqual(inc.offer, OFFER);

  const answered = once(a.socket, 'call-answered');
  assert.deepEqual(await emit(b.socket, 'answer', { to: a.number, answer: ANSWER }), { ok: true });
  assert.deepEqual((await answered).answer, ANSWER);

  const cand = once(b.socket, 'ice-candidate');
  await emit(a.socket, 'ice-candidate', { to: b.number, candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.equal((await cand).candidate.sdpMid, '0');

  const ended = once(b.socket, 'call-ended');
  assert.deepEqual(await emit(a.socket, 'hangup', { to: b.number }), { ok: true });
  assert.deepEqual(await ended, { from: a.number, reason: 'hangup' });
  assert.equal(srv.state.calls.size, 0);
});

test('calling an offline number, yourself, or with a bad offer fails', async () => {
  const a = await registered();
  assert.equal((await emit(a.socket, 'call', { to: '000001', offer: OFFER })).error, 'offline');
  assert.equal((await emit(a.socket, 'call', { to: a.number, offer: OFFER })).error, 'self-call');
  assert.equal((await emit(a.socket, 'call', { to: '123456', offer: { type: 'offer' } })).error, 'invalid-offer');
  assert.equal((await emit(a.socket, 'call', { to: 'abc', offer: OFFER })).error, 'invalid-number');
});

test('a third caller gets busy', async () => {
  const a = await registered();
  const b = await registered();
  const c = await registered();
  await emit(a.socket, 'call', { to: b.number, offer: OFFER });
  assert.equal((await emit(c.socket, 'call', { to: b.number, offer: OFFER })).error, 'busy');
  await emit(a.socket, 'hangup', { to: b.number });
});

test('declining while ringing tells the caller "rejected"', async () => {
  const a = await registered();
  const b = await registered();
  await emit(a.socket, 'call', { to: b.number, offer: OFFER });
  const ended = once(a.socket, 'call-ended');
  await emit(b.socket, 'hangup', { to: a.number });
  assert.equal((await ended).reason, 'rejected');
});

test('unanswered call times out as no-answer / missed', async () => {
  const a = await registered();
  const b = await registered();
  const aEnded = once(a.socket, 'call-ended');
  const bEnded = once(b.socket, 'call-ended');
  await emit(a.socket, 'call', { to: b.number, offer: OFFER });
  assert.equal((await aEnded).reason, 'no-answer');
  assert.equal((await bEnded).reason, 'missed');
});

test('outsiders cannot inject signaling into someone else\'s call', async () => {
  const a = await registered();
  const b = await registered();
  const x = await registered();
  await emit(a.socket, 'call', { to: b.number, offer: OFFER });
  assert.equal((await emit(x.socket, 'answer', { to: a.number, answer: ANSWER })).error, 'no-such-call');
  assert.equal((await emit(x.socket, 'hangup', { to: b.number })).error, 'no-such-call');
  assert.equal((await emit(x.socket, 'ice-candidate', { to: b.number, candidate: { candidate: 'x' } })).error, 'no-such-call');
  await emit(a.socket, 'hangup', { to: b.number });
});

test('disconnecting mid-call notifies the other side and frees the number', async () => {
  const a = await registered();
  const b = await registered();
  await emit(a.socket, 'call', { to: b.number, offer: OFFER });
  await emit(b.socket, 'answer', { to: a.number, answer: ANSWER });
  const ended = once(b.socket, 'call-ended');
  a.socket.close();
  assert.deepEqual(await ended, { from: a.number, reason: 'disconnected' });
  assert.equal(srv.state.users.has(a.number), false);
});

test('call attempts are rate limited', async () => {
  const a = await registered();
  const results = [];
  for (let i = 0; i < 6; i += 1) results.push((await emit(a.socket, 'call', { to: '000002', offer: OFFER })).error);
  assert.equal(results[5], 'rate-limited');
});
