# RunPod RTX 6000 Ada media stack

This package builds a reproducible ComfyUI image/video service on one RTX 6000 Ada (48 GB). It uses native ComfyUI nodes and commercially usable Apache-2.0 model releases.

## Verified production baseline

- Images: Z-Image Turbo BF16, 1024x576, 8 steps.
- Video: Wan 2.2 TI2V-5B FP16, image-to-video, 832x480, 49 frames, 16 FPS. The accepted fallback is 30 steps; the official-template 20-step fast target awaits the next GPU A/B.
- Optional quality candidate: Wan 2.2 I2V-A14B FP8 plus the matching LightX2V four-step LoRAs. This is not enabled until its separate benchmark passes.

Measured on 2026-09-21 on the target RTX 6000 Ada:

- Z-Image warm median: about 4.03 seconds.
- Wan 5B warm 832x480/49-frame generation at 30 steps: 48.15 seconds, 23,114 MiB peak VRAM.
- Wan 5B warm 1280x704/81-frame generation: 198.24 seconds, 29,258 MiB peak VRAM. The final frame showed visible subject deformation, so this is not the default.
- First requests took 7-9 minutes when loading directly from the object-backed Global volume. Production startup must hydrate local NVMe before readiness.

These are benchmark observations, not a client SLA. See `results-2026-09-21.csv`.

## Pod layout

- GPU: one RTX 6000 Ada, concurrency one.
- Container disk: 50 GB minimum for ComfyUI, its environment, download staging, and the 37 GiB baseline local serving cache.
- Global volume: `lumina-models`, mounted at RunPod's default `/workspace`; it is the portable source of truth for model weights and benchmark evidence.
- Disposable runtime: `/root/lumina-runtime`.
- Repository: `/root/lumina-deck-pro`.
- ComfyUI port: 8188 through the authenticated RunPod proxy. Do not expose it through a public raw TCP port.

The Global volume is object-backed. Do not place Git checkouts, Python environments, mutable caches, or temporary downloads on it. The scripts stage each download on local POSIX storage, validate it, copy it sequentially to `/workspace`, and then validate the persistent copy.

## First installation

Run from the repository root on the Pod:

```bash
export RUNPOD_WORKSPACE_ROOT=/root/lumina-runtime
export RUNPOD_MODEL_STORE_ROOT=/workspace

bash -n ops/runpod/*.sh
bash ops/runpod/bootstrap.sh
bash ops/runpod/download_models.sh baseline
bash ops/runpod/fetch_workflows.sh
bash ops/runpod/preflight.sh baseline
```

The native reference workflows are saved under `/root/lumina-runtime/ComfyUI/user/default/workflows/lumina/`.

The GPU-verified API workflows used by the worker are:

```text
ops/runpod/workflows/api/image-fast.json
ops/runpod/workflows/api/video-fast.json
```

## Production startup and readiness

Start ComfyUI with baseline hydration enabled:

```bash
export RUNPOD_WORKSPACE_ROOT=/root/lumina-runtime
export RUNPOD_MODEL_STORE_ROOT=/workspace
export RUNPOD_HYDRATE_PROFILE=baseline
bash ops/runpod/start_comfyui.sh
```

`start_comfyui.sh` does not bind port 8188 until `hydrate_models.sh` has copied and validated the selected model files on local NVMe. This prevents a client request from paying the 7-9 minute Global-volume cold-load cost. Hydration is resumable; later starts reuse valid local copies while the container exists.

Check readiness from a second terminal:

```bash
curl --fail --silent http://127.0.0.1:8188/system_stats
nvidia-smi
```

Stopping the Pod erases the local runtime/cache. Recreating a Pod repeats bootstrap and hydration, but the model store persists globally and does not need to be downloaded from Hugging Face again.

On a replacement compatible Pod with the same Global volume attached at `/workspace`, copy this repository to `/root/lumina-deck-pro` and run the one-command provisioner:

```bash
cd /root/lumina-deck-pro
bash ops/runpod/provision_baseline.sh
```

It safely reruns bootstrap, reuses and validates persistent weights, hydrates local NVMe, and starts ComfyUI. Performance is measured only for the RTX 6000 Ada; treat another GPU as a fresh benchmark target.

## Benchmark commands

Use `BENCHMARK.md` for the acceptance cases. `benchmark_api.py` submits a tokenized API workflow, waits for completion, downloads the output, validates it, and prints measured metadata. Run `monitor_gpu.sh` in another terminal to record one-second telemetry.

Benchmark artifacts belong in `/workspace/lumina-benchmarks` so they survive Pod replacement. Normalize accepted video to H.264/yuv420p MP4 before client delivery.

## Application worker

After applying the media migrations through `supabase/migrations/20260921203000_video_project_recovery.sql` to the selected project, provide secrets only as Pod environment variables:

```bash
export SUPABASE_URL='https://YOUR_PROJECT.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='YOUR_SERVER_ONLY_SERVICE_ROLE_KEY'
export WORKSPACE=/root/lumina-runtime
export MEDIA_WORKFLOW_DIR=/root/lumina-deck-pro/ops/runpod/workflows/api
export COMFYUI_INPUT_DIR=/root/lumina-runtime/ComfyUI/input
export COMFYUI_OUTPUT_DIR=/root/lumina-runtime/ComfyUI/output
export MEDIA_OUTPUT_DIR=/root/lumina-runtime/media-output
export WAN_FAST_STEPS=30
bash ops/runpod/start_media_worker.sh
```

The worker checks the narrated-lesson queue first, then claims one `deck_media_jobs` row at a time. It heartbeats, honors cancellation, validates outputs, and normalizes video to H.264 MP4. Deck-owned jobs upload to `deck-assets/<deck-id>/media/`; legacy standalone Video projects upload to `video-assets/<project-id>/media/`; narrated lessons upload to `lesson-video-assets/<project-id>/media/`.

For a narrated lesson, Postgres queues all topic-specific Z-Image scenes, then queues one five-second Wan animation per completed still. Once every animation and the server-generated narration are ready, it queues a `lesson-assemble` job. That job stretches each stable five-second clip to its 7.5-second timeline slot, concatenates the scenes, pads/trims the narration to the requested 60 or 90 seconds, and writes one H.264/AAC MP4. The durable chain continues if the browser closes or the Pod restarts. The worker health endpoint is `http://127.0.0.1:8090/health`.

The image/video inference remains local on the Pod. Lesson planning and Indian-language speech are intentionally performed by the web server before GPU queuing, so the expensive GPU is not held while waiting on text/audio APIs. Never put those provider keys on the Pod or in browser-prefixed variables.

The current fast target uses the official native-template value of 20 sampling
steps. Keep the server-only `WAN_FAST_STEPS=30` for the first live test because
that graph has already passed on the target GPU. Only switch to 20 after it
passes the fixed-seed GPU comparison in `BENCHMARK.md`; do not quote a client
SLA before that comparison.

## Quality candidate

Only after the baseline is deployed reliably:

```bash
bash ops/runpod/download_models.sh quality
bash ops/runpod/preflight.sh quality
```

Benchmark the official native A14B workflow before applying LightX2V. Do not use the same LoRA for both experts. A 50 GB container cannot hydrate baseline and quality weights simultaneously; use a larger container disk or hydrate only the serving profile.

## Cost and security controls

- Keep concurrency at one until production telemetry proves otherwise.
- Paid API nodes are disabled.
- Never put provider, database, or storage secrets in workflow JSON or this repository.
- Preserve outputs in Supabase/R2 before terminating a Pod.
- Stop the GPU Pod when testing is complete; persistent volumes may continue to incur storage charges.
- Delete unused legacy/network volumes after confirming they are unattached.
