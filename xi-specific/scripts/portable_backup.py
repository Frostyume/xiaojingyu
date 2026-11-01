"""Authenticated, streaming file envelope. Does not decrypt inner DPAPI data.

Format v1: magic(8), random HKDF salt(32), nonce(12), plaintext length(8),
ciphertext(length), GCM tag(16). Header is authenticated as AAD.
No archive extraction, network access, password KDF or key logging.
"""
import argparse
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import csv
import subprocess
import uuid
from contextlib import contextmanager

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAGIC = b'PAVLT01\x00'
HEADER = struct.Struct('>8s32s12sQ')
CHUNK = 1024 * 1024
# Stay below GCM's per-invocation plaintext limit (2^39 - 256 bits).
MAX_BYTES = 16 * 1024 ** 3


def private_directory(parent):
    if os.name != 'nt':
        return Path(tempfile.mkdtemp(prefix='.vault-partial-', dir=parent))
    import ctypes
    from ctypes import wintypes
    # Create with the restrictive descriptor atomically, before any secret exists.
    sid = next(csv.reader(subprocess.check_output(
        ['whoami.exe', '/user', '/fo', 'csv', '/nh'], text=True).strip().splitlines()))[1]
    if not sid.startswith('S-1-') or not all(c.isdigit() or c in 'S-' for c in sid):
        raise ValueError('Invalid current-user SID')
    class SecurityAttributes(ctypes.Structure):
        _fields_ = [('length', wintypes.DWORD), ('descriptor', ctypes.c_void_p),
                    ('inherit', wintypes.BOOL)]
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetVolumePathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetVolumePathNameW.restype = wintypes.BOOL
    kernel.GetVolumeInformationW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetVolumeInformationW.restype = wintypes.BOOL
    volume = ctypes.create_unicode_buffer(32768)
    flags = wintypes.DWORD()
    if not kernel.GetVolumePathNameW(str(parent), volume, len(volume)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.GetVolumeInformationW(volume.value, None, 0, None, None, ctypes.byref(flags), None, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    if not flags.value & 0x8:  # FILE_PERSISTENT_ACLS; FAT/exFAT cannot protect staging.
        raise OSError('Destination filesystem must support persistent ACLs')
    convert = advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    convert.restype = wintypes.BOOL
    kernel.CreateDirectoryW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(SecurityAttributes)]
    kernel.CreateDirectoryW.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    descriptor = ctypes.c_void_p()
    if not convert(f'D:P(A;OICI;FA;;;{sid})', 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    path = parent / ('.vault-partial-' + uuid.uuid4().hex)
    try:
        attrs = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
        if not kernel.CreateDirectoryW(str(path), ctypes.byref(attrs)):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.LocalFree(descriptor)
    return path


@contextmanager
def private_output(destination):
    destination = Path(destination).absolute()
    parent = destination.parent.resolve(strict=True)
    destination = parent / destination.name
    if destination.exists() or destination.is_symlink():
        raise FileExistsError('Destination must be a new file')
    staging = private_directory(parent)
    temp = staging / 'payload'
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as output:
            yield output
            output.flush()
            os.fsync(output.fileno())
        # Hardlinks retain the file ACL and fail if the target already exists.
        os.link(temp, destination)
    finally:
        temp.unlink(missing_ok=True)
        staging.rmdir()


def decode_key(value):
    key = base64.b64decode(value.strip(), validate=True)
    if len(key) != 32:
        raise ValueError('Recovery key must contain 32 random bytes')
    return key


def derive(master, salt):
    if len(master) != 32:
        raise ValueError('Invalid recovery key length')
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt,
                info=b'personal-agent-file-envelope-v1').derive(master)


def transform(source, destination, master, decrypt=False):
    source = Path(source).resolve(strict=True)
    destination = Path(destination).absolute()
    parent = destination.parent.resolve(strict=True)
    destination = parent / destination.name
    if source == destination or destination.exists() or destination.is_symlink():
        raise FileExistsError('Destination must be a new file')
    with source.open('rb') as incoming:
        source_size = os.fstat(incoming.fileno()).st_size
        if decrypt:
            header = incoming.read(HEADER.size)
            if len(header) != HEADER.size:
                raise ValueError('Truncated header')
            magic, salt, nonce, length = HEADER.unpack(header)
            if magic != MAGIC or length > MAX_BYTES or source_size != HEADER.size + length + 16:
                raise ValueError('Invalid format, size or trailing data')
            incoming.seek(-16, os.SEEK_END)
            tag = incoming.read(16)
            incoming.seek(HEADER.size)
            context = Cipher(algorithms.AES(derive(master, salt)), modes.GCM(nonce, tag)).decryptor()
        else:
            length = source_size
            if length > MAX_BYTES:
                raise ValueError('Source exceeds supported size')
            salt, nonce = os.urandom(32), os.urandom(12)
            header = HEADER.pack(MAGIC, salt, nonce, length)
            context = Cipher(algorithms.AES(derive(master, salt)), modes.GCM(nonce)).encryptor()
        context.authenticate_additional_data(header)
        digest = hashlib.sha256()
        with private_output(destination) as output:
            if not decrypt:
                output.write(header)
            remaining = length
            while remaining:
                data = incoming.read(min(CHUNK, remaining))
                if not data:
                    raise ValueError('Source changed or truncated during processing')
                remaining -= len(data)
                result = context.update(data)
                digest.update(result if decrypt else data)
                output.write(result)
            output.write(context.finalize())  # InvalidTag never promotes a partial plaintext.
            if not decrypt:
                if incoming.read(1):
                    raise ValueError('Source grew during processing')
                output.write(context.tag)
    return {'status': 'decrypted_and_authenticated' if decrypt else 'encrypted',
            'plaintext_bytes': length, 'plaintext_sha256': digest.hexdigest(),
            'format': 'PAVLT01', 'inner_dpapi_migrated': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    keygen = commands.add_parser('keygen')
    keygen.add_argument('--key-file', type=Path, required=True)
    for name in ('encrypt', 'decrypt'):
        command = commands.add_parser(name)
        command.add_argument('--source', type=Path, required=True)
        command.add_argument('--output', type=Path, required=True)
        command.add_argument('--key-file', type=Path)
    args = parser.parse_args()
    if args.command == 'keygen':
        if args.key_file.suffix != '.key':
            parser.error('Use a .key file outside backup/sync folders')
        with private_output(args.key_file) as output:
            output.write(base64.b64encode(os.urandom(32)) + b'\n')
        print(json.dumps({'status': 'key_created_locally', 'independent_custody_verified': False}))
        return
    value = args.key_file.read_bytes() if args.key_file else getpass.getpass('Recovery key (hidden): ').encode('ascii')
    result = transform(args.source, args.output, decode_key(value), decrypt=args.command == 'decrypt')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
