from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path


# This worker communicates with Node through pipes on Windows.  Python otherwise
# inherits the active ANSI code page, while the controller decodes the protocol
# as UTF-8.  Pin both streams so transcript JSON and diagnostic messages remain
# lossless regardless of the user's console locale.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def format_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds_value, milliseconds_value = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds_value:02d},{milliseconds_value:03d}"


def emit_error(code: str, message: str, detail: str | None = None) -> int:
    print(json.dumps({"status": "error", "error_code": code, "message": message, "detail": detail}, ensure_ascii=False))
    return 1


_DLL_DIRECTORY_HANDLES: list[object] = []


def configure_gpu_runtime(runtime_root: str | None) -> dict[str, object]:
    if runtime_root is None or runtime_root.strip() == "":
        raise RuntimeError("ASR_GPU_RUNTIME_ROOT_NOT_CONFIGURED")
    root = Path(runtime_root).resolve(strict=True)
    directories = [
        root / "python-packages" / "nvidia" / "cublas" / "bin",
        root / "python-packages" / "nvidia" / "cudnn" / "bin",
        root / "python-packages" / "nvidia" / "cuda_runtime" / "bin",
    ]
    required = [
        directories[0] / "cublas64_12.dll",
        directories[0] / "cublasLt64_12.dll",
        directories[1] / "cudnn64_9.dll",
        directories[1] / "cudnn_ops64_9.dll",
        directories[2] / "cudart64_12.dll",
    ]
    missing = [str(item) for item in required if not item.is_file()]
    if missing:
        raise RuntimeError(f"ASR_GPU_RUNTIME_DLL_MISSING: {', '.join(missing)}")
    original_path = os.environ.get("PATH", "")
    os.environ["PATH"] = os.pathsep.join([*(str(item) for item in directories), original_path])
    add_directory = getattr(os, "add_dll_directory", None)
    if add_directory is not None:
        for directory in directories:
            _DLL_DIRECTORY_HANDLES.append(add_directory(str(directory)))
    return {
        "available": True,
        "root": str(root),
        "dll_directories": [str(item) for item in directories],
        "required_dlls": [str(item) for item in required],
        "path_scope": "child_process",
    }


def nvidia_smi_path() -> str | None:
    detected = shutil.which("nvidia-smi")
    if detected is not None:
        return detected
    system_root = os.environ.get("SystemRoot")
    if system_root:
        candidate = Path(system_root) / "System32" / "nvidia-smi.exe"
        if candidate.is_file():
            return str(candidate)
    return None


def gpu_sample(executable: str) -> tuple[float, float] | None:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        result = subprocess.run(
            [executable, "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            creationflags=flags,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    row = result.stdout.splitlines()[0].split(",") if result.stdout.splitlines() else []
    if len(row) < 2:
        return None
    try:
        return float(row[0].strip()), float(row[1].strip())
    except ValueError:
        return None


class GpuSampler:
    def __init__(self, interval_seconds: float = 0.25) -> None:
        self.executable = nvidia_smi_path()
        self.interval_seconds = interval_seconds
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.samples: list[tuple[float, float]] = []
        self.baseline_vram_mb: float | None = None

    def start(self) -> None:
        if self.executable is None:
            return
        initial = gpu_sample(self.executable)
        if initial is not None:
            self.baseline_vram_mb = initial[0]
            self.samples.append(initial)
        self.thread = threading.Thread(target=self._collect, name="asr-gpu-sampler", daemon=True)
        self.thread.start()

    def _collect(self) -> None:
        assert self.executable is not None
        while not self.stop_event.wait(self.interval_seconds):
            sample = gpu_sample(self.executable)
            if sample is not None:
                self.samples.append(sample)

    def stop(self) -> dict[str, object]:
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=3)
        if self.executable is not None:
            final = gpu_sample(self.executable)
            if final is not None:
                self.samples.append(final)
        peak = max((item[0] for item in self.samples), default=None)
        utilization = max((item[1] for item in self.samples), default=None)
        baseline = self.baseline_vram_mb
        return {
            "available": self.executable is not None and len(self.samples) > 0,
            "sample_semantics": "whole_gpu_sampled",
            "sample_count": len(self.samples),
            "baseline_vram_mb": baseline,
            "peak_vram_mb": peak,
            "peak_delta_vram_mb": None if peak is None or baseline is None else round(max(0.0, peak - baseline), 3),
            "peak_gpu_utilization_percent": utilization,
        }


def run_transcription(model_path: Path, source: Path, device: str, compute_type: str, language: str | None) -> dict[str, object]:
    from faster_whisper import WhisperModel  # type: ignore

    model = WhisperModel(str(model_path), device=device, compute_type=compute_type, local_files_only=True)
    segments, info = model.transcribe(str(source), language=language, vad_filter=True, beam_size=5)
    rows = [
        {"start": round(float(segment.start), 3), "end": round(float(segment.end), 3), "text": segment.text.strip()}
        for segment in segments
        if segment.text.strip()
    ]
    if not rows:
        raise RuntimeError("TRANSCRIPTION_EMPTY")
    return {
        "segments": rows,
        "language": str(info.language),
        "language_probability": round(float(info.language_probability), 6),
        "device": device,
        "compute_type": compute_type,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline faster-whisper worker for Personal Workbench")
    parser.add_argument("--model", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--language", default=None)
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--cpu-compute-type", default="int8")
    parser.add_argument("--gpu-runtime-root", default=os.environ.get("PERSONAL_WORKBENCH_ASR_GPU_RUNTIME"))
    args = parser.parse_args()

    try:
        source = Path(args.input).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        return emit_error("ASR_INPUT_MISSING", "ASR 输入文件不存在。", str(exc))
    try:
        model_path = Path(args.model).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        return emit_error("ASR_MODEL_MISSING", "本机 ASR 模型不存在。", str(exc))
    if not model_path.is_dir():
        return emit_error("ASR_MODEL_MISSING", "本机 ASR 模型目录无效。")
    output = Path(args.output).resolve()
    if source == output:
        return emit_error("ASR_FAILED", "ASR 输出不能覆盖输入文件。")

    started = time.perf_counter()
    requested = str(args.device)
    primary_device = "cuda" if requested in {"auto", "cuda"} else "cpu"
    primary_compute = str(args.compute_type) if primary_device == "cuda" else str(args.cpu_compute_type)
    fallback_reason: str | None = None
    gpu_runtime: dict[str, object] = {"available": False, "root": args.gpu_runtime_root, "path_scope": "child_process"}
    gpu_sampling: dict[str, object] | None = None
    if primary_device == "cuda":
        try:
            gpu_runtime = configure_gpu_runtime(args.gpu_runtime_root)
        except Exception as exc:
            runtime_error = f"{type(exc).__name__}: {exc}"
            if requested == "cuda":
                return emit_error("ASR_RUNTIME_MISSING", "隔离 GPU ASR 运行库不可用。", runtime_error)
            fallback_reason = runtime_error
            primary_device = "cpu"
            primary_compute = str(args.cpu_compute_type)
            print(f"GPU ASR runtime unavailable; using CPU: {runtime_error}", file=sys.stderr)
    sampler = GpuSampler()
    try:
        if primary_device == "cuda":
            sampler.start()
        result = run_transcription(model_path, source, primary_device, primary_compute, args.language)
    except Exception as exc:
        if primary_device == "cuda":
            gpu_sampling = sampler.stop()
        if requested != "auto" or primary_device != "cuda":
            return emit_error("ASR_FAILED", "本机 ASR 转写失败。", f"{type(exc).__name__}: {exc}")
        fallback_reason = f"{type(exc).__name__}: {exc}"
        print(f"CUDA ASR initialization failed; retrying on CPU: {fallback_reason}", file=sys.stderr)
        try:
            result = run_transcription(model_path, source, "cpu", str(args.cpu_compute_type), args.language)
        except Exception as cpu_exc:
            return emit_error("ASR_FAILED", "本机 ASR 的 CUDA 与 CPU 路径均失败。", f"{type(cpu_exc).__name__}: {cpu_exc}")
    else:
        if primary_device == "cuda":
            gpu_sampling = sampler.stop()

    rows = result["segments"]
    assert isinstance(rows, list)
    lines: list[str] = []
    for index, row in enumerate(rows, start=1):
        assert isinstance(row, dict)
        lines.extend([str(index), f"{format_timestamp(float(row['start']))} --> {format_timestamp(float(row['end']))}", str(row["text"]), ""])
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    temporary.replace(output)
    payload = {
        "status": "ok",
        "engine": "faster-whisper",
        "model_path": str(model_path),
        "requested_device": requested,
        "resolved_device": result["device"],
        "compute_type": result["compute_type"],
        "fallback_used": fallback_reason is not None,
        "fallback_reason": fallback_reason,
        "gpu_runtime": gpu_runtime,
        "gpu_sampling": gpu_sampling,
        "language": result["language"],
        "language_probability": result["language_probability"],
        "duration_ms": round((time.perf_counter() - started) * 1000),
        "segments": rows,
        "output_path": str(output),
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
