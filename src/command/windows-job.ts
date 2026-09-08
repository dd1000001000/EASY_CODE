import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

// This trusted helper is outside the job. The worker waits for assignment before
// launching any sandbox/target process. No breakaway flags are granted.
const SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class ECJob {
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr p, uint l);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr j, uint c);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j, int c, out Accounting p, uint l, IntPtr r);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int p);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool member);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr p, uint c);
 [DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)] static extern bool QueryIds(IntPtr j, int c, IntPtr p, uint l, IntPtr r);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr p);
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long a,b; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic basic; public IO io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d; public uint faults,total,active,terminated; }
 public static void Run(int pid) {
  IntPtr job=CreateJobObject(IntPtr.Zero,null), process=IntPtr.Zero, buffer=IntPtr.Zero;
  if(job==IntPtr.Zero) throw new Exception("Cannot create command Job Object");
  try {
   Limits limits=new Limits(); limits.basic.flags=0x2000;
   int size=Marshal.SizeOf(typeof(Limits)); buffer=Marshal.AllocHGlobal(size); Marshal.StructureToPtr(limits,buffer,false);
   if(!SetInformationJobObject(job,9,buffer,(uint)size)) throw new Exception("Cannot set kill-on-close");
   process=OpenProcess(0x101,false,pid);
   if(process==IntPtr.Zero || !AssignProcessToJobObject(job,process)) throw new Exception("Cannot contain worker in command Job Object");
   Console.WriteLine("READY"); Console.Out.Flush();
   string line;
   while((line=Console.ReadLine())=="QUIESCE") {
    IntPtr ids=Marshal.AllocHGlobal(65536);
    try {
     bool quiet=false;
     for(int attempt=0;attempt<200;attempt++) {
      if(!QueryIds(job,3,ids,65536,IntPtr.Zero)) throw new Exception("Cannot enumerate contained descendants");
      int count=Marshal.ReadInt32(ids,4); bool other=false;
      if(count<0 || count>(65536-8)/IntPtr.Size) throw new Exception("Invalid job process count");
      for(int n=0;n<count;n++) {
       long memberPid=Marshal.ReadIntPtr(ids,8+n*IntPtr.Size).ToInt64();
       if(memberPid==pid) continue;
       other=true; IntPtr child=OpenProcess(0x1001,false,checked((int)memberPid));
       if(child==IntPtr.Zero) continue;
       try { bool member;
        if(!IsProcessInJob(child,job,out member)) throw new Exception("Cannot verify job membership");
        if(member && !TerminateProcess(child,1)) throw new Exception("Cannot terminate contained descendant");
       } finally { CloseHandle(child); }
      }
      if(!other) {quiet=true;break;}
      Thread.Sleep(25);
     }
     if(!quiet) throw new Exception("Descendants remain before ACL cleanup");
     Console.WriteLine("QUIET");Console.Out.Flush();
    } finally { Marshal.FreeHGlobal(ids); }
   }
   if(!TerminateJobObject(job,1)) throw new Exception("Cannot terminate command Job Object");
   for(int i=0;i<200;i++) { Accounting state;
    if(!QueryInformationJobObject(job,1,out state,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new Exception("Cannot verify process tree");
    if(state.active==0) { Console.WriteLine("EMPTY"); Console.Out.Flush(); return; }
    Thread.Sleep(25);
   }
   throw new Exception("Command Job Object is not empty");
  } finally { if(buffer!=IntPtr.Zero) Marshal.FreeHGlobal(buffer); if(process!=IntPtr.Zero) CloseHandle(process); CloseHandle(job); }
 }
}`;

export interface WindowsCommandJob {
  quiesce(): Promise<void>;
  stop(): Promise<{ confirmed: boolean; method: string }>;
}

export async function containWindowsWorker(pid: number): Promise<WindowsCommandJob> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid worker PID");
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${SOURCE}\n'@; [ECJob]::Run(${pid})`;
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child: ChildProcessWithoutNullStreams = spawn(executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"], cwd: path.dirname(executable),
      env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: path.dirname(executable) } });
  let output = "";
  let empty = false;
  let quiescing: Promise<void> | undefined;
  let stopping: Promise<{ confirmed: boolean; method: string }> | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let quietResolve: (() => void) | undefined;
  let quietReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closed = new Promise<boolean>((resolve) => {
    child.once("error", (error) => { readyReject(error); quietReject?.(error); resolve(false); });
    child.once("close", (code) => { const error=new Error("Windows job supervisor exited");readyReject(error);quietReject?.(error);resolve(code === 0 && empty); });
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-1024);
    let newline: number;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline).trim(); output = output.slice(newline + 1);
      if (line === "READY") readyResolve();
      if (line === "QUIET") quietResolve?.();
      if (line === "EMPTY") empty = true;
    }
  });
  child.stdin.on("error", error => { quietReject?.(error); });
  child.stderr.resume();
  const timer = setTimeout(() => { readyReject(new Error("Windows Job Object setup timed out")); child.kill(); }, 15000);
  try { await ready; } finally { clearTimeout(timer); }
  return {
    quiesce() {
      // Cancellation and worker cleanup may request quiescence concurrently.
      // Share only the in-flight operation, never reuse an old QUIET record.
      return quiescing ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await new Promise<void>((resolve,reject)=>{
          quietResolve=resolve;quietReject=reject;
          timer=setTimeout(()=>reject(new Error("Descendant cleanup was not confirmed")),7000);
          child.stdin.write("QUIESCE\n");
        });
      } finally { if(timer)clearTimeout(timer);quietResolve=undefined;quietReject=undefined; quiescing=undefined; }
      })();
    },
    stop() {
    return stopping ??= (async () => {
      child.stdin.end("STOP\n");
      let timeout: NodeJS.Timeout | undefined;
      const confirmed = await Promise.race([closed, new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => { child.kill(); resolve(false); }, 7000);
      })]);
      if (timeout) clearTimeout(timeout);
      return { confirmed, method: "windows-job-object" };
    })();
  } };
}
