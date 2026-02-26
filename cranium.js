// cranium.js — Slack ↔ Claude Code bridge
import bolt from "@slack/bolt";
const { App } = bolt;
import { spawn } from "child_process";
import { createInterface } from "readline";
import { writeFileSync, readFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "fs";
import path from "path";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const CRANIUM_DIR = process.env.CRANIUM_DIR || path.resolve(".");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MEMORY_DIR = `${CRANIUM_DIR}/memory`;
const MCP_CONFIG = `${CRANIUM_DIR}/mcp-config.json`;
const SESSIONS_FILE = `${CRANIUM_DIR}/sessions.json`;
const PENDING_DIR = `${CRANIUM_DIR}/pending-executions`;
const ACTIVE_CALL_FILE = `${CRANIUM_DIR}/voice/active-call.json`;
const RECENT_CALL_FILE = `${CRANIUM_DIR}/voice/recent-call.json`;

const CLAUDE_ENV = {
  ...process.env,
  HOME: process.env.HOME,
  USER: process.env.USER || "cranium",
  PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  LANG: "en_US.UTF-8",
};

// ── Boot Tracking (for post-restart context injection) ──────────────────────
const BOOT_TIME = Date.now();
const RESTART_MARKER = `${CRANIUM_DIR}/.restart-origin`;

// Read and clear restart origin marker (written before restart to track which thread triggered it)
function getRestartOrigin() {
  try {
    if (!existsSync(RESTART_MARKER)) return null;
    const data = JSON.parse(readFileSync(RESTART_MARKER, "utf8"));
    unlinkSync(RESTART_MARKER);
    return data; // { channel, threadTs }
  } catch {
    try { unlinkSync(RESTART_MARKER); } catch {}
    return null;
  }
}

// ── Session Management (disk-persisted) ─────────────────────────────────────
const sessions = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

function persistSessions() {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (e) {
    console.error("Failed to persist sessions:", e.message);
  }
}

function loadSessions() {
  try {
    if (!existsSync(SESSIONS_FILE)) return;
    const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    for (const [k, v] of Object.entries(data)) {
      // Load all sessions regardless of age — sessionIds are kept indefinitely
      // so --resume works even when returning to old threads
      sessions.set(k, v);
    }
    console.log(`Restored ${sessions.size} session(s) from disk`);
  } catch (e) {
    console.error("Failed to load sessions:", e.message);
  }
}

// ── Running Process Tracking (for cancel/abort) ─────────────────────────────
// Maps threadKey -> { proc, ackTs, channel, aborted }
const runningProcesses = new Map();

// Cancel detection — returns true if message is primarily a cancel/stop request.
// Matches both exact ("stop") and natural phrasing ("hold on let's pause for a second").
const CANCEL_EXACT = /^\s*(stop|cancel|abort|pause|nevermind|never mind|kill it|wait|hold up|scratch that|hold on|stop that)\s*[.!]?\s*$/i;
const CANCEL_FUZZY = /\b(hold on|stop|cancel|abort|pause|wait|hold up)\b/i;

function isCancelMessage(text) {
  // Exact match: message is just a cancel word
  if (CANCEL_EXACT.test(text)) return true;
  // Fuzzy match: short message (under 60 chars) containing a cancel word
  // Avoids false positives on long messages that happen to contain "stop" or "wait"
  if (text.length < 60 && CANCEL_FUZZY.test(text)) return true;
  return false;
}

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || "sonnet";
const MODEL_EMOJI = { opus: "🔴" };

// Friendly names for tool use status updates
const TOOL_LABELS = {
  Bash: (input) => {
    const cmd = input?.command || "";
    const short = cmd.split("\n")[0].substring(0, 60);
    return short ? `Running: \`${short}\`` : "Running a command...";
  },
  Read: (input) => {
    const p = input?.file_path || input?.path || "";
    const name = p.split("/").pop();
    return name ? `Reading \`${name}\`` : "Reading a file...";
  },
  Edit: (input) => {
    const p = input?.file_path || input?.path || "";
    const name = p.split("/").pop();
    return name ? `Editing \`${name}\`` : "Editing a file...";
  },
  Write: (input) => {
    const p = input?.file_path || input?.path || "";
    const name = p.split("/").pop();
    return name ? `Writing \`${name}\`` : "Writing a file...";
  },
  Glob: () => "Searching for files...",
  Grep: () => "Searching file contents...",
  WebFetch: (input) => {
    const url = input?.url || "";
    try { return `Fetching ${new URL(url).hostname}...`; } catch { return "Fetching a URL..."; }
  },
  WebSearch: (input) => {
    const q = input?.query || "";
    return q ? `Searching: "${q.substring(0, 40)}"` : "Searching the web...";
  },
  TodoWrite: () => "Updating task list...",
  Task: () => "Spawning a sub-agent...",
};

// ── Skills Index ─────────────────────────────────────────────────────────────
// Scans skills/ and builds a compact index from each file's title + "When to Use" section.
// Used by the router for skill matching, and appended to every prompt as a fallback index.
const SKILLS_DIR = `${CRANIUM_DIR}/skills`;

function buildSkillsIndex() {
  try {
    const files = readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md")).sort();
    const entries = [];
    for (const file of files) {
      try {
        const content = readFileSync(`${SKILLS_DIR}/${file}`, "utf8");
        const lines = content.split("\n");
        const titleLine = lines.find(l => l.startsWith("# "));
        const title = titleLine ? titleLine.replace(/^# /, "").trim() : file.replace(".md", "");
        const whenIdx = lines.findIndex(l => /^##\s*when to use/i.test(l));
        let description = "";
        if (whenIdx !== -1) {
          for (let i = whenIdx + 1; i < lines.length && i < whenIdx + 6; i++) {
            const l = lines[i].trim();
            if (l && !l.startsWith("#")) { description = l.replace(/^[-*]\s*/, ""); break; }
          }
        }
        entries.push(`- **${file}**: ${title}${description ? ` — ${description}` : ""}`);
      } catch {}
    }
    if (entries.length === 0) return { index: "" };
    return {
      index: `\n\n---\n**Available skills** (check the relevant file before acting):\n${entries.join("\n")}`,
    };
  } catch {
    return { index: "" };
  }
}

const SKILLS = buildSkillsIndex(); // Built once at startup
const SKILLS_INDEX = SKILLS.index;


// ── Helpers ──────────────────────────────────────────────────────────────────
// ── Voice Call State ──────────────────────────────────────────────────────
// Checks if a voice call is currently active by reading the state file
// written by the voice server. Returns the call data or null.
function getActiveVoiceCall() {
  try {
    if (!existsSync(ACTIVE_CALL_FILE)) return null;
    const data = JSON.parse(readFileSync(ACTIVE_CALL_FILE, "utf8"));
    // Sanity check: if the file is older than 4 hours, it's stale (orphaned)
    const age = Date.now() - new Date(data.startedAt).getTime();
    if (age > 4 * 60 * 60 * 1000) {
      try { unlinkSync(ACTIVE_CALL_FILE); } catch {}
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// ── Recent Voice Call Context ─────────────────────────────────────────
// After a voice call ends, the voice server writes a recent-call.json file.
// The listener consumes it on the next Slack message to inject context
// so Claude acknowledges the call naturally.
function getAndConsumeRecentCall() {
  try {
    if (!existsSync(RECENT_CALL_FILE)) return null;
    const data = JSON.parse(readFileSync(RECENT_CALL_FILE, "utf8"));
    // Consume it — only inject once
    unlinkSync(RECENT_CALL_FILE);
    // Only use if the call ended recently (within 2 hours)
    const age = Date.now() - new Date(data.endedAt).getTime();
    if (age > 2 * 60 * 60 * 1000) return null;
    return data;
  } catch {
    try { unlinkSync(RECENT_CALL_FILE); } catch {}
    return null;
  }
}


// Split a long message into chunks, breaking at paragraph boundaries when possible
function splitMessage(text, maxLen = 3900) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to break at a double newline (paragraph boundary) within the limit
    let breakAt = remaining.lastIndexOf("\n\n", maxLen);
    if (breakAt < maxLen * 0.3) {
      // Paragraph break too early — try single newline
      breakAt = remaining.lastIndexOf("\n", maxLen);
    }
    if (breakAt < maxLen * 0.3) {
      // No good line break — hard cut at limit
      breakAt = maxLen;
    }
    chunks.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).replace(/^\n+/, "");
  }
  return chunks;
}

function today() {
  return new Date().toISOString().split("T")[0];
}

function appendDailyNote(note) {
  const file = `${MEMORY_DIR}/${today()}.md`;
  if (!existsSync(file)) {
    writeFileSync(file, `# ${today()} Session Notes\n\n`);
  }
  appendFileSync(file, `${note}\n`);
}

function getThreadKey(message) {
  return message.thread_ts || message.ts;
}

// ── Session Cleanup ─────────────────────────────────────────────────────────
// Sessions are never fully deleted — the sessionId is kept forever so --resume
// works if the user returns to an old thread. After 30m idle we only clear the
// model-stickiness metadata so routing starts fresh.
function cleanupSessions() {
  const now = Date.now();
  let staled = 0;
  for (const [threadId, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS && session.model) {
      appendDailyNote(`- Session went idle (30m). Turns: ${session.turns}, last model: ${session.model}`);
      // Retain sessionId and channel/threadTs; clear routing state only
      sessions.set(threadId, {
        sessionId: session.sessionId,
        channel: session.channel,
        threadTs: session.threadTs,
        turns: session.turns,
        bootNotified: session.bootNotified,
        lastActivity: session.lastActivity,
        // model intentionally omitted
      });
      staled++;
    }
  }
  if (staled > 0) persistSessions();
}
setInterval(cleanupSessions, 5 * 60 * 1000);

// ── Context Management: Summary-and-Reset ────────────────────────────────
// After TURN_THRESHOLD turns in a thread, the conversation history gets too
// long and causes hallucinations. We summarize the thread so far, drop
// --resume, and start a fresh session with the summary injected as context.
const TURN_THRESHOLD = 50;

async function fetchRecentThreadMessages(channel, threadTs, limit = 20) {
  try {
    const result = await app.client.conversations.replies({
      token: process.env.SLACK_BOT_TOKEN,
      channel,
      ts: threadTs,
      limit: 200, // Fetch more than we need, then take the tail
    });
    if (!result.messages || result.messages.length === 0) return "";
    const msgs = result.messages.slice(-limit);
    return msgs.map(m => {
      const who = m.bot_id ? "Claude" : "User";
      const text = (m.text || "").substring(0, 500);
      return `${who}: ${text}`;
    }).join("\n\n");
  } catch (e) {
    console.error("fetchRecentThreadMessages error:", e.message);
    return "";
  }
}

async function summarizeThread(channel, threadTs) {
  const recentMessages = await fetchRecentThreadMessages(channel, threadTs, 25);
  if (!recentMessages) return null;

  const summarizePrompt = `You are summarizing a long Slack conversation between the user and Claude (an AI assistant). This summary will be injected into a new session so Claude can continue with full context but without the bloated history.

Produce a structured summary covering:
1. **What was being worked on** — the main topics/tasks
2. **Key decisions made** — anything the user decided or approved
3. **Current state** — where things stand right now, what's in progress
4. **Open items** — anything unresolved or pending
5. **Important context** — preferences the user expressed, constraints, blockers

Be concise but thorough. ~300-500 words. Focus on what future-Claude needs to continue seamlessly.

Recent conversation:
${recentMessages}`;

  try {
    const summary = await runClaudeRaw(
      ["-p", summarizePrompt, "--model", "opus", "--output-format", "text", "--dangerously-skip-permissions", "--no-session-persistence"],
      60000
    );
    return summary.trim();
  } catch (e) {
    console.error("Thread summarization failed:", e.message);
    return null;
  }
}

// ── Claude CLI Runner (non-streaming, used for router) ──────────────────────
function runClaudeRaw(args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, args, {
      env: CLAUDE_ENV,
      cwd: CRANIUM_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, timeout);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}: ${stderr.substring(0, 300)}`));
      else resolve(stdout);
    });
  });
}

// ── Streaming Claude Runner ─────────────────────────────────────────────────
// Returns { promise, proc } — proc is the child process handle for abort support
function runClaudeStreaming(args, { onStatus }) {
  const proc = spawn(CLAUDE_BIN, args, {
    env: CLAUDE_ENV,
    cwd: CRANIUM_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const promise = new Promise((resolve, reject) => {
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

    let sessionId = null;
    let resultText = null;
    let lastAssistantText = null; // Fallback: capture text from assistant events
    let stderr = "";
    let lastStatusTime = 0;
    const STATUS_THROTTLE_MS = 2000;

    proc.stderr.on("data", (d) => { stderr += d; });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);

        if (event.type === "system" && event.subtype === "init") {
          sessionId = event.session_id;
          return;
        }

        if (event.type === "result") {
          sessionId = event.session_id || sessionId;
          resultText = event.result || "";
          return;
        }

        if (event.type === "assistant" && event.message?.content) {
          sessionId = event.session_id || sessionId;

          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              // Track the last text block from assistant as fallback
              lastAssistantText = block.text;
            }
            if (block.type === "tool_use") {
              const labelFn = TOOL_LABELS[block.name];
              let statusText;
              if (labelFn) {
                try { statusText = labelFn(block.input); } catch { statusText = `Using ${block.name}...`; }
              } else {
                statusText = `Using ${block.name}...`;
              }

              const now = Date.now();
              if (now - lastStatusTime >= STATUS_THROTTLE_MS) {
                lastStatusTime = now;
                onStatus(statusText);
              }
            }
          }
        }
      } catch {
        // Non-JSON line, ignore
      }
    });

    proc.on("close", (code, signal) => {
      // If killed by signal (abort), resolve with what we have
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        resolve({ text: resultText || "", sessionId, aborted: true });
        return;
      }

      // Only check stderr for rate limit signals — never resultText,
      // which contains the actual response and could false-positive
      // if the conversation mentions "usage limit" etc.
      const stderrLower = stderr.toLowerCase();
      const isRateLimit =
        stderrLower.includes("usage limit") ||
        stderrLower.includes("rate limit") ||
        stderrLower.includes("too many requests") ||
        stderrLower.includes("overloaded") ||
        code === 429;

      if (isRateLimit) {
        const err = new Error("rate_limit");
        err.isRateLimit = true;
        reject(err);
      } else if (code !== 0 && !resultText) {
        reject(new Error(`exit ${code}: ${stderr.substring(0, 300)}`));
      } else {
        // Use resultText if available, fall back to last assistant text block,
        // then to a generic message (never show "No output" to the user)
        const text = resultText || lastAssistantText || "(completed — no text response)";
        resolve({ text, sessionId });
      }
    });
  });

  return { promise, proc };
}

// ── Slack File Download ─────────────────────────────────────────────────────
const TEXT_EXTENSIONS = new Set(["csv", "txt", "json", "md", "js", "ts", "py", "html", "xml", "yaml", "yml", "toml", "ini", "log", "sql", "sh", "env", "tsv"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);
const MAX_TEXT_FILE_BYTES = 50 * 1024; // 50KB cap for text injection
const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500MB cap for video files

async function downloadSlackFile(file) {
  const url = file.url_private_download || file.url_private;
  if (!url) return null;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    const ext = (file.filetype || "bin").toLowerCase();
    const filePath = `/tmp/slack-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    writeFileSync(filePath, buffer);
    return filePath;
  } catch (e) {
    console.error("File download error:", e.message);
    return null;
  }
}

// ── Video Processing ────────────────────────────────────────────────────────
async function processVideoFile(videoPath) {
  const outputDir = `/tmp/video-${Date.now()}`;
  try {
    const { execSync } = await import("child_process");
    const result = execSync(
      `node ${CRANIUM_DIR}/scripts/process-video.cjs "${videoPath}" "${outputDir}"`,
      { encoding: "utf8", timeout: 600000 } // 10 min max
    );
    // Parse manifest from last line of output
    const lines = result.trim().split("\n");
    const manifestLine = lines.findIndex(l => l.startsWith("{"));
    if (manifestLine >= 0) {
      return JSON.parse(lines.slice(manifestLine).join("\n"));
    }
    // Fallback: read manifest file
    const { readFileSync } = await import("fs");
    return JSON.parse(readFileSync(`${outputDir}/manifest.json`, "utf8"));
  } catch (e) {
    console.error("Video processing failed:", e.message);
    return null;
  }
}

// ── Thread Parent Context ───────────────────────────────────────────────────
async function fetchThreadParent(channel, threadTs) {
  try {
    const result = await app.client.conversations.replies({
      token: process.env.SLACK_BOT_TOKEN,
      channel,
      ts: threadTs,
      limit: 1,
    });
    const parent = result.messages && result.messages[0];
    return parent ? (parent.text || "").trim() : null;
  } catch (e) {
    console.error("fetchThreadParent error:", e.message);
    return null;
  }
}

// ── Slack Status Updater ────────────────────────────────────────────────────
function createStatusUpdater(channel, messageTs, emoji) {
  let pending = null;
  let updating = false;

  return async function updateStatus(statusText) {
    pending = statusText;
    if (updating) return;

    updating = true;
    while (pending !== null) {
      const text = pending;
      pending = null;
      try {
        await app.client.chat.update({
          token: process.env.SLACK_BOT_TOKEN,
          channel,
          ts: messageTs,
          text: `${emoji} ${text}`,
        });
      } catch (e) {
        console.error("Status update error:", e.message);
      }
    }
    updating = false;
  };
}

// ── Message Handler ─────────────────────────────────────────────────────────
async function handleMessage({ message, say }) {
  if (message.subtype === "bot_message" || message.bot_id) return;
  const text = message.text || "";
  const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim();

  // Download attached files (images, PDFs + text)
  const imagePaths = [];  // images + PDFs — passed as file paths for Claude to read
  const textAttachments = []; // { name, content }
  if (message.files && message.files.length > 0) {
    for (const file of message.files) {
      const ext = (file.filetype || "").toLowerCase();
      if (file.mimetype && file.mimetype.startsWith("image/")) {
        const filePath = await downloadSlackFile(file);
        if (filePath) imagePaths.push(filePath);
      } else if (ext === "pdf" || (file.mimetype && file.mimetype === "application/pdf")) {
        const filePath = await downloadSlackFile(file);
        if (filePath) imagePaths.push(filePath);
      } else if (VIDEO_EXTENSIONS.has(ext) || (file.mimetype && file.mimetype.startsWith("video/"))) {
        if (file.size && file.size > MAX_VIDEO_BYTES) {
          console.log(`Skipping oversized video: ${file.name} (${(file.size / 1024 / 1024).toFixed(0)}MB)`);
          textAttachments.push({ name: file.name || "video", content: `[Video too large: ${file.name} — ${(file.size / 1024 / 1024).toFixed(0)}MB exceeds ${MAX_VIDEO_BYTES / 1024 / 1024}MB limit]` });
        } else {
          console.log(`Processing video: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
          const vidPath = await downloadSlackFile(file);
          if (vidPath) {
            const manifest = await processVideoFile(vidPath);
            if (manifest) {
              // Add frames as images for Claude to see
              for (const fp of manifest.framePaths || []) {
                imagePaths.push(fp);
              }
              // Add transcript as text attachment
              if (manifest.transcriptPath) {
                try {
                  const transcript = readFileSync(manifest.transcriptPath, "utf8");
                  textAttachments.push({
                    name: `${file.name || "video"} — audio transcript`,
                    content: transcript
                  });
                } catch {}
              }
              textAttachments.push({
                name: `${file.name || "video"} — video info`,
                content: `Video: ${file.name}, Duration: ${manifest.duration}s, Frames extracted: ${manifest.frameCount} (1 every ${manifest.frameInterval}s), Has audio transcript: ${manifest.hasTranscript}`
              });
            }
            try { unlinkSync(vidPath); } catch {} // Clean up original video
          }
        }
      } else if (TEXT_EXTENSIONS.has(ext) || (file.mimetype && file.mimetype.startsWith("text/"))) {
        if (file.size && file.size > MAX_TEXT_FILE_BYTES) {
          console.log(`Skipping large text file: ${file.name} (${file.size} bytes)`);
          textAttachments.push({ name: file.name || "file", content: `[File too large: ${file.name} — ${(file.size / 1024).toFixed(0)}KB exceeds ${MAX_TEXT_FILE_BYTES / 1024}KB limit]` });
        } else {
          const filePath = await downloadSlackFile(file);
          if (filePath) {
            try {
              const content = readFileSync(filePath, "utf8");
              textAttachments.push({ name: file.name || `file.${ext}`, content });
              unlinkSync(filePath); // Clean up immediately — we have the content
            } catch (e) {
              console.error("Text file read error:", e.message);
            }
          }
        }
      }
    }
  }

  if (!cleanText && imagePaths.length === 0 && textAttachments.length === 0) return;

  // ── Cancel/Abort Detection ──────────────────────────────────────────────
  const threadKey = getThreadKey(message);
  const running = runningProcesses.get(threadKey);

  if (running && isCancelMessage(cleanText)) {
    console.log(`Abort requested for thread ${threadKey} — killing process`);
    running.aborted = true;
    try { running.proc.kill("SIGTERM"); } catch (e) {
      console.error("Failed to kill process:", e.message);
    }

    // Update the status message to show cancellation
    try {
      await app.client.chat.update({
        token: process.env.SLACK_BOT_TOKEN,
        channel: running.channel,
        ts: running.ackTs,
        text: `⏹️ Cancelled`,
      });
    } catch {}

    // Acknowledge
    await say({
      text: "Stopped. What's up?",
      thread_ts: message.thread_ts || message.ts,
    });
    return;
  }

  // If there's a running process and the new message is NOT a cancel,
  // kill the old process anyway (new instruction supersedes)
  if (running) {
    console.log(`New message in thread ${threadKey} while process running — killing old process`);
    running.aborted = true;
    try { running.proc.kill("SIGTERM"); } catch {}
    try {
      await app.client.chat.update({
        token: process.env.SLACK_BOT_TOKEN,
        channel: running.channel,
        ts: running.ackTs,
        text: `⏹️ Superseded`,
      });
    } catch {}
  }

  // ── Voice Call Approval Detection ──────────────────────────────────────
  // Check if this thread has a pending voice execution awaiting approval
  if (message.thread_ts) {
    const pending = findPendingExecution(message.channel, message.thread_ts);
    if (pending) {
      const DECLINE_PATTERN = /^\s*(no|nope|cancel|scratch that|nevermind|never mind|don'?t|hold off|skip|nah)\s*[.!]?\s*$/i;
      if (DECLINE_PATTERN.test(cleanText)) {
        // Decline — remove the pending execution
        try { unlinkSync(pending.filePath); } catch {}
        await say({ text: "Got it — action items scrapped.", thread_ts: message.thread_ts });
        return;
      }
      if (APPROVAL_PATTERN.test(cleanText)) {
        // Clean approval — execute as-is
        executeApprovedVoicePlan(pending, message);
        return;
      }
      // Any other reply — fall through to normal message handling
      // The pending execution stays until explicitly approved or declined
    }
  }

  // Build base prompt
  let prompt = cleanText;
  if (imagePaths.length > 0) {
    const imageNote = imagePaths.map(p => `[Image attached: ${p}]`).join("\n");
    prompt = cleanText ? `${imageNote}\n\n${cleanText}` : imageNote;
  }
  if (textAttachments.length > 0) {
    const fileBlocks = textAttachments.map(f => `[Attached file: ${f.name}]\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n");
    prompt = prompt ? `${prompt}\n\n${fileBlocks}` : fileBlocks;
  }

  const threadTs = message.thread_ts || message.ts;

  // If thread reply with no session, fetch parent for context
  if (message.thread_ts && !sessions.get(threadKey)) {
    const parentText = await fetchThreadParent(message.channel, message.thread_ts);
    if (parentText && parentText !== cleanText) {
      prompt = `[Thread context - original message]: "${parentText}"\n\n${prompt}`;
    }
  }

  // ── Voice Call Detection ────────────────────────────────────────────────
  // Narrow match: must be a short, intentional command — not "let's talk about X" or "call me crazy"
  const CALL_ME_EXACT = /^\s*(call me|start a call|voice call|let'?s talk|hop on a call|voice mode|voice chat)\s*[.!?]?\s*$/i;
  const CALL_ME_SHORT = /\b(call me|voice call|voice mode|hop on a call)\b/i;
  const isVoiceRequest = CALL_ME_EXACT.test(cleanText) || (cleanText.length < 40 && CALL_ME_SHORT.test(cleanText));
  if (isVoiceRequest) {
    const session = sessions.get(threadKey);
    const params = new URLSearchParams();
    if (session && session.sessionId) params.set("session", session.sessionId);
    params.set("channel", message.channel);
    params.set("thread", threadTs);
    const voiceBase = process.env.VOICE_URL || `http://localhost:${process.env.VOICE_PORT || 3100}`;
    const voiceUrl = `${voiceBase}/?${params.toString()}`;

    await say({
      text: `🎙️ Voice session ready. Open this link:\n${voiceUrl}\n\nI'll have full context from this thread. When we wrap up, the summary and action items will post back here.`,
      thread_ts: threadTs,
    });
    return;
  }

  try {
    const model = DEFAULT_MODEL;

    // ── Voice Call Context Injection ──────────────────────────────────────
    const activeCall = getActiveVoiceCall();
    if (activeCall) {
      const callThread = activeCall.slackThread ? ` in thread ${activeCall.slackThread}` : "";
      const callChannel = activeCall.slackChannel ? ` (channel: ${activeCall.slackChannel})` : "";
      prompt = `[VOICE CALL ACTIVE] The user is currently on a live voice call with you${callThread}${callChannel}, started at ${activeCall.startedAt}. They may be talking to you on voice while also messaging in Slack. Keep this in mind — they're hands-free and may reference things said on the call. If this Slack message relates to the voice conversation, maintain continuity.\n\n${prompt}`;
    } else {
      // Check if a voice call recently ended — inject context for continuity
      const recentCall = getAndConsumeRecentCall();
      if (recentCall) {
        // Merge voice session into this thread so --resume carries forward
        if (recentCall.sessionId && recentCall.slackThread) {
          const callThreadKey = recentCall.slackThread;
          const existing = sessions.get(callThreadKey);
          if (existing) {
            existing.sessionId = recentCall.sessionId;
            sessions.set(callThreadKey, existing);
          } else {
            sessions.set(callThreadKey, {
              sessionId: recentCall.sessionId,
              channel: recentCall.slackChannel,
              threadTs: recentCall.slackThread,
              lastActivity: Date.now(),
              turns: 0,
            });
          }
          persistSessions();
        }

        const transcriptBlock = recentCall.transcript
          ? `\n\nFull voice call transcript:\n${recentCall.transcript}`
          : "";
        prompt = `[RECENT VOICE CALL] You just finished a voice call with the user (ended ${recentCall.endedAt}). A summary was posted to Slack. Continue naturally — if the user references the call, you have full context. Don't re-summarize the call unprompted.${transcriptBlock}\n\n${prompt}`;
      }
    }

    // Inject Slack thread coordinates so Claude can write the restart-origin marker
    prompt += `\n\n<slack-thread channel="${message.channel}" thread_ts="${threadTs}" />`;

    // Inject turn count and new-thread nudge hint for long or shifting conversations
    const nudgeSession = sessions.get(threadKey);
    const turnCount = nudgeSession ? (nudgeSession.turns || 0) : 0;
    if (turnCount >= 15) {
      prompt += `\n\n<thread-context turns="${turnCount}" threshold="${TURN_THRESHOLD}" />`;
      prompt += `\nThis thread is at ${turnCount} turns. If the topic has shifted from the original thread topic, or if context is getting heavy, end your response with a brief nudge: "---\\n💡 We've shifted topics — want to start a fresh thread for this?" Only suggest it when the shift is real, not on every message. Never nudge if this is a continuation of the same task.`;
    }

    // Always append the skills index so Claude knows what else is available
    prompt += SKILLS_INDEX;

    const emoji = MODEL_EMOJI[model] || "⚪";

    // Eagerly persist channel/threadTs
    const earlySession = sessions.get(threadKey);
    if (earlySession && (!earlySession.channel || !earlySession.threadTs)) {
      earlySession.channel = message.channel;
      earlySession.threadTs = threadTs;
      sessions.set(threadKey, earlySession);
      persistSessions();
    } else if (!earlySession) {
      sessions.set(threadKey, { channel: message.channel, threadTs, lastActivity: Date.now(), turns: 0 });
      persistSessions();
    }

    // Post indicator message immediately
    const ackResult = await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: message.channel,
      thread_ts: threadTs,
      text: `${emoji} Working on it...`,
    });
    const ackTs = ackResult.ts;

    const updateStatus = createStatusUpdater(message.channel, ackTs, emoji);

    // ── Context Management: Check if thread needs summary-and-reset ────
    const currentSession = sessions.get(threadKey);
    let contextSummary = null;
    let didReset = false;

    if (currentSession && currentSession.turns >= TURN_THRESHOLD && currentSession.sessionId) {
      console.log(`Thread ${threadKey} hit ${currentSession.turns} turns — triggering summary-and-reset`);
      updateStatus("Summarizing long thread...");

      contextSummary = await summarizeThread(message.channel, threadTs);
      if (contextSummary) {
        // Prepend summary to prompt so the fresh session has context
        prompt = `[THREAD CONTEXT — This is a continuation of a long conversation. Here's what happened so far:]\n\n${contextSummary}\n\n[END THREAD CONTEXT — The conversation continues below. Respond to the user's latest message.]\n\n${prompt}`;
        // Clear the sessionId so we start fresh (no --resume)
        currentSession.sessionId = null;
        currentSession.turns = 0;
        sessions.set(threadKey, currentSession);
        persistSessions();
        didReset = true;
        console.log(`Thread ${threadKey} reset — summary injected (${contextSummary.length} chars)`);
      } else {
        console.log(`Thread ${threadKey} — summarization failed, continuing with existing session`);
      }
    }

    // Build Claude args
    const claudeArgs = [
      "-p", prompt,
      "--model", model,
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    if (existsSync(MCP_CONFIG)) {
      claudeArgs.push("--mcp-config", MCP_CONFIG);
    }

    const sessionForResume = sessions.get(threadKey);
    if (sessionForResume && sessionForResume.sessionId) {
      claudeArgs.push("--resume", sessionForResume.sessionId);
    }

    const { promise: claudePromise, proc: claudeProc } = runClaudeStreaming(claudeArgs, {
      onStatus: (statusText) => updateStatus(statusText),
    });

    // Track running process for abort support
    runningProcesses.set(threadKey, {
      proc: claudeProc,
      ackTs,
      channel: message.channel,
      aborted: false,
    });

    let response;
    try {
      response = await claudePromise;
    } finally {
      runningProcesses.delete(threadKey);
    }

    // If aborted, don't post results — the cancel handler already responded
    if (response.aborted) {
      console.log(`Thread ${threadKey}: process was aborted, skipping response`);
      // Still save sessionId so --resume works
      const existing = sessions.get(threadKey);
      if (response.sessionId && existing) {
        existing.sessionId = response.sessionId;
        sessions.set(threadKey, existing);
        persistSessions();
      }
      return;
    }

    // Update indicator to "done"
    const resetTag = didReset ? " 🔄 context reset" : "";
    try {
      await app.client.chat.update({
        token: process.env.SLACK_BOT_TOKEN,
        channel: message.channel,
        ts: ackTs,
        text: `${emoji} Done [${model}${resetTag}]`,
      });
    } catch {}

    // Update session tracking
    const existing = sessions.get(threadKey);
    sessions.set(threadKey, {
      sessionId: response.sessionId || (existing && existing.sessionId),
      model,
      lastActivity: Date.now(),
      turns: (existing ? existing.turns : 0) + 1,
      channel: message.channel,
      threadTs,
      bootNotified: false,
    });
    persistSessions();

    // Post final response — split into multiple messages if needed
    const responseChunks = splitMessage(response.text, 3900);
    for (const chunk of responseChunks) {
      await say({
        text: chunk,
        thread_ts: threadTs,
      });
    }

    // Clean up temp image files
    for (const p of imagePaths) {
      try { unlinkSync(p); } catch {}
    }

    appendDailyNote(`- [${model}] "${cleanText.substring(0, 80)}${cleanText.length > 80 ? "..." : ""}" -> ${response.text.length} chars`);

  } catch (error) {
    console.error("Handler error:", error);
    const errorType = error.isRateLimit ? "rate_limit" : error.message.substring(0, 80);
    appendDailyNote(`- [ERROR] "${cleanText.substring(0, 80)}${cleanText.length > 80 ? "..." : ""}" -> ${errorType}`);
    if (error.isRateLimit) {
      await say({
        text: `⛔ Hit the Max usage limit. I'm offline until the window resets (typically 5 hours). If this keeps happening, we need a higher plan.`,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `Something went wrong: ${error.message}`,
        thread_ts: threadTs,
      });
    }
  }
}

// ── Voice Call Approval Detection ────────────────────────────────────────────
const APPROVAL_PATTERN = /^\s*(go ahead|do it|go for it|approved|execute|yes go|let'?s go|make it happen|proceed|yep|yes|lgtm|ship it)\s*[.!]?\s*$/i;

function findPendingExecution(channel, threadTs) {
  if (!existsSync(PENDING_DIR)) return null;
  let files;
  try {
    files = readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
  } catch { return null; }

  for (const file of files) {
    const filePath = `${PENDING_DIR}/${file}`;
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      if (data.channel === channel && data.threadTs === threadTs && data.status === 'awaiting_approval') {
        return { filePath, data };
      }
    } catch { continue; }
  }
  return null;
}

async function executeApprovedVoicePlan(pending, message) {
  const { data, filePath } = pending;
  const { plan, actionItems, transcript, channel, threadTs } = data;

  // Remove pending file immediately
  try { unlinkSync(filePath); } catch {}

  console.log(`Voice call approved — executing for thread ${threadTs}`);

  // Include the user's approval message if it had modifications
  const approvalText = (message.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  const hasModifications = !APPROVAL_PATTERN.test(approvalText) && approvalText.length > 20;

  // Build structured action items block if available
  let actionBlock = '';
  if (actionItems && actionItems.length > 0) {
    const claudeItems = actionItems.filter(a => a.owner === 'Claude' || a.owner === 'claude');
    if (claudeItems.length > 0) {
      actionBlock = '\n\nStructured action items (execute these in order):\n';
      for (let i = 0; i < claudeItems.length; i++) {
        actionBlock += `${i + 1}. ${claudeItems[i].action}${claudeItems[i].context ? ` (context: ${claudeItems[i].context})` : ''}\n`;
      }
    }
  }

  const prompt = `[AUTONOMOUS EXECUTION] You just finished a voice call with the user. They reviewed the summary and action items in Slack and approved execution.

Here's the summary and action items from the call:

${plan}
${actionBlock}${hasModifications ? `\nThe user's approval message (may contain modifications):\n"${approvalText}"\n` : ''}
Full transcript for context:
${transcript}

Execute each action item in order. Be thorough. If you hit a blocker, report it and move to the next item. When done, give a brief summary of what you accomplished.`;

  const threadKey = `${channel}:${threadTs}`;
  const model = DEFAULT_MODEL;

  try {
    const ackResult = await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel,
      thread_ts: threadTs,
      text: `🔴 Executing voice call action items... [${model}]`,
    });
    const ackTs = ackResult.ts;
    const updateStatus = createStatusUpdater(channel, ackTs, "🔴");

    const claudeArgs = [
      "-p", prompt,
      "--model", model,
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    if (existsSync(MCP_CONFIG)) {
      claudeArgs.push("--mcp-config", MCP_CONFIG);
    }

    const existingSession = sessions.get(threadKey);
    if (existingSession && existingSession.sessionId) {
      claudeArgs.push("--resume", existingSession.sessionId);
    }

    const { promise: claudePromise, proc: claudeProc } = runClaudeStreaming(claudeArgs, {
      onStatus: (statusText) => updateStatus(statusText),
    });

    runningProcesses.set(threadKey, { proc: claudeProc, ackTs, channel, aborted: false });

    let response;
    try {
      response = await claudePromise;
    } finally {
      runningProcesses.delete(threadKey);
    }

    if (response.aborted) {
      console.log(`Voice exec for ${threadTs} was aborted`);
      if (response.sessionId) {
        const s = sessions.get(threadKey) || { channel, threadTs };
        s.sessionId = response.sessionId;
        sessions.set(threadKey, s);
        persistSessions();
      }
      return;
    }

    // Update indicator
    try {
      await app.client.chat.update({
        token: process.env.SLACK_BOT_TOKEN, channel, ts: ackTs,
        text: `🔴 Done [${model}]`,
      });
    } catch {}

    // Save session
    const existing = sessions.get(threadKey) || { channel, threadTs };
    sessions.set(threadKey, {
      ...existing,
      sessionId: response.sessionId || existing.sessionId,
      model,
      lastActivity: Date.now(),
    });
    persistSessions();

    // Post result — split into multiple messages if needed
    const responseChunks = splitMessage(response.text, 3900);
    for (const chunk of responseChunks) {
      await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel,
        thread_ts: threadTs,
        text: chunk,
      });
    }

    appendDailyNote(`- [voice-exec] "${plan.substring(0, 80)}..." -> ${response.text.length} chars`);

  } catch (error) {
    console.error(`Voice exec error:`, error.message);
    appendDailyNote(`- [ERROR voice-exec] "${plan.substring(0, 80)}..." -> ${error.message.substring(0, 80)}`);
    try {
      await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel,
        thread_ts: threadTs,
        text: `Something went wrong executing voice call actions: ${error.message}`,
      });
    } catch {}
  }
}

// Clean up stale pending executions (older than 24h)
function cleanStalePendingExecutions() {
  if (!existsSync(PENDING_DIR)) return;
  try {
    const files = readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const file of files) {
      const filePath = `${PENDING_DIR}/${file}`;
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        if (data.createdAt && new Date(data.createdAt).getTime() < cutoff) {
          unlinkSync(filePath);
          console.log(`Cleaned stale pending execution: ${file}`);
        }
      } catch { try { unlinkSync(filePath); } catch {} }
    }
  } catch {}
}

app.event("message", handleMessage);

(async () => {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
  if (!existsSync(PENDING_DIR)) {
    mkdirSync(PENDING_DIR, { recursive: true });
  }
  loadSessions();
  await app.start();
  cleanStalePendingExecutions();
  console.log("Cranium v3.30 is running");
  appendDailyNote(`\n## Listener v3.30 started at ${new Date().toISOString()}`);

  // Post-restart notification — only to the thread that triggered the restart
  const restartOrigin = getRestartOrigin();
  if (restartOrigin && restartOrigin.channel && restartOrigin.threadTs) {
    try {
      await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel: restartOrigin.channel,
        thread_ts: restartOrigin.threadTs,
        text: `⚡ Restarted. Ready to go.`,
      });
      console.log(`Sent restart notification to originating thread`);
    } catch (e) {
      console.error("Boot notification error:", e.message);
    }
  } else {
    console.log("No restart origin marker found — skipping boot notifications");
  }

  // Voice call executions are now approval-gated — no auto-processing needed
})();
