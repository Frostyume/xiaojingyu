"""Stopped-source full private snapshot adapter. CLI uses real OS gate only.

Reuses existing SQLite backup, ACL staging, PAVLT encryption and archive restore.
No service control, model call, automatic activation or source cleanup.
"""
from contextlib import closing
from datetime import datetime, timezone
import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[2]
sys.path.insert(0, str(PROJECT / "scripts"))
sys.path.insert(0, str(PROJECT / "companion"))
import portable_backup as P
import archive as A
from backup_personal_data import digest, snapshot_file
import preflight as F


def now():
    return datetime.now(timezone.utc).isoformat()


def real_gate(plan_file):
    node_path = os.environ.get('XI_NODE_EXE')
    if not node_path or not Path(node_path).is_absolute() or not Path(node_path).is_file():
        raise ValueError('Set XI_NODE_EXE to an explicit Node executable')
    result = subprocess.run([node_path, str(HERE / "snapshot-source-gate.mjs"), str(plan_file)],
                            capture_output=True, text=True, encoding="utf-8-sig", timeout=55,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        report = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise ValueError("Actual stopped-source OS gate failed") from None
    if result.returncode or report.get("allowed") is not True or report.get("actualOsProbe") is not True:
        raise ValueError("Old entry/task/sender or unknown OS state blocks snapshot")
    return report


def walk_files(root):
    root = F.plain_path(root)
    files, dirs = [], []
    for folder, children, names in os.walk(root, followlinks=False):
        parent = Path(folder)
        dirs.append(parent.relative_to(root).as_posix())
        for name in children + names:
            F.plain_path(parent / name)
        for name in names:
            source = parent / name
            if not source.is_file():
                raise ValueError("Nonregular source refused")
            files.append(source)
    return files, dirs


def sources(mapping, root, vendor):
    groups = [(root / "home/companion", "home/companion"), (root / "home/providers", "home/providers"),
              (vendor / "guardian-scoped", "vendor/guardian-scoped")]
    entries, directories = {}, set()
    for source, target in groups:
        if not F.plain_path(source).is_dir():
            raise ValueError("Required complete data/private/code directory missing")
        files, dirs = walk_files(source)
        directories.update(target if name == "." else target + "/" + name for name in dirs)
        for path in files:
            entries[target + "/" + path.relative_to(source).as_posix()] = path
    singles = [(root / "core-entry.json", "launch/core-entry.json"),
               (vendor / "core/companion.scoped-candidate.ts", "vendor/core/companion.scoped-candidate.ts"),
               (vendor / "package.json", "vendor/package.json"),
               (vendor / "guardian/channels.json", "vendor/guardian/channels.json")]
    if (vendor / "package-lock.json").is_file():
        singles.append((vendor / "package-lock.json", "vendor/package-lock.json"))
    for label in ("independent_entry", "core_start", "launcher", "graceful_stop"):
        # Actual reviewed launcher source, not arbitrary files discovered from credentials.
        original = Path(mapping["launch_and_stop"][label])
        singles.append((original, "launch/implementation/" + original.name))
    for source, target in singles:
        source = F.plain_path(source)
        if not source.is_file():
            raise ValueError("Required code/configuration reference missing")
        entries[target] = source
    for target in entries:
        A.safe_name(target)
        directories.update(parent.as_posix() for parent in Path(target).parents if parent.as_posix() != ".")
    folded = [name.casefold() for name in entries]
    if len(folded) != len(set(folded)):
        raise ValueError("Case-insensitive source collision")
    return entries, sorted(directories)


def stable_fingerprint(entries, directories):
    fingerprint = {}
    for target, source in entries.items():
        # SHM locking state is not restored; committed WAL content is fingerprinted.
        sqlite_sidecar = target.endswith(("-shm", "-wal")) and target[:-4] in entries and Path(target[:-4]).suffix.lower() in F.DB_SUFFIXES
        if sqlite_sidecar and (target.endswith("-shm") or source.stat().st_size == 0):
            continue
        fingerprint[target] = {"sha256": digest(source), "bytes": source.stat().st_size}
    return {"files": fingerprint, "directories": directories}


def quickcheck(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
        if db.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise ValueError("Restored SQLite quick_check failed")


def _create(map_file, plan_file, output, key_file, vendor_root, gate, synthetic_only):
    mapping = F.read_map(map_file)
    plan = json.loads(F.plain_path(plan_file).read_text(encoding="utf-8"))
    root = F.plain_path(plan["oldRuntimeRoot"])
    vendor = F.plain_path(vendor_root or mapping["runtime"]["vendor_app"])
    output = F.plain_path(output)
    if output.exists():
        raise FileExistsError("Append-only snapshot output must be new")
    key_file = F.plain_path(key_file)
    for source in (root, vendor):
        if output.is_relative_to(source) or source.is_relative_to(output) or key_file.is_relative_to(source):
            raise ValueError("Output/master key must be separate from source data/code")
    before_gate = gate(plan_file)  # Must succeed before secret/data content reads.
    if before_gate.get("allowed") is not True or not synthetic_only and before_gate.get("actualOsProbe") is not True:
        raise ValueError("Real stopped-source observation required")
    inventory = F.prepare(map_file, runtime_root=root, vendor_root=vendor)
    ignored = {"RUNTIME_NOT_OBSERVED", "QUIESCENCE_PROOF_NOT_VALIDATED"}
    if any(item["code"] not in ignored for item in inventory["blockers"]) or not inventory["inventory"]["complete"]:
        raise ValueError("Complete 18-database/source inventory is not satisfied")
    entries, directories = sources(mapping, root, vendor)
    before = stable_fingerprint(entries, directories)
    output.mkdir(parents=True, exist_ok=False)
    stage = P.private_directory(output)
    # All configuration/credential plaintext remains below the atomic private ACL staging root.
    payload = stage / "payload"
    payload.mkdir()
    master = None
    try:
        manifest_files, databases, sidecars = {}, [], []
        declared_dbs = {Path(row["path"]).relative_to(Path(mapping["runtime"]["root"])).as_posix()
                        for row in mapping["data"]["observed_scoped_databases"] + mapping["data"]["other_databases"]}
        db_targets = {"home/companion/" + str(Path(name).relative_to("home/companion")).replace("\\", "/") for name in declared_dbs}
        for directory in directories:
            payload.joinpath(*A.safe_name(directory).parts).mkdir(parents=True, exist_ok=True)
        for target, source in entries.items():
            if any(target.endswith(suffix) and target[:-len(suffix)] in db_targets for suffix in ("-wal", "-shm", "-journal")):
                sidecars.append(target)
                continue
            method = snapshot_file(source, payload / target)
            manifest_files[target] = {"sha256": digest(payload / target), "bytes": (payload / target).stat().st_size, "method": method}
            if method == "sqlite-backup-api":
                quickcheck(payload / target)
                databases.append(target)
        if not db_targets <= set(databases):
            raise ValueError("Not all 18 required SQLite databases were backed up through SQLite API")
        current_entries, current_dirs = sources(mapping, root, vendor)
        if before != stable_fingerprint(current_entries, current_dirs):
            raise ValueError("Source changed while copying; private failed stage retained")
        after_gate = gate(plan_file)
        if after_gate.get("allowed") is not True or not synthetic_only and after_gate.get("actualOsProbe") is not True:
            raise ValueError("Fresh post-copy OS gate refused source consistency")
        descriptor = {"format": "xi-stopped-full-private-snapshot-v1", "created_at": now(), "synthetic_only": synthetic_only,
            "files": manifest_files, "directories": directories, "databases": databases, "sqlite_sidecars_consumed": sidecars,
            "before_gate": before_gate, "after_gate": after_gate,
            "coverage": "entire home/companion and home/providers, no workshop-runs/workspace/data exclusion",
            "config_and_credentials": "inside recovery-key encrypted archive only", "vendor_dependencies_fully_bundled": False,
            "dpapi_inner_decryption_verified": False, "global_hostile_writer_isolation_proven": False,
            "external_write_barrier_required": True, "automatic_activation": False}
        (payload / "SNAPSHOT-METADATA.json").write_text(json.dumps(descriptor, ensure_ascii=False, indent=2), encoding="utf-8")
        plain_zip = stage / "snapshot.zip"
        archived = A.create(payload, plain_zip)
        master = P.decode_key(key_file.read_bytes())
        encrypted = output / "snapshot.zip.pavlt"
        P.transform(plain_zip, encrypted, master)
        recovered_zip = stage / "recovered.zip"
        P.transform(encrypted, recovered_zip, master, decrypt=True)
        if digest(recovered_zip) != digest(plain_zip):
            raise ValueError("Encrypted envelope roundtrip mismatch")
        restored = stage / "restored"
        A.restore(recovered_zip, restored)
        for directory in directories:
            restored.joinpath(*A.safe_name(directory).parts).mkdir(parents=True, exist_ok=True)
        for target, row in manifest_files.items():
            if digest(restored / target) != row["sha256"] or (restored / target).stat().st_size != row["bytes"]:
                raise ValueError("Independent restore hash mismatch")
        for target in databases:
            quickcheck(restored / target)
        final_entries, final_dirs = sources(mapping, root, vendor)
        if before != stable_fingerprint(final_entries, final_dirs):
            raise ValueError("Source changed before completion; failed private stage retained")
        final_gate = gate(plan_file)
        if final_gate.get("allowed") is not True or not synthetic_only and final_gate.get("actualOsProbe") is not True:
            raise ValueError("Final source OS observation failed")
        receipt = {"format": "xi-stopped-private-snapshot-receipt-v1", "status": "encrypted_full_source_restore_verified",
            "created_at": now(), "synthetic_only": synthetic_only, "encrypted_file": str(encrypted),
            "ciphertext_sha256": digest(encrypted), "restored_files": archived["files"], "databases_verified": len(databases),
            "required_databases": len(db_targets), "empty_directories_preserved": True,
            "sqlite_backup_api": True, "quick_check": True, "hashes_verified": True,
            "actual_os_gates": not synthetic_only, "plaintext_retained_after_success": False,
            "services_or_tasks_changed": False, "automatic_activation": False, "cloud_copy_verified": False,
            "inner_dpapi_decryption_verified": False, "lossless_cutover_verified": False}
        with (output / "receipt.json").open("x", encoding="utf-8") as handle:
            json.dump(receipt, handle, ensure_ascii=False, indent=2)
        # Only disposable plaintext copies, after authenticated encrypted independent restore.
        resolved = stage.resolve(strict=True)
        if resolved.parent != output.resolve(strict=True) or not resolved.name.startswith(".vault-partial-") or stage.is_symlink():
            raise ValueError("Unexpected private cleanup target; retained")
        shutil.rmtree(resolved)
        return receipt
    finally:
        master = None


def create_production_snapshot(map_file, plan_file, output, key_file, vendor_root=None):
    return _create(map_file, plan_file, output, key_file, vendor_root, real_gate, False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--vendor-root", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(create_production_snapshot(args.map, args.plan, args.output, args.key_file, args.vendor_root), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"status": "snapshot_not_completed", "error_type": type(error).__name__,
                          "private_failed_stage_may_exist_and_is_retained": True, "services_or_tasks_changed": False}))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
