"""Local versioned data snapshot. No network, credentials export, or source writes."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
from datetime import datetime, timezone
import uuid
import zipfile
from backup_site_source import create as backup_site_source

ROOTS = ('hub', 'docs', 'config', 'tutor', 'music', 'data', 'reports', 'scripts', 'integrations', 'sources')
SKIP_PARTS = {'node_modules', '__pycache__', '.git', '.venv', 'dependencies', 'vendor', 'private', 'backups', 'feasibility'}
SKIP_SUFFIX = {'.pyc', '.dpapi', '.pem', '.key', '.log', '.lock', '.tmp', '.exe', '.dll'}
DB_SUFFIX = {'.sqlite', '.sqlite3', '.db'}


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def selected(root):
    for name in ROOTS:
        base = root / name
        if not base.exists():
            continue
        for folder, dirs, names in os.walk(base, followlinks=False):
            parent = Path(folder)
            dirs[:] = sorted(d for d in dirs if d not in SKIP_PARTS and not (parent/d).is_symlink()
                             and not (hasattr(parent/d, 'is_junction') and (parent/d).is_junction()))
            for name in sorted(names):
                p = parent / name
                if p.is_symlink() or not p.resolve().is_relative_to(root):
                    raise ValueError('Linked file refused: ' + str(p))
                lower = name.lower()
                if (p.suffix.lower() in SKIP_SUFFIX or lower.endswith(('-wal', '-shm', '-journal'))
                    or lower.startswith(('.env', '.', 'qa-', 'auth.', 'credentials', 'token.'))
                    or lower == 'traces.sqlite'):
                    continue
                yield p
    for name in ('项目说明.md', 'AGENTS.md'):
        p = root / name
        if p.is_file() and not p.is_symlink():
            yield p


def snapshot_file(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.suffix.lower() in DB_SUFFIX:
        started = time.monotonic()
        def progress(status, remaining, total):
            if time.monotonic() - started > 90:
                raise TimeoutError('Database backup timeout')
        with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)) as src:
            with closing(sqlite3.connect(target)) as dst:
                src.backup(dst, pages=1024, progress=progress, sleep=.05)
                result = dst.execute('PRAGMA integrity_check').fetchall()
                if result != [('ok',)]:
                    raise ValueError('Database integrity check failed: ' + source.name)
        return 'sqlite-backup-api'
    for attempt in range(3):
        before = source.stat()
        with source.open('rb') as src, target.open('wb') as dst:
            for block in iter(lambda: src.read(1024 * 1024), b''):
                dst.write(block)
        after = source.stat()
        if (before.st_mtime_ns, before.st_size) == (after.st_mtime_ns, after.st_size):
            return 'stable-file-copy'
    raise ValueError('Source kept changing: ' + str(source))


def verify(archive):
    """Read bytes back and rebuild each SQLite DB in an isolated temp directory."""
    with zipfile.ZipFile(archive) as z, tempfile.TemporaryDirectory(prefix='personal-agent-verify-') as tmp:
        names = z.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate archive entries')
        manifest = json.loads(z.read('manifest.json'))
        expected = {'manifest.json'} | {i['path'] for i in manifest['files']}
        if set(names) != expected:
            raise ValueError('Archive/manifest mismatch')
        databases = 0
        for item in manifest['files']:
            name = item['path']
            if Path(name).is_absolute() or '..' in Path(name).parts or ':' in name or '\\' in name:
                raise ValueError('Unsafe archive name')
            h = hashlib.sha256(); size = 0
            dbfile = Path(tmp) / 'verify.sqlite3'
            db = dbfile.open('wb') if item['method'] == 'sqlite-backup-api' else None
            try:
                with z.open(name) as f:
                    for block in iter(lambda: f.read(1024 * 1024), b''):
                        h.update(block); size += len(block)
                        if db:
                            db.write(block)
            finally:
                if db:
                    db.close()
            if h.hexdigest() != item['sha256'] or size != item['bytes']:
                raise ValueError('Checksum mismatch: ' + name)
            if item['method'] == 'sqlite-backup-api':
                with closing(sqlite3.connect(dbfile.as_uri() + '?mode=ro', uri=True)) as c:
                    if c.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                        raise ValueError('Restored database failed: ' + name)
                databases += 1
        return {'files': len(manifest['files']), 'databases': databases,
                'bytes_verified': sum(i['bytes'] for i in manifest['files']),
                'archive_sha256': digest(Path(archive)), 'status': 'verified',
                'content_decryption_verified': False, 'cloud_copy_verified': False}


def create(root, output, site_repos=()):
    root = Path(root).resolve(strict=True); output = Path(output).resolve()
    if output.is_relative_to(root):
        raise ValueError('Backup destination must be outside project')
    output.mkdir(parents=True, exist_ok=True)
    source_backups = []
    for requested_repo in site_repos:
        source_repo = Path(requested_repo).resolve(strict=True)
        site_name = source_repo.name
        if (source_repo / '.git').exists():
            try:
                source_backups.append(backup_site_source(source_repo, output))
            except (ValueError, OSError, TimeoutError) as exc:
                source_backups.append({'source_repository': site_name, 'source_restore_verified': False, 'error': str(exc)})
            except Exception as exc:
                # A source Git failure must not prevent preserving personal databases.
                source_backups.append({'source_repository': site_name, 'source_restore_verified': False, 'error_type': type(exc).__name__})
        elif source_repo.exists():
            source_backups.append({'source_repository': site_name, 'source_restore_verified': False, 'error': 'Source repository unavailable'})
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    final = output / ('personal-agent-' + stamp + '.zip')
    partial = final.with_suffix('.zip.partial')
    manifest = {'schema_version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
                'source_root': str(root), 'scope': list(ROOTS), 'files': [],
                'companion_source_backups': source_backups,
                'excluded_directory_names': sorted(SKIP_PARTS),
                'limitations': ['Local-only, no cloud upload', 'Not a global transaction across databases',
                                'DPAPI payloads require original Windows user; decryption not tested',
                                'Credentials, dependencies, QA databases, logs, traces and old backups excluded',
                                'Cloud tutor state and uncollected chats not fetched', 'Local ZIP is not encrypted']}
    try:
        with tempfile.TemporaryDirectory(prefix='snapshot-', dir=output) as tmp:
            stage = Path(tmp)
            for src in selected(root):
                rel = src.relative_to(root).as_posix(); dst = stage / rel
                method = snapshot_file(src, dst)
                manifest['files'].append({'path': rel, 'bytes': dst.stat().st_size,
                                          'sha256': digest(dst), 'method': method})
            with zipfile.ZipFile(partial, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=5) as z:
                for item in manifest['files']:
                    z.write(stage / item['path'], item['path'])
                z.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
        receipt = verify(partial)
        os.replace(partial, final)
        receipt.update({'archive': str(final), 'created_at': manifest['created_at'],
                        'companion_source_backups': source_backups})
        final.with_suffix('.receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
        return receipt
    except Exception:
        # A failed partial is preserved, never promoted or advertised as a valid backup.
        raise


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root', type=Path)
    ap.add_argument('--output', type=Path)
    ap.add_argument('--site-repo', type=Path, action='append', default=[])
    ap.add_argument('--verify', type=Path)
    args = ap.parse_args()
    if not args.verify and (args.root is None or args.output is None):
        ap.error('--root and --output are required for creation')
    print(json.dumps(verify(args.verify) if args.verify else create(args.root, args.output, args.site_repo), ensure_ascii=False, indent=2))
