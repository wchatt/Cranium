#!/usr/bin/env python3
"""TTS wrapper: edge-tts (best quality) with Piper as offline fallback.
Usage: tts.py <text> <output.mp3>
"""
import sys
import subprocess
import os
import socket
import json
import wave
import io

PIPER_MODEL = os.path.join(os.path.dirname(__file__), 'models', 'piper', 'en_US-lessac-high.onnx')
FFMPEG = os.path.expanduser('~/.local/bin/ffmpeg')
DAEMON_SOCKET = '/tmp/piper-tts.sock'


def tts_via_daemon(text, output_path):
    """Fast path: send to running daemon (model already loaded)."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(30)
        s.connect(DAEMON_SOCKET)
        s.sendall(json.dumps({'text': text, 'output': output_path}).encode() + b'\n')
        resp = b''
        while True:
            chunk = s.recv(4096)
            if not chunk:
                break
            resp += chunk
            if b'\n' in resp:
                break
    result = json.loads(resp.strip())
    if not result.get('ok'):
        raise RuntimeError(result.get('error', 'daemon error'))


def tts_piper_direct(text, output_path):
    """Slow path: load model inline (no daemon running)."""
    from piper.voice import PiperVoice
    voice = PiperVoice.load(PIPER_MODEL)

    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(22050)
        voice.synthesize_wav(text, wav_file)

    buf.seek(0)
    wav_bytes = buf.read()

    result = subprocess.run(
        [FFMPEG, '-y', '-f', 'wav', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-q:a', '4', output_path],
        input=wav_bytes,
        capture_output=True
    )
    if result.returncode != 0:
        raise RuntimeError(f'ffmpeg failed: {result.stderr.decode()[:200]}')


async def tts_edge(text, output_path):
    """Final fallback: edge-tts (requires internet)."""
    import edge_tts
    communicate = edge_tts.Communicate(text, 'en-US-GuyNeural', rate='+35%')
    await communicate.save(output_path)


def main():
    if len(sys.argv) > 2:
        text = sys.argv[1]
        output = sys.argv[2]
    elif len(sys.argv) > 1:
        text = sys.argv[1]
        output = '/dev/stdout'
    else:
        text = sys.stdin.read()
        output = '/dev/stdout'

    if not text.strip():
        sys.exit(0)

    # Primary: edge-tts (best voice quality)
    try:
        import asyncio
        asyncio.run(tts_edge(text, output))
        return
    except Exception as e:
        print(f'[tts] edge-tts failed ({e}), falling back to Piper', file=sys.stderr)

    # Fallback: Piper daemon (local, no network needed)
    if os.path.exists(DAEMON_SOCKET) and os.path.exists(PIPER_MODEL):
        try:
            tts_via_daemon(text, output)
            return
        except Exception as e:
            print(f'[tts] Daemon failed ({e}), trying direct', file=sys.stderr)

    # Last resort: Piper direct (slow — loads model each time)
    if os.path.exists(PIPER_MODEL):
        try:
            tts_piper_direct(text, output)
            return
        except Exception as e:
            print(f'[tts] Piper direct also failed ({e})', file=sys.stderr)
            sys.exit(1)


if __name__ == '__main__':
    main()
