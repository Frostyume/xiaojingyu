"""Stage only pinned interpreter components and standard library. Takes no repo input."""
import hashlib
import os
from pathlib import Path
import shutil
import sys
import zipfile

base = Path(sys.base_prefix).resolve()
target = Path(sys.argv[1]).resolve(strict=True)
extensions = ["_decimal.pyd", "_sqlite3.pyd", "sqlite3.dll", "_bz2.pyd", "_lzma.pyd",
              "_elementtree.pyd", "_queue.pyd", "_uuid.pyd", "_zoneinfo.pyd", "pyexpat.pyd",
              "select.pyd", "_socket.pyd", "unicodedata.pyd"]
excluded = {"site-packages", "__pycache__", "test", "tests", "idlelib", "tkinter",
            "ensurepip", "venv", "turtledemo"}

def checked(p):
    if p.resolve(strict=True) != p or p.is_junction() or p.is_symlink():
        raise RuntimeError("Unexpected interpreter component path")
    return p

for name in ["python.exe","python3.dll","python313.dll","vcruntime140.dll","vcruntime140_1.dll"]:
    shutil.copyfile(checked(base/name), target/name)
(target/"DLLs").mkdir()
for name in extensions:
    shutil.copyfile(checked(base/"DLLs"/name), target/"DLLs"/name)
lib = checked(base/"Lib")
with zipfile.ZipFile(target/"python313.zip", "x") as archive:
    for directory, dirs, names in os.walk(lib):
        dirs[:] = sorted(n for n in dirs if n not in excluded)
        for child in dirs:
            checked(Path(directory)/child)
        for name in sorted(names):
            if name.endswith(".py"):
                p = checked(Path(directory)/name)
                archive.writestr(zipfile.ZipInfo(p.relative_to(lib).as_posix()), p.read_bytes())
(target/"python313._pth").write_bytes(b"python313.zip\nDLLs\n.\n")
digest = hashlib.sha256()
for p in sorted(target.rglob("*")):
    if p.is_file():
        digest.update(p.relative_to(target).as_posix().encode() + b"\0" + hashlib.sha256(p.read_bytes()).digest())
print(digest.hexdigest())
