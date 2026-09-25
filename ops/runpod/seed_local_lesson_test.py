#!/usr/bin/env python3
"""Seed one fully local narrated-lesson test into the production queue.

Run on the GPU worker after sourcing /root/lumina-media-worker.env. It uses the
loopback planner, translator and TTS services, then inserts the audited project
into Supabase for the normal media worker to render and assemble.
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
import uuid
import wave
from io import BytesIO
from typing import Any


SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
PLANNER_URL = os.environ.get("LOCAL_VIDEO_AGENT_URL", "http://127.0.0.1:18080")
TRANSLATION_URL = os.environ.get("LOCAL_VIDEO_TRANSLATION_URL", "http://127.0.0.1:18082")
TTS_URL = os.environ.get("LOCAL_VIDEO_TTS_URL", "http://127.0.0.1:18081")


def request(
    method: str,
    url: str,
    payload: Any | None = None,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 300,
    expect_json: bool = True,
) -> Any:
    body = data
    request_headers = dict(headers or {})
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        result = response.read()
    return json.loads(result or b"null") if expect_json else result


def local_post(port_url: str, path: str, payload: dict[str, Any], *, raw: bool = False) -> Any:
    return request("POST", f"{port_url.rstrip('/')}{path}", payload, expect_json=not raw)


def supabase(method: str, path: str, payload: Any | None = None, *, prefer: str = "") -> Any:
    headers = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
    if prefer:
        headers["Prefer"] = prefer
    return request(method, f"{SUPABASE_URL}{path}", payload, headers=headers)


def owner_id() -> str:
    for table in ("lesson_video_projects", "video_projects", "decks"):
        query = urllib.parse.urlencode(
            {"select": "owner_id", "order": "created_at.desc", "limit": "1"}
        )
        rows = supabase("GET", f"/rest/v1/{table}?{query}")
        if rows and rows[0].get("owner_id"):
            return str(rows[0]["owner_id"])
    raise RuntimeError("No existing project owner was found for the end-to-end test")


def plan_lesson() -> dict[str, Any]:
    scene = {
        "type": "object",
        "additionalProperties": False,
        "required": ["index", "fact", "narration", "visualDescription", "motionDescription"],
        "properties": {
            "index": {"type": "integer", "minimum": 1, "maximum": 8},
            "fact": {"type": "string", "minLength": 10, "maxLength": 400},
            "narration": {"type": "string", "minLength": 5, "maxLength": 500},
            "visualDescription": {"type": "string", "minLength": 20, "maxLength": 500},
            "motionDescription": {"type": "string", "minLength": 15, "maxLength": 800},
        },
    }
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["title", "learningObjective", "visualBible", "scenes"],
        "properties": {
            "title": {"type": "string", "minLength": 3, "maxLength": 200},
            "learningObjective": {"type": "string", "minLength": 10, "maxLength": 500},
            "visualBible": {"type": "string", "minLength": 40, "maxLength": 500},
            "scenes": {"type": "array", "minItems": 8, "maxItems": 8, "items": scene},
        },
    }
    payload = {
        "stage": "video-lesson-planner-e2e",
        "maxNewTokens": 2200,
        "jsonSchema": schema,
        "systemPrompt": (
            "You are a careful Class 8 Indian-school curriculum editor. Create exactly eight "
            "connected scenes for a 60-second algebra lesson. Use only stable textbook facts and "
            "silently audit every claim. Source facts and narration must be plain English; each "
            "narration is one natural sentence of 10-14 words. Teach variables, expressions, like "
            "terms, substitution, and a one-step equation in logical order. Visuals must be "
            "text-free concrete metaphors or mechanisms, never classrooms, teachers, students, "
            "blackboards, code, equations, letters, numbers, captions, labels, logos or UI. Do not "
            "ask an image model to count exact repeated objects. Use a consistent premium 16:9 "
            "educational-documentary style. Motion must preserve every object and only describe a "
            "subtle camera move."
        ),
        "userPrompt": (
            "Plan a Class 8 Mathematics lesson about algebra for Kannada narration. The English "
            "source must be factually precise and the full story must fit 60 seconds."
        ),
    }
    result = local_post(PLANNER_URL, "/structured", payload)
    plan = result["output"]
    scenes = plan.get("scenes") or []
    if len(scenes) != 8 or any(scene.get("index") != index for index, scene in enumerate(scenes, 1)):
        raise RuntimeError("Planner returned an invalid scene sequence")
    for scene in scenes:
        words = len(str(scene["narration"]).split())
        if not 8 <= words <= 16:
            raise RuntimeError(f"Scene {scene['index']} narration has {words} words")
    return plan


def translate_plan(plan: dict[str, Any]) -> dict[str, Any]:
    texts = [plan["title"], *[scene["narration"] for scene in plan["scenes"]]]
    translated = local_post(
        TRANSLATION_URL, "/translate", {"texts": texts, "languageCode": "kn-IN"}
    )["translations"]
    if len(translated) != 9:
        raise RuntimeError("Translation response did not preserve the scene count")
    plan = json.loads(json.dumps(plan))
    plan["title"] = translated[0]
    for index, scene in enumerate(plan["scenes"]):
        scene["narration"] = translated[index + 1]
    return plan


def synthesize(plan: dict[str, Any]) -> tuple[bytes, float]:
    transcript = " ".join(scene["narration"].strip() for scene in plan["scenes"])
    audio = local_post(
        TTS_URL,
        "/synthesize",
        {"transcript": transcript, "languageCode": "kn-IN", "pace": "brisk"},
        raw=True,
    )
    with wave.open(BytesIO(audio), "rb") as wav:
        duration = wav.getnframes() / wav.getframerate()
    if not 20 <= duration <= 90:
        raise RuntimeError(f"Unexpected narration duration: {duration:.2f} seconds")
    return audio, duration


def seed(plan: dict[str, Any], audio: bytes, audio_duration: float) -> str:
    project_id = str(uuid.uuid4())
    owner = owner_id()
    narration = " ".join(scene["narration"].strip() for scene in plan["scenes"])
    project = {
        "id": project_id,
        "owner_id": owner,
        "class_level": 8,
        "subject": "Mathematics",
        "topic": "Algebra",
        "language_code": "kn-IN",
        "language_name": "Kannada",
        "target_duration_seconds": 60,
        "title": plan["title"],
        "learning_objective": plan["learningObjective"],
        "narration_text": narration,
        "narration_duration_seconds": round(audio_duration, 3),
        "status": "generating_images",
    }
    supabase("POST", "/rest/v1/lesson_video_projects", project, prefer="return=minimal")

    storage_path = f"{project_id}/narration.wav"
    encoded_path = urllib.parse.quote(storage_path, safe="/")
    request(
        "POST",
        f"{SUPABASE_URL}/storage/v1/object/lesson-video-assets/{encoded_path}",
        data=audio,
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
            "Content-Type": "audio/wav",
            "x-upsert": "false",
        },
        expect_json=False,
    )
    narration_url = f"{SUPABASE_URL}/storage/v1/object/public/lesson-video-assets/{encoded_path}"
    query = urllib.parse.urlencode({"id": f"eq.{project_id}"})
    supabase(
        "PATCH",
        f"/rest/v1/lesson_video_projects?{query}",
        {"narration_url": narration_url},
        prefer="return=minimal",
    )

    scene_rows: list[dict[str, Any]] = []
    job_rows: list[dict[str, Any]] = []
    for scene in plan["scenes"]:
        scene_id = str(uuid.uuid4())
        visual = (
            f"Storyboard visual bible: {plan['visualBible']}. Scene composition: "
            f"{scene['visualDescription']}. Text-free conceptual educational illustration; "
            "show only the topic objects and spatial relationships. No exact object counting."
        )
        image_prompt = (
            f"Educational visual for Class 8 Mathematics about algebra. Exact concept: "
            f"{scene['fact']}. {visual} One coherent widescreen 16:9 composition, accurate "
            "physical details, clean subject separation. Absolutely no classroom, people, "
            "blackboard, code, equations, letters, numbers, captions, labels, logo, watermark, "
            "UI, or visible text."
        )
        video_prompt = (
            "Preserve this exact educational image without changing any object. Apply only a "
            f"gentle stable camera move. Intended motion: {scene['motionDescription']}"
        )
        scene_rows.append(
            {
                "id": scene_id,
                "project_id": project_id,
                "scene_index": scene["index"],
                "duration_seconds": 7.5,
                "fact": scene["fact"],
                "narration": scene["narration"],
                "image_prompt": image_prompt,
                "video_prompt": video_prompt,
            }
        )
        job_rows.append(
            {
                "owner_id": owner,
                "project_id": project_id,
                "scene_id": scene_id,
                "kind": "image",
                "profile": "image-fast",
                "prompt": image_prompt,
                "negative_prompt": (
                    "text, writing, letters, numbers, equations, captions, labels, classroom, "
                    "teacher, blackboard, projector, watermark, logo, duplicate subjects, low quality"
                ),
                "parameters": {
                    "width": 1024,
                    "height": 576,
                    "steps": 8,
                    "sceneIndex": scene["index"],
                },
            }
        )
    supabase("POST", "/rest/v1/lesson_video_scenes", scene_rows, prefer="return=minimal")
    supabase("POST", "/rest/v1/lesson_video_jobs", job_rows, prefer="return=minimal")
    return project_id


def main() -> int:
    if not SUPABASE_URL or not SERVICE_KEY:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
    started = time.monotonic()
    plan = plan_lesson()
    planned = time.monotonic()
    plan = translate_plan(plan)
    translated = time.monotonic()
    audio, duration = synthesize(plan)
    voiced = time.monotonic()
    project_id = seed(plan, audio, duration)
    print(
        json.dumps(
            {
                "projectId": project_id,
                "title": plan["title"],
                "narrationDurationSeconds": round(duration, 3),
                "sceneCount": 8,
                "timings": {
                    "planning": round(planned - started, 2),
                    "translation": round(translated - planned, 2),
                    "voice": round(voiced - translated, 2),
                    "totalBeforeQueue": round(time.monotonic() - started, 2),
                },
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
