"""Merge preflight inventories from multiple state roots into one backup manifest.

Pure metadata transformation: no filesystem, network, subprocess, environment,
SQLite, deletion, quiescence proof, or publication of any kind.
"""

import re

_ROOT_ID_RE = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
_SHA256_RE = re.compile(r"[0-9a-fA-F]{64}\Z")
_DRIVE_RE = re.compile(r"[A-Za-z]:")


def _validate_root_id(root_id):
    if not isinstance(root_id, str) or not _ROOT_ID_RE.match(root_id):
        raise ValueError("invalid root_id: %r" % (root_id,))
    return root_id


def _validate_relative_path(path, context):
    if not isinstance(path, str):
        raise ValueError("%s: relative path must be a string, got %r" % (context, path))
    if path == "":
        raise ValueError("%s: relative path is empty" % context)
    if "\x00" in path:
        raise ValueError("%s: relative path contains NUL: %r" % (context, path))
    if "\\" in path:
        raise ValueError("%s: relative path contains backslash: %r" % (context, path))
    if path.startswith("/"):
        raise ValueError("%s: relative path is absolute: %r" % (context, path))
    if _DRIVE_RE.match(path):
        raise ValueError("%s: relative path has a drive prefix: %r" % (context, path))
    for segment in path.split("/"):
        if segment in ("", ".", ".."):
            raise ValueError(
                "%s: relative path is not canonical POSIX: %r" % (context, path)
            )
    return path


def _validate_bytes(value, context):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(
            "%s: bytes must be a nonnegative int, got %r" % (context, value)
        )
    return value


def _archive_path(root_id, relative_path):
    return "roots/" + root_id + "/" + relative_path


def merge_manifests(manifests, required_dbs):
    """Merge per-root preflight inventories into one deterministic manifest.

    ``manifests`` is a list of dicts with keys ``root_id``, ``files`` (list of
    ``{relative_path, bytes, sha256?}``) and ``empty_directories`` (list of
    relative paths). ``required_dbs`` maps root_id to a list of required DB
    relative paths. Returns a JSON-serializable dict; input is never mutated.
    """
    if not isinstance(manifests, list):
        raise ValueError("manifests must be a list")
    if not isinstance(required_dbs, dict):
        raise ValueError("required_dbs must be a mapping")

    seen_roots = set()
    files = []
    empty_directories = []
    file_index = set()

    for entry in manifests:
        if not isinstance(entry, dict):
            raise ValueError("manifest entry must be a dict, got %r" % (entry,))
        for key in ("root_id", "files", "empty_directories"):
            if key not in entry:
                raise ValueError("manifest entry missing key %r" % (key,))
        root_id = _validate_root_id(entry["root_id"])
        if root_id in seen_roots:
            raise ValueError("duplicate root_id: %r" % (root_id,))
        seen_roots.add(root_id)

        if not isinstance(entry["files"], list):
            raise ValueError("root %r: files must be a list" % (root_id,))
        if not isinstance(entry["empty_directories"], list):
            raise ValueError("root %r: empty_directories must be a list" % (root_id,))

        root_files = set()
        for item in entry["files"]:
            if not isinstance(item, dict):
                raise ValueError("root %r: file record must be a dict" % (root_id,))
            if "relative_path" not in item or "bytes" not in item:
                raise ValueError(
                    "root %r: file record needs relative_path and bytes" % (root_id,)
                )
            context = "root %r file" % (root_id,)
            relative_path = _validate_relative_path(item["relative_path"], context)
            size = _validate_bytes(item["bytes"], context)
            if relative_path in root_files:
                raise ValueError(
                    "root %r: duplicate file path %r" % (root_id, relative_path)
                )
            root_files.add(relative_path)
            record = {
                "root_id": root_id,
                "relative_path": relative_path,
                "archive_path": _archive_path(root_id, relative_path),
                "bytes": size,
            }
            if "sha256" in item:
                sha256 = item["sha256"]
                if not isinstance(sha256, str) or not _SHA256_RE.match(sha256):
                    raise ValueError(
                        "root %r path %r: sha256 must be 64 hex characters"
                        % (root_id, relative_path)
                    )
                record["sha256"] = sha256
            files.append(record)
            file_index.add((root_id, relative_path))

        root_dirs = set()
        for path in entry["empty_directories"]:
            context = "root %r empty directory" % (root_id,)
            relative_path = _validate_relative_path(path, context)
            if relative_path in root_dirs:
                raise ValueError(
                    "root %r: duplicate empty directory path %r"
                    % (root_id, relative_path)
                )
            if relative_path in root_files:
                raise ValueError(
                    "root %r: path %r recorded as both file and empty directory"
                    % (root_id, relative_path)
                )
            root_dirs.add(relative_path)
            empty_directories.append(
                {
                    "root_id": root_id,
                    "relative_path": relative_path,
                    "archive_path": _archive_path(root_id, relative_path),
                }
            )

    missing_databases = []
    for root_id in required_dbs:
        _validate_root_id(root_id)
        db_paths = required_dbs[root_id]
        if not isinstance(db_paths, list):
            raise ValueError("root %r: required db list must be a list" % (root_id,))
        for path in db_paths:
            _validate_relative_path(path, "root %r required database" % (root_id,))
            if (root_id, path) not in file_index:
                missing_databases.append({"root_id": root_id, "relative_path": path})

    sort_key = lambda record: (record["root_id"], record["relative_path"])
    return {
        "files": sorted(files, key=sort_key),
        "empty_directories": sorted(empty_directories, key=sort_key),
        "missing_databases": sorted(missing_databases, key=sort_key),
        "ready_for_snapshot": False,
        "quiescence_verified": False,
    }
