#!/usr/bin/env python3
"""Loopback-only AI4Bharat Indic Parler-TTS service."""

from __future__ import annotations

import io
import json
import os
import re
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import numpy as np
import torch
from parler_tts import ParlerTTSForConditionalGeneration
from transformers import AutoTokenizer


MODEL_PATH = os.environ.get("LOCAL_TTS_MODEL_PATH", "/workspace/lumina-local-ai/indic-parler-tts")
DESCRIPTION_TOKENIZER_PATH = os.environ.get(
    "LOCAL_TTS_DESCRIPTION_TOKENIZER_PATH",
    "/workspace/lumina-local-ai/flan-t5-large-tokenizer",
)
PORT = int(os.environ.get("LOCAL_TTS_PORT", "18081"))
MAX_REQUEST_BYTES = 100_000
LANGUAGES = {
    "en-IN": "Indian English",
    "hi-IN": "Hindi",
    "bn-IN": "Bengali",
    "gu-IN": "Gujarati",
    "kn-IN": "Kannada",
    "ml-IN": "Malayalam",
    "mr-IN": "Marathi",
    "ta-IN": "Tamil",
    "te-IN": "Telugu",
}
MODEL_LOCK = threading.Lock()


print(f"[local-tts] loading {MODEL_PATH}", flush=True)
MODEL = ParlerTTSForConditionalGeneration.from_pretrained(
    MODEL_PATH,
    local_files_only=True,
)
MODEL.eval()
PROMPT_TOKENIZER = AutoTokenizer.from_pretrained(MODEL_PATH, local_files_only=True)
DESCRIPTION_TOKENIZER = AutoTokenizer.from_pretrained(
    DESCRIPTION_TOKENIZER_PATH,
    local_files_only=True,
)
SAMPLE_RATE = int(MODEL.config.sampling_rate)
print(f"[local-tts] ready on CPU at {SAMPLE_RATE} Hz; GPU is acquired only for a request", flush=True)


def chunks(text: str, limit: int = 340) -> list[str]:
    pieces = [part.strip() for part in re.split(r"(?<=[.!?।])\s+", text.strip()) if part.strip()]
    output: list[str] = []
    current = ""
    for piece in pieces or [text.strip()]:
        if current and len(current) + 1 + len(piece) > limit:
            output.append(current)
            current = piece
        else:
            current = f"{current} {piece}".strip()
    if current:
        output.append(current)
    return output


def synthesize(payload: dict[str, Any]) -> tuple[bytes, str]:
    transcript = str(payload.get("transcript", "")).strip()
    language_code = str(payload.get("languageCode", ""))
    pace = str(payload.get("pace", "natural"))
    language = LANGUAGES.get(language_code)
    if not language or not transcript or len(transcript) > 8_000:
        raise ValueError("valid transcript and supported languageCode are required")

    description = (
        f"A native {language} female educator speaks in a warm, confident narration style, "
        f"with {'a brisk but clear' if pace == 'brisk' else 'a steady natural'} pace and balanced pitch. "
        "The recording is studio quality, very clear and close, with no background noise or reverberation."
    )
    silence = np.zeros(int(SAMPLE_RATE * 0.16), dtype=np.float32)
    segments: list[np.ndarray] = []

    with MODEL_LOCK:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        try:
            MODEL.to(device)
            description_inputs = DESCRIPTION_TOKENIZER(description, return_tensors="pt").to(device)
            with torch.inference_mode():
                for text_chunk in chunks(transcript):
                    prompt_inputs = PROMPT_TOKENIZER(text_chunk, return_tensors="pt").to(device)
                    generated = MODEL.generate(
                        input_ids=description_inputs.input_ids,
                        attention_mask=description_inputs.attention_mask,
                        prompt_input_ids=prompt_inputs.input_ids,
                        prompt_attention_mask=prompt_inputs.attention_mask,
                    )
                    audio = generated.detach().float().cpu().numpy().squeeze()
                    segments.extend([audio.astype(np.float32), silence])
        finally:
            if device == "cuda":
                MODEL.to("cpu")
                torch.cuda.empty_cache()

    waveform = np.concatenate(segments[:-1]) if len(segments) > 1 else segments[0]
    peak = float(np.max(np.abs(waveform))) if waveform.size else 0.0
    if peak <= 0:
        raise RuntimeError("model returned silent audio")
    pcm = np.clip(waveform / max(1.0, peak), -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm16)
    return output.getvalue(), f"local-{language.lower().replace(' ', '-')}-educator"


class Handler(BaseHTTPRequestHandler):
    server_version = "LuminaLocalTTS/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[local-tts] {self.address_string()} {fmt % args}", flush=True)

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_json(404, {"error": "not found"})
            return
        self.send_json(200, {"status": "ready", "model": "ai4bharat/indic-parler-tts", "local": True})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/synthesize":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("request body is empty or too large")
            audio, voice = synthesize(json.loads(self.rfile.read(length)))
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("X-Lumina-Model", "ai4bharat/indic-parler-tts")
            self.send_header("X-Lumina-Voice", voice)
            self.end_headers()
            self.wfile.write(audio)
        except Exception as exc:
            print(f"[local-tts] request failed: {type(exc).__name__}: {exc}", flush=True)
            self.send_json(500, {"error": f"Local narration failed: {type(exc).__name__}"})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
