#!/usr/bin/env python3
"""Small, dependency-free handoff manager for Codex IDE and ChatGPT Work."""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
EXCHANGE = ROOT / "exchange"
PACKAGES = ROOT / ".bridge" / "packages"
DIRECTIONS = ("ide-to-work", "work-to-ide")
STATUSES = ("open", "in_progress", "blocked", "ready_for_review", "completed")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")[:60] or "handoff"


def ensure_layout() -> None:
    for direction in DIRECTIONS:
        (EXCHANGE / direction).mkdir(parents=True, exist_ok=True)
    (EXCHANGE / "archive").mkdir(parents=True, exist_ok=True)
    PACKAGES.mkdir(parents=True, exist_ok=True)


def iter_handoffs():
    ensure_layout()
    for direction in DIRECTIONS:
        for path in sorted((EXCHANGE / direction).iterdir(), reverse=True):
            if path.is_dir() and (path / "handoff.json").exists():
                yield direction, path


def read_manifest(path: Path) -> dict:
    return json.loads((path / "handoff.json").read_text(encoding="utf-8"))


def cmd_init(_args) -> int:
    ensure_layout()
    print(f"Bridge ready: {ROOT}")
    return 0


def cmd_new(args) -> int:
    ensure_layout()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    handoff_id = f"{timestamp}-{slugify(args.title)}"
    path = EXCHANGE / args.direction / handoff_id
    path.mkdir(parents=True, exist_ok=False)
    (path / "files").mkdir()

    manifest = {
        "schema_version": 1,
        "id": handoff_id,
        "direction": args.direction,
        "title": args.title,
        "status": "open",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "parent_handoff": None,
        "files": [],
    }
    (path / "handoff.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (path / "REQUEST.md").write_text(
        f"# Request: {args.title}\n\n"
        "## Goal\n\nDescribe the desired outcome.\n\n"
        "## Context\n\nDescribe relevant prior work and decisions.\n\n"
        "## Requested work\n\n- [ ] Add concrete tasks.\n\n"
        "## Allowed scope\n\nList files or systems that may be changed.\n\n"
        "## Acceptance criteria\n\n- [ ] Add verifiable criteria.\n\n"
        "## Verification\n\nList commands or checks.\n\n"
        "## Blockers or risks\n\nNone known.\n",
        encoding="utf-8",
    )
    (path / "RESPONSE.md").write_text(
        f"# Response: {args.title}\n\n"
        "## Outcome\n\nPending.\n\n"
        "## Changed files\n\nNone yet.\n\n"
        "## Verification\n\nNot run.\n\n"
        "## Risks and follow-up\n\nPending.\n",
        encoding="utf-8",
    )
    print(path.relative_to(ROOT))
    return 0


def validate_handoff(path: Path) -> list[str]:
    errors: list[str] = []
    # "files/" is optional: git does not track empty directories, so a handoff
    # created without attachments (files == []) legitimately arrives with no
    # files/ dir after a clone. Only the manifest + the two Markdown docs are
    # structurally required.
    required = ("handoff.json", "REQUEST.md", "RESPONSE.md")
    for name in required:
        if not (path / name).exists():
            errors.append(f"{path.relative_to(ROOT)}: missing {name}")
    if errors or not (path / "handoff.json").exists():
        return errors
    files_dir = path / "files"
    if files_dir.exists() and not files_dir.is_dir():
        errors.append(f"{path.relative_to(ROOT)}: files must be a directory")
    try:
        data = read_manifest(path)
    except (json.JSONDecodeError, OSError) as exc:
        return [f"{path.relative_to(ROOT)}: invalid handoff.json ({exc})"]
    if data.get("direction") not in DIRECTIONS:
        errors.append(f"{path.relative_to(ROOT)}: invalid direction")
    if data.get("status") not in STATUSES:
        errors.append(f"{path.relative_to(ROOT)}: invalid status")
    if data.get("id") != path.name:
        errors.append(f"{path.relative_to(ROOT)}: id must match directory name")
    if not data.get("title"):
        errors.append(f"{path.relative_to(ROOT)}: title is required")
    # If the manifest lists attachments, files/ must actually exist.
    if data.get("files") and not files_dir.is_dir():
        errors.append(f"{path.relative_to(ROOT)}: manifest lists files but files/ is missing")
    return errors


def cmd_validate(args) -> int:
    paths = [ROOT / args.path] if args.path else [p for _, p in iter_handoffs()]
    errors = [error for path in paths for error in validate_handoff(path.resolve())]
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Valid: {len(paths)} handoff(s)")
    return 0


def cmd_status(_args) -> int:
    rows = []
    for direction, path in iter_handoffs():
        try:
            data = read_manifest(path)
            rows.append((path.name, direction, data.get("status", "?"), data.get("title", "")))
        except (json.JSONDecodeError, OSError):
            rows.append((path.name, direction, "invalid", ""))
    if not rows:
        print("No handoffs yet.")
        return 0
    for handoff_id, direction, status, title in rows:
        print(f"{status:16} {direction:12} {handoff_id}  {title}")
    return 0


def cmd_pack(args) -> int:
    ensure_layout()
    path = (ROOT / args.path).resolve()
    if ROOT not in path.parents or not path.is_dir():
        print("Handoff path must be a directory inside this project.", file=sys.stderr)
        return 1
    errors = validate_handoff(path)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    destination = PACKAGES / f"{path.name}.zip"
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in sorted(path.rglob("*")):
            if item.is_file():
                archive.write(item, Path(path.name) / item.relative_to(path))
    print(destination.relative_to(ROOT))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    init_parser = sub.add_parser("init", help="Create mailbox directories")
    init_parser.set_defaults(func=cmd_init)

    new_parser = sub.add_parser("new", help="Create a handoff")
    new_parser.add_argument("direction", choices=DIRECTIONS)
    new_parser.add_argument("title")
    new_parser.set_defaults(func=cmd_new)

    status_parser = sub.add_parser("status", help="List handoffs")
    status_parser.set_defaults(func=cmd_status)

    validate_parser = sub.add_parser("validate", help="Validate one or all handoffs")
    validate_parser.add_argument("path", nargs="?")
    validate_parser.set_defaults(func=cmd_validate)

    pack_parser = sub.add_parser("pack", help="Create a ZIP for one handoff")
    pack_parser.add_argument("path")
    pack_parser.set_defaults(func=cmd_pack)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

