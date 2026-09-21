import tempfile
import unittest
from pathlib import Path

from media_worker import (
    QueueClient,
    WorkerError,
    cleanup_job_files,
    history_output_paths,
    replace_tokens,
    resolve_job_parameters,
    validate_output,
    wan_frame_count,
)


class WorkerContractTests(unittest.TestCase):
    def test_upload_uses_deck_scoped_pro_bucket(self) -> None:
        calls = []

        class Client:
            def request(self, method, path, **kwargs):
                calls.append((method, path, kwargs))

        queue = QueueClient("https://example.supabase.co", "test-key")
        queue.client = Client()
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "result.mp4"
            path.write_bytes(b"video")
            url = queue.upload(
                "deck-assets",
                "11111111-1111-1111-1111-111111111111",
                "22222222-2222-2222-2222-222222222222",
                path,
            )

        expected = (
            "/storage/v1/object/deck-assets/"
            "11111111-1111-1111-1111-111111111111/media/"
            "22222222-2222-2222-2222-222222222222.mp4"
        )
        self.assertEqual(calls[0][0:2], ("POST", expected))
        self.assertIn("/storage/v1/object/public/deck-assets/", url)

    def test_upload_supports_standalone_video_bucket(self) -> None:
        calls = []

        class Client:
            def request(self, method, path, **kwargs):
                calls.append((method, path, kwargs))

        queue = QueueClient("https://example.supabase.co", "test-key")
        queue.client = Client()
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "result.png"
            path.write_bytes(b"image")
            url = queue.upload(
                "video-assets",
                "33333333-3333-3333-3333-333333333333",
                "44444444-4444-4444-4444-444444444444",
                path,
            )

        self.assertIn("/storage/v1/object/video-assets/", calls[0][1])
        self.assertIn("/storage/v1/object/public/video-assets/", url)

    def test_recursive_token_replacement_preserves_numeric_types(self) -> None:
        workflow = {"1": {"inputs": {"text": "__PROMPT__", "seed": "__SEED__"}}}
        result = replace_tokens(workflow, {"__PROMPT__": "hello", "__SEED__": 42})
        self.assertEqual(result["1"]["inputs"], {"text": "hello", "seed": 42})

    def test_png_signature_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "output.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 2048)
            self.assertEqual(validate_output(path, "image")["extension"], ".png")

    def test_tiny_output_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / "bad.png"
            path.write_bytes(b"bad")
            with self.assertRaises(WorkerError):
                validate_output(path, "image")

    def test_wan_frame_count_is_compatible_and_not_short(self) -> None:
        self.assertEqual(wan_frame_count(3, 16), 49)
        self.assertEqual(wan_frame_count(5, 16), 81)
        self.assertEqual(wan_frame_count(5, 24), 121)

    def test_fast_profile_rejects_expensive_overrides(self) -> None:
        parameters = resolve_job_parameters({
            "profile": "video-fast",
            "parameters": {
                "width": 1920,
                "height": 1088,
                "durationSeconds": 10,
                "fps": 30,
                "seed": 123,
            },
        })
        self.assertEqual(parameters, {
            "width": 832,
            "height": 480,
            "durationSeconds": 3,
            "fps": 16,
            "steps": 20,
            "seed": 123,
        })

    def test_cleanup_removes_only_the_current_jobs_files(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory)
            comfy_input = root / "input"
            output_dir = root / "worker-output"
            comfy_output = root / "comfy-output"
            for path in (comfy_input, output_dir, comfy_output / "lumina"):
                path.mkdir(parents=True)
            job_id = "11111111-1111-1111-1111-111111111111"
            source = comfy_input / f"media-job-{job_id}.png"
            worker_copy = output_dir / f"{job_id}.normalized.mp4"
            comfy_copy = comfy_output / "lumina" / "video-fast_00001_.webm"
            unrelated = output_dir / "another-job.mp4"
            for path in (source, worker_copy, comfy_copy, unrelated):
                path.write_bytes(b"test")

            history = {
                "outputs": {
                    "11": {
                        "videos": [{
                            "filename": comfy_copy.name,
                            "subfolder": "lumina",
                            "type": "output",
                        }],
                    },
                },
            }
            paths = history_output_paths(history, comfy_output)
            cleanup_job_files(job_id, comfy_input, output_dir, paths)

            self.assertFalse(source.exists())
            self.assertFalse(worker_copy.exists())
            self.assertFalse(comfy_copy.exists())
            self.assertTrue(unrelated.exists())

    def test_history_output_paths_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory)
            history = {
                "outputs": {
                    "10": {
                        "images": [{
                            "filename": "outside.png",
                            "subfolder": "../",
                            "type": "output",
                        }],
                    },
                },
            }
            self.assertEqual(history_output_paths(history, root / "output"), [])


if __name__ == "__main__":
    unittest.main()
