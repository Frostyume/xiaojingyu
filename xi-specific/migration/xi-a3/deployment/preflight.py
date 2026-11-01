"""Read-only Xi deployment inventory. No backup, service control or content reads.

Production scanning is an explicit CLI invocation. Tests use fixture roots only.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
DB_SUFFIXES = {".sqlite", ".sqlite3", ".db"}


def utc():
    return datetime.now(timezone.utc).isoformat()


def linked(path):
    st = Path(path).lstat()
    return (stat.S_ISLNK(st.st_mode)
            or bool(getattr(st, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))
            or (stat.S_ISREG(st.st_mode) and st.st_nlink != 1))


def plain_path(path):
    """Check ancestors before resolving, including Windows junctions/hardlinks."""
    path = Path(path).absolute()
    for part in (path, *path.parents):
        if os.path.lexists(part) and linked(part):
            raise ValueError("Linked path refused: " + str(part))
    return path.resolve()


def file_metadata(path):
    path = plain_path(path)
    if not path.exists():
        return {"path": str(path), "exists": False}
    value = path.stat()
    if not path.is_file() and not path.is_dir():
        raise ValueError("Nonregular path refused: " + str(path))
    return {"path": str(path), "exists": True, "kind": "directory" if path.is_dir() else "file",
            "bytes": value.st_size if path.is_file() else None,
            "mtime_ns": value.st_mtime_ns, "contents_read": False}


def read_map(path):
    path = plain_path(path)
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("Map exceeds bounded metadata size")
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("format") != "xi-a3-production-cutover-map-v1":
        raise ValueError("Unsupported cutover map")
    return value


def probe_runtime(runtime_root, observer_pid):
    """Optional local OS metadata only. PowerShell script emits no command lines."""
    if os.name != "nt":
        raise ValueError("Runtime probe requires Windows")
    # Optional probe may parse only this small control receipt, never a linked target.
    receipt = file_metadata(Path(runtime_root) / "runtime.json")
    if receipt.get("bytes", 0) is not None and receipt.get("bytes", 0) > 1024 * 1024:
        raise ValueError("Runtime control receipt exceeds bound")
    result = subprocess.run([
        "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", str(HERE / "probe-runtime.ps1"), "-RuntimeRoot", str(runtime_root),
        "-ObserverPid", str(observer_pid),
    ], capture_output=True, text=True, encoding="utf-8-sig", timeout=45,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode != 0:
        # Never echo raw shell output; only source-controlled metadata should escape.
        raise ValueError("Read-only OS metadata probe failed; no service action taken")
    if len(result.stdout) > 1024 * 1024:
        raise ValueError("OS metadata probe output exceeds bound")
    value = json.loads(result.stdout)
    if value.get("format") != "xi-a3-runtime-metadata-v1":
        raise ValueError("Unexpected OS metadata probe format")
    return value


def prepare(map_path, *, runtime_root=None, vendor_root=None, inspect_runtime=False,
            quiescence_evidence=None, _probe=None):
    mapping = read_map(map_path)
    original_root = Path(mapping["runtime"]["root"])
    original_vendor = Path(mapping["runtime"]["vendor_app"])
    root = plain_path(runtime_root or original_root)
    vendor = plain_path(vendor_root or original_vendor)
    authority = root / "home/companion"
    blockers = []
    warnings = []

    def block(code, detail, **metadata):
        blockers.append({"code": code, "detail": detail, **metadata})

    def remap(raw):
        path = Path(raw)
        if path.is_relative_to(original_root):
            return root / path.relative_to(original_root)
        if path.is_relative_to(original_vendor):
            return vendor / path.relative_to(original_vendor)
        raise ValueError("Map reference outside registered runtime/vendor roots")

    expected = mapping["data"]["observed_scoped_databases"] + mapping["data"]["other_databases"]
    expected_paths = [remap(row["path"]) for row in expected]
    if len(expected_paths) != 18 or len(set(expected_paths)) != 18:
        block("INCOMPLETE_MAP_EXPECTATIONS", "Map must cover the 18 distinct known databases", expected_count=len(expected_paths))

    files, directories, empty_directories = [], [], []
    if not authority.is_dir():
        block("MISSING_AUTHORITY_ROOT", "Registered home/companion root does not exist", path=str(authority))
    else:
        try:
            plain_path(authority)
            for folder, dirs, names in os.walk(authority, followlinks=False):
                parent = Path(folder)
                directories.append(parent.relative_to(authority).as_posix())
                had_children = bool(dirs or names)
                safe_dirs = []
                for name in sorted(dirs):
                    child = parent / name
                    try:
                        plain_path(child)
                        safe_dirs.append(name)
                    except ValueError:
                        block("LINK_OR_REPARSE_REFUSED", "Directory link/junction is not traversed", path=str(child))
                dirs[:] = safe_dirs
                if not had_children:
                    empty_directories.append(parent.relative_to(authority).as_posix())
                for name in sorted(names):
                    child = parent / name
                    try:
                        row = file_metadata(child)
                        row["relative_path"] = child.relative_to(authority).as_posix()
                        if row.get("kind") != "file":
                            raise ValueError("Nonregular inventory entry")
                        files.append(row)
                    except ValueError:
                        block("LINK_OR_REPARSE_REFUSED", "File link/hardlink/nonregular entry is refused", path=str(child))
        except (OSError, ValueError):
            block("INVENTORY_UNREADABLE", "Complete metadata traversal failed; inventory is incomplete")

    included = {Path(row["path"]) for row in files}
    database_coverage = []
    for path in expected_paths:
        covered = path in included
        database_coverage.append({"path": str(path), "inventoried": covered})
        if not covered:
            block("MISSING_REQUIRED_DATABASE", "Known database is missing or refused by inventory", path=str(path))
    for row in files:
        if Path(row["path"]).suffix.lower() in DB_SUFFIXES and Path(row["path"]) not in set(expected_paths):
            block("UNMAPPED_DATABASE", "Additional database requires explicit scope registration", path=row["path"])

    # Declared directories include scratch that previous portable scripts excluded.
    for directory in mapping["data"]["directories"]:
        path = remap(directory["path"])
        try:
            if not plain_path(path).is_dir():
                block("MISSING_REQUIRED_DIRECTORY", "Declared authority directory is missing", path=str(path))
        except ValueError:
            block("LINK_OR_REPARSE_REFUSED", "Declared authority directory is linked", path=str(path))

    references = []
    raw_references = list(mapping["data"]["personality_and_implementation_references"])
    raw_references.extend(row["deployed_path"] for row in mapping["data"]["code_fingerprints"])
    raw_references.extend([mapping["runtime"]["core_source"], mapping["runtime"]["core_entry_reference"]])
    expected_hashes = {row["deployed_path"]: row["sha256"] for row in mapping["data"]["code_fingerprints"]}
    for raw in dict.fromkeys(raw_references):
        path = remap(raw)
        try:
            row = file_metadata(path)
            row["reference_role"] = "code/personality/configuration; metadata only"
            if raw in expected_hashes:
                row["previously_observed_code_sha256"] = expected_hashes[raw]
                row["sha256_rechecked_this_run"] = False
            references.append(row)
            if not row["exists"]:
                block("MISSING_REFERENCE", "Registered code/personality/configuration reference is absent", path=str(path))
        except ValueError:
            block("LINK_OR_REPARSE_REFUSED", "Registered reference traverses a link", path=str(path))

    credentials = []
    for raw in mapping["data"]["credentials"]["references_only"]:
        base, _, key = raw.partition("#")
        path = remap(base)
        try:
            row = file_metadata(path)
        except ValueError:
            row = {"path": str(path), "exists": None, "linked": True}
            block("LINK_OR_REPARSE_REFUSED", "Credential reference traverses a link", path=str(path))
        row.update({"configuration_key_reference": key or None, "contents_read": False,
                    "backup_policy": "include only through separately encrypted private recovery backup; no key/Authorization export",
                    "directory_children_enumerated": False})
        credentials.append(row)
        if row["exists"] is False:
            block("MISSING_CREDENTIAL_REFERENCE", "Recovery credential reference does not exist", path=str(path))

    runtime_observation = {"status": "not_requested", "processes": [], "listeners": [], "qq_clients": [], "tasks": []}
    if inspect_runtime:
        try:
            runtime_observation = (_probe or probe_runtime)(root, os.getpid())
            for process in runtime_observation.get("processes", []):
                if set(process.get("roles", [])) & {"old_core", "old_launcher", "old_entry_host"}:
                    block("OLD_WRITER_OR_LAUNCHER_ACTIVE", "Old writer/entry process is still present; identity requires operator review",
                          pid=process["pid"], roles=process["roles"])
                elif "runtime_path_process" in process.get("roles", []):
                    category = "potential_manual_editor" if str(process.get("name", "")).lower() in {
                        "notepad.exe", "notepad++.exe", "code.exe", "wordpad.exe"} else "unknown_observer"
                    warnings.append({"code": "PATH_MATCH_ONLY_RECHECK_BEFORE_CUTOVER", "classification": category,
                        "pid": process["pid"], "detail": "Path match alone does not establish an active writer; do not close it automatically"})
            for listener in runtime_observation.get("listeners", []):
                if listener.get("port") == 17789:
                    block("OLD_CORE_LISTENER_ACTIVE", "Old core listener remains present", pid=listener["pid"])
            for client in runtime_observation.get("qq_clients", []):
                block("QQ_SENDER_CANDIDATE_CONNECTED", "Connected OneBot client may send; do not activate another sender",
                      pid=client["pid"], classification=client.get("classification", "unknown-client"))
            for task in runtime_observation.get("tasks", []):
                if task.get("enabled") or task.get("state") == "Running":
                    block("OLD_AUTOMATIC_ENTRY_NOT_FROZEN", "Old task/logon entry is not held for cutover", task=task["name"])
            if runtime_observation.get("errors"):
                block("RUNTIME_OBSERVATION_INCOMPLETE", "One or more OS metadata queries failed")
        except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError):
            block("RUNTIME_OBSERVATION_FAILED", "Optional read-only OS observation failed; no service operation attempted")
    else:
        block("RUNTIME_NOT_OBSERVED", "Use --inspect-runtime for read-only OS process/port/task observations")

    evidence = {"supplied": quiescence_evidence is not None, "validated": False,
                "validation_supported": False, "contents_read": False}
    if quiescence_evidence is not None:
        try:
            evidence["candidate_reference"] = file_metadata(quiescence_evidence)
        except (OSError, ValueError):
            evidence["candidate_reference"] = {"path": str(quiescence_evidence), "exists": None, "invalid": True}
    block("QUIESCENCE_PROOF_NOT_VALIDATED", "No authoritative production quiescence/ownership verifier is installed. A supplied JSON flag or stable mtime is not a proof.")

    freeze = [
        {"entry": "operator-configured scheduled task", "kind": "logon scheduled task", "status_this_tool": "read-only; never modified"},
        {"entry": "operator-managed launch shortcuts", "kind": "manual task/run entries", "status_this_tool": "not frozen; future operator-controlled hold"},
        {"entry": mapping["launch_and_stop"]["independent_entry"], "kind": "old independent entry; may call existing DSH start/stop", "status_this_tool": "never executed"},
        {"entry": mapping["launch_and_stop"]["core_start"], "kind": "old start/resume entry", "status_this_tool": "never executed"},
        {"entry": mapping["launch_and_stop"]["launcher"], "kind": "old core launcher", "status_this_tool": "never executed"},
        {"entry": "all active model/tool/workshop/voice/profile/space writers and external admin scripts", "kind": "must be enumerated by actual lifecycle owner", "status_this_tool": "not proven absent"},
        {"entry": "every actual OneBot sender client", "kind": "must have one cross-base owner", "status_this_tool": "observation optional; no connection or sender control"},
    ]
    return {"format": "xi-a3-deployment-preflight-v1", "created_at": utc(), "mode": "read-only-metadata",
            "map_reference": str(plain_path(map_path)), "map_live_status_reused": False,
            "runtime_root": str(root), "vendor_root": str(vendor),
            "inventory": {"root": str(authority), "complete": not any(b["code"] in {
                "MISSING_AUTHORITY_ROOT", "INVENTORY_UNREADABLE", "LINK_OR_REPARSE_REFUSED", "MISSING_REQUIRED_DATABASE",
                "MISSING_REQUIRED_DIRECTORY", "INCOMPLETE_MAP_EXPECTATIONS"} for b in blockers),
                "files": sorted(files, key=lambda r: r["relative_path"]), "directories": sorted(directories),
                "empty_directories": sorted(empty_directories), "database_coverage": database_coverage,
                "all_home_companion_files_selected": True, "default_skip_rules": [],
                "contents_read": False, "hashes_calculated": False, "non_atomic_metadata_enumeration": True},
            "code_personality_configuration_references": references, "encrypted_backup_credential_references": credentials,
            "runtime_observation": runtime_observation, "quiescence": evidence,
            "entries_requiring_freeze": freeze, "blockers": blockers, "warnings": warnings,
            "ready_for_snapshot": False, "global_quiescence_claimed": False,
            "mtime_stability_used_as_proof": False, "data_copied": False, "services_or_tasks_changed": False,
            "reason_ready_false": "Only a future trusted lifecycle evidence verifier can admit a real frozen generation; this tool does not invent one"}


def save_report(report, output):
    output = plain_path(output)
    for root in (Path(report["runtime_root"]), Path(report["vendor_root"])):
        if output.is_relative_to(root) or root.is_relative_to(output):
            raise ValueError("Report must be outside runtime/vendor source roots")
    if output.exists():
        raise FileExistsError("Preflight report is append-only; choose a new output name")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--vendor-root", type=Path)
    parser.add_argument("--inspect-runtime", action="store_true", help="Optional local OS metadata probe; never health APIs")
    parser.add_argument("--quiescence-evidence", type=Path, help="Register an evidence reference only; no production proof validator is implemented")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = prepare(args.map, runtime_root=args.runtime_root, vendor_root=args.vendor_root,
                         inspect_runtime=args.inspect_runtime, quiescence_evidence=args.quiescence_evidence)
        path = save_report(report, args.output)
        print(json.dumps({"report": str(path), "ready_for_snapshot": report["ready_for_snapshot"],
              "files": len(report["inventory"]["files"]), "empty_directories": len(report["inventory"]["empty_directories"]),
              "databases_covered": sum(r["inventoried"] for r in report["inventory"]["database_coverage"]),
              "runtime_observation": report["runtime_observation"].get("status", "observed"),
              "blockers": report["blockers"], "warnings": report["warnings"]}, ensure_ascii=False, indent=2))
        return 0  # Successful observation is not snapshot authorization.
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(json.dumps({"ready_for_snapshot": False, "error_type": type(error).__name__,
                          "error": "Preflight cannot complete safely; no services/tasks/data changed"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
