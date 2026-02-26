# Voice Interface

## Overview

Voice mode lets the user call Claude hands-free via a WebSocket-based web app. The listener detects voice requests in Slack, replies with a link, and the user opens it on their phone.

## Architecture

```
User's phone (browser) <-> voice/server.cjs (HTTP+WS, port 3100) <-> claude -p (opus) + Kokoro TTS (in-process)
```

### Components
- **`voice/server.cjs`** — Node.js HTTP + WebSocket server. Authenticates via token, manages sessions, spawns `claude -p` (opus, always), runs TTS, sends audio back.
- **`voice/public/index.html`** — Mobile-first SPA. Web Speech API for recognition, AudioContext for playback + synthesized audio cues, WebSocket for communication.
- **`voice/tts.py`** — TTS with fallback chain: edge-tts (best quality) → Piper daemon → Piper direct (offline fallback).
- **`voice/tts_daemon.py`** — Piper TTS daemon. Keeps model loaded in memory for low-latency synthesis. Communicates via Unix socket.
- **`voice/models/piper/`** — Piper voice model (`en_US-lessac-high.onnx`).
- **`voice/transcripts/`** — Markdown transcripts saved on disconnect.

### Systemd Services
- `voice-server.service` — Runs `node voice/server.cjs`. Restart with: `sudo systemctl restart voice-server`
- Uses a reverse proxy (e.g. Caddy, nginx) for HTTPS/WSS on the public domain.

### How Voice Calls Start
1. The user says "call me" or "voice call" etc. in Slack (exact match, or short message < 40 chars)
2. Listener (`listener.js`) detects via `CALL_ME_EXACT` / `CALL_ME_SHORT` regex patterns
3. Listener generates a **short-lived, single-use token** (expires in 10 min), writes it to `voice/.voice-tokens.json`, and builds a link with the token + session ID + Slack params
4. The user taps the link → opens in browser → voice server validates token on page load (without consuming) → taps "Start" → WebSocket connects and **consumes** the token (one-time use)
5. **Claude speaks first** — on connect, the server fetches recent Slack thread messages, generates a context-aware greeting (via sonnet for speed), TTS's it, and sends the audio to the client. The greeting references what was just discussed in Slack. If no context, falls back to a static greeting.
6. Static `VOICE_AUTH_TOKEN` from `.env` is kept as emergency fallback only

## UX Flow

### During Call
1. **Start screen** — Single button, taps to request mic + prime AudioContext
2. **Listening** — Blue orb pulses, Web Speech API captures. Status: `Listening — say "over" when done`
3. **"Over" keyword** — Speech accumulates in buffer. When buffer ends with "over" + 0.5s silence, strips "over" and sends text. **This is a deliberate design choice** — the user explicitly prefers it over silence-based auto-send because pauses while speaking get cut off by aggressive silence detection. Do not replace with auto-silence unless the user asks.
4. **Over confirmed** — Ascending blip (E3 → G3) plays
5. **Thinking** — Orange orb, ambient thinking sound plays (pad + melody + heartbeat)
6. **Speaking** — Green orb, TTS audio plays via AudioContext
7. **Done** — Descending blip (G3 → C3), returns to listening

### During-Call Tool Use Policy
**Reads/lookups = OK.** If the user asks "what's in my Notion tasks?" or "check the calendar," do the lookup and answer verbally.
**Writes/executions = DEFER.** Action items discussed during the call (creating tasks, writing files, editing configs, running scripts, memory updates) must NOT execute until after the call ends. They go into the post-call summary for approval. The call is for brainstorming and alignment; execution happens post-call via the approval flow below.

**Enforcement approach:** Behavioral rule only. Server-side tool filtering (e.g. `--allowedTools` whitelist during calls) was scoped out and rejected — too rigid, adds complexity, and the failure mode (action items execute slightly early) isn't destructive. If the behavioral rule keeps failing, revisit server-side filtering.

### End of Call (Post-Call Workflow)
1. The user taps **End Call** button (red phone icon) — closes WebSocket
2. Server detects disconnect, saves transcript to `voice/transcripts/`
3. Server writes `voice/recent-call.json` (topics, timestamps) for post-call Slack context injection
4. **Action item extraction (thorough):** Server runs a dedicated opus prompt that scans EVERY line of the transcript for action items — anything agreed to, requested, offered, or deferred. Returns structured JSON with action, owner (Claude/User), and context. This is the first pass and its sole job is completeness.
5. **Summary generation:** A second opus prompt takes the extracted action items + transcript and writes a conversational Slack message. Every action item MUST appear in the summary — nothing gets lost.
6. If there are Claude-owned action items, a pending execution file is written to `pending-executions/` (includes both the summary and the structured action items array).
7. The user reviews in Slack and replies:
   - **Approval** ("go ahead", "do it", "approved", etc.) → listener picks up pending execution, runs it with opus
   - **Decline** ("no", "cancel", "scratch that") → pending execution deleted, acknowledged
   - **Modifications** (any other reply) → treated as approval with the reply text passed as modifications
8. Pending executions auto-expire after 24 hours
9. **Post-call Slack continuity**: The next Slack message from the user triggers the listener to read `voice/recent-call.json` (consumed on first use), injecting `[RECENT VOICE CALL]` context so Claude naturally references the call

## Audio Cues

### Over Confirmed (intro)
Quick ascending sine blip: E3 (165Hz) → G3 (196Hz), 0.10 volume, ~120ms each.

### Thinking Sound (middle)
Layered hybrid of three elements playing simultaneously:

**Base Pad:**
- 3 sine oscillators: C3/E3/G3 (131/165/196 Hz) with slight detuning (-4, 0, +3 cents)
- Low-pass at 420Hz, high-pass at 150Hz (phone speaker safe)
- Breathing LFO at 0.15Hz on master gain (±0.012)
- Filter sweep LFO at 0.08Hz (±80Hz around cutoff)
- 1.5s fade-in to 0.05 volume

**Pentatonic Melody:**
- Notes: G3/A3/C4/D4/E4 (196/220/262/294/330 Hz), triangle wave
- 0.06 gain, fades in over 0.8s, sustains at 0.04
- New note every 3.5–6s (randomized), through dedicated 500Hz low-pass
- Routes directly to destination (not through pad filters)

**Percussive Heartbeat:**
- Double-thump at ~72 BPM (830ms interval)
- Each thump: sine oscillator with pitch drop (200→60Hz in 80ms), 0.08 gain, fast decay
- Second thump 200ms later, slightly softer (180→50Hz, 0.05 gain)

All stopped cleanly via `stopThinkingCue()` which sets a `thinkingStopped` flag, clears timers, fades master to 0 over 0.5s, then stops all oscillators.

### Done Speaking (outro)
Quick descending sine blip: G3 (196Hz) → C3 (131Hz), 0.08 volume.

## Lock Screen Behavior
Running voice mode with the phone locked is **not feasible with current browser tech**. Both iOS and Android suspend web page processes (killing speech recognition, WebSockets, and mic access) when the screen locks. The Wake Lock API prevents auto-lock during a call, which is the best available solution. A native app wrapper would be needed for true lock-screen support — not worth building unless voice becomes a daily driver.

## Key Quirks & Gotchas

### Bind Address (DO NOT CHANGE)
Voice server must bind to `0.0.0.0` (the default). If you're using a reverse proxy (Tailscale, Caddy, nginx), it proxies through `127.0.0.1:3100`, so binding to a specific IP causes a 502 blank page. This was broken once and took debugging to find — don't repeat it.

### Permissions
Voice server spawns `claude -p` with `--dangerously-skip-permissions`. Without this, file operations fail because there's no terminal for approval prompts.

### WebSocket Keepalive
Mobile carriers kill idle TCP after ~2 minutes. Server pings every 25s, terminates clients that miss pong. Client reconnects on close and maintains processing state.

### AudioContext on Mobile
iOS/Android require AudioContext to be created and a buffer played during a user gesture (tap). The start button handles this. Without it, all audio playback silently fails.

### AudioContext decodeAudioData
TTS audio (MP3 blobs) are played via `AudioContext.decodeAudioData()` + `BufferSource` for reliable mobile playback. Falls back to HTML5 `Audio()` if decode fails.

### Web Speech API
- `continuous: true` keeps the mic open across pauses
- `isFinal` results accumulate in `speechBuffer`
- Recognition auto-restarts on `onend` (unless muted or processing)
- Some in-app browsers (Slack, Facebook) don't support it — detected and blocked with a helpful message

### Session Continuity
- Session IDs extracted from Claude stderr, passed via `--resume` on subsequent messages
- Slack channel/thread params carried through the WebSocket URL for transcript posting
- On disconnect: transcript saved to `voice/transcripts/`, summary generated (sonnet) and posted to Slack thread

### Response Done Signal
- Race condition: client flipped to "listening" between TTS sentence chunks because `playNext()` assumed empty queue = response done.
- Fix: server sends `{ type: 'response_done' }` after all TTS completes. Client only transitions to listening on that signal.

### TTS
- Primary: **Kokoro TTS** (`bf_emma` voice, British female, grade B-) — runs in-process in Node.js, no Python needed
  - Model: `onnx-community/Kokoro-82M-v1.0-ONNX` (q8 quantized, ~92MB model, ~530MB RSS)
  - Loaded once at server startup, stays in memory
  - Audio output: 24kHz WAV, sent as binary WebSocket message
  - Sentence-level streaming: Claude's text is split into sentences as it arrives, each TTS'd and sent immediately
- Fallback: **Python TTS** (edge-tts → Piper daemon → Piper direct) — used if Kokoro fails to load
- Piper model: `en_US-lessac-high` kept loaded via daemon at `/tmp/piper-tts.sock`
- To change voice: edit `KOKORO_VOICE` constant in `voice/server.cjs` (see kokoro-js docs for voice IDs)

### Active Call State
- Voice server writes `voice/active-call.json` on connect, deletes on disconnect
- Listener checks this file and injects `[VOICE CALL ACTIVE]` context into Slack prompts
- Stale files (>4h) are auto-cleaned
- Enables Claude to know when the user is on a voice call while also messaging in Slack

### Recent Call Context
- Voice server writes `voice/recent-call.json` on disconnect (with topics from transcript)
- Listener reads and **consumes** (deletes) this file on the next Slack message
- Injects `[RECENT VOICE CALL]` context so Claude naturally acknowledges the recent call
- Stale files (>2h) are ignored and cleaned up

## Modifying the Voice Interface

### Changing audio cues
Edit `playOverCue()`, `playThinkingCue()`, or `playDoneCue()` in `voice/public/index.html`. All use Web Audio API oscillators — no external audio files needed.

### Changing TTS voice/speed
Edit `KOKORO_VOICE` constant at the top of `voice/server.cjs`. Available voices: af_heart (A), af_bella (A-), bf_emma (B-), af_nicole (B-), af_aoede (C+), af_kore (C+), af_sarah (C+), am_fenrir (C+), am_michael (C+), am_puck (C+). See kokoro-js README for full list of 54 voices.
For fallback TTS: edit `voice/tts.py` — `VOICE` and `RATE` constants at the top.

### Changing the system prompt
Edit the prompt template in `voice/server.cjs` (the `[VOICE MODE]` block in the message handler).

### Restarting
```bash
sudo systemctl restart voice-server
```
Check logs: `journalctl -u voice-server.service --no-pager -n 30`
