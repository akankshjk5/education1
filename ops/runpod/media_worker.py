#!/usr/bin/env python3
"""Single-concurrency queue -> ComfyUI -> validation -> storage worker.

This intentionally uses only the Python standard library so the RunPod image
does not need a second dependency environment for the worker itself.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import mimetypes
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


STOP = threading.Event()
STATE: dict[str, Any] = {"status": "starting", "job_id": None, "last_error": None}
PROFILE_PARAMETERS: dict[str, dict[str, int | float]] = {
    "image-fast": {"width": 1024, "height": 576, "steps": 8},
    "video-fast": {
        "width": 832, "height": 480, "durationSeconds": 3, "fps": 16, "steps": 20,
    },
    "video-quality": {
        "width": 1280, "height": 720, "durationSeconds": 5, "fps": 16, "steps": 30,
    },
}


class WorkerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class JsonClient:
    def __init__(self, base_url: str, headers: dict[str, str] | None = None):
        self.base_url = base_url.rstrip("/")
        self.headers = headers or {}

    def request(
        self,
        method: str,
        path: str,
        payload: Any | None = None,
        *,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 30,
        expect_json: bool = True,
    ) -> Any:
        body = data
        request_headers = {**self.headers, **(headers or {})}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.base_url}{path}", data=body, method=method, headers=request_headers
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:1000]
            raise WorkerError("http_error", f"{method} {path}: HTTP {error.code}: {detail}") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise WorkerError("network_error", f"{method} {path}: {error}") from error
        if not expect_json:
            return result
        return json.loads(result or b"null")


class QueueClient:
    def __init__(self, supabase_url: str, service_key: str):
        self.client = JsonClient(
            supabase_url,
            {"apikey": service_key, "Authorization": f"Bearer {service_key}"},
        )
        self.supabase_url = supabase_url.rstrip("/")

    def rpc(self, name: str, payload: dict[str, Any]) -> Any:
        return self.client.request("POST", f"/rest/v1/rpc/{name}", payload)

    def claim(self, worker_id: str) -> dict[str, Any] | None:
        result = self.rpc("claim_deck_media_job", {"p_worker_id": worker_id})
        return result[0] if isinstance(result, list) and result else None

    def heartbeat(self, job_id: str, worker_id: str, progress: int) -> None:
        self.rpc(
            "heartbeat_deck_media_job",
            {"p_job_id": job_id, "p_worker_id": worker_id, "p_progress": progress},
        )

    def cancelled(self, job_id: str) -> bool:
        query = urllib.parse.urlencode(
            {"id": f"eq.{job_id}", "select": "cancel_requested_at", "limit": "1"}
        )
        rows = self.client.request("GET", f"/rest/v1/deck_media_jobs?{query}")
        return bool(rows and rows[0].get("cancel_requested_at"))

    def complete(
        self, job_id: str, worker_id: str, output_url: str, metadata: dict[str, Any]
    ) -> None:
        ok = self.rpc(
            "complete_deck_media_job",
            {
                "p_job_id": job_id,
                "p_worker_id": worker_id,
                "p_output_url": output_url,
                "p_output_metadata": metadata,
            },
        )
        if not ok:
            raise WorkerError("stale_job", "Job ownership changed before completion")

    def fail(self, job_id: str, worker_id: str, code: str, message: str) -> None:
        self.rpc(
            "fail_deck_media_job",
            {
                "p_job_id": job_id,
                "p_worker_id": worker_id,
                "p_error_code": code,
                "p_error_message": message[:2000],
                "p_retry_delay_seconds": 30,
            },
        )

    def upload(self, bucket: str, parent_id: str, job_id: str, path: Path) -> str:
        object_name = f"{parent_id}/media/{job_id}{path.suffix.lower()}"
        encoded_name = urllib.parse.quote(object_name, safe="/")
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.client.request(
            "POST",
            f"/storage/v1/object/{bucket}/{encoded_name}",
            data=path.read_bytes(),
            headers={"Content-Type": content_type, "x-upsert": "false"},
            timeout=300,
        )
        return f"{self.supabase_url}/storage/v1/object/public/{bucket}/{encoded_name}"


class ComfyClient:
    def __init__(self, base_url: str):
        self.client = JsonClient(base_url)

    def submit(self, workflow: dict[str, Any]) -> str:
        response = self.client.request(
            "POST", "/prompt", {"prompt": workflow, "client_id": str(uuid.uuid4())}
        )
        prompt_id = response.get("prompt_id") if isinstance(response, dict) else None
        if not prompt_id:
            raise WorkerError("comfy_submit_failed", f"Unexpected ComfyUI response: {response}")
        return str(prompt_id)

    def interrupt(self) -> None:
        try:
            self.client.request("POST", "/interrupt", {})
        except WorkerError:
            pass

    def wait(self, prompt_id: str, timeout_seconds: int, on_tick: Any) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            if STOP.is_set():
                self.interrupt()
                raise WorkerError("worker_stopping", "Worker is stopping")
            on_tick()
            history = self.client.request("GET", f"/history/{urllib.parse.quote(prompt_id)}")
            if isinstance(history, dict) and prompt_id in history:
                item = history[prompt_id]
                status = item.get("status", {})
                if status.get("status_str") == "error":
                    raise WorkerError("comfy_execution_failed", json.dumps(status)[:1500])
                if item.get("outputs"):
                    return item
            time.sleep(2)
        self.interrupt()
        raise WorkerError("generation_timeout", f"ComfyUI exceeded {timeout_seconds}s")

    def download_output(self, history_item: dict[str, Any], destination: Path) -> Path:
        candidates: list[dict[str, Any]] = []
        for output in history_item.get("outputs", {}).values():
            if not isinstance(output, dict):
                continue
            for key in ("videos", "gifs", "images"):
                value = output.get(key)
                if isinstance(value, list):
                    candidates.extend(item for item in value if isinstance(item, dict))
        if not candidates:
            raise WorkerError("missing_output", "ComfyUI history contained no media file")
        selected = candidates[-1]
        filename = str(selected.get("filename", ""))
        if not filename:
            raise WorkerError("missing_output", "ComfyUI output did not include a filename")
        query = urllib.parse.urlencode(
            {
                "filename": filename,
                "subfolder": str(selected.get("subfolder", "")),
                "type": str(selected.get("type", "output")),
            }
        )
        data = self.client.request("GET", f"/view?{query}", timeout=300, expect_json=False)
        output_path = destination.with_suffix(Path(filename).suffix.lower() or ".bin")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(data)
        return output_path


def replace_tokens(value: Any, tokens: dict[str, Any]) -> Any:
    if isinstance(value, dict):
        return {key: replace_tokens(item, tokens) for key, item in value.items()}
    if isinstance(value, list):
        return [replace_tokens(item, tokens) for item in value]
    if isinstance(value, str):
        if value in tokens:
            return tokens[value]
        result = value
        for token, replacement in tokens.items():
            result = result.replace(token, str(replacement))
        return result
    return value


def allowed_source_hosts() -> set[str]:
    hosts = {
        host.strip().lower()
        for host in os.environ.get("MEDIA_SOURCE_HOSTS", "").split(",")
        if host.strip()
    }
    supabase_host = urllib.parse.urlparse(os.environ["SUPABASE_URL"]).hostname
    if supabase_host:
        hosts.add(supabase_host.lower())
    return hosts


def wan_frame_count(duration_seconds: float, fps: int) -> int:
    """Return a Wan-compatible (4n+1) frame count meeting the duration."""
    return ((round(duration_seconds * fps) + 3) // 4) * 4 + 1


def resolve_job_parameters(job: dict[str, Any]) -> dict[str, int | float]:
    """Apply fixed serving limits; only the inexpensive seed may be overridden."""
    profile = str(job.get("profile", ""))
    defaults = PROFILE_PARAMETERS.get(profile)
    if defaults is None:
        raise WorkerError("unsupported_profile", f"Unsupported media profile: {profile}")
    result = dict(defaults)
    if profile == "video-fast":
        configured_steps = int(os.environ.get("WAN_FAST_STEPS", str(result["steps"])))
        if configured_steps not in (20, 30):
            raise WorkerError("invalid_worker_config", "WAN_FAST_STEPS must be 20 or 30")
        result["steps"] = configured_steps
    requested = job.get("parameters") or {}
    if "seed" in requested:
        result["seed"] = int(requested["seed"])
    return result


def download_source_image(job: dict[str, Any], comfy_input: Path) -> str:
    source = str(job.get("source_image_url") or "")
    parsed = urllib.parse.urlparse(source)
    if parsed.scheme != "https" or not parsed.hostname:
        raise WorkerError("invalid_source", "Source image must use HTTPS")
    if parsed.hostname.lower() not in allowed_source_hosts():
        raise WorkerError("invalid_source_host", "Source image host is not allowlisted")
    request = urllib.request.Request(source, headers={"User-Agent": "LuminaMediaWorker/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            content_type = response.headers.get_content_type()
            if not content_type.startswith("image/"):
                raise WorkerError("invalid_source_type", f"Expected image, got {content_type}")
            data = response.read(25 * 1024 * 1024 + 1)
    except urllib.error.URLError as error:
        raise WorkerError("source_download_failed", str(error)) from error
    if len(data) > 25 * 1024 * 1024:
        raise WorkerError("source_too_large", "Source image exceeds 25 MB")
    suffix = mimetypes.guess_extension(content_type) or ".png"
    name = f"media-job-{job['id']}{suffix}"
    comfy_input.mkdir(parents=True, exist_ok=True)
    (comfy_input / name).write_bytes(data)
    return name


def load_workflow(job: dict[str, Any], workflow_dir: Path, comfy_input: Path) -> dict[str, Any]:
    path = workflow_dir / f"{job['profile']}.json"
    if not path.is_file():
        raise WorkerError("workflow_missing", f"Missing API workflow: {path}")
    try:
        workflow = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise WorkerError("workflow_invalid", f"Cannot read {path}: {error}") from error
    source_name = download_source_image(job, comfy_input) if job["kind"] == "video" else ""
    parameters = resolve_job_parameters(job)
    fps = int(parameters.get("fps", 16))
    duration_seconds = float(parameters.get("durationSeconds", 3))
    # Wan video latent lengths must be 1 modulo 4. Round up to the next valid
    # length so the delivered clip is never shorter than requested.
    frames = wan_frame_count(duration_seconds, fps)
    tokens = {
        "__PROMPT__": job["prompt"],
        "__NEGATIVE_PROMPT__": job.get("negative_prompt", ""),
        "__SOURCE_IMAGE__": source_name,
        "__SEED__": int(parameters.get("seed", 42)),
        "__WIDTH__": int(parameters.get("width", 1024 if job["kind"] == "image" else 832)),
        "__HEIGHT__": int(parameters.get("height", 576 if job["kind"] == "image" else 480)),
        "__FPS__": fps,
        "__FRAMES__": frames,
        "__STEPS__": int(parameters.get("steps", 30)),
        "__DURATION_SECONDS__": duration_seconds,
    }
    return replace_tokens(workflow, tokens)


def validate_output(path: Path, kind: str) -> dict[str, Any]:
    size = path.stat().st_size
    if size < 1024:
        raise WorkerError("invalid_output", "Generated output is unexpectedly small")
    metadata: dict[str, Any] = {"bytes": size, "extension": path.suffix.lower()}
    if kind == "image":
        with path.open("rb") as handle:
            magic = handle.read(12)
        valid = (
            magic.startswith(b"\x89PNG\r\n\x1a\n")
            or magic.startswith(b"\xff\xd8\xff")
            or magic[:4] in (b"RIFF", b"GIF8")
        )
        if not valid:
            raise WorkerError("invalid_image", "Output has an unsupported image signature")
        return metadata
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "stream=width,height,codec_name:format=duration",
                "-of", "json", str(path),
            ],
            check=True, capture_output=True, text=True, timeout=30,
        )
        probe = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise WorkerError("invalid_video", f"ffprobe failed: {error}") from error
    streams = probe.get("streams") or []
    duration = float((probe.get("format") or {}).get("duration") or 0)
    if not streams or duration <= 0:
        raise WorkerError("invalid_video", "Video has no playable stream or duration")
    metadata.update({"duration": duration, **streams[0]})
    return metadata


def normalize_video(path: Path) -> Path:
    normalized = path.with_name(f"{path.stem}.normalized.mp4")
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error", "-i", str(path),
                "-map", "0:v:0", "-map", "0:a?",
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                "-c:a", "aac", "-b:a", "128k", str(normalized),
            ],
            check=True, capture_output=True, text=True, timeout=300,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise WorkerError("video_normalization_failed", f"ffmpeg failed: {error}") from error
    return normalized


def history_output_paths(history_item: dict[str, Any], output_root: Path) -> list[Path]:
    """Resolve ComfyUI output files without allowing paths outside output_root."""
    root = output_root.resolve()
    paths: list[Path] = []
    for output in history_item.get("outputs", {}).values():
        if not isinstance(output, dict):
            continue
        for key in ("videos", "gifs", "images"):
            value = output.get(key)
            if not isinstance(value, list):
                continue
            for item in value:
                if not isinstance(item, dict) or item.get("type", "output") != "output":
                    continue
                filename = str(item.get("filename", ""))
                if not filename:
                    continue
                candidate = (root / str(item.get("subfolder", "")) / filename).resolve()
                try:
                    candidate.relative_to(root)
                except ValueError:
                    continue
                paths.append(candidate)
    return paths


def cleanup_job_files(
    job_id: str,
    comfy_input: Path,
    output_dir: Path,
    comfy_output_paths: list[Path] | None = None,
) -> None:
    """Best-effort cleanup of files created for one completed or failed attempt."""
    candidates = list(comfy_input.glob(f"media-job-{job_id}.*"))
    candidates.extend(output_dir.glob(f"{job_id}*"))
    candidates.extend(comfy_output_paths or [])
    for path in candidates:
        if path.is_file() or path.is_symlink():
            with contextlib.suppress(OSError):
                path.unlink()


def health_server(port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/health":
                self.send_response(404)
                self.end_headers()
                return
            payload = json.dumps(STATE).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def process_job(
    job: dict[str, Any], queue: QueueClient, comfy: ComfyClient, worker_id: str,
    workflow_dir: Path, comfy_input: Path, comfy_output: Path, output_dir: Path,
) -> None:
    job_id = str(job["id"])
    STATE.update(status="processing", job_id=job_id, last_error=None)
    history: dict[str, Any] | None = None
    job_started = time.monotonic()
    try:
        workflow = load_workflow(job, workflow_dir, comfy_input)
        queue.heartbeat(job_id, worker_id, 5)
        prompt_id = comfy.submit(workflow)
        generation_started = time.monotonic()
        last_heartbeat = 0.0

        def tick() -> None:
            nonlocal last_heartbeat
            if queue.cancelled(job_id):
                comfy.interrupt()
                raise WorkerError("cancelled", "Cancellation requested")
            now = time.monotonic()
            if now - last_heartbeat >= 10:
                queue.heartbeat(job_id, worker_id, 25)
                last_heartbeat = now

        history = comfy.wait(
            prompt_id,
            int(os.environ.get("MEDIA_JOB_TIMEOUT_SECONDS", "1800")),
            tick,
        )
        generation_seconds = time.monotonic() - generation_started
        queue.heartbeat(job_id, worker_id, 85)
        postprocess_started = time.monotonic()
        path = comfy.download_output(history, output_dir / job_id)
        if job["kind"] == "video":
            path = normalize_video(path)
        metadata = validate_output(path, str(job["kind"]))
        postprocess_seconds = time.monotonic() - postprocess_started
        queue.heartbeat(job_id, worker_id, 95)
        upload_started = time.monotonic()
        if job.get("deck_id"):
            bucket, parent_id = "deck-assets", str(job["deck_id"])
        elif job.get("video_project_id"):
            bucket, parent_id = "video-assets", str(job["video_project_id"])
        else:
            raise WorkerError("invalid_job", "Media job has no deck or video project parent")
        output_url = queue.upload(bucket, parent_id, job_id, path)
        upload_seconds = time.monotonic() - upload_started
        metadata["latency_seconds"] = {
            "generation": round(generation_seconds, 3),
            "postprocess": round(postprocess_seconds, 3),
            "upload": round(upload_seconds, 3),
            "total": round(time.monotonic() - job_started, 3),
        }
        metadata["serving_parameters"] = resolve_job_parameters(job)
        queue.complete(job_id, worker_id, output_url, metadata)
    finally:
        comfy_paths = history_output_paths(history, comfy_output) if history else []
        cleanup_job_files(job_id, comfy_input, output_dir, comfy_paths)


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Required environment variable is missing: {name}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="Claim at most one job, then exit")
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    parser.add_argument("--health-port", type=int, default=8090)
    args = parser.parse_args()

    supabase_url = require_env("SUPABASE_URL")
    service_key = require_env("SUPABASE_SERVICE_ROLE_KEY")
    comfy_url = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
    workspace = Path(os.environ.get("WORKSPACE", "/workspace"))
    workflow_dir = Path(
        os.environ.get("MEDIA_WORKFLOW_DIR", workspace / "lumina-deck-pro/ops/runpod/workflows/api")
    )
    comfy_input = Path(os.environ.get("COMFYUI_INPUT_DIR", workspace / "ComfyUI/input"))
    comfy_output = Path(os.environ.get("COMFYUI_OUTPUT_DIR", workspace / "ComfyUI/output"))
    output_dir = Path(os.environ.get("MEDIA_OUTPUT_DIR", workspace / "lumina-media-output"))
    worker_id = os.environ.get("MEDIA_WORKER_ID", f"runpod-{uuid.uuid4().hex[:12]}")

    queue = QueueClient(supabase_url, service_key)
    comfy = ComfyClient(comfy_url)
    server = health_server(args.health_port)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_args: STOP.set())

    STATE["status"] = "idle"
    try:
        while not STOP.is_set():
            job = queue.claim(worker_id)
            if not job:
                if args.once:
                    return 0
                STOP.wait(args.poll_seconds)
                continue
            try:
                process_job(
                    job, queue, comfy, worker_id, workflow_dir, comfy_input, comfy_output, output_dir
                )
                STATE.update(status="idle", job_id=None, last_error=None)
            except WorkerError as error:
                STATE.update(status="error", last_error=error.code)
                queue.fail(str(job["id"]), worker_id, error.code, str(error))
                print(f"job {job['id']} failed [{error.code}]: {error}", file=sys.stderr, flush=True)
                STATE.update(status="idle", job_id=None)
            except Exception as error:  # final containment boundary for a long-running worker
                STATE.update(status="error", last_error="worker_exception")
                queue.fail(str(job["id"]), worker_id, "worker_exception", str(error))
                print(f"job {job['id']} failed [worker_exception]: {error}", file=sys.stderr, flush=True)
                STATE.update(status="idle", job_id=None)
            if args.once:
                return 0
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
