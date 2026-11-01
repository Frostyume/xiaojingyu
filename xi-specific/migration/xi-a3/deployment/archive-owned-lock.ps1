$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$lockPath=[IO.Path]::GetFullPath([string]$request.lockPath)
$archivePath=[IO.Path]::GetFullPath([string]$request.archivePath)
if([IO.Path]::GetDirectoryName($lockPath) -ne [IO.Path]::GetDirectoryName($archivePath) -or [IO.Path]::GetFileName($archivePath) -notlike ([IO.Path]::GetFileName($lockPath)+'.abandoned.*.json') -or $request.expectedSha256 -notmatch '^[a-f0-9]{64}$'){throw 'invalid-archive-request'}
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class XiOwnedLockFile {
 [StructLayout(LayoutKind.Sequential)] public struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation; public System.Runtime.InteropServices.ComTypes.FILETIME Access; public System.Runtime.InteropServices.ComTypes.FILETIME Write; public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow; }
 [StructLayout(LayoutKind.Sequential)] struct Disposition { public int DeleteFile; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int cls,ref Disposition info,uint size);
 public static SafeFileHandle Open(string path) { var h=CreateFileW(path,0x80010000,0,IntPtr.Zero,3,0x80,IntPtr.Zero); if(h.IsInvalid) throw new IOException("exclusive-lock-open-failed"); return h; }
 public static Info Inspect(SafeFileHandle handle) { Info info; if(!GetFileInformationByHandle(handle,out info)) throw new IOException("lock-info-failed"); return info; }
 public static string FileId(Info info) { return (((ulong)info.IndexHigh<<32)|info.IndexLow).ToString(); }
 public static void MarkDelete(SafeFileHandle handle) { var d=new Disposition {DeleteFile=1}; if(!SetFileInformationByHandle(handle,4,ref d,4)) throw new IOException("lock-delete-by-handle-failed"); }
}
'@
$handle=$null;$stream=$null;$archive=$null
try{
 $handle=[XiOwnedLockFile]::Open($lockPath)
 $info=[XiOwnedLockFile]::Inspect($handle)
 if($info.Links -ne 1 -or ($info.Attributes -band 0x400) -or [XiOwnedLockFile]::FileId($info) -ne [string]$request.expectedInode){throw 'lock-file-identity-changed'}
 $stream=New-Object IO.FileStream($handle,[IO.FileAccess]::Read)
 if($stream.Length -gt 1048576){throw 'lock-size-limit'}
 $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
 while($offset -lt $bytes.Length){$count=$stream.Read($bytes,$offset,$bytes.Length-$offset);if($count -le 0){throw 'lock-short-read'};$offset+=$count}
 $sha=[Security.Cryptography.SHA256]::Create()
 try{$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
 if($hash -ne $request.expectedSha256){throw 'lock-content-changed'}
 $archive=New-Object IO.FileStream($archivePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 $archive.Write($bytes,0,$bytes.Length);$archive.Flush($true);$archive.Dispose();$archive=$null
 [XiOwnedLockFile]::MarkDelete($handle) # Exact exclusively held file; never unlink a path after an unlocked check.
 $stream.Dispose();$stream=$null;$handle=$null
 @{format='xi-owned-lock-archive-v1';archived=$true;sha256=$hash;archivePath=$archivePath} | ConvertTo-Json -Compress
}finally{if($archive){$archive.Dispose()};if($stream){$stream.Dispose()}elseif($handle){$handle.Dispose()}}
