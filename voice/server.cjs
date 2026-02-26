#!/usr/bin/env node
/**
 * Voice Interface WebSocket Server
 * Receives transcribed text from browser, runs claude -p (opus), converts response to audio
 * via Kokoro TTS (in-process, bf_emma voice), sends audio back to the browser for playback.
 *
 * Key architecture:
 * - Kokoro TTS model loads once at startup, stays in memory (~530MB)
 * - Sentence-level streaming: Claude's text is split into sentences as it arrives,
 *   each sentence is TTS'd and sent immediately — first audio plays while later sentences generate
 * - No Python subprocess for TTS — everything runs in-process in Node.js
 * - Piper daemon kept as fallback if Kokoro fails
 */

const { WebSocketServer } = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

// --- Config ---
const PORT = parseInt(process.env.VOICE_PORT || '3100');
const TTS_SCRIPT = path.join(__dirname, 'tts.py');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRANSCRIPT_DIR = path.join(__dirname, 'transcripts');
const PENDING_DIR = path.join(__dirname, '..', 'pending-executions');
const ACTIVE_CALL_FILE = path.join(__dirname, '..', 'voice', 'active-call.json');
const RECENT_CALL_FILE = path.join(__dirname, '..', 'voice', 'recent-call.json');
const KOKORO_VOICE = 'bf_emma';

// --- Auth: network-level ---
// No token validation needed — voice server relies on network-level security
// (e.g. VPN, private network). Only devices on the trusted network can reach it.

// Ensure directories exist
if (!fs.existsSync(TRANSCRIPT_DIR)) {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
}

// --- Kokoro TTS: load model once at startup, keep in memory ---
let kokoroTts = null;
let kokoroReady = false;

async function initKokoro() {
  try {
    console.log('[voice] Loading Kokoro TTS model (q8, CPU)...');
    const startTime = Date.now();
    const { KokoroTTS } = require('kokoro-js');
    kokoroTts = await KokoroTTS.from_pretrained(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      { dtype: 'q8', device: 'cpu' }
    );
    kokoroReady = true;
    console.log(`[voice] Kokoro TTS ready (${KOKORO_VOICE}) — loaded in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error(`[voice] Kokoro TTS failed to load: ${e.message}. Falling back to Python TTS.`);
    kokoroReady = false;
  }
}

// Generate TTS audio as WAV buffer using Kokoro
async function kokoroGenerate(text) {
  if (!kokoroReady || !kokoroTts) throw new Error('Kokoro not ready');
  const audio = await kokoroTts.generate(text, { voice: KOKORO_VOICE, speed: 1.1 });
  const wavBuffer = audio.toWav();
  return Buffer.from(wavBuffer);
}

// --- Piper TTS daemon as fallback ---
const TTS_DAEMON_SCRIPT = path.join(__dirname, 'tts_daemon.py');
let ttsDaemon = null;
let ttsDaemonFailures = 0;
const TTS_DAEMON_MAX_FAILURES = 3;

function startTtsDaemon() {
  if (!fs.existsSync(TTS_DAEMON_SCRIPT)) return;
  if (ttsDaemonFailures >= TTS_DAEMON_MAX_FAILURES) {
    console.log(`[voice] Piper TTS daemon failed ${ttsDaemonFailures} times, giving up (Kokoro is primary)`);
    return;
  }
  console.log('[voice] Starting Piper TTS daemon (fallback)...');
  ttsDaemon = spawn('python3', [TTS_DAEMON_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(__dirname, '..'),
    env: {
      HOME: process.env.HOME,
      USER: process.env.USER || 'cranium',
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
    },
    detached: false,
  });
  ttsDaemon.stdout.on('data', (d) => console.log(`[tts-daemon] ${d.toString().trim()}`));
  ttsDaemon.stderr.on('data', (d) => console.log(`[tts-daemon] ${d.toString().trim()}`));
  ttsDaemon.on('close', (code) => {
    ttsDaemon = null;
    ttsDaemonFailures++;
    if (ttsDaemonFailures < TTS_DAEMON_MAX_FAILURES) {
      console.log(`[voice] TTS daemon exited (${code}), retrying (${ttsDaemonFailures}/${TTS_DAEMON_MAX_FAILURES})...`);
      setTimeout(startTtsDaemon, 5000);
    } else {
      console.log(`[voice] Piper TTS daemon failed ${ttsDaemonFailures} times, giving up (Kokoro is primary)`);
    }
  });
  ttsDaemon.on('error', (e) => console.error(`[voice] TTS daemon error: ${e.message}`));
}

startTtsDaemon();

// Fallback: Python TTS (edge-tts -> Piper chain)
async function fallbackTts(text) {
  const audioFile = `/tmp/voice-fallback-${Date.now()}.mp3`;
  const tts = spawn('python3', [TTS_SCRIPT, text, audioFile], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let ttsErr = '';
  tts.stderr.on('data', (chunk) => { ttsErr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    tts.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`TTS failed (code ${code}): ${ttsErr}`));
    });
    tts.on('error', reject);
  });
  const data = fs.readFileSync(audioFile);
  setTimeout(() => { fs.unlink(audioFile, () => {}); }, 10000);
  return data;
}

// Unified TTS: try Kokoro first, fall back to Python
async function generateTts(text) {
  if (kokoroReady) {
    try {
      return await kokoroGenerate(text);
    } catch (e) {
      console.error(`[voice] Kokoro TTS failed for "${text.substring(0, 40)}...": ${e.message}, falling back`);
    }
  }
  return await fallbackTts(text);
}

// --- Sentence splitter for streaming TTS ---
// Splits text into sentences suitable for individual TTS generation.
// Splits on . ! ? followed by space or end-of-string, but not on common abbreviations.
function splitSentences(text) {
  const sentences = [];
  // Split on sentence-ending punctuation followed by space or end
  const parts = text.split(/(?<=[.!?])\s+/);
  let current = '';
  for (const part of parts) {
    current += (current ? ' ' : '') + part;
    // Only split if the part ends with sentence-ending punctuation
    // and isn't a common abbreviation (e.g., "Dr.", "Mr.", "etc.")
    if (/[.!?]$/.test(current) && !/\b(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|etc|i\.e|e\.g)\.\s*$/i.test(current)) {
      sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) {
    sentences.push(current.trim());
  }
  return sentences;
}

// Load tokens from .env file
let CLAUDE_OAUTH_TOKEN = '';
let SLACK_BOT_TOKEN = '';
try {
  const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  const oauthMatch = envFile.match(/CLAUDE_CODE_OAUTH_TOKEN=(.+)/);
  if (oauthMatch) CLAUDE_OAUTH_TOKEN = oauthMatch[1].trim();
  const slackMatch = envFile.match(/SLACK_BOT_TOKEN=(.+)/);
  if (slackMatch) SLACK_BOT_TOKEN = slackMatch[1].trim();
} catch (e) { /* ignore */ }
if (!CLAUDE_OAUTH_TOKEN) console.warn('[voice] WARNING: No CLAUDE_CODE_OAUTH_TOKEN found — claude -p will fail');
if (!SLACK_BOT_TOKEN) console.warn('[voice] WARNING: No SLACK_BOT_TOKEN found — post-call Slack posting will fail');

// --- Fetch recent Slack thread messages for voice greeting context ---
async function fetchRecentSlackContext(channel, threadTs, limit = 8) {
  if (!SLACK_BOT_TOKEN || !channel || !threadTs) return '';
  try {
    const resp = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=200`, {
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const data = await resp.json();
    if (!data.ok || !data.messages || data.messages.length === 0) return '';
    const msgs = data.messages
      .filter(m => m.text)
      .slice(-limit);
    if (msgs.length === 0) return '';
    return msgs.map(m => {
      const who = m.bot_id ? 'Claude' : 'User';
      const text = (m.text || '').substring(0, 300);
      return `${who}: ${text}`;
    }).join('\n');
  } catch (e) {
    console.error('[voice] Failed to fetch Slack context:', e.message);
    return '';
  }
}

// If the network layer already provides encryption (e.g. VPN/WireGuard), HTTPS is redundant.
// Plain HTTP avoids self-signed cert issues with iOS Safari WebSocket upgrades.
const USE_HTTPS = false;
const CERT_PATH = '';
const KEY_PATH = '';

// --- Save transcript to file ---
function saveTranscript(wsId, transcript, slackChannel, slackThread) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '-');
  const fileName = `${dateStr}_${timeStr}_${wsId.slice(0, 8)}.md`;
  const filePath = path.join(TRANSCRIPT_DIR, fileName);

  let content = `# Voice Call Transcript\n`;
  content += `**Date:** ${now.toISOString()}\n`;
  if (slackChannel && slackThread) {
    content += `**Slack:** ${slackChannel} / ${slackThread}\n`;
  }
  content += `**Turns:** ${transcript.length}\n\n---\n\n`;

  for (const t of transcript) {
    content += `**${t.role === 'user' ? 'User' : 'Claude'}:** ${t.text}\n\n`;
  }

  fs.writeFileSync(filePath, content);
  console.log(`[voice] Transcript saved: ${filePath}`);
  return filePath;
}

// --- Post brief summary to Slack ---
async function postCallSummary(channel, threadTs, summaryText) {
  if (!SLACK_BOT_TOKEN) {
    console.error('[voice] Cannot post to Slack — no bot token');
    return;
  }

  try {
    let message = summaryText;
    if (message.length > 3900) {
      message = message.substring(0, 3900) + '\n\n_(truncated)_';
    }

    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel,
        thread_ts: threadTs,
        text: message,
      }),
    });
    const data = await resp.json();
    if (!data.ok) {
      console.error(`[voice] Slack post failed: ${data.error}`);
    } else {
      console.log(`[voice] Posted call summary to Slack thread ${threadTs}`);
    }
  } catch (e) {
    console.error(`[voice] Slack post error: ${e.message}`);
  }
}

// --- Run a simple Claude prompt and return stdout ---
function runClaudePrompt(prompt, cleanEnv, model = 'opus') {
  return new Promise((resolve) => {
    const claude = spawn('claude', ['-p', '--output-format', 'text', '--model', model, '--dangerously-skip-permissions', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.join(__dirname, '..'),
      env: cleanEnv
    });
    let stdout = '';
    claude.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    claude.on('close', (code) => {
      resolve(code === 0 ? stdout.trim() : '');
    });
    claude.on('error', () => { resolve(''); });
  });
}

// --- Extract action items from transcript (thorough scan) ---
async function extractActionItems(transcript, cleanEnv) {
  const transcriptText = transcript.map(t =>
    `${t.role === 'user' ? 'User' : 'Claude'}: ${t.text}`
  ).join('\n\n');

  const extractPrompt = `You are reviewing a voice call transcript between the User and Claude. Your job is to extract EVERY action item, task, request, or commitment made during the call. Be thorough — scan every line. Action items that get missed here are lost forever.

An action item is anything where:
- The User asked Claude to do something (explicitly or implicitly)
- Claude offered to do something and the User agreed or didn't object
- A decision was made that requires follow-up work
- Something was deferred to "after the call"
- The User said they wanted something built, changed, investigated, scoped, etc.

For each action item, note:
1. What needs to be done (specific and actionable)
2. Who owns it (Claude or User)
3. The context from the conversation (why it was discussed)

Output format — return ONLY a JSON array, no other text:
[
  {
    "action": "Description of what needs to be done",
    "owner": "Claude" or "User",
    "context": "Brief context from the conversation"
  }
]

If there are truly no action items, return an empty array: []

Transcript:
${transcriptText}`;

  const result = await runClaudePrompt(extractPrompt, cleanEnv);
  if (!result) return [];

  try {
    // Parse JSON — handle cases where the model wraps it in markdown code blocks
    const cleaned = result.replace(/^```json?\s*/m, '').replace(/\s*```$/m, '').trim();
    const items = JSON.parse(cleaned);
    if (Array.isArray(items)) return items;
  } catch (e) {
    console.error(`[voice] Action item extraction parse error: ${e.message}`);
  }
  return [];
}

// --- Generate call summary + action items using Claude ---
async function generateCallSummary(transcript, cleanEnv) {
  // Step 1: Thorough action item extraction
  const actionItems = await extractActionItems(transcript, cleanEnv);
  const claudeActions = actionItems.filter(a => a.owner === 'Claude' || a.owner === 'claude');
  const userActions = actionItems.filter(a => a.owner === 'User' || a.owner === 'user');

  console.log(`[voice] Extracted ${actionItems.length} action items (${claudeActions.length} Claude, ${userActions.length} User)`);

  // Step 2: Generate conversational summary with action items baked in
  const transcriptText = transcript.map(t =>
    `${t.role === 'user' ? 'User' : 'Claude'}: ${t.text}`
  ).join('\n\n');

  let actionBlock = '';
  if (actionItems.length > 0) {
    actionBlock = '\n\nExtracted action items (include ALL of these in your summary):\n';
    for (const item of actionItems) {
      actionBlock += `- [${item.owner}] ${item.action}\n`;
    }
  }

  const summaryPrompt = `You just hung up a voice call with the User. Write a natural follow-up Slack message — like a coworker would after hanging up a phone call.

Rules:
- Sound like YOU continuing the conversation in text, not a meeting minutes bot.
- Briefly mention what you talked about (1-2 sentences, conversational).
- If there are Claude action items, mention them conversationally: "I'll go ahead and [X] and [Y]."
- If there are User action items, mention those too: "On your end, you mentioned wanting to [X]."
- IMPORTANT: Every single action item listed below MUST appear in your summary. Do not skip or combine them into vague descriptions. Be specific about each one.
- If there ARE Claude action items, end with: "Just say 'go ahead' and I'll get started."
- If there are NO action items, just wrap up casually. Do NOT include the approval prompt.
- No headers, no bullet points, no structured formatting. Just talk.
- Keep it concise but complete — every action item must be mentioned.
${actionBlock}
Transcript:
${transcriptText}`;

  const summary = await runClaudePrompt(summaryPrompt, cleanEnv);
  if (!summary) {
    const topics = transcript
      .filter(t => t.role === 'user')
      .map(t => `• ${t.text.substring(0, 80)}`)
      .join('\n');
    return { summary: topics || '(empty call)', actionItems };
  }

  return { summary, actionItems };
}

// --- Write pending execution file for listener to pick up on approval ---
function writePendingExecution(summary, actionItems, transcript, channel, threadTs) {
  if (!fs.existsSync(PENDING_DIR)) {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
  }
  const fileName = `voice-${Date.now()}.json`;
  const filePath = path.join(PENDING_DIR, fileName);
  const transcriptText = transcript.map(t =>
    `${t.role === 'user' ? 'User' : 'Claude'}: ${t.text}`
  ).join('\n\n');
  fs.writeFileSync(filePath, JSON.stringify({
    plan: summary,
    actionItems: actionItems || [],
    transcript: transcriptText,
    channel,
    threadTs,
    createdAt: new Date().toISOString(),
    status: 'awaiting_approval',
  }, null, 2));
  console.log(`[voice] Pending execution written: ${filePath}`);
  return filePath;
}

// --- HTTP server for serving the static page ---
function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const filePath = path.join(PUBLIC_DIR, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  if (url.pathname.startsWith('/audio/')) {
    const fileName = path.basename(url.pathname);
    const filePath = path.join('/tmp', fileName);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
    return;
  }

  if (url.pathname.endsWith('.html') && !url.pathname.includes('..')) {
    const fileName = path.basename(url.pathname);
    const filePath = path.join(PUBLIC_DIR, fileName);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// --- Create HTTP(S) server ---
let httpServer;
if (USE_HTTPS && CERT_PATH && KEY_PATH) {
  httpServer = https.createServer({
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
  }, serveStatic);
} else {
  httpServer = http.createServer(serveStatic);
}

// --- WebSocket server ---
const wss = new WebSocketServer({ server: httpServer });

// --- Keepalive: ping every 25s to prevent carrier/NAT idle timeout ---
const PING_INTERVAL = 25000;
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[voice] Client missed pong — terminating dead connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const wsId = crypto.randomUUID();
  let sessionId = url.searchParams.get('session') || null;
  const slackChannel = url.searchParams.get('channel') || null;
  const slackThread = url.searchParams.get('thread') || null;
  let processing = false;
  let currentProcess = null;
  const transcript = [];

  const cleanEnv = {
    HOME: process.env.HOME,
    USER: process.env.USER || 'cranium',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_OAUTH_TOKEN,
  };

  console.log(`[voice] Client connected: ${wsId}${sessionId ? ` (resuming session ${sessionId})` : ' (new session)'}${slackChannel ? ` [slack: ${slackChannel}/${slackThread}]` : ''}`);

  // Write active call state file
  try {
    fs.writeFileSync(ACTIVE_CALL_FILE, JSON.stringify({
      wsId,
      sessionId,
      slackChannel,
      slackThread,
      startedAt: new Date().toISOString(),
    }, null, 2));
    console.log(`[voice] Active call file written`);
  } catch (e) {
    console.error(`[voice] Failed to write active call file: ${e.message}`);
  }

  // Keepalive pong handler
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let cachedSlackContext = null;
  let greetingDone = false;

  // --- Claude speaks first: context-aware greeting with Kokoro TTS ---
  (async () => {
    try {
      cachedSlackContext = await fetchRecentSlackContext(slackChannel, slackThread);

      let greetText;
      if (cachedSlackContext) {
        const greetingPrompt = `You're picking up a voice call with the User. Here's what you two were just discussing in Slack:\n\n${cachedSlackContext}\n\nGenerate a brief, natural greeting (1 sentence) that acknowledges the recent conversation. Examples: "Hey — so about that API issue." or "Hey, I was just looking into the scout thing you mentioned." Don't say "how can I help" or anything generic. Just pick up where you left off. Plain text only, no markdown.`;

        const greetClaude = spawn('claude', ['-p', '--output-format', 'text', '--model', 'sonnet', '--dangerously-skip-permissions', greetingPrompt], {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: path.join(__dirname, '..'),
          env: cleanEnv
        });
        let rawText = '';
        greetClaude.stdout.on('data', (chunk) => { rawText += chunk.toString(); });
        await new Promise((resolve) => {
          greetClaude.on('close', resolve);
          greetClaude.on('error', resolve);
        });
        greetText = rawText.trim() || "Hey, what's going on?";
      } else {
        greetText = "Hey, what's up?";
      }

      // TTS the greeting using Kokoro (in-process, no Python)
      const greetAudio = await generateTts(greetText);

      if (ws.readyState === 1) {
        transcript.push({ role: 'claude', text: greetText });
        ws.send(JSON.stringify({ type: 'response_text', text: greetText }));
        ws.send(JSON.stringify({ type: 'status', status: 'speaking' }));
        ws.send(greetAudio);
        console.log(`[voice] Greeting sent: "${greetText}" (${greetAudio.length} bytes)`);
      }
    } catch (e) {
      console.error(`[voice] Greeting generation failed: ${e.message}`);
    }
    greetingDone = true;
  })();

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'transcript' && msg.text) {
      if (processing) {
        ws.send(JSON.stringify({ type: 'status', status: 'busy' }));
        return;
      }

      // Wait for greeting to finish before processing first user message
      if (!greetingDone) {
        const waitStart = Date.now();
        while (!greetingDone && Date.now() - waitStart < 15000) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      processing = true;
      const userText = msg.text.trim();
      transcript.push({ role: 'user', text: userText });
      console.log(`[voice] User said: "${userText.substring(0, 80)}..."`);

      ws.send(JSON.stringify({ type: 'status', status: 'thinking' }));

      try {
        const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--dangerously-skip-permissions'];
        if (sessionId) {
          args.push('--resume', sessionId);
        }

        const voiceRules = `[VOICE MODE] Live voice call. User is hands-free. Your responses are read aloud via TTS.
CRITICAL RULES — violating these ruins the experience:
1. WALKIE-TALKIE BREVITY. 1-2 sentences. If it takes more than 10 seconds to say, it's too long. User can always ask for more.
2. ZERO TECHNICAL CONTENT. Never say filenames, code, error messages, line numbers, config details, or technical jargon out loud. If you need to share anything technical, say "I'll drop the details in Slack" and move on.
3. PLAIN SPEECH ONLY. No markdown, no bullets, no lists, no formatting. Talk like a human on the phone.
4. NO FILLER. No "Great question!", no preamble, no "Let me think about that." Just answer.
5. LISTEN AND UNDERSTAND FIRST. On the phone, your priority is understanding what the User needs and gathering context. Ask clarifying questions. Don't jump to action unless the User explicitly asks you to do something. This is a conversation, not a command line.
6. BLOCKERS: If you hit a problem, say what's wrong in under 10 words. "I'm blocked on file permissions, want me to send details?" That's it. Never explain the technical details verbally.
7. WRAP UP: When the User says "wrap up" or "let's wrap up", give a brief 2-3 sentence verbal summary of what was discussed and decided. Keep it conversational.
8. CALL ENDING: When the call ends (User hangs up or taps End Call), a detailed summary with action items is automatically generated and posted to Slack. The User reviews it there and approves before anything gets executed. You don't need to manage this — just have a good conversation.
9. DEFERRED WORK: If the User asks you to check something or do a task, give a brief verbal acknowledgment like "I'll handle that after we hang up" or "I'll check and post to Slack." Do NOT execute long tool chains, file reads, or investigations during the call — it produces long technical responses that get spoken aloud. Keep the conversation flowing. Action items get executed post-call.

You're Claude, the User's assistant. Be direct, have opinions, be useful.`;

        let prompt;
        if (!sessionId) {
          const slackContext = cachedSlackContext || await fetchRecentSlackContext(slackChannel, slackThread);
          const contextBlock = slackContext
            ? `\nRECENT SLACK CONVERSATION (what you and the User were just discussing before this call):\n${slackContext}\n\nUse this context naturally. If relevant, pick up where the conversation left off. Don't summarize it back to them — just continue as if you remember.`
            : '';
          prompt = `${voiceRules}${contextBlock}\n\nUser says: ${userText}`;
        } else {
          prompt = `${voiceRules}\n\nUser says: ${userText}`;
        }

        args.push(prompt);

        console.log(`[voice] Spawning: claude ${args.slice(0, 4).join(' ')} "<prompt>"`);
        const claude = spawn('claude', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: path.join(__dirname, '..'),
          env: cleanEnv
        });

        currentProcess = claude;
        let responseText = '';
        let stderr = '';
        let streamBuf = '';

        // --- Streaming sentence-level TTS ---
        // As Claude produces text, we accumulate it and detect sentence boundaries.
        // Each complete sentence is immediately TTS'd and sent to the client.
        // The client's audio queue plays them in order — first sentence plays
        // while later sentences are still being generated + TTS'd.
        let textAccumulator = ''; // Raw text from Claude, not yet TTS'd
        let sentencesSent = 0;
        let ttsQueue = Promise.resolve(); // Serialized TTS generation
        let firstAudioSent = false;

        function enqueueSentenceTts(sentence) {
          sentencesSent++;
          const sentenceNum = sentencesSent;
          ttsQueue = ttsQueue.then(async () => {
            if (ws.readyState !== 1) return;
            try {
              const startTime = Date.now();
              const audioData = await generateTts(sentence);
              const elapsed = Date.now() - startTime;
              console.log(`[voice] TTS sentence ${sentenceNum}: "${sentence.substring(0, 40)}..." → ${audioData.length} bytes in ${elapsed}ms`);

              if (ws.readyState === 1) {
                if (!firstAudioSent) {
                  // First audio chunk — switch client from thinking to speaking
                  ws.send(JSON.stringify({ type: 'status', status: 'speaking' }));
                  firstAudioSent = true;
                }
                ws.send(audioData);
              }
            } catch (e) {
              console.error(`[voice] TTS failed for sentence ${sentenceNum}: ${e.message}`);
            }
          });
        }

        function flushSentences() {
          const sentences = splitSentences(textAccumulator);
          // Send all complete sentences (keep the last fragment if it doesn't end with punctuation)
          if (sentences.length > 1) {
            // All but the last are complete — TTS them
            for (let i = 0; i < sentences.length - 1; i++) {
              enqueueSentenceTts(sentences[i]);
            }
            // Keep the last fragment (may be incomplete)
            textAccumulator = sentences[sentences.length - 1];
          }
          // If there's only one sentence and it ends with punctuation, it's complete
          else if (sentences.length === 1 && /[.!?]$/.test(sentences[0].trim())) {
            enqueueSentenceTts(sentences[0]);
            textAccumulator = '';
          }
        }

        // Parse stream-json output
        claude.stdout.on('data', (chunk) => {
          streamBuf += chunk.toString();
          let nlIdx;
          while ((nlIdx = streamBuf.indexOf('\n')) !== -1) {
            const line = streamBuf.slice(0, nlIdx).trim();
            streamBuf = streamBuf.slice(nlIdx + 1);
            if (!line) continue;
            try {
              const evt = JSON.parse(line);

              if (evt.session_id) {
                sessionId = evt.session_id;
              }

              // Accumulate assistant text and trigger streaming TTS
              if (evt.type === 'assistant' && evt.message?.content) {
                for (const block of evt.message.content) {
                  if (block.type === 'text') {
                    responseText += block.text;
                    textAccumulator += block.text;
                    flushSentences();
                  }
                }
              }

              // Forward tool use as live activity
              if (evt.type === 'assistant' && evt.message?.content) {
                for (const block of evt.message.content) {
                  if (block.type === 'tool_use') {
                    const toolName = block.name || 'Working';
                    let detail = '';
                    if (toolName === 'Read' && block.input?.file_path) {
                      detail = 'Reading file...';
                    } else if (toolName === 'Edit' && block.input?.file_path) {
                      detail = 'Editing file...';
                    } else if (toolName === 'Write' && block.input?.file_path) {
                      detail = 'Writing file...';
                    } else if (toolName === 'Bash') {
                      detail = 'Running command...';
                    } else if (toolName === 'Grep' || toolName === 'Glob') {
                      detail = 'Searching...';
                    } else if (toolName === 'WebFetch' || toolName === 'WebSearch') {
                      detail = 'Researching...';
                    } else if (toolName === 'Task') {
                      detail = 'Delegating subtask...';
                    } else {
                      detail = `Using ${toolName}...`;
                    }
                    try {
                      ws.send(JSON.stringify({ type: 'activity', text: detail }));
                    } catch (e) {}
                  }
                }
              }

              if (evt.type === 'result') {
                if (!responseText && evt.result) {
                  responseText = typeof evt.result === 'string' ? evt.result : '';
                }
                if (evt.session_id) {
                  sessionId = evt.session_id;
                }
              }
            } catch (e) {
              // Not valid JSON, skip
            }
          }
        });

        claude.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          stderr += text;
          console.log(`[voice] claude stderr: ${text.trim()}`);
          const sessionMatch = stderr.match(/session:\s*([a-f0-9-]+)/i);
          if (sessionMatch && !sessionId) {
            sessionId = sessionMatch[1];
          }
        });

        await new Promise((resolve, reject) => {
          claude.on('close', (code) => {
            currentProcess = null;
            console.log(`[voice] claude exited with code ${code}, response length: ${responseText.length}`);
            if (code === 0) resolve();
            else reject(new Error(`claude exited with code ${code}: ${stderr || '(no stderr)'}`));
          });
          claude.on('error', (err) => {
            console.log(`[voice] claude spawn error: ${err.message}`);
            reject(err);
          });
        });

        responseText = responseText.trim();
        if (!responseText) {
          ws.send(JSON.stringify({ type: 'status', status: 'error', message: 'Empty response from Claude' }));
          processing = false;
          return;
        }

        console.log(`[voice] Claude responded: "${responseText.substring(0, 80)}..."`);
        transcript.push({ role: 'claude', text: responseText });

        // Send full text transcript
        ws.send(JSON.stringify({ type: 'response_text', text: responseText }));

        // Flush any remaining text that didn't end with punctuation
        if (textAccumulator.trim()) {
          enqueueSentenceTts(textAccumulator.trim());
          textAccumulator = '';
        }

        // Wait for all TTS to complete before marking processing done
        await ttsQueue;

        // Signal client that all audio for this response has been sent
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'response_done' }));
        }

      } catch (err) {
        console.error(`[voice] Error:`, err.message);
        ws.send(JSON.stringify({ type: 'status', status: 'error', message: err.message }));
      }

      processing = false;
    }

    // Handle cancel/interrupt
    if (msg.type === 'cancel') {
      if (currentProcess) {
        currentProcess.kill('SIGTERM');
        currentProcess = null;
        processing = false;
        ws.send(JSON.stringify({ type: 'status', status: 'cancelled' }));
      }
    }
  });

  ws.on('close', () => {
    console.log(`[voice] Client disconnected: ${wsId}`);
    if (currentProcess) {
      currentProcess.kill('SIGTERM');
    }
    // Remove active call state file
    try {
      if (fs.existsSync(ACTIVE_CALL_FILE)) {
        const callData = JSON.parse(fs.readFileSync(ACTIVE_CALL_FILE, 'utf8'));
        if (callData.wsId === wsId) {
          fs.unlinkSync(ACTIVE_CALL_FILE);
          console.log(`[voice] Active call file removed`);
        }
      }
    } catch (e) {
      console.error(`[voice] Failed to remove active call file: ${e.message}`);
    }
    // On disconnect: save transcript, generate summary + action items, post to Slack
    const hadConversation = transcript.some(t => t.role === 'claude');
    if (transcript.length > 0) {
      saveTranscript(wsId, transcript, slackChannel, slackThread);

      if (slackChannel && slackThread && hadConversation) {
        try {
          const topics = transcript
            .filter(t => t.role === 'user')
            .map(t => t.text.substring(0, 100))
            .slice(0, 5);
          const fullTranscript = transcript.map(t =>
            `${t.role === 'user' ? 'User' : 'Claude'}: ${t.text}`
          ).join('\n\n');
          fs.writeFileSync(RECENT_CALL_FILE, JSON.stringify({
            endedAt: new Date().toISOString(),
            slackChannel,
            slackThread,
            sessionId: sessionId || null,
            topics,
            transcript: fullTranscript,
          }, null, 2));
          console.log('[voice] Recent call file written');
        } catch (e) {
          console.error(`[voice] Failed to write recent call file: ${e.message}`);
        }

        generateCallSummary(transcript, cleanEnv)
          .then(async (result) => {
            const { summary, actionItems } = result;
            const claudeActions = (actionItems || []).filter(a =>
              a.owner === 'Claude' || a.owner === 'claude'
            );
            if (claudeActions.length > 0) {
              writePendingExecution(summary, actionItems, transcript, slackChannel, slackThread);
            }
            await postCallSummary(slackChannel, slackThread, summary);
          })
          .catch(e => console.error(`[voice] Summary generation failed: ${e.message}`));
      }
    }
  });
});

// Bind to 0.0.0.0 by default — required when running behind a reverse proxy.
// Override with VOICE_BIND_HOST env var if needed.
const BIND_HOST = process.env.VOICE_BIND_HOST || '0.0.0.0';

// Initialize Kokoro TTS, then start server
initKokoro().then(() => {
  httpServer.listen(PORT, BIND_HOST, () => {
    console.log(`[voice] Server running on ${BIND_HOST}:${PORT} (${USE_HTTPS ? 'HTTPS' : 'HTTP'})`);
    console.log(`[voice] TTS: Kokoro (${KOKORO_VOICE})${kokoroReady ? ' ✓' : ' ✗ — using Python fallback'}`);
    console.log(`[voice] Auth: network-level (no token required)`);
  });
});
