# WebDial

Free browser-to-browser voice calling with a phone-style dialer pad. Built on **WebRTC** (peer-to-peer audio) and a **Node.js + Socket.IO** signaling server. No paid services, no accounts. Open the page and you get a phone number.

## Features

- Every browser gets a 6-digit number that stays the same after a reload or reconnect
- Dialer pad with real **DTMF tones** (Web Audio API) and keyboard support
- Outgoing and incoming calls with ringback tone, ringtone, accept and decline
- In-call controls: mute, a keypad that sends DTMF to the other side, and a call timer
- Call states handled: **busy**, **offline**, **declined**, **no answer** (45s), **missed**, peer disconnect
- **Recents** (call log) and **Contacts**, stored in the browser
- Share link (`/?call=123456`) that opens the dialer with the number filled in
- Responsive mobile-first UI with light and dark themes, plus accessibility labels
- Security: strict CSP, input validation, call rate limiting, payload size limits, and checks that only the two people in a call can signal each other

## Architecture

```
 Browser A                    Node.js server                   Browser B
┌──────────┐   Socket.IO    ┌──────────────────┐   Socket.IO  ┌──────────┐
│ Dialer UI│ ── offer ────▶ │ number registry  │ ── offer ──▶ │ Dialer UI│
│ WebRTC   │ ◀── answer ─── │ call state       │ ◀─ answer ── │ WebRTC   │
│          │ ◀─ ICE cand ─▶ │ (ringing/active) │ ◀─ ICE ────▶ │          │
└────┬─────┘                └──────────────────┘              └────┬─────┘
     │              audio flows directly peer-to-peer (SRTP)        │
     └──────────────────────────────────────────────────────────────┘
                 STUN (Google, free) helps the peers find each other
```

The server only does **signaling**: it relays the SDP offer/answer and ICE candidates and tracks call state. Audio never passes through it, so a free-tier host is enough.

## Run locally

Requires Node.js 18+.

```bash
npm install
npm start            # http://localhost:3000
```

Open `http://localhost:3000` in **two tabs** (or two browsers), dial the number shown in one from the other, and accept.

> Browsers only allow microphone access on **HTTPS or localhost**. To test from your phone on the same Wi-Fi, use the deployed HTTPS URL, or a free tunnel such as `npx localtunnel --port 3000` or `cloudflared tunnel --url http://localhost:3000`.

```bash
npm run dev          # auto-restart on file changes
npm test             # 13 integration tests for the signaling server
```

## Deploy for free

### Render (recommended)
1. Push this folder to a GitHub repository.
2. On [render.com](https://render.com), choose **New → Blueprint** and select the repo. `render.yaml` sets everything up (free plan, `/health` check).
3. You get an HTTPS URL like `https://webdial.onrender.com`.

Free Render services go to sleep after about 15 minutes of no traffic, so the first visit afterwards takes around 30s to wake up.

### Other options
- **Railway / Koyeb / Fly.io:** use the included `Dockerfile`.
- **Docker anywhere:** `docker build -t webdial . && docker run -p 3000:3000 webdial`

> Socket.IO needs a long-running server, so serverless platforms like Vercel or Netlify Functions are **not** suitable.

## Configuration

See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | none | Optional TURN relay |
| `ICE_SERVERS` | Google STUN | Full JSON ICE server list (overrides the above) |
| `RING_TIMEOUT_MS` | `45000` | How long a call rings before "no answer" |
| `CORS_ORIGIN` | same-origin | Allowed origins if the frontend is hosted elsewhere |

**About TURN:** STUN alone works on most home and mobile networks. Some strict corporate or university networks block direct peer-to-peer traffic, and the call then shows *"Connection failed. This network may need a TURN server."* Metered.ca offers a free TURN tier (around 50 GB/month); add its credentials using the variables above.

## Project structure

```
webdial/
├── server.js            # Express + Socket.IO signaling server
├── public/
│   ├── index.html       # App shell: keypad, recents, contacts, call screen
│   ├── styles.css       # Responsive UI, light/dark theme
│   ├── app.js           # WebRTC, signaling client, DTMF tones, storage
│   └── favicon.svg
├── test/server.test.js  # node:test integration tests (socket.io-client)
├── Dockerfile
├── render.yaml
└── .env.example
```

## Signaling protocol

| Client → server | Server → client | Notes |
|---|---|---|
| `register {number?, deviceId}` | ack `{ok, number}` | Keeps the saved number when it's free or held by the same device |
| `call {to, offer}` | `incoming-call {from, offer}` | Ack errors: `offline`, `busy`, `self-call`, `rate-limited`, … |
| `answer {to, answer}` | `call-answered {from, answer}` | Only the callee of a ringing call can answer |
| `ice-candidate {to, candidate}` | `ice-candidate {from, candidate}` | Only relayed between the two parties of a call |
| `hangup {to}` | `call-ended {from, reason}` | reason: `hangup`, `rejected`, `cancelled`, `no-answer`, `missed`, `disconnected` |
| none | `session-replaced` | The number was opened in another tab |

## Resume bullet points

- Built **WebDial**, a real-time browser-to-browser voice calling app using **WebRTC**, **Node.js**, **Express** and **Socket.IO**, deployed for free on Render.
- Designed a signaling protocol (SDP offer/answer, ICE candidate relay) with server-side call state for busy, offline, decline, ring timeout and disconnect handling.
- Generated standard **DTMF** dial tones with the Web Audio API and sent in-call DTMF over RTP using `RTCDTMFSender`.
- Hardened the server with a Content Security Policy, input validation, payload size limits, rate limiting and call-membership checks; covered it with 13 automated integration tests.

## Possible extensions

Video calls (add `video: true`), group calls via an SFU (mediasoup/LiveKit), user accounts with Firebase Auth, push notifications for missed calls, and call recording with `MediaRecorder`.

## License

MIT
