"""Portable workspace archives. Caller must quiesce writers; never include credentials.

Restores to a new directory only. No application launch, network or account access.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tempfile
import zipfile

def digest(data):
    return hashlib.sha256(data).hexdigest()

def safe_name(name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or '\\' in name or ':' in name or any(x in {'', '.', '..'} for x in name.split('/')):
        raise ValueError('Unsafe archive path')
    if any(x.rstrip(' .') != x for x in p.parts):
        raise ValueError('Ambiguous Windows path')
    reserved = {'CON', 'PRN', 'AUX', 'NUL'} | {f'{x}{i}' for x in ('COM', 'LPT') for i in range(1, 10)}
    if any(x.split('.')[0].upper() in reserved for x in p.parts):
        raise ValueError('Reserved path')
    return p

def create(source, target):
    source, target = Path(source).resolve(), Path(target).resolve()
    if target.exists() or target.is_relative_to(source):
        raise ValueError('New archive outside workspace required')
    files = []
    for p in sorted(source.rglob('*')):
        if p.is_symlink() or (hasattr(p, 'is_junction') and p.is_junction()):
            raise ValueError('Links are not archived')
        if p.is_file():
            name = p.relative_to(source).as_posix()
            safe_name(name)
            files.append((p, name))
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix='.archive-', dir=target.parent)
    os.close(fd)
    tmp = Path(temp_name)
    entries = []
    try:
        with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
            for p, name in files:
                data = p.read_bytes()
                entries.append({'path': name, 'size': len(data), 'sha256': digest(data)})
                z.writestr('payload/' + name, data)
            z.writestr('manifest.json', json.dumps({'schema_version': 1, 'entries': entries}))
        # Detect changed content and added/deleted files during the copy.
        current = {p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file()}
        if current != {e['path'] for e in entries} or any(digest((source / e['path']).read_bytes()) != e['sha256'] for e in entries):
            raise ValueError('Workspace changed; quiesce writers and retry')
        # Windows rename refuses an existing target; publish the completed file.
        if os.name != 'nt':
            raise RuntimeError('Atomic no-overwrite publication currently validated on Windows only')
        tmp.rename(target)
        return {'files': len(entries), 'sha256': digest(target.read_bytes())}
    finally:
        if tmp.exists():
            tmp.unlink()

def restore(archive, destination):
    destination = Path(destination).absolute()
    if destination.exists():
        raise ValueError('Restore requires a new destination')
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.restore-', dir=destination.parent))
    try:
        with zipfile.ZipFile(archive) as z:
            names = z.namelist()
            if len(names) > 100000 or sum(i.file_size for i in z.infolist()) > 2 * 1024**3 or z.getinfo('manifest.json').file_size > 16 * 1024**2:
                raise ValueError('Archive exceeds restore limits')
            if len(names) != len(set(names)):
                raise ValueError('Duplicate entries')
            manifest = json.loads(z.read('manifest.json'))
            if manifest.get('schema_version') != 1:
                raise ValueError('Unknown schema')
            entries = manifest['entries']
            expected = {'manifest.json'}
            folded = set()
            for e in entries:
                p = safe_name(e['path'])
                if str(p).casefold() in folded:
                    raise ValueError('Case collision')
                folded.add(str(p).casefold())
                name = 'payload/' + str(p)
                expected.add(name)
                data = z.read(name)
                if len(data) != e['size'] or digest(data) != e['sha256']:
                    raise ValueError('Integrity mismatch')
                out = stage.joinpath(*p.parts)
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(data)
            if set(names) != expected:
                raise ValueError('Unexpected entries')
        stage.rename(destination)
        return {'files': len(entries), 'verified': True}
    finally:
        if stage.exists():
            shutil.rmtree(stage)
