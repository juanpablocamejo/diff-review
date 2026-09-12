import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Diálogo nativo vía @bindrs/rfd en un proceso Node aparte (el addon no se puede
 * embutir en el bundle de SvelteKit). Fallback shell si falla.
 */
export async function pickFolder(): Promise<string | null> {
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
  throw new Error('No se encontró @bindrs/rfd en node_modules');
}

const { AsyncFileDialog } = require(findRfdIndex());
const handle = await new AsyncFileDialog().setTitle('Elegí el repositorio git').pickFolder();
if (!handle) process.exit(1);
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

		if (result.status === 1) return null;
		if (result.status !== 0) {
			const err = (result.stderr || result.stdout || result.error?.message || `exit ${result.status}`)
				.toString()
				.trim();
			throw new Error(err || 'worker rfd falló');
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
				'Set folder = shell.BrowseForFolder(0, "Elegí el repositorio git", 0)',
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
			throw new Error(err || 'cscript falló');
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
		throw new Error('No se pudo abrir el diálogo de carpetas: ' + msg);
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
			['-e', 'POSIX path of (choose folder with prompt "Elegí el repositorio git")'],
			{ encoding: 'utf8', timeout: 10 * 60 * 1000 }
		);
		return String(out || '')
			.trim()
			.replace(/\/$/, '');
	} catch (err) {
		const status = (err as { status?: number }).status;
		if (status === 1 || /User canceled|-128/i.test(String(err))) return null;
		throw new Error(
			'No se pudo abrir el diálogo de carpetas: ' + (err instanceof Error ? err.message : String(err))
		);
	}
}

function pickLinux(): string | null {
	try {
		const out = execFileSync(
			'zenity',
			['--file-selection', '--directory', '--title=Elegí el repositorio git'],
			{ encoding: 'utf8', timeout: 10 * 60 * 1000 }
		);
		return String(out || '').trim() || null;
	} catch (zenityErr) {
		const zStatus = (zenityErr as { status?: number }).status;
		if (zStatus === 1) return null;
		try {
			const out = execFileSync(
				'kdialog',
				['--getexistingdirectory', '.', 'Elegí el repositorio git'],
				{ encoding: 'utf8', timeout: 10 * 60 * 1000 }
			);
			return String(out || '').trim() || null;
		} catch (kErr) {
			const kStatus = (kErr as { status?: number }).status;
			if (kStatus === 1) return null;
			throw new Error(
				'No hay diálogo de carpetas disponible. Instalá zenity o kdialog, o pegá la ruta a mano.'
			);
		}
	}
}
