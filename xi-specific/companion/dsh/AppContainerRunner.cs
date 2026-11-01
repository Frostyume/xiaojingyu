// Trusted offline runner. No model inputs become host commands or environment.
// Microsoft AppContainer token + a non-breakaway kill-on-close Job Object.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Security.AccessControl;
using System.Security.Principal;

public class AppContainerRunner {
 [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid,Capabilities; public uint CapabilityCount,Reserved; }
 [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved,lpDesktop,lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public short wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
 [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public int dwProcessId,dwThreadId; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long perProcess,perJob; public uint flags; public UIntPtr minWs,maxWs; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr capabilities,uint count,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
 [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED_LIMIT limits,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,uint size,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,ref SECURITY_ATTRIBUTES sa,uint disposition,uint flags,IntPtr template);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int required);
 static volatile bool parentClosed=false;
 static void Check(bool ok,string step){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),step);}
 static IntPtr Allocate<T>(T value){IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T)));Marshal.StructureToPtr(value,p,false);return p;}
 static string Q(string value){return "\""+value.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r","\\r").Replace("\n","\\n")+"\"";}
 static void Emit(string json){Console.WriteLine(json);Console.Out.Flush();}
 static IntPtr FileHandle(string path,uint access,uint disposition){var sa=new SECURITY_ATTRIBUTES {nLength=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),bInheritHandle=true};IntPtr h=CreateFileW(path,access,3,ref sa,disposition,0x80,IntPtr.Zero);if(h==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error(),"stdio file");return h;}
 static void DrainJob(IntPtr job){IntPtr data=Marshal.AllocHGlobal(48);try{for(int i=0;i<100;i++){uint returned;Check(QueryInformationJobObject(job,1,data,48,out returned),"job drain query");if(Marshal.ReadInt32(data,40)==0)return;Thread.Sleep(50);}throw new Exception("Job process tree did not finish draining");}finally{Marshal.FreeHGlobal(data);}}
 static void TokenCheck(IntPtr process){IntPtr token=IntPtr.Zero,data=Marshal.AllocHGlobal(16);try{Check(OpenProcessToken(process,8,out token),"open child token");int size;Check(GetTokenInformation(token,29,data,16,out size),"is appcontainer");if(Marshal.ReadInt32(data)!=1)throw new Exception("Child token is not AppContainer");GetTokenInformation(token,30,IntPtr.Zero,0,out size);IntPtr caps=Marshal.AllocHGlobal(Math.Max(size,8));try{Check(GetTokenInformation(token,30,caps,Math.Max(size,8),out size),"capabilities");if(Marshal.ReadInt32(caps)!=0)throw new Exception("Unexpected AppContainer capabilities");}finally{Marshal.FreeHGlobal(caps);}}finally{Marshal.FreeHGlobal(data);if(token!=IntPtr.Zero)CloseHandle(token);}}
 public static int Main(string[] args){
  IntPtr sid=IntPtr.Zero,attrs=IntPtr.Zero,security=IntPtr.Zero,handles=IntPtr.Zero,environment=IntPtr.Zero,job=IntPtr.Zero,stdin=IntPtr.Zero,stdout=IntPtr.Zero,stderr=IntPtr.Zero;
  PROCESS_INFORMATION process=new PROCESS_INFORMATION();string moniker="PersonalAgent.Whale.Offline."+Guid.NewGuid().ToString("N");bool created=false,assigned=false,cancelled=false;var start=DateTime.UtcNow;
  try{
   if(args.Length!=4)throw new Exception("Usage: runner workspace node entrypoint cancel-file");
   string work=Path.GetFullPath(args[0]),node=Path.GetFullPath(args[1]),entry=args[2],cancel=Path.GetFullPath(args[3]);
   if(!Directory.Exists(work)||!File.Exists(node)||!File.Exists(Path.Combine(work,entry))||entry.Contains("..")||Path.IsPathRooted(entry)||entry.IndexOf('"')>=0)throw new Exception("Invalid pinned execution input");
   // No writable ancestor/global ACL changes: only this fresh disposable project root.
   int hr=CreateAppContainerProfile(moniker,moniker,"Ephemeral offline whale workshop; no capabilities",IntPtr.Zero,0,out sid);if(hr<0)Marshal.ThrowExceptionForHR(hr);created=true;
   var acl=Directory.GetAccessControl(work);acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.SetAccessControl(work,acl);
   string runtime=Path.GetDirectoryName(node);var runtimeAcl=Directory.GetAccessControl(runtime);runtimeAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.ReadAndExecute,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.SetAccessControl(runtime,runtimeAcl);
   Directory.CreateDirectory(Path.Combine(work,".tmp"));Directory.CreateDirectory(Path.Combine(work,".profile"));
   IntPtr attrSize=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref attrSize);attrs=Marshal.AllocHGlobal(attrSize);Check(InitializeProcThreadAttributeList(attrs,2,0,ref attrSize),"init attributes");
   security=Allocate(new SECURITY_CAPABILITIES {AppContainerSid=sid,Capabilities=IntPtr.Zero,CapabilityCount=0});Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20009),security,new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))),IntPtr.Zero,IntPtr.Zero),"AppContainer attribute");
   stdin=FileHandle("NUL",0x80000000,3);stdout=FileHandle(Path.Combine(work,".stdout.log"),0x40000000,2);stderr=FileHandle(Path.Combine(work,".stderr.log"),0x40000000,2);
   handles=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handles,0,stdin);Marshal.WriteIntPtr(handles,IntPtr.Size,stdout);Marshal.WriteIntPtr(handles,IntPtr.Size*2,stderr);
   Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"stdio handle list");
   var startup=new STARTUPINFOEX();startup.StartupInfo.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));startup.StartupInfo.dwFlags=0x100;startup.StartupInfo.hStdInput=stdin;startup.StartupInfo.hStdOutput=stdout;startup.StartupInfo.hStdError=stderr;startup.lpAttributeList=attrs;
   string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
   string block="NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main\0LOCALAPPDATA="+Path.Combine(work,".profile")+"\0PATH="+Path.GetDirectoryName(node)+";"+windows+"\\System32\0SystemRoot="+windows+"\0TEMP="+Path.Combine(work,".tmp")+"\0TMP="+Path.Combine(work,".tmp")+"\0USERPROFILE="+Path.Combine(work,".profile")+"\0windir="+windows+"\0\0";environment=Marshal.StringToHGlobalUni(block);
   job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero,"create job");var limits=new EXTENDED_LIMIT();limits.basic.flags=0x2000|0x200|8;limits.basic.active=16;limits.jobMemory=new UIntPtr(1024UL*1024*1024);Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))),"job limits");
   Check(CreateProcessW(node,new StringBuilder("\""+node+"\" \""+entry+"\""),IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|4|0x08000000,environment,work,ref startup,out process),"create suspended AppContainer");
   Check(AssignProcessToJobObject(job,process.hProcess),"assign job before start");assigned=true;TokenCheck(process.hProcess);
   Emit("{\"event\":\"started\",\"pid\":"+process.dwProcessId+",\"appcontainer\":true,\"capabilities\":0,\"kill_tree_on_close\":true}");
   new Thread(delegate(){try{while(Console.ReadLine()!=null){}}catch{}parentClosed=true;}){IsBackground=true}.Start();
   Check(ResumeThread(process.hThread)!=0xffffffff,"resume");
   while(WaitForSingleObject(process.hProcess,100)==258){if(parentClosed||File.Exists(cancel)){cancelled=true;Check(TerminateJobObject(job,1223),"cancel tree");break;}}
   WaitForSingleObject(process.hProcess,5000);uint code;Check(GetExitCodeProcess(process.hProcess,out code),"exit code");
   // Always terminate surviving children even after the main script exits successfully.
   Check(TerminateJobObject(job,cancelled?1223u:0u),"drain child tree");DrainJob(job);
   Emit("{\"event\":\"finished\",\"pid\":"+process.dwProcessId+",\"exit_code\":"+code+",\"cancelled\":"+(cancelled?"true":"false")+",\"appcontainer\":true,\"capabilities\":0,\"duration_ms\":"+(long)(DateTime.UtcNow-start).TotalMilliseconds+"}");
   return cancelled?2:code==0?0:1;
  }catch(Exception error){Emit("{\"event\":\"runner-error\",\"error\":"+Q(error.Message)+"}");return 3;}
  finally{
   if(job!=IntPtr.Zero){TerminateJobObject(job,1223);CloseHandle(job);}else if(process.hProcess!=IntPtr.Zero)TerminateProcess(process.hProcess,1223);
   if(!assigned&&process.hProcess!=IntPtr.Zero)TerminateProcess(process.hProcess,1223);
   foreach(IntPtr handle in new IntPtr[]{process.hThread,process.hProcess,stdin,stdout,stderr})if(handle!=IntPtr.Zero&&handle!=new IntPtr(-1))CloseHandle(handle);
   if(attrs!=IntPtr.Zero){DeleteProcThreadAttributeList(attrs);Marshal.FreeHGlobal(attrs);}foreach(IntPtr p in new IntPtr[]{security,handles,environment})if(p!=IntPtr.Zero)Marshal.FreeHGlobal(p);
   if(sid!=IntPtr.Zero)FreeSid(sid);if(created){int result=DeleteAppContainerProfile(moniker);Emit("{\"event\":\"profile-cleanup\",\"hresult\":"+result+"}");}
  }
 }
}
