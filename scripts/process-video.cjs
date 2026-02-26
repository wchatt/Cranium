#!/usr/bin/env node
/**
 * process-video.cjs — Extracts frames + transcribes audio from a video file.
 *
 * Usage: node scripts/process-video.cjs <video_path> <output_dir>
 *
 * Output structure in output_dir/:
 *   frames/frame_0001.jpg, frame_0002.jpg, ...
 *   transcript.txt  (full transcription with timestamps)
 *   manifest.json   (metadata: frame count, duration, transcript path)
 *
 * Frame extraction: 1 frame every 3 seconds, max 1280px wide.
 * Transcription: faster-whisper (tiny model, CPU) — good enough for narration.
 */

const { execSync, spawnSync } = require("child_process");
const { existsSync, mkdirSync, readdirSync, writeFileSync } = require("fs");
const path = require("path");

// Discover ffmpeg/ffprobe on PATH, with fallback to common locations
function findBinary(name) {
  try {
    return execSync(`which ${name}`, { encoding: "utf8" }).trim();
  } catch {
    const fallbacks = [
      `/usr/bin/${name}`,
      `/usr/local/bin/${name}`,
      `${process.env.HOME}/.local/bin/${name}`,
    ];
    for (const p of fallbacks) {
      if (existsSync(p)) return p;
    }
    console.error(`${name} not found on PATH or in common locations. Install it first.`);
    process.exit(1);
  }
}

const FFMPEG = findBinary("ffmpeg");
const FFPROBE = findBinary("ffprobe");
const FRAME_INTERVAL = 3; // seconds between frames
const MAX_FRAMES = 80; // Claude has image limits — cap at 80 frames (~4 min of video at 3s intervals)

const videoPath = process.argv[2];
const outputDir = process.argv[3];

if (!videoPath || !outputDir) {
  console.error("Usage: node process-video.cjs <video_path> <output_dir>");
  process.exit(1);
}

if (!existsSync(videoPath)) {
  console.error(`Video not found: ${videoPath}`);
  process.exit(1);
}

// Create output dirs
const framesDir = path.join(outputDir, "frames");
mkdirSync(framesDir, { recursive: true });

// Get video duration
let duration = 0;
try {
  const raw = execSync(
    `"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
    { encoding: "utf8" }
  ).trim();
  duration = parseFloat(raw) || 0;
} catch (e) {
  console.error("Could not determine video duration:", e.message);
}

console.log(`Video duration: ${duration.toFixed(1)}s`);

// Calculate optimal frame interval — if video is long, space frames out more
const estimatedFrames = Math.ceil(duration / FRAME_INTERVAL);
const interval = estimatedFrames > MAX_FRAMES
  ? Math.ceil(duration / MAX_FRAMES)
  : FRAME_INTERVAL;

console.log(`Extracting frames every ${interval}s...`);

// Extract frames
try {
  execSync(
    `"${FFMPEG}" -i "${videoPath}" -vf "fps=1/${interval},scale='min(1280,iw)':-1" -q:v 3 "${framesDir}/frame_%04d.jpg" -y`,
    { stdio: "pipe" }
  );
} catch (e) {
  console.error("Frame extraction failed:", e.message);
}

const frames = readdirSync(framesDir).filter(f => f.endsWith(".jpg")).sort();
console.log(`Extracted ${frames.length} frames`);

// Extract audio and transcribe
console.log("Transcribing audio...");
const audioPath = path.join(outputDir, "audio.wav");
let transcript = "";

try {
  // Extract audio as WAV (16kHz mono — optimal for Whisper)
  execSync(
    `"${FFMPEG}" -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioPath}" -y`,
    { stdio: "pipe" }
  );

  // Transcribe with faster-whisper
  const pythonScript = `
import sys, json
from faster_whisper import WhisperModel

model = WhisperModel("tiny", device="cpu", compute_type="int8")
segments, info = model.transcribe("${audioPath.replace(/"/g, '\\"')}", language="en")

result = []
for seg in segments:
    result.append({
        "start": round(seg.start, 1),
        "end": round(seg.end, 1),
        "text": seg.text.strip()
    })

print(json.dumps(result))
`;

  const pyResult = spawnSync("python3", ["-c", pythonScript], {
    encoding: "utf8",
    timeout: 300000, // 5 min max for transcription
  });

  if (pyResult.status === 0 && pyResult.stdout.trim()) {
    const segments = JSON.parse(pyResult.stdout.trim());
    transcript = segments
      .map(s => `[${formatTime(s.start)} - ${formatTime(s.end)}] ${s.text}`)
      .join("\n");

    writeFileSync(path.join(outputDir, "transcript.txt"), transcript);
    console.log(`Transcribed ${segments.length} segments`);
  } else {
    console.error("Transcription returned no output");
    if (pyResult.stderr) console.error(pyResult.stderr.slice(0, 500));
  }
} catch (e) {
  console.error("Audio transcription failed:", e.message);
}

// Clean up audio file
try {
  require("fs").unlinkSync(audioPath);
} catch {}

// Write manifest
const manifest = {
  videoPath,
  duration: Math.round(duration),
  frameCount: frames.length,
  frameInterval: interval,
  framePaths: frames.map(f => path.join(framesDir, f)),
  transcriptPath: existsSync(path.join(outputDir, "transcript.txt"))
    ? path.join(outputDir, "transcript.txt")
    : null,
  hasTranscript: transcript.length > 0,
  processedAt: new Date().toISOString(),
};

writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log(JSON.stringify(manifest, null, 2));

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
