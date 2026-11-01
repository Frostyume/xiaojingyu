"""Private multi-root backup adapter; no service control or automatic activation.

Reuses the accepted Qoder metadata merger and the existing stopped snapshot's
SQLite backup, private ACL staging, PAVLT envelope and archive verifier.
"""
from contextlib import closing
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
sys.path.insert(0, str(HERE.parent / "deployment"))
import production_snapshot as S
from qoder_multi_root_manifest import merge_manifests
from seal_restored_acl import restrict as restrict_restored_acl

FORMAT = "xi-multi-root-private-plan-v1"
METADATA = "MULTI-ROOT-METADATA.json"
MERGER_SHA = "819639b84444d0566e8cb7245142b73d0bd10722fd262cc9b50dbb1880a7ec56"


def read_json(path):
    path = S.F.plain_path(path)
    try:
        if path.stat().st_size > 4 * 1024 * 1024:
            raise ValueError("Control metadata exceeds bound")
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        error.safe_path = str(path)
        error.phase = "read-control-json"
        raise


def write_private(path, value):
    path = S.F.plain_path(path)
    with S.P.private_output(path) as stream:
        stream.write((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def plain_file(path):
    path = S.F.plain_path(path)
    if not path.is_file():
        raise FileNotFoundError(2, "Required source file is absent", str(path))
    return path


def disjoint_output(target, sources):
    target = S.F.plain_path(target)
    if target.exists():
        raise FileExistsError("Output must not exist")
    for source in sources:
        source = S.F.plain_path(source)
        if target.is_relative_to(source) or source.is_relative_to(target):
            raise ValueError("Output overlaps source")
    return target


def prepare_plan(manifest_file, map_file, output, *, owned_task, vendor_root=None):
    """Metadata-only inventory. Never reads database/file bodies or a recovery key."""
    manifest_file = plain_file(manifest_file)
    manifest, mapping = read_json(manifest_file), S.F.read_map(map_file)
    if manifest.get("format") != "xi-owned-launch-manifest-v1":
        raise ValueError("Explicit owned launch manifest required")
    old = S.F.plain_path(manifest["handoffPlan"]["oldRuntimeRoot"])
    owned = S.F.plain_path(manifest["paths"]["bridgeRoot"])
    dsh = S.F.plain_path(manifest["dsh"]["root"])
    vendor = S.F.plain_path(vendor_root or mapping["runtime"]["vendor_app"])
    if not manifest_file.is_relative_to(owned) or old == owned or old.is_relative_to(owned) or owned.is_relative_to(old):
        raise ValueError("Explicit separate old/owned roots required")
    if dsh == owned or dsh.is_relative_to(old) or old.is_relative_to(dsh):
        raise ValueError("Invalid independent DSH data root")
    roots = [{"root_id":"legacy", "kind":"legacy-package", "path":str(old), "vendor":str(vendor), "map_file":str(S.F.plain_path(map_file))},
             {"root_id":"owned", "kind":"tree", "path":str(owned), "dependency_links":[]},
             {"root_id":"dsh", "kind":"tree", "path":str(dsh), "dependency_links":[]}]
    for source in roots[1:]:
        link = Path(source["path"]) / "node_modules"
        if os.path.lexists(link) and S.F.linked(link):
            source["dependency_links"].append({"relative_path":"node_modules", "target":str(link.resolve(strict=True)), "bundled":False})
    refs = manifest["credentialReferences"]
    credential_files = []
    for label in ("http", "ws"):
        credential_files.append({"relative_path":"qq-" + label + ".json", "path":refs[label]["path"]})
    for name in ("provider", "webProvider"):
        if name not in refs:
            continue
        ref = refs[name]
        for key in ("key_path", "config_path", "env_path"):
            if ref.get(key):
                credential_files.append({"relative_path":name + "-" + key + ".private", "path":ref[key]})
    roots.append({"root_id":"credentials", "kind":"files", "files":credential_files})
    old_rows = mapping["data"]["observed_scoped_databases"] + mapping["data"]["other_databases"]
    original_root = Path(mapping["runtime"]["root"])
    required = {"legacy":[Path(row["path"]).relative_to(original_root).as_posix() for row in old_rows],
                "owned":[(Path(manifest["paths"]["stateDir"]) / "db/bridge.db").relative_to(owned).as_posix()]}
    if len(required["legacy"]) != 18 or len(set(required["legacy"])) != 18:
        raise ValueError("Original eighteen database coverage required")
    from urllib.parse import urlparse
    onebot = urlparse(manifest["handoffPlan"]["oneBotEndpoint"])
    if onebot.hostname not in {"127.0.0.1", "localhost", "::1"} or not onebot.port:
        raise ValueError("Explicit OneBot loopback port required")
    locks = [Path(manifest["handoffPlan"]["ownerLockPath"]), owned / ".workroom-viewer.lock", dsh / "owner.lock", dsh / "mcp-pids.jsonl"]
    workshop = manifest.get("assetsPaths", {}).get("workshop", {})
    if workshop.get("db"):
        locks.append(Path(workshop["db"] + ".owned-worker.lock"))
    console_port = manifest["paths"].get("consolePort")
    if console_port is None:
        # Approved control JSON only: never return any credential/token field.
        console_port = read_json(manifest["paths"]["configFile"]).get("consolePort")
    ports = [manifest["handoffPlan"]["oldCorePort"], console_port, manifest["dsh"]["port"]]
    if manifest.get("viewer"):
        ports.append(manifest["viewer"]["port"])
    if any(type(port) is not int or not 1 <= port <= 65535 for port in ports):
        raise ValueError("Explicit actual runtime ports required")
    plan = {"format":FORMAT, "prepared_at":S.now(), "roots":roots, "required_databases":required,
            "gate":{"roots":[str(old), str(owned), str(dsh)], "ports":sorted(set(ports)), "onebot_port":onebot.port,
                    "tasks":[{"name":manifest["handoffPlan"]["oldTaskName"], "path":manifest["handoffPlan"]["oldTaskPath"]},
                             {"name":owned_task, "path":"\\"}], "must_be_absent":[str(p) for p in locks]},
            "merger_sha256":MERGER_SHA, "ready_for_snapshot":False, "automatic_activation":False}
    inventory, _, _ = collect(plan)
    if inventory["missing_databases"]:
        raise ValueError("Required database missing; no plan published")
    output = disjoint_output(output, [old, owned, dsh, vendor])
    # Existing private_output correctly requires an existing parent. Prepare's
    # requested backup parent can be new; create it only after source-disjoint
    # validation, then recheck links before publishing the private metadata file.
    output.parent.mkdir(parents=True, exist_ok=True)
    S.F.plain_path(output.parent)
    write_private(output, plan)
    return {"status":"prepared_metadata_only", "plan":str(output), "roots":len(roots), "files":len(inventory["files"]),
            "empty_directories":len(inventory["empty_directories"]), "required_databases":sum(map(len, required.values())),
            "source_bytes":sum(row["bytes"] for row in inventory["files"]), "ready_for_snapshot":False,
            "credential_bodies_read":False, "services_or_tasks_changed":False}


def collect(plan):
    if plan.get("format") != FORMAT or S.digest(HERE / "qoder_multi_root_manifest.py") != MERGER_SHA:
        raise ValueError("Unknown plan or changed accepted merger")
    manifests, entries, directories = [], {}, set()
    tree_roots = {S.F.plain_path(row["path"]) for row in plan["roots"] if row["kind"] == "tree"}
    for source in plan["roots"]:
        files, dirs, empty = {}, [], []
        root_id, kind = source["root_id"], source["kind"]
        if kind == "legacy-package":
            files, dirs = S.sources(S.F.read_map(source["map_file"]), S.F.plain_path(source["path"]), S.F.plain_path(source["vendor"]))
            empty = [name for name in dirs if not any(f.startswith(name + "/") for f in files) and not any(d.startswith(name + "/") for d in dirs)]
        elif kind == "tree":
            root = S.F.plain_path(source["path"])
            if not root.is_dir():
                raise ValueError("Required root directory missing")
            dependencies = {row["relative_path"]:row for row in source.get("dependency_links", [])}
            for relative, row in dependencies.items():
                link = root / relative
                if relative != "node_modules" or not os.path.lexists(link) or not S.F.linked(link) or str(link.resolve(strict=True)) != row["target"]:
                    raise ValueError("Registered dependency link missing or changed")
            for folder, children, names in os.walk(root, followlinks=False):
                parent = Path(folder)
                if parent != root:
                    dirs.append(parent.relative_to(root).as_posix())
                original_children = bool(children or names)
                keep = []
                for name in sorted(children):
                    child = parent / name
                    relative = child.relative_to(root).as_posix()
                    if relative in dependencies:
                        row = dependencies[relative]
                        if name != "node_modules" or not S.F.linked(child) or str(child.resolve(strict=True)) != row["target"]:
                            raise ValueError("Registered dependency link changed")
                        continue
                    S.F.plain_path(child)
                    if child in tree_roots and child != root:
                        continue  # Relocated into its own explicit root namespace, not dropped.
                    keep.append(name)
                children[:] = keep
                if not original_children and parent != root:
                    empty.append(parent.relative_to(root).as_posix())
                for name in sorted(names):
                    file = plain_file(parent / name)
                    files[file.relative_to(root).as_posix()] = file
        elif kind == "files":
            for row in source["files"]:
                if row["relative_path"] in files:
                    raise ValueError("Repeated explicit file alias")
                files[row["relative_path"]] = plain_file(row["path"])
        else:
            raise ValueError("Unsupported source group")
        manifests.append({"root_id":root_id, "files":[{"relative_path":name, "bytes":file.stat().st_size} for name,file in files.items()], "empty_directories":empty})
        prefix = "roots/" + root_id
        directories.add(prefix)
        directories.update(prefix + "/" + name for name in dirs)
        for name, file in files.items():
            target = prefix + "/" + name
            S.A.safe_name(target)
            entries[target] = file
            directories.update(p.as_posix() for p in Path(target).parents if p.as_posix() != ".")
    inventory = merge_manifests(manifests, plan["required_databases"])
    all_names = sorted(set(entries) | directories)
    if len({name.casefold() for name in all_names}) != len(all_names) or set(entries) & directories:
        raise ValueError("Archive case or file/directory conflict")
    for name in all_names:
        S.A.safe_name(name)
    return inventory, entries, sorted(directories)


def real_gate(plan):
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(HERE / "multi-root-probe.ps1")],
        input=json.dumps({**plan["gate"], "observer_pid":os.getpid()}), capture_output=True, text=True, encoding="utf-8", timeout=55,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        value = json.loads(result.stdout)
    except (ValueError, TypeError):
        error = ValueError("Fresh multi-root OS gate unavailable")
        error.safe_code, error.phase, error.safe_blockers = "OS_GATE_TRANSPORT_FAILED", "os-probe", []
        raise error from None
    if result.returncode or value.get("format") != "xi-multi-root-os-gate-v1" or value.get("allowed") is not True or value.get("actual_os_probe") is not True:
        error = ValueError("Known writer/task/port/lock/OneBot or unknown OS state blocks snapshot")
        allowed_codes = {"runtime-executor-present", "runtime-port-listening", "onebot-client-present", "task-not-observed-exactly-once",
                         "automatic-entry-not-frozen", "owned-lock-or-child-journal-retained", "os-observation-failed"}
        error.safe_code, error.phase = "OS_GATE_BLOCKED", "os-probe"
        error.safe_blockers = [code for code in value.get("blockers", []) if isinstance(code,str) and code in allowed_codes]
        raise error
    return value


def assert_gate(value, synthetic):
    if value.get("allowed") is not True or not synthetic and value.get("actual_os_probe") is not True:
        raise ValueError("Stopped ownership evidence not observed")


def _create(plan_file, output, key_file, gate, synthetic):
    plan = read_json(plan_file)
    roots = [Path(row["path"]) for row in plan["roots"] if "path" in row]
    roots.extend(Path(row["vendor"]) for row in plan["roots"] if "vendor" in row)
    output = disjoint_output(output, roots)
    key_file = plain_file(key_file)
    if any(key_file.is_relative_to(root) for root in roots):
        raise ValueError("Recovery key must be outside backed-up roots")
    before_gate = gate(plan); assert_gate(before_gate, synthetic)
    inventory, entries, dirs = collect(plan)
    if key_file in set(entries.values()):
        raise ValueError("Recovery master must never enter its own archive")
    if inventory["missing_databases"]:
        raise ValueError("Required SQLite missing")
    if sum(row["bytes"] for row in inventory["files"]) > 2 * 1024 ** 3 - 16 * 1024 ** 2:
        raise ValueError("Existing archive verifier 2GiB limit exceeded; do not truncate")
    before = S.stable_fingerprint(entries, dirs)
    output.mkdir(parents=True, exist_ok=False)
    stage = S.P.private_directory(output)
    payload = stage / "payload"; payload.mkdir()
    master = None
    try:
        for name in dirs:
            payload.joinpath(*S.A.safe_name(name).parts).mkdir(parents=True, exist_ok=True)
        files, dbs, sidecars = {}, [], []
        db_targets = {name for name in entries if Path(name).suffix.lower() in S.F.DB_SUFFIXES}
        for name, source in entries.items():
            sidecar = next((suffix for suffix in ("-wal", "-shm", "-journal") if name.endswith(suffix)), None)
            if sidecar:
                if name[:-len(sidecar)] not in db_targets:
                    raise ValueError("Orphan SQLite sidecar refused")
                sidecars.append(name); continue
            method = S.snapshot_file(source, payload / name)
            files[name] = {"sha256":S.digest(payload / name), "bytes":(payload / name).stat().st_size, "method":method}
            if method == "sqlite-backup-api":
                S.quickcheck(payload / name); dbs.append(name)
        required = {"roots/" + root + "/" + name for root, names in plan["required_databases"].items() for name in names}
        if not required <= set(dbs):
            raise ValueError("Required databases not backed up with SQLite API")
        _, current, current_dirs = collect(plan)
        if before != S.stable_fingerprint(current, current_dirs):
            raise ValueError("Source changed during snapshot")
        after_gate = gate(plan); assert_gate(after_gate, synthetic)
        descriptor = {"format":"xi-multi-root-private-snapshot-v1", "created_at":S.now(), "synthetic_only":synthetic,
            "plan":plan, "files":files, "directories":dirs, "databases":dbs, "sqlite_sidecars_consumed":sidecars,
            "before_gate":before_gate, "after_gate":after_gate, "metadata_merger_sha256":MERGER_SHA,
            "consistency":"synthetic-per-db-only" if synthetic else "known-writers-stopped-and-automatic-entries-frozen",
            "hostile_writer_isolation_proven":False, "external_write_barrier_required":True,
            "dependency_links_bundled":False, "code_and_platform_binaries_fully_bundled":False, "automatic_activation":False}
        (payload / METADATA).write_text(json.dumps(descriptor, ensure_ascii=False, indent=2), encoding="utf-8")
        plain_zip = stage / "snapshot.zip"; S.A.create(payload, plain_zip)
        master = S.P.decode_key(key_file.read_bytes())
        encrypted = output / "snapshot.zip.pavlt"; S.P.transform(plain_zip, encrypted, master)
        recovered_zip = stage / "roundtrip.zip"; S.P.transform(encrypted, recovered_zip, master, decrypt=True)
        if S.digest(plain_zip) != S.digest(recovered_zip):
            raise ValueError("Authenticated envelope roundtrip differs")
        restored = stage / "restored"; S.A.restore(recovered_zip, restored); verify_restored(restored)
        _, current, current_dirs = collect(plan)
        if before != S.stable_fingerprint(current, current_dirs):
            raise ValueError("Source changed before snapshot completion")
        final_gate = gate(plan); assert_gate(final_gate, synthetic)
        receipt = {"format":"xi-multi-root-private-snapshot-receipt-v1", "status":"encrypted_multi_root_restore_verified", "created_at":S.now(),
            "synthetic_only":synthetic, "encrypted_file":str(encrypted), "ciphertext_sha256":S.digest(encrypted),
            "roots":len(plan["roots"]), "files":len(files), "databases_verified":len(dbs), "required_databases":len(required),
            "sqlite_backup_api":True, "hashes_verified":True, "quick_check":True, "empty_directories_preserved":True,
            "actual_os_gates":not synthetic, "final_gate":final_gate, "plaintext_retained_after_success":False,
            "inner_dpapi_decryption_verified":False, "automatic_activation":False, "cloud_copy_verified":False,
            "services_or_tasks_changed":False, "restoring_over_live_generation_allowed":False}
        cleanup_stage(stage, output)
        write_private(output / "receipt.json", receipt)
        return receipt
    finally:
        master = None  # Failed private stages deliberately remain for diagnosis.


def cleanup_stage(stage, parent):
    resolved = stage.resolve(strict=True)
    if resolved.parent != parent.resolve(strict=True) or not resolved.name.startswith(".vault-partial-") or S.F.linked(stage):
        raise ValueError("Unexpected private stage; retained")
    shutil.rmtree(resolved)


def verify_restored(root):
    root = S.F.plain_path(root)
    descriptor = read_json(root / METADATA)
    if descriptor.get("format") != "xi-multi-root-private-snapshot-v1":
        raise ValueError("Unknown snapshot descriptor")
    for name in descriptor["directories"]:
        root.joinpath(*S.A.safe_name(name).parts).mkdir(parents=True, exist_ok=True)
    actual, actual_dirs = S.walk_files(root)
    if {p.relative_to(root).as_posix() for p in actual} != set(descriptor["files"]) | {METADATA}:
        raise ValueError("Restored file inventory differs")
    expected_dirs = set(descriptor["directories"]) | {"."}
    if set(actual_dirs) != expected_dirs:
        raise ValueError("Restored directory inventory differs")
    for name, row in descriptor["files"].items():
        target = root.joinpath(*S.A.safe_name(name).parts)
        if target.stat().st_size != row["bytes"] or S.digest(target) != row["sha256"]:
            raise ValueError("Restored hash differs")
    for name in descriptor["databases"]:
        S.quickcheck(root.joinpath(*S.A.safe_name(name).parts))
    return {"verified":True, "files":len(descriptor["files"]), "databases":len(descriptor["databases"])}


def restore_snapshot(encrypted, key_file, destination):
    if os.name != "nt":
        raise RuntimeError("No-overwrite restored-root publication is validated on Windows only")
    encrypted, key_file = plain_file(encrypted), plain_file(key_file)
    destination = disjoint_output(destination, [encrypted.parent, key_file])
    stage = S.P.private_directory(destination.parent)
    master = None
    try:
        master = S.P.decode_key(key_file.read_bytes())
        zipfile = stage / "authenticated.zip"; S.P.transform(encrypted, zipfile, master, decrypt=True)
        restored = stage / "restored"; S.A.restore(zipfile, restored)
        result = verify_restored(restored)
        (restored / "RESTORE-VERIFIED.json").write_text(json.dumps({**result, "ciphertext_sha256":S.digest(encrypted), "automatic_activation":False,
            "notice":"Offline preservation only; never replace the current generation or replay saved queues."}, indent=2), encoding="utf-8")
        restored.rename(destination)  # Windows no-overwrite publication.
        # Python's archive temp directory may introduce OWNER RIGHTS/SYSTEM/
        # Administrators ACLs. Restore the envelope's stricter current-user-only
        # contract on this newly published offline tree and verify every entry.
        restrict_restored_acl(destination)
        acl_check = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
            str(HERE / "seal-restored-acl.ps1"), "-Root", str(destination)], capture_output=True, text=True, encoding="utf-8", timeout=60,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if acl_check.returncode or json.loads(acl_check.stdout).get("current_user_only_allow") is not True:
            raise ValueError("Offline restore ACL not confirmed; tree retained")
        cleanup_stage(stage, destination.parent)
        return {**result, "destination":str(destination), "automatic_activation":False, "replaced_existing_root":False, "current_user_only_acl_verified":True}
    finally:
        master = None


def main():
    parser = argparse.ArgumentParser(description=__doc__); commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare"); prep.add_argument("--manifest", type=Path, required=True); prep.add_argument("--map", type=Path, required=True)
    prep.add_argument("--output", type=Path, required=True); prep.add_argument("--owned-task", required=True); prep.add_argument("--vendor-root", type=Path)
    create = commands.add_parser("create"); create.add_argument("--plan", type=Path, required=True); create.add_argument("--output", type=Path, required=True); create.add_argument("--key-file", type=Path, required=True)
    restore = commands.add_parser("restore"); restore.add_argument("--encrypted", type=Path, required=True); restore.add_argument("--key-file", type=Path, required=True); restore.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare": result = prepare_plan(args.manifest, args.map, args.output, owned_task=args.owned_task, vendor_root=args.vendor_root)
        elif args.command == "create": result = _create(args.plan, args.output, args.key_file, real_gate, False)
        else: result = restore_snapshot(args.encrypted, args.key_file, args.destination)
        print(json.dumps(result, ensure_ascii=False)); return 0
    except Exception as error:
        codes = {FileNotFoundError:"PATH_NOT_FOUND", FileExistsError:"OUTPUT_ALREADY_EXISTS", PermissionError:"PATH_ACCESS_DENIED",
                 json.JSONDecodeError:"CONTROL_JSON_INVALID", TimeoutError:"OPERATION_TIMED_OUT"}
        code = next((value for kind,value in codes.items() if isinstance(error,kind)), "SNAPSHOT_CHECK_FAILED")
        if getattr(error,"safe_code",None) in {"OS_GATE_TRANSPORT_FAILED","OS_GATE_BLOCKED"}:
            code = error.safe_code
        report = {"status":"not_completed", "error_code":code, "error_type":type(error).__name__,
                  "phase":getattr(error,"phase",args.command), "services_or_tasks_changed":False,
                  "failed_private_stage_may_exist":args.command in {"create","restore"}}
        safe_path = getattr(error,"safe_path",None) or getattr(error,"filename",None)
        if safe_path is not None:
            report["path"] = str(safe_path)  # Known filesystem/control path, never JSON/native stderr or key contents.
        if hasattr(error,"safe_blockers"):
            report["blockers"] = error.safe_blockers
        print(json.dumps(report, ensure_ascii=False)); return 2


if __name__ == "__main__":
    raise SystemExit(main())
