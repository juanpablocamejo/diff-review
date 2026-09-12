import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Diálogo nativo de carpetas.
 * Windows: PowerShell DPI-aware (exit 2 = canceló; 1 = error → fallback).
 * Otros: @bindrs/rfd; si falla, shell (VBS / osascript / zenity).
 */
export async function pickFolder(): Promise<string | null> {
	if (platform() === 'win32') {
		try {
			return pickWindowsDpiAware();
		} catch (err) {
			console.warn(
				'[diff-review] picker DPI-aware falló, probando rfd/fallback:',
				err instanceof Error ? err.message : err
			);
		}
	}

	try {
		return pickWithRfdWorker();
	} catch (err) {
		console.warn(
			'[diff-review] @bindrs/rfd no disponible, usando fallback:',
			err instanceof Error ? err.message : err
		);
		return pickFolderFallback();
	}
}

function resolveNodeBin(): string {
	if (process.execPath && /node(\.exe)?$/i.test(process.execPath)) return process.execPath;
	return 'node';
}

function writeUtf8Bom(path: string, content: string) {
	writeFileSync(path, `\uFEFF${content}`, 'utf8');
}

/**
 * IFileOpenDialog nativo (Vista+) + DPI Per-Monitor V2 ANTES de cualquier UI.
 * Exit: 0 ok, 2 canceló, otro error → fallback.
 */
function pickWindowsDpiAware(): string | null {
	const dir = mkdtempSync(join(tmpdir(), 'diff-review-pick-'));
	const script = join(dir, 'pick.ps1');
	const outFile = join(dir, 'path.txt');
	try {
		// ASCII-only + BOM: PowerShell 5.1 sin BOM rompe encoding.
		writeUtf8Bom(
			script,
			`
$ErrorActionPreference = 'Stop'

# 1) DPI awareness ANTES de cargar WinForms / crear ventanas.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DiffReviewDpi {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static readonly IntPtr PerMonitorV2 = unchecked((IntPtr)(-4));
  public static void Enable() {
    try { SetThreadDpiAwarenessContext(PerMonitorV2); return; } catch { }
    try { SetProcessDpiAwareness(2); return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}
'@
[DiffReviewDpi]::Enable()

# 2) IFileOpenDialog COM (mismo dialogo nitido que el Explorer).
Add-Type @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
internal class FileOpenDialogRCW { }

[ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileDialog {
  [PreserveSig] int Show(IntPtr parent);
  void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
  void SetFileTypeIndex(uint iFileType);
  void GetFileTypeIndex(out uint piFileType);
  void Advise(IntPtr pfde, out uint pdwCookie);
  void Unadvise(uint dwCookie);
  void SetOptions(uint fos);
  void GetOptions(out uint pfos);
  void SetDefaultFolder(IShellItem psi);
  void SetFolder(IShellItem psi);
  void GetFolder(out IShellItem ppsi);
  void GetCurrentSelection(out IShellItem ppsi);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
  void GetResult(out IShellItem ppsi);
  void AddPlace(IShellItem psi, int fdap);
  void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
  void Close(int hr);
  void SetClientGuid(ref Guid guid);
  void ClearClientData();
  void SetFilter(IntPtr pFilter);
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItem {
  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
  void GetParent(out IShellItem ppsi);
  void GetDisplayName(uint sigdnName, out IntPtr ppszName);
  void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
  void Compare(IShellItem psi, uint hint, out int piOrder);
}

public static class DiffReviewFolderPicker {
  const uint FOS_PICKFOLDERS = 0x00000020;
  const uint FOS_FORCEFILESYSTEM = 0x00000040;
  const uint FOS_PATHMUSTEXIST = 0x00000800;
  const uint SIGDN_FILESYSPATH = 0x80058000;

  [DllImport("ole32.dll")]
  static extern void CoTaskMemFree(IntPtr pv);

  public static string Pick(string title) {
    var dialog = (IFileDialog)new FileOpenDialogRCW();
    uint options;
    dialog.GetOptions(out options);
    dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
    int hr = dialog.Show(IntPtr.Zero);
    if (hr != 0) return null; // cancel / error
    IShellItem item;
    dialog.GetResult(out item);
    IntPtr psz;
    item.GetDisplayName(SIGDN_FILESYSPATH, out psz);
    string path = Marshal.PtrToStringUni(psz);
    CoTaskMemFree(psz);
    return path;
  }
}
'@

$path = [DiffReviewFolderPicker]::Pick('Elegi el repositorio git')
if ([string]::IsNullOrWhiteSpace($path)) { exit 2 }
[System.IO.File]::WriteAllText(${JSON.stringify(outFile)}, $path)
exit 0
`.trim() + '\r\n'
		);

		const result = spawnSync(
			'powershell.exe',
			['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
			{
				encoding: 'utf8',
				windowsHide: false,
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 10 * 60 * 1000
			}
		);

		if (result.status === 2) return null;

		if (result.status !== 0) {
			const err = (result.stderr || result.stdout || result.error?.message || `exit ${result.status}`)
				.toString()
				.trim();
			throw new Error(err || 'powershell picker fallo');
		}

		if (!existsSync(outFile)) {
			throw new Error('powershell picker no escribio la ruta');
		}
		const path = readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim();
		if (!path) throw new Error('powershell picker devolvio ruta vacia');
		return path;
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

function pickWithRfdWorker(): string | null {
	const dir = mkdtempSync(join(tmpdir(), 'diff-review-rfd-'));
	const worker = join(dir, 'pick.mjs');
	const outFile = join(dir, 'path.txt');
	try {
		writeFileSync(
			worker,
			`import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const outFile = ${JSON.stringify(outFile)};

function findRfdIndex() {
  const seen = new Set();
  let dir = process.cwd();
  for (let i = 0; i < 16; i++) {
    if (seen.has(dir)) break;
    seen.add(dir);
    const indexJs = join(dir, 'node_modules', '@bindrs', 'rfd', 'index.js');
    if (existsSync(indexJs)) return indexJs;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('No se encontro @bindrs/rfd en node_modules');
}

const { AsyncFileDialog } = require(findRfdIndex());
const handle = await new AsyncFileDialog().setTitle('Elegi el repositorio git').pickFolder();
if (!handle) process.exit(2);
writeFileSync(outFile, handle.path(), 'utf8');
`,
			'utf8'
		);

		const result = spawnSync(resolveNodeBin(), [worker], {
			encoding: 'utf8',
			windowsHide: false,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 10 * 60 * 1000,
			cwd: process.cwd(),
			env: process.env
		});

		if (result.status === 2 || result.status === 1) return null;
		if (result.status !== 0) {
			const err = (result.stderr || result.stdout || result.error?.message || `exit ${result.status}`)
				.toString()
				.trim();
			throw new Error(err || 'worker rfd fallo');
		}
		if (!existsSync(outFile)) return null;
		const path = readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim();
		return path || null;
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

function pickFolderFallback(): string | null {
	const os = platform();
	if (os === 'win32') return pickWindowsVbs();
	if (os === 'darwin') return pickMac();
	return pickLinux();
}

function pickWindowsVbs(): string | null {
	const dir = mkdtempSync(join(tmpdir(), 'diff-review-pick-'));
	const vbs = join(dir, 'pick.vbs');
	const outFile = join(dir, 'path.txt');
	try {
		writeFileSync(
			vbs,
			[
				'Set shell = CreateObject("Shell.Application")',
				'Set folder = shell.BrowseForFolder(0, "Elegi el repositorio git", 0)',
				'If folder Is Nothing Then',
				'  WScript.Quit 1',
				'End If',
				'Set fso = CreateObject("Scripting.FileSystemObject")',
				`Set file = fso.CreateTextFile(${JSON.stringify(outFile)}, True, True)`,
				'file.Write folder.Self.Path',
				'file.Close'
			].join('\r\n'),
			'utf8'
		);

		const result = spawnSync('cscript.exe', ['//nologo', '//E:VBScript', vbs], {
			encoding: 'utf8',
			windowsHide: false,
			stdio: ['ignore', 'ignore', 'pipe'],
			timeout: 10 * 60 * 1000
		});

		if (result.status === 1) return null;
		if (result.status !== 0) {
			const err = (result.stderr || result.error?.message || `exit ${result.status}`).toString().trim();
			throw new Error(err || 'cscript fallo');
		}
		if (!existsSync(outFile)) return null;
		const buf = readFileSync(outFile);
		const path =
			buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
				? buf.subarray(2).toString('utf16le').trim()
				: buf.toString('utf8').replace(/^\uFEFF/, '').trim();
		return path || null;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/canceled|cancelled|abort/i.test(msg)) return null;
		throw new Error('No se pudo abrir el dialogo de carpetas: ' + msg);
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

function pickMac(): string | null {
	try {
		const out = execFileSync(
			'osascript',
			['-e', 'POSIX path of (choose folder with prompt "Elegi el repositorio git")'],
			{ encoding: 'utf8', timeout: 10 * 60 * 1000 }
		);
		return String(out || '')
			.trim()
			.replace(/\/$/, '');
	} catch (err) {
		const status = (err as { status?: number }).status;
		if (status === 1 || /User canceled|-128/i.test(String(err))) return null;
		throw new Error(
			'No se pudo abrir el dialogo de carpetas: ' + (err instanceof Error ? err.message : String(err))
		);
	}
}

function pickLinux(): string | null {
	try {
		const out = execFileSync(
			'zenity',
			['--file-selection', '--directory', '--title=Elegi el repositorio git'],
			{ encoding: 'utf8', timeout: 10 * 60 * 1000 }
		);
		return String(out || '').trim() || null;
	} catch (zenityErr) {
		const zStatus = (zenityErr as { status?: number }).status;
		if (zStatus === 1) return null;
		try {
			const out = execFileSync(
				'kdialog',
				['--getexistingdirectory', '.', 'Elegi el repositorio git'],
				{ encoding: 'utf8', timeout: 10 * 60 * 1000 }
			);
			return String(out || '').trim() || null;
		} catch (kErr) {
			const kStatus = (kErr as { status?: number }).status;
			if (kStatus === 1) return null;
			throw new Error(
				'No hay dialogo de carpetas disponible. Instala zenity o kdialog, o pega la ruta a mano.'
			);
		}
	}
}
