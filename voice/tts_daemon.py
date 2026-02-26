#!/usr/bin/env python3
"""
Piper TTS daemon — keeps model loaded, serves requests via Unix socket.
Protocol: JSON lines on the socket
  Request:  {"text": "...", "output": "/tmp/out.mp3"}\n
  Response: {"ok": true}\n  or  {"ok": false, "error": "..."}\n
"""
import sys
import os
import json
import socket
import wave
import io
import subprocess
import threading

PIPER_MODEL = os.path.join(os.path.dirname(__file__), 'models', 'piper', 'en_US-lessac-high.onnx')
FFMPEG = os.path.expanduser('~/.local/bin/ffmpeg')
SOCKET_PATH = '/tmp/piper-tts.sock'


def synthesize(voice, text, output_path):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(22050)
        voice.synthesize_wav(text, w)
    buf.seek(0)
    wav_bytes = buf.read()

    result = subprocess.run(
        [FFMPEG, '-y', '-f', 'wav', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-q:a', '4', output_path],
        input=wav_bytes, capture_output=True
    )
    if result.returncode != 0:
        raise RuntimeError(f'ffmpeg: {result.stderr.decode()[:200]}')


def handle_client(conn, voice):
    try:
        buf = b''
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                if not line.strip():
                    continue
                try:
                    req = json.loads(line)
                    text = req.get('text', '').strip()
                    output = req.get('output', '')
                    if not text or not output:
                        conn.sendall(json.dumps({'ok': False, 'error': 'missing text or output'}).encode() + b'\n')
                        continue
                    synthesize(voice, text, output)
                    conn.sendall(json.dumps({'ok': True}).encode() + b'\n')
                except Exception as e:
                    conn.sendall(json.dumps({'ok': False, 'error': str(e)}).encode() + b'\n')
    finally:
        conn.close()


def main():
    from piper.voice import PiperVoice
    print('[tts-daemon] Loading model...', file=sys.stderr, flush=True)
    voice = PiperVoice.load(PIPER_MODEL)
    print(f'[tts-daemon] Model loaded, listening on {SOCKET_PATH}', file=sys.stderr, flush=True)

    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)
    server.listen(5)
    os.chmod(SOCKET_PATH, 0o600)

    while True:
        conn, _ = server.accept()
        t = threading.Thread(target=handle_client, args=(conn, voice), daemon=True)
        t.start()


if __name__ == '__main__':
    main()
