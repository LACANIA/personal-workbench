#!/usr/bin/env python3
"""Local frame OCR worker. stdout is a single JSON protocol record; diagnostics go to stderr."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def under_root(candidate: Path, root: Path) -> bool:
    try:
        candidate.resolve(strict=True).relative_to(root.resolve(strict=True))
        return True
    except (OSError, ValueError):
        return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    started = time.perf_counter()
    frame_root = Path(args.input_dir)
    manifest_path = Path(args.manifest)
    output_path = Path(args.output)
    if not frame_root.is_dir() or not manifest_path.is_file() or output_path.parent != frame_root.parent:
        raise RuntimeError("OCR_PATH_DENIED")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = manifest.get("frames")
    if not isinstance(entries, list) or len(entries) == 0 or len(entries) > 24:
        raise RuntimeError("OCR_MANIFEST_INVALID")
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as error:  # noqa: BLE001
        raise RuntimeError(f"OCR_RUNTIME_MISSING:{error}") from error
    engine = RapidOCR()
    frames: list[dict[str, object]] = []
    for item in entries:
        if not isinstance(item, dict) or not isinstance(item.get("file"), str):
            raise RuntimeError("OCR_MANIFEST_INVALID")
        file_path = frame_root / item["file"]
        if file_path.suffix.lower() not in {".jpg", ".jpeg", ".png"} or not under_root(file_path, frame_root):
            raise RuntimeError("OCR_FRAME_PATH_DENIED")
        result, _elapsed = engine(str(file_path))
        parts: list[str] = []
        scores: list[float] = []
        for row in result or []:
            if not isinstance(row, (list, tuple)) or len(row) < 3:
                continue
            text = str(row[1]).strip()
            if text:
                parts.append(text)
                try:
                    scores.append(float(row[2]))
                except (TypeError, ValueError):
                    pass
        frames.append({
            "index": int(item.get("index", len(frames))),
            "timestamp_ms": int(item.get("timestamp_ms", 0)),
            "text": "\n".join(parts),
            "confidence": round(sum(scores) / len(scores), 4) if scores else None,
        })
    payload = {
        "status": "ok",
        "engine": "rapidocr_onnxruntime",
        "duration_ms": round((time.perf_counter() - started) * 1000, 3),
        "frames": frames,
    }
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output_path)
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(f"OCR worker failed: {error}", file=sys.stderr)
        print(json.dumps({"status": "error", "error_code": str(error).split(":", 1)[0], "message": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
