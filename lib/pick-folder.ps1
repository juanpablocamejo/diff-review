# STA folder picker. Uses the Vista IFileOpenDialog so it comes to the front
# instead of a WinForms owner window that sat on top of the dialog and ate clicks.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$csharp = @'
using System;
using System.Runtime.InteropServices;

public static class DiffReviewFolderPicker {
  const uint FOS_PICKFOLDERS = 0x00000020;
  const uint FOS_FORCEFILESYSTEM = 0x00000040;
  const uint FOS_PATHMUSTEXIST = 0x00000800;
  const uint SIGDN_FILESYSPATH = 0x80058000;
  const int HRESULT_CANCELLED = unchecked((int)0x800704C7);

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int dwProcessId);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
  class FileOpenDialog {}

  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes();
    void SetFileTypeIndex();
    void GetFileTypeIndex();
    void Advise();
    void Unadvise();
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder();
    void SetFolder();
    void GetFolder();
    void GetCurrentSelection();
    void SetFileName();
    void GetFileName();
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel();
    void SetFileNameLabel();
    void GetResult(out IShellItem item);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler();
    void GetParent();
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
  }

  // \u00ED = í so the title stays correct even if this .ps1 is read as ANSI.
  const string Title = "Eleg\u00ED un repositorio git";

  public static int Pick(out string path) {
    path = null;
    AllowSetForegroundWindow(-1);
    var dialog = (IFileOpenDialog)new FileOpenDialog();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    dialog.SetTitle(Title);

    var worker = new System.Threading.Thread(() => {
      for (var i = 0; i < 25; i++) {
        System.Threading.Thread.Sleep(80);
        var hwnd = FindWindow("#32770", Title);
        if (hwnd != IntPtr.Zero) {
          ShowWindow(hwnd, 9);
          SetForegroundWindow(hwnd);
          return;
        }
      }
    });
    worker.IsBackground = true;
    worker.Start();

    int hr = dialog.Show(GetForegroundWindow());
    if (hr == HRESULT_CANCELLED || hr != 0) return hr == HRESULT_CANCELLED ? 2 : hr;

    IShellItem item;
    dialog.GetResult(out item);
    item.GetDisplayName(SIGDN_FILESYSPATH, out path);
    return string.IsNullOrEmpty(path) ? 2 : 0;
  }
}
'@

Add-Type -TypeDefinition $csharp -Language CSharp | Out-Null

$path = $null
$code = [DiffReviewFolderPicker]::Pick([ref]$path)
if ($code -eq 0 -and $path) {
  Write-Output $path
  exit 0
}
exit 2
