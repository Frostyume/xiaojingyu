"""Apply only DACL protection to a newly verified offline restore, no SACL/owner change."""
import csv
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import subprocess


def restrict(root):
    if os.name != "nt":
        raise RuntimeError("Windows restore ACL required")
    root = Path(root).resolve(strict=True)
    sid = next(csv.reader(subprocess.check_output(["whoami.exe","/user","/fo","csv","/nh"], text=True).strip().splitlines()))[1]
    if not sid.startswith("S-1-") or not all(char.isdigit() or char in "S-" for char in sid):
        raise ValueError("Current user SID unavailable")
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    convert = advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = [wintypes.LPCWSTR,wintypes.DWORD,ctypes.POINTER(ctypes.c_void_p),ctypes.c_void_p]
    convert.restype = wintypes.BOOL
    get_dacl = advapi.GetSecurityDescriptorDacl
    get_dacl.argtypes = [ctypes.c_void_p,ctypes.POINTER(wintypes.BOOL),ctypes.POINTER(ctypes.c_void_p),ctypes.POINTER(wintypes.BOOL)]
    get_dacl.restype = wintypes.BOOL
    set_named = advapi.SetNamedSecurityInfoW
    set_named.argtypes = [wintypes.LPWSTR,ctypes.c_int,wintypes.DWORD,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p]
    set_named.restype = wintypes.DWORD
    kernel.LocalFree.argtypes = [ctypes.c_void_p]; kernel.LocalFree.restype = ctypes.c_void_p
    descriptor = ctypes.c_void_p()
    if not convert("D:P(A;OICI;FA;;;" + sid + ")",1,ctypes.byref(descriptor),None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        dacl = ctypes.c_void_p(); present = wintypes.BOOL(); defaulted = wintypes.BOOL()
        if not get_dacl(descriptor,ctypes.byref(present),ctypes.byref(dacl),ctypes.byref(defaulted)) or not present:
            raise RuntimeError("Restore DACL unavailable")
        # DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION only.
        # Unlike Set-Acl this never requests the SACL SeSecurityPrivilege.
        error = set_named(str(root),1,0x80000004,None,None,dacl,None)
        if error:
            raise ctypes.WinError(error)
    finally:
        kernel.LocalFree(descriptor)
