"""Command-line entrypoint for one-file preview and reviewed commit."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


MY_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(MY_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(MY_AGENT_ROOT))

from memory.ingest.errors import IngestError  # noqa: E402
from memory.ingest.ingest_api import (  # noqa: E402
    commit_document_ingest,
    preview_document_ingest,
)
from memory.ingest.path_policy import DEFAULT_POLICY_PATH  # noqa: E402


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Controlled Research Memory document ingestion.")
    subparsers = parser.add_subparsers(dest="command")

    preview = subparsers.add_parser("preview", help="Validate and create a dry-run Manifest.")
    preview.add_argument("--database", type=Path, required=True)
    preview.add_argument("--project", required=True)
    preview.add_argument("--file", type=Path, required=True)
    preview.add_argument("--source-version", required=True)
    preview.add_argument("--summary", required=True)
    preview.add_argument("--title")
    preview.add_argument("--document-type")
    preview.add_argument("--policy", type=Path, default=DEFAULT_POLICY_PATH)
    preview.add_argument("--base-directory", type=Path)
    preview.add_argument("--manifest-directory", type=Path)
    preview.add_argument("--max-lines", type=int, default=120)
    preview.add_argument("--max-chars", type=int, default=8000)

    commit = subparsers.add_parser("commit", help="Commit one reviewed dry-run Manifest.")
    commit.add_argument("--manifest", type=Path, required=True)
    commit.add_argument("--manifest-sha256", required=True)
    commit.add_argument("--confirm-production-write", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments or arguments[0] not in {"preview", "commit"}:
        arguments.insert(0, "preview")
    parser = _parser()
    args = parser.parse_args(arguments)
    try:
        if args.command == "preview":
            result = preview_document_ingest(
                database=args.database,
                project_name=args.project,
                file_path=args.file,
                source_version=args.source_version,
                summary=args.summary,
                title=args.title,
                document_type=args.document_type,
                policy_path=args.policy,
                base_directory=args.base_directory,
                manifest_directory=args.manifest_directory,
                chunking_config={"max_lines": args.max_lines, "max_chars": args.max_chars},
            )
        else:
            result = commit_document_ingest(
                manifest_path=args.manifest,
                manifest_sha256=args.manifest_sha256,
                confirm_production_write=args.confirm_production_write,
            )
    except IngestError as exc:
        print(json.dumps({"status": "ERROR", "error": exc.as_dict()}, ensure_ascii=False, indent=2))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
