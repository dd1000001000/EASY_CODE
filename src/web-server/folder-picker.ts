import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// IFileDialog in folder mode uses the same Explorer-style common dialog as the
// Windows file picker, while returning a real filesystem directory.
const WINDOWS_FOLDER_PICKER = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
internal class FileOpenDialog { }

[ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem folder);
    void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName(out IntPtr name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItem {
    void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid riid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint nameType, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int result);
}

public static class EasyCodeFolderPicker {
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    public static string Pick() {
        IFileDialog dialog = (IFileDialog)new FileOpenDialog();
        try {
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | 0x20u | 0x40u); // PICKFOLDERS | FORCEFILESYSTEM
            dialog.SetTitle("Choose an EASY CODE project folder");
            // The browser initiated this request. Owning the dialog to its
            // foreground window keeps the native picker above that window.
            int result = dialog.Show(GetForegroundWindow());
            if (result == unchecked((int)0x800704C7)) return null; // User canceled
            if (result != 0) Marshal.ThrowExceptionForHR(result);
            IShellItem item;
            dialog.GetResult(out item);
            try {
                IntPtr name;
                item.GetDisplayName(0x80058000u, out name); // SIGDN_FILESYSPATH
                try { return Marshal.PtrToStringUni(name); }
                finally { Marshal.FreeCoTaskMem(name); }
            } finally { Marshal.ReleaseComObject(item); }
        } finally { Marshal.ReleaseComObject(dialog); }
    }
}
'@
try {
  $selected = [EasyCodeFolderPicker]::Pick()
  if ($selected) { [Console]::WriteLine($selected) }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}`;

/** A browser directory handle does not expose its absolute OS path; use the host's own picker. */
export async function pickLocalFolder(signal?: AbortSignal): Promise<string | undefined> {
  let program: string;
  let args: string[];
  if (process.platform === "win32") {
    program = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n" + WINDOWS_FOLDER_PICKER;
    args = ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  } else if (process.platform === "darwin") {
    program = "/usr/bin/osascript";
    args = ["-e", "POSIX path of (choose folder with prompt \"Choose an EASY CODE project folder\")"];
  } else if (existsSync("/usr/bin/zenity")) {
    program = "/usr/bin/zenity";
    args = ["--file-selection", "--directory", "--title=Choose an EASY CODE project folder"];
  } else if (existsSync("/usr/bin/kdialog")) {
    program = "/usr/bin/kdialog";
    args = ["--getexistingdirectory"];
  } else throw new Error("No system folder picker is available on this computer.");
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { windowsHide: true, shell: false, signal, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); if (output.length > 8192) child.kill(); });
    child.stderr?.on("data", (chunk: Buffer) => { errorOutput += chunk.toString("utf8"); if (errorOutput.length > 8192) child.kill(); });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve(output.trim() || undefined);
      else if (code === 1 && !errorOutput.trim()) resolve(undefined);
      else reject(new Error(`Folder picker failed${errorOutput.trim() ? `: ${errorOutput.trim()}` : "."}`));
    });
  });
}
