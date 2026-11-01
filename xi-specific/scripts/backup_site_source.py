"""Preserve a clean Site Git repository and verify recovery without running its code."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import uuid


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True,
        timeout=120).stdout.decode("utf-8").strip()


def create(repo, output):
    repo = Path(repo).resolve(strict=True)
    output = Path(output).resolve()
    if output.is_relative_to(repo):
        raise ValueError("Destination must be outside source repository")
    if git(repo, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("Uncommitted files exist; preserve them before source backup")
    head = git(repo, "rev-parse", "HEAD")
    tree = git(repo, "rev-parse", "HEAD^{tree}")
    output.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    # Repository label is metadata; random suffix prevents same-second collisions.
    label = ''.join(c for c in repo.name if c.isascii() and (c.isalnum() or c == '-')) or 'site'
    bundle = output / f"{label}-source-{stamp}-{uuid.uuid4().hex[:8]}.bundle"
    git(repo, "bundle", "create", str(bundle), "--all", "HEAD")
    git(repo, "bundle", "verify", str(bundle))
    with tempfile.TemporaryDirectory(prefix="home-source-recovery-") as tmp:
        restored = Path(tmp) / "restored.git"
        # Bare clone restores Git objects only: no checkout, hooks or package scripts run.
        subprocess.run(["git", "clone", "--bare", str(bundle), str(restored)],
                       check=True, capture_output=True, timeout=120)
        if git(restored, "rev-parse", "HEAD") != head:
            raise ValueError("Recovered HEAD mismatch")
        if git(restored, "rev-parse", "HEAD^{tree}") != tree:
            raise ValueError("Recovered tree mismatch")
        git(restored, "fsck", "--full", "--strict")
        tracked = len(git(restored, "ls-tree", "-r", "--name-only", "HEAD").splitlines())
    if git(repo, "rev-parse", "HEAD") != head or git(repo, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("Source changed during backup; bundle retained but not certified")
    receipt = {
        "source_repository": repo.name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "archive": str(bundle), "bytes": bundle.stat().st_size,
        "sha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
        "head": head, "tree": tree, "tracked_files": tracked,
        "source_restore_verified": True, "cloud_copy_verified": False,
        "limitations": [
            "Local, unencrypted Git history backup; not a cloud data backup",
            "Ignored files, credentials, dependencies and live D1/R2 data excluded",
            "No deployment, application execution or cross-device credential recovery tested"
        ]
    }
    bundle.with_suffix(".receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    return receipt


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()
    print(json.dumps(create(args.repo, args.output), ensure_ascii=False, indent=2))
