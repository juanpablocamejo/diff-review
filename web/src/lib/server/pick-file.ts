import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

export type PickedFile = { path: string; text: string };

/**
 * Diálogo nativo para elegir un JSON. Si `defaultDir` existe, abre ahí.
 */
export async function pickJsonFile(defaultDir?: string): Promise<PickedFile | null> {
	const startDir = defaultDir && existsSync(defaultDir) ? defaultDir : '';

	if (platform() === 'win32') {
		try {
			return pickWindowsJson(startDir);
		} catch (err) {
			console.warn(
				'[diff-review] picker JSON Windows falló, probando rfd/fallback:',
				err instanceof Error ? err.message : err
			);
		}
	}

	try {
		return pickJsonWithRfd(startDir);
	} catch (err) {
		console.warn(
			'[diff-review] @bindrs/rfd JSON no disponible, usando fallback:',
			err instanceof Error ? err.message : err
		);
		return pickJsonFallback(startDir);
	}
}

function resolveNodeBin(): string {
	if (process.execPath && /node(\.exe)?$/i.test(process.execPath)) return process.execPath;
	return 'node';
}

function writeUtf8Bom(path: string, content: string) {
	writeFileSync(path, `\uFEFF${content}`, 'utf8');
}

function readPicked(path: string): PickedFile | null {
	if (!path || !existsSync(path)) return null;
	return { path, text: readFileSync(path, 'utf8') };
}

/** OpenFileDialog con InitialDirectory (DPI: mejor esfuerzo). */
function pickWindowsJson(startDir: string): PickedFile | null {
	const dir = mkdtempSync(join(tmpdir(), 'diff-review-pick-json-'));
	const script = join(dir, 'pick.ps1');
	const outFile = join(dir, 'path.txt');
	try {
		writeUtf8Bom(
			script,
			`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DiffReviewDpi {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  public static readonly IntPtr PerMonitorV2 = unchecked((IntPtr)(-4));
  public static void Enable() {
    try { SetThreadDpiAwarenessContext(PerMonitorV2); } catch { }
  }
}
'@
  [DiffReviewDpi]::Enable()
} catch {}

$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = 'Elegi el JSON de review'
$dlg.Filter = 'JSON (*.json)|*.json|Todos (*.*)|*.*'
$dlg.FilterIndex = 1
$dlg.CheckFileExists = $true
$dlg.Multiselect = $false
$dir = ${JSON.stringify(startDir)}
if ($dir -and (Test-Path -LiteralPath $dir)) { $dlg.InitialDirectory = $dir }
if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }
[System.IO.File]::WriteAllText(${JSON.stringify(outFile)}, $dlg.FileName)
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
			throw new Error(err || 'powershell json picker fallo');
		}
		if (!existsSync(outFile)) throw new Error('powershell json picker no escribio la ruta');
		const path = readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim();
		const picked = readPicked(path);
		if (!picked) throw new Error('powershell json picker devolvio ruta vacia');
		return picked;
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

function pickJsonWithRfd(startDir: string): PickedFile | null {
	const dir = mkdtempSync(join(tmpdir(), 'diff-review-rfd-json-'));
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
const startDir = ${JSON.stringify(startDir)};

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
let dlg = new AsyncFileDialog()
  .setTitle('Elegi el JSON de review')
  .addFilter('JSON', ['json']);
if (startDir) dlg = dlg.setDirectory(startDir);
const handle = await dlg.pickFile();
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
			throw new Error(err || 'worker rfd json fallo');
		}
		if (!existsSync(outFile)) return null;
		const path = readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim();
		return readPicked(path);
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

function pickJsonFallback(startDir: string): PickedFile | null {
	const os = platform();
	if (os === 'darwin') return pickMacJson(startDir);
	if (os === 'linux') return pickLinuxJson(startDir);
	return null;
}

function pickMacJson(startDir: string): PickedFile | null {
	try {
		const args = startDir
			? [
					'-e',
					`POSIX path of (choose file with prompt "Elegi el JSON de review" of type {"public.json","json"} default location POSIX file ${JSON.stringify(startDir + '/')})`
				]
			: [
					'-e',
					'POSIX path of (choose file with prompt "Elegi el JSON de review" of type {"public.json","json"})'
				];
		const out = execFileSync('osascript', args, { encoding: 'utf8', timeout: 10 * 60 * 1000 });
		return readPicked(
			String(out || '')
				.trim()
				.replace(/\/$/, '')
		);
	} catch (err) {
		const status = (err as { status?: number }).status;
		if (status === 1 || /User canceled|-128/i.test(String(err))) return null;
		throw new Error(
			'No se pudo abrir el dialogo de archivo: ' + (err instanceof Error ? err.message : String(err))
		);
	}
}

function pickLinuxJson(startDir: string): PickedFile | null {
	try {
		const args = ['--file-selection', '--title=Elegi el JSON de review', '--file-filter=*.json'];
		if (startDir) args.push(`--filename=${join(startDir, '/')}`);
		const out = execFileSync('zenity', args, { encoding: 'utf8', timeout: 10 * 60 * 1000 });
		return readPicked(String(out || '').trim());
	} catch (zenityErr) {
		const zStatus = (zenityErr as { status?: number }).status;
		if (zStatus === 1) return null;
		try {
			const args = startDir
				? ['--getopenfilename', startDir, '*.json']
				: ['--getopenfilename', '.', '*.json'];
			const out = execFileSync('kdialog', args, { encoding: 'utf8', timeout: 10 * 60 * 1000 });
			return readPicked(String(out || '').trim());
		} catch (kErr) {
			const kStatus = (kErr as { status?: number }).status;
			if (kStatus === 1) return null;
			throw new Error(
				'No hay dialogo de archivos disponible. Instala zenity o kdialog, o arrastra el JSON.'
			);
		}
	}
}
