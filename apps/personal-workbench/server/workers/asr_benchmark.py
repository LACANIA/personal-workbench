from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from statistics import fmean


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    temporary.replace(path)


def normalize_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).lower().split())


def media_duration(ffprobe: Path, source: Path) -> float:
    result = subprocess.run(
        [str(ffprobe), "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(source)],
        check=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, shell=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"FFPROBE_FAILED: {result.stderr.strip()}")
    return float(result.stdout.strip())


def gpu_environment(runtime_root: Path) -> dict[str, str]:
    root = runtime_root / "python-packages" / "nvidia"
    directories = [root / "cublas" / "bin", root / "cudnn" / "bin", root / "cuda_runtime" / "bin"]
    missing = [str(item) for item in directories if not item.is_dir()]
    if missing:
        raise RuntimeError(f"GPU_RUNTIME_DIRECTORY_MISSING: {', '.join(missing)}")
    environment = os.environ.copy()
    environment["PATH"] = os.pathsep.join([*(str(item) for item in directories), environment.get("PATH", "")])
    environment["PERSONAL_WORKBENCH_ASR_GPU_RUNTIME"] = str(runtime_root)
    return environment


def run_worker(
    python: Path,
    worker: Path,
    model: Path,
    source: Path,
    output: Path,
    device: str,
    compute_type: str,
    runtime_root: Path,
) -> dict[str, object]:
    args = [
        str(python), str(worker), "--model", str(model), "--input", str(source), "--output", str(output),
        "--device", device, "--compute-type", compute_type, "--cpu-compute-type", "int8",
        "--gpu-runtime-root", str(runtime_root),
    ]
    environment = gpu_environment(runtime_root) if device == "cuda" else os.environ.copy()
    print(f"benchmark {source.name}: {device}/{compute_type}", file=sys.stderr)
    started = time.perf_counter()
    result = subprocess.run(
        args, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=environment, timeout=3600, shell=False,
    )
    wall = time.perf_counter() - started
    line = next((item for item in reversed(result.stdout.splitlines()) if item.strip()), "{}")
    try:
        payload = json.loads(line)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"ASR_PROTOCOL_INVALID: {exc}: {result.stderr[-1200:]}") from exc
    if result.returncode != 0 or payload.get("status") != "ok":
        raise RuntimeError(f"ASR_BENCHMARK_FAILED: {payload}: {result.stderr[-1200:]}")
    payload["benchmark_wall_time_seconds"] = round(wall, 6)
    payload["worker_stderr"] = result.stderr[-4000:]
    return payload


def sample_row(sample_id: str, source: Path, duration: float, payload: dict[str, object]) -> dict[str, object]:
    segments = payload.get("segments")
    if not isinstance(segments, list):
        raise RuntimeError("ASR_SEGMENTS_MISSING")
    text = "\n".join(str(item.get("text", "")) for item in segments if isinstance(item, dict)).strip()
    wall = float(payload.get("benchmark_wall_time_seconds", 0.0))
    sampling = payload.get("gpu_sampling") if isinstance(payload.get("gpu_sampling"), dict) else {}
    peak = sampling.get("peak_vram_mb") if isinstance(sampling, dict) else None
    return {
        "sample_id": sample_id,
        "media_path": str(source),
        "media_duration_seconds": round(duration, 6),
        "device": str(payload.get("resolved_device")),
        "compute_type": str(payload.get("compute_type")),
        "asr_time_seconds": round(wall, 6),
        "rtf": round(wall / duration, 6),
        "peak_vram_mb": peak,
        "vram_semantics": sampling.get("sample_semantics") if isinstance(sampling, dict) else None,
        "transcript_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "transcript_text": text,
        "language": str(payload.get("language")),
        "fallback_used": bool(payload.get("fallback_used")),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="CPU/GPU faster-whisper benchmark")
    parser.add_argument("--python", required=True)
    parser.add_argument("--worker", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--ffprobe", required=True)
    parser.add_argument("--gpu-runtime-root", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--runtime-output", required=True)
    parser.add_argument("--gpu-compute-type", default="float16")
    parser.add_argument("--sample", action="append", required=True, help="sample_id=absolute_path")
    args = parser.parse_args()

    python = Path(args.python).resolve(strict=True)
    worker = Path(args.worker).resolve(strict=True)
    model = Path(args.model).resolve(strict=True)
    ffprobe = Path(args.ffprobe).resolve(strict=True)
    runtime_root = Path(args.gpu_runtime_root).resolve(strict=True)
    output = Path(args.output).resolve()
    evidence_root = output.parent / "benchmark-runs"
    comparisons: list[dict[str, object]] = []
    for definition in args.sample:
        sample_id, separator, raw_path = definition.partition("=")
        if not separator or not sample_id or not raw_path:
            raise RuntimeError("INVALID_SAMPLE_DEFINITION")
        source = Path(raw_path).resolve(strict=True)
        duration = media_duration(ffprobe, source)
        device_rows: dict[str, dict[str, object]] = {}
        for device, compute in (("cpu", "int8"), ("cuda", args.gpu_compute_type)):
            srt_path = evidence_root / f"{sample_id}-{device}.srt"
            payload = run_worker(python, worker, model, source, srt_path, device, compute, runtime_root)
            atomic_json(evidence_root / f"{sample_id}-{device}-worker.json", payload)
            device_rows[device] = sample_row(sample_id, source, duration, payload)
        cpu = device_rows["cpu"]
        gpu = device_rows["cuda"]
        cpu_text = str(cpu["transcript_text"])
        gpu_text = str(gpu["transcript_text"])
        normalized_cpu = normalize_text(cpu_text)
        normalized_gpu = normalize_text(gpu_text)
        comparisons.append({
            "sample_id": sample_id,
            "cpu": cpu,
            "gpu": gpu,
            "speedup": round(float(cpu["asr_time_seconds"]) / float(gpu["asr_time_seconds"]), 6),
            "exact_match": cpu_text == gpu_text,
            "normalized_match": normalized_cpu == normalized_gpu,
            "character_difference_ratio": round(1.0 - difflib.SequenceMatcher(None, normalized_cpu, normalized_gpu).ratio(), 6),
        })
    peak_values = [float(row["gpu"]["peak_vram_mb"]) for row in comparisons if row["gpu"].get("peak_vram_mb") is not None]
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "selected_compute_type": args.gpu_compute_type,
        "comparisons": comparisons,
        "summary": {
            "sample_count": len(comparisons),
            "mean_speedup": round(fmean(float(row["speedup"]) for row in comparisons), 6),
            "mean_cpu_rtf": round(fmean(float(row["cpu"]["rtf"]) for row in comparisons), 6),
            "mean_gpu_rtf": round(fmean(float(row["gpu"]["rtf"]) for row in comparisons), 6),
            "peak_vram_mb": max(peak_values) if peak_values else None,
            "peak_vram_semantics": "whole_gpu_sampled",
        },
    }
    atomic_json(output, report)
    atomic_json(Path(args.runtime_output).resolve(), report)
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
