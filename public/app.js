/* WebDial client: dialer UI + WebRTC peer connection + Socket.IO signaling. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const VALID_DIAL = /^\d{4,10}$/;
  const KEYS = [
    ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
    ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
    ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
    ['*', ''], ['0', '+'], ['#', ''],
  ];
  const STORAGE = {
    number: 'webdial.number',
    device: 'webdial.deviceId',
    history: 'webdial.history',
    contacts: 'webdial.contacts',
  };

  // ---------------------------------------------------------------- storage
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };

  function getDeviceId() {
    let id = store.get(STORAGE.device, null);
    if (typeof id !== 'string' || id.length < 8) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      store.set(STORAGE.device, id);
    }
    return id;
  }

  // ---------------------------------------------------------------- tones (Web Audio)
  const Tones = (() => {
    const DTMF = {
      1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
      4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
      7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
      '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
    };
    let ctx = null;
    let loopTimer = null;

    function context() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function play(freqs, start, duration, volume) {
      const c = context();
      if (!c) return;
      const t0 = c.currentTime + start;
      const gain = c.createGain();
      gain.connect(c.destination);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(volume, t0 + 0.01);
      gain.gain.setValueAtTime(volume, t0 + duration - 0.02);
      gain.gain.linearRampToValueAtTime(0, t0 + duration);
      freqs.forEach((f) => {
        const osc = c.createOscillator();
        osc.frequency.value = f;
        osc.connect(gain);
        osc.start(t0);
        osc.stop(t0 + duration);
      });
    }

    function stop() {
      clearInterval(loopTimer);
      loopTimer = null;
    }

    function loop(fn, period) {
      stop();
      fn();
      loopTimer = setInterval(fn, period);
    }

    return {
      unlock: context,
      dtmf: (key) => DTMF[key] && play(DTMF[key], 0, 0.14, 0.12),
      ringback: () => loop(() => play([440, 480], 0, 2, 0.06), 6000),
      ringtone: () => loop(() => {
        play([523, 659], 0, 0.35, 0.14);
        play([587, 740], 0.45, 0.35, 0.14);
      }, 2500),
      busy: () => {
        stop();
        for (let i = 0; i < 3; i += 1) play([480, 620], i * 0.8, 0.4, 0.06);
      },
      stop,
    };
  })();

  // ---------------------------------------------------------------- state
  const state = {
    number: null,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    call: null,
    history: store.get(STORAGE.history, []),
    contacts: store.get(STORAGE.contacts, []),
  };
  if (!Array.isArray(state.history)) state.history = [];
  if (!Array.isArray(state.contacts)) state.contacts = [];

  const deviceId = getDeviceId();
  const remoteAudio = $('remote-audio');
  const dialInput = $('dial-input');

  // ---------------------------------------------------------------- formatting
  const formatNumber = (n) => (n && n.length === 6 ? `${n.slice(0, 3)} ${n.slice(3)}` : n || '');
  const nameFor = (number) => state.contacts.find((c) => c.number === number)?.name || null;
  const initial = (text) => (text || '#').trim().charAt(0).toUpperCase() || '#';

  function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function timeAgo(ts) {
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  let toastTimer = null;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function setStatus(kind, text) {
    $('status').dataset.state = kind;
    $('status-text').textContent = text;
  }

  // Flash the tab title while a call is ringing in a background tab.
  const baseTitle = document.title;
  let titleTimer = null;
  function flashTitle(on) {
    clearInterval(titleTimer);
    titleTimer = null;
    document.title = baseTitle;
    if (!on) return;
    let flip = false;
    titleTimer = setInterval(() => {
      flip = !flip;
      document.title = flip ? 'Incoming call…' : baseTitle;
    }, 1000);
  }

  // ---------------------------------------------------------------- keypad UI
  function buildKeypad(container, onPress) {
    KEYS.forEach(([digit, letters]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'key';
      btn.dataset.key = digit;
      btn.setAttribute('aria-label', digit);
      const d = document.createElement('span');
      d.className = 'digit';
      d.textContent = digit;
      const l = document.createElement('span');
      l.className = 'letters';
      l.textContent = letters;
      btn.append(d, l);
      btn.addEventListener('click', () => onPress(digit));
      container.appendChild(btn);
    });
  }

  function flashKey(container, key) {
    const btn = container.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!btn) return;
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 120);
  }

  function setDial(value) {
    dialInput.value = value.replace(/[^\d*#]/g, '').slice(0, 15);
    updateDialUi();
  }

  function updateDialUi() {
    const value = dialInput.value;
    const name = nameFor(value);
    $('contact-match').textContent = name || '';
  }

  function pressMainKey(key) {
    Tones.dtmf(key);
    setDial(dialInput.value + key);
  }

  buildKeypad($('keypad'), pressMainKey);
  buildKeypad($('incall-keypad'), (key) => sendDtmf(key));

  dialInput.addEventListener('input', () => setDial(dialInput.value));
  dialInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startCall(dialInput.value);
  });

  // Backspace: tap deletes one digit, hold clears.
  (() => {
    const btn = $('backspace');
    let holdTimer = null;
    let cleared = false;
    btn.addEventListener('pointerdown', () => {
      cleared = false;
      holdTimer = setTimeout(() => { cleared = true; setDial(''); }, 600);
    });
    const cancel = () => clearTimeout(holdTimer);
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('click', () => {
      if (!cleared) setDial(dialInput.value.slice(0, -1));
    });
  })();

  $('call-btn').addEventListener('click', () => startCall(dialInput.value));

  // Physical keyboard support on the keypad screen.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (state.call) {
      if (state.call.status === 'active' && /^[\d*#]$/.test(e.key)) {
        sendDtmf(e.key);
        flashKey($('incall-keypad'), e.key);
      }
      return;
    }
    if (!$('view-keypad').classList.contains('active')) return;
    if (/^[\d*#]$/.test(e.key)) {
      pressMainKey(e.key);
      flashKey($('keypad'), e.key);
    } else if (e.key === 'Backspace') {
      setDial(dialInput.value.slice(0, -1));
    } else if (e.key === 'Enter') {
      startCall(dialInput.value);
    }
  });

  // Browsers only allow audio after a user gesture.
  document.addEventListener('pointerdown', () => Tones.unlock(), { once: true });

  // ---------------------------------------------------------------- tabs
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.view === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    if (name === 'recents') renderRecents();
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

  // ---------------------------------------------------------------- my number
  $('copy-number').addEventListener('click', async () => {
    if (!state.number) return toast('Not connected yet');
    try {
      await navigator.clipboard.writeText(state.number);
      toast('Number copied');
    } catch {
      toast(`Your number is ${state.number}`);
    }
  });

  $('share-link').addEventListener('click', async () => {
    if (!state.number) return toast('Not connected yet');
    const url = `${location.origin}/?call=${state.number}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Call me on WebDial', url }); return; } catch { /* fall through */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Call link copied');
    } catch {
      toast(url);
    }
  });

  // ---------------------------------------------------------------- recents
  function addHistory(call, outcome) {
    const answered = Boolean(call.answeredAt);
    const endedAt = Date.now();
    let kind = call.direction;
    if (!answered && call.direction === 'incoming') kind = outcome === 'declined' ? 'declined' : 'missed';
    state.history.unshift({
      number: call.peer,
      kind,
      outcome: answered ? 'completed' : outcome,
      at: call.createdAt,
      duration: call.connectedAt ? Math.round((endedAt - call.connectedAt) / 1000) : 0,
    });
    state.history = state.history.slice(0, 100);
    store.set(STORAGE.history, state.history);
    renderRecents();
  }

  const OUTCOME_LABEL = {
    busy: 'Busy',
    'no-answer': 'No answer',
    rejected: 'Declined',
    offline: 'Unavailable',
    cancelled: 'Cancelled',
    failed: 'Failed',
  };

  function makeIconButton(className, label, pathD, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `icon-btn ${className}`;
    btn.setAttribute('aria-label', label);
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    btn.appendChild(svg);
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  const PHONE_PATH = 'M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z';
  const TRASH_PATH = 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z';

  function listItem({ title, sub, missed, avatarText, actions }) {
    const li = document.createElement('li');
    li.className = 'item';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = avatarText;
    const main = document.createElement('div');
    main.className = 'item-main';
    const t = document.createElement('div');
    t.className = `item-title${missed ? ' missed' : ''}`;
    t.textContent = title;
    const s = document.createElement('div');
    s.className = `item-sub${missed ? ' missed' : ''}`;
    s.textContent = sub;
    main.append(t, s);
    const act = document.createElement('div');
    act.className = 'item-actions';
    actions.forEach((a) => act.appendChild(a));
    li.append(avatar, main, act);
    return li;
  }

  function renderRecents() {
    const list = $('recents-list');
    list.replaceChildren();
    state.history.forEach((h) => {
      const name = nameFor(h.number);
      const missed = h.kind === 'missed';
      let label;
      if (h.kind === 'missed') label = 'Missed';
      else if (h.kind === 'declined') label = 'Declined';
      else {
        const dir = h.kind === 'outgoing' ? 'Outgoing' : 'Incoming';
        label = h.outcome === 'completed' ? `${dir} · ${formatDuration(h.duration)}` : `${dir} · ${OUTCOME_LABEL[h.outcome] || 'Ended'}`;
      }
      list.appendChild(listItem({
        title: name || formatNumber(h.number),
        sub: `${label} · ${timeAgo(h.at)}`,
        missed,
        avatarText: name ? initial(name) : '#',
        actions: [makeIconButton('call', `Call ${name || h.number}`, PHONE_PATH, () => startCall(h.number))],
      }));
    });
    $('recents-empty').hidden = state.history.length > 0;
    $('clear-recents').hidden = state.history.length === 0;
  }

  $('clear-recents').addEventListener('click', () => {
    state.history = [];
    store.set(STORAGE.history, state.history);
    renderRecents();
  });

  // ---------------------------------------------------------------- contacts
  function renderContacts() {
    const list = $('contacts-list');
    list.replaceChildren();
    [...state.contacts]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => {
        list.appendChild(listItem({
          title: c.name,
          sub: formatNumber(c.number),
          avatarText: initial(c.name),
          actions: [
            makeIconButton('call', `Call ${c.name}`, PHONE_PATH, () => startCall(c.number)),
            makeIconButton('delete', `Delete ${c.name}`, TRASH_PATH, () => {
              state.contacts = state.contacts.filter((x) => x.number !== c.number);
              store.set(STORAGE.contacts, state.contacts);
              renderContacts();
              renderRecents();
              updateDialUi();
            }),
          ],
        }));
      });
    $('contacts-empty').hidden = state.contacts.length > 0;
  }

  $('contact-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('contact-name').value.trim().slice(0, 40);
    const number = $('contact-number').value.replace(/\D/g, '');
    if (!name) return toast('Enter a name');
    if (!VALID_DIAL.test(number)) return toast('Enter a valid number (4–10 digits)');
    const existing = state.contacts.find((c) => c.number === number);
    if (existing) existing.name = name;
    else state.contacts.push({ name, number });
    store.set(STORAGE.contacts, state.contacts);
    $('contact-form').reset();
    renderContacts();
    renderRecents();
    updateDialUi();
    toast(existing ? 'Contact updated' : 'Contact saved');
  });

  // ---------------------------------------------------------------- call screen
  let screenToken = 0;

  function showCallScreen(call) {
    screenToken += 1;
    const name = nameFor(call.peer);
    $('call-avatar').textContent = name ? initial(name) : '#';
    $('call-peer-name').textContent = name || formatNumber(call.peer);
    $('call-peer-number').textContent = name ? formatNumber(call.peer) : '';
    $('dtmf-display').textContent = '';
    $('incall-pad').hidden = true;
    $('pad-btn').setAttribute('aria-pressed', 'false');
    $('mute-btn').setAttribute('aria-pressed', 'false');
    $('call-screen').hidden = false;
    renderCallActions(call);
  }

  function renderCallActions(call) {
    const incomingRinging = call && call.direction === 'incoming' && call.status === 'ringing';
    $('incoming-actions').hidden = !incomingRinging;
    $('active-actions').hidden = !call || incomingRinging;
    const live = Boolean(call && call.status === 'active');
    $('mute-btn').disabled = !live;
    $('pad-btn').disabled = !live;
    $('call-screen').classList.toggle('ringing', Boolean(call && call.status !== 'active'));
  }

  function setCallStatus(text) {
    $('call-status').textContent = text;
  }

  function hideCallScreenSoon() {
    const token = screenToken;
    setTimeout(() => {
      if (!state.call && token === screenToken) $('call-screen').hidden = true;
    }, 1400);
  }

  $('hangup-btn').addEventListener('click', () => {
    const call = state.call;
    if (!call) return;
    finishCall('Call ended', { outcome: call.status === 'active' ? 'completed' : 'cancelled' });
  });
  $('decline-btn').addEventListener('click', () => finishCall('Call declined', { outcome: 'declined' }));
  $('accept-btn').addEventListener('click', () => acceptCall());

  $('mute-btn').addEventListener('click', () => {
    const call = state.call;
    if (!call || !call.stream) return;
    call.muted = !call.muted;
    call.stream.getAudioTracks().forEach((t) => { t.enabled = !call.muted; });
    $('mute-btn').setAttribute('aria-pressed', String(call.muted));
  });

  $('pad-btn').addEventListener('click', () => {
    const pad = $('incall-pad');
    pad.hidden = !pad.hidden;
    $('pad-btn').setAttribute('aria-pressed', String(!pad.hidden));
  });

  // ---------------------------------------------------------------- WebRTC
  async function getMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('Microphone access needs HTTPS (or localhost).');
      err.name = 'InsecureContext';
      throw err;
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  }

  function micErrorMessage(err) {
    switch (err && err.name) {
      case 'NotAllowedError': return 'Microphone permission denied';
      case 'NotFoundError': return 'No microphone found';
      case 'NotReadableError': return 'Microphone is in use by another app';
      case 'InsecureContext': return err.message;
      default: return 'Could not start the call';
    }
  }

  const stopStream = (stream) => stream && stream.getTracks().forEach((t) => t.stop());

  function newCall(peer, direction) {
    const call = {
      peer,
      direction, // 'outgoing' | 'incoming'
      status: direction === 'incoming' ? 'ringing' : 'dialing', // dialing | ringing | accepting | active
      pc: null,
      stream: null,
      offer: null,
      canSignal: direction === 'incoming',
      outgoing: [], // signaling messages queued until the server knows about the call
      remoteCandidates: [], // ICE candidates received before the remote description was set
      createdAt: Date.now(),
      answeredAt: null,
      connectedAt: null,
      timerId: null,
      muted: false,
    };
    state.call = call;
    return call;
  }

  function sendSignal(call, event, payload) {
    if (call.canSignal) socket.emit(event, payload);
    else call.outgoing.push([event, payload]);
  }

  function flushOutgoing(call) {
    call.outgoing.splice(0).forEach(([event, payload]) => socket.emit(event, payload));
  }

  async function drainRemoteCandidates(call) {
    const pending = call.remoteCandidates.splice(0);
    for (const c of pending) {
      try { await call.pc.addIceCandidate(c); } catch (err) { console.warn('ICE candidate rejected', err); }
    }
  }

  function createPeer(call) {
    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    call.pc = pc;
    call.stream.getTracks().forEach((track) => pc.addTrack(track, call.stream));

    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(call, 'ice-candidate', { to: call.peer, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      remoteAudio.srcObject = e.streams[0] || new MediaStream([e.track]);
      remoteAudio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (state.call !== call) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        if (call.status === 'active') startTimer(call);
      } else if (s === 'disconnected') {
        if (call.status === 'active') setCallStatus('Reconnecting…');
      } else if (s === 'failed') {
        finishCall('Connection failed. This network may need a TURN server.', { outcome: 'failed' });
      }
    };
    return pc;
  }

  function startTimer(call) {
    if (call.timerId) return;
    call.connectedAt = Date.now();
    const tick = () => setCallStatus(formatDuration((Date.now() - call.connectedAt) / 1000));
    tick();
    call.timerId = setInterval(tick, 1000);
  }

  function markActive(call) {
    call.status = 'active';
    call.answeredAt = Date.now();
    renderCallActions(call);
    if (call.pc && call.pc.connectionState === 'connected') startTimer(call);
    else setCallStatus('Connecting…');
  }

  const CALL_ERRORS = {
    offline: 'Number is offline or does not exist',
    busy: 'Line busy',
    'already-in-call': 'You are already in a call',
    'self-call': "You can't call your own number",
    'invalid-number': 'Invalid number',
    'rate-limited': 'Too many calls. Wait a moment.',
    'not-registered': 'Not connected yet',
  };

  async function startCall(raw) {
    const number = String(raw || '').replace(/\D/g, '');
    if (state.call) return;
    if (!state.number || !socket.connected) return toast('Not connected yet');
    if (!VALID_DIAL.test(number)) return toast('Enter a valid number');
    if (number === state.number) return toast("You can't call your own number");

    Tones.unlock();
    const call = newCall(number, 'outgoing');
    showCallScreen(call);
    setCallStatus('Starting microphone…');

    try {
      call.stream = await getMic();
      if (state.call !== call) { stopStream(call.stream); return; }
      createPeer(call);
      const offer = await call.pc.createOffer();
      await call.pc.setLocalDescription(offer);
      if (state.call !== call) return;

      setCallStatus('Calling…');
      const desc = call.pc.localDescription;
      socket.emit('call', { to: number, offer: { type: desc.type, sdp: desc.sdp } }, (res) => {
        if (state.call !== call) {
          // User hung up before the server confirmed; cancel on the server too.
          if (res && res.ok) socket.emit('hangup', { to: number });
          return;
        }
        if (!res || !res.ok) {
          const error = (res && res.error) || 'failed';
          finishCall(CALL_ERRORS[error] || 'Call failed', {
            notify: false,
            outcome: error === 'busy' || error === 'offline' ? error : 'failed',
          });
          return;
        }
        call.canSignal = true;
        call.status = 'ringing';
        flushOutgoing(call);
        Tones.ringback();
        setCallStatus('Ringing…');
      });
    } catch (err) {
      console.error(err);
      finishCall(micErrorMessage(err), { notify: false, outcome: 'failed' });
    }
  }

  async function acceptCall() {
    const call = state.call;
    if (!call || call.direction !== 'incoming' || call.status !== 'ringing') return;

    Tones.stop();
    flashTitle(false);
    call.status = 'accepting';
    renderCallActions(call);
    setCallStatus('Connecting…');

    try {
      call.stream = await getMic();
      if (state.call !== call) { stopStream(call.stream); return; }
      createPeer(call);
      await call.pc.setRemoteDescription(call.offer);
      await drainRemoteCandidates(call);
      const answer = await call.pc.createAnswer();
      await call.pc.setLocalDescription(answer);
      if (state.call !== call) return;

      const desc = call.pc.localDescription;
      socket.emit('answer', { to: call.peer, answer: { type: desc.type, sdp: desc.sdp } }, (res) => {
        if (state.call !== call) return;
        if (!res || !res.ok) {
          finishCall('Call is no longer available', { notify: false, outcome: 'missed' });
          return;
        }
        markActive(call);
      });
    } catch (err) {
      console.error(err);
      finishCall(micErrorMessage(err), { outcome: 'failed' });
    }
  }

  function sendDtmf(key) {
    const call = state.call;
    if (!call || call.status !== 'active') return;
    Tones.dtmf(key);
    const display = $('dtmf-display');
    display.textContent = (display.textContent + key).slice(-14);
    const sender = call.pc && call.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
    if (sender && sender.dtmf && sender.dtmf.canInsertDTMF !== false) {
      try { sender.dtmf.insertDTMF(key, 100, 70); } catch { /* DTMF not supported */ }
    }
  }

  function finishCall(message, { notify = true, outcome = 'completed' } = {}) {
    const call = state.call;
    if (!call) return;
    state.call = null;

    if (notify && call.canSignal && socket.connected) socket.emit('hangup', { to: call.peer });

    Tones.stop();
    if (outcome === 'busy' || outcome === 'rejected') Tones.busy();
    flashTitle(false);
    clearInterval(call.timerId);
    if (call.pc) {
      call.pc.onicecandidate = null;
      call.pc.ontrack = null;
      call.pc.onconnectionstatechange = null;
      call.pc.close();
    }
    stopStream(call.stream);
    remoteAudio.srcObject = null;

    addHistory(call, outcome);
    setCallStatus(message || 'Call ended');
    $('incoming-actions').hidden = true;
    $('active-actions').hidden = true;
    $('call-screen').classList.remove('ringing');
    hideCallScreenSoon();
  }

  // ---------------------------------------------------------------- signaling
  const socket = io({ transports: ['websocket', 'polling'] });

  function register() {
    setStatus('connecting', 'Registering…');
    socket.emit('register', { number: store.get(STORAGE.number, null), deviceId }, (res) => {
      if (!res || !res.ok) {
        setStatus('offline', 'Registration failed');
        return;
      }
      state.number = res.number;
      store.set(STORAGE.number, res.number);
      $('my-number').textContent = formatNumber(res.number);
      setStatus('online', 'Online');
    });
  }

  socket.on('connect', register);

  socket.on('disconnect', () => {
    state.number = null;
    setStatus('offline', 'Reconnecting…');
    if (state.call) finishCall('Connection to server lost', { notify: false, outcome: 'failed' });
  });

  socket.on('session-replaced', () => {
    state.number = null;
    $('my-number').textContent = '— — —';
    setStatus('offline', 'Open in another tab');
    if (state.call) finishCall('Number moved to another tab', { notify: false, outcome: 'failed' });
    toast('Your number is now active in another tab. Reload to take it back.');
  });

  socket.on('incoming-call', ({ from, offer }) => {
    if (state.call) {
      // We're busy locally (e.g. still opening the mic for an outgoing call).
      socket.emit('hangup', { to: from });
      return;
    }
    const call = newCall(from, 'incoming');
    call.offer = offer;
    showCallScreen(call);
    setCallStatus('Incoming call…');
    Tones.ringtone();
    flashTitle(true);
  });

  socket.on('call-answered', async ({ from, answer }) => {
    const call = state.call;
    if (!call || call.peer !== from || call.direction !== 'outgoing' || !call.pc) return;
    Tones.stop();
    try {
      await call.pc.setRemoteDescription(answer);
      await drainRemoteCandidates(call);
      if (state.call === call) markActive(call);
    } catch (err) {
      console.error(err);
      finishCall('Could not connect the call', { outcome: 'failed' });
    }
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    const call = state.call;
    if (!call || call.peer !== from) return;
    if (!call.pc || !call.pc.remoteDescription) {
      call.remoteCandidates.push(candidate);
      return;
    }
    try { await call.pc.addIceCandidate(candidate); } catch (err) { console.warn('ICE candidate rejected', err); }
  });

  const ENDED = {
    hangup: ['Call ended', 'completed'],
    rejected: ['Call declined', 'rejected'],
    cancelled: ['Missed call', 'missed'],
    'no-answer': ['No answer', 'no-answer'],
    missed: ['Missed call', 'missed'],
    disconnected: ['The other side disconnected', 'completed'],
  };

  socket.on('call-ended', ({ from, reason }) => {
    const call = state.call;
    if (!call || call.peer !== from) return;
    const [message, outcome] = ENDED[reason] || ['Call ended', 'completed'];
    finishCall(message, { notify: false, outcome });
  });

  // ---------------------------------------------------------------- boot
  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => { if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) state.iceServers = cfg.iceServers; })
    .catch(() => {});

  const prefill = new URLSearchParams(location.search).get('call');
  if (prefill) setDial(prefill.replace(/\D/g, ''));

  if (!window.RTCPeerConnection) toast('This browser does not support WebRTC calls');

  renderRecents();
  renderContacts();
  updateDialUi();
})();
