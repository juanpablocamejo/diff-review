import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Tiempo máximo para que el navegador imprima el PDF. */
const TIMEOUT_MS = 60_000;

function candidates(): string[] {
	const env = process.env.DIFF_REVIEW_CHROME;
	const list: string[] = env ? [env] : [];
	if (process.platform === 'win32') {
		const roots = [
			process.env['PROGRAMFILES'],
			process.env['PROGRAMFILES(X86)'],
			process.env['LOCALAPPDATA']
		].filter(Boolean) as string[];
		for (const root of roots) {
			list.push(join(root, 'Google/Chrome/Application/chrome.exe'));
			list.push(join(root, 'Chromium/Application/chrome.exe'));
			list.push(join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe'));
			list.push(join(root, 'Microsoft/Edge/Application/msedge.exe'));
		}
	} else if (process.platform === 'darwin') {
		list.push(
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			'/Applications/Chromium.app/Contents/MacOS/Chromium',
			'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
			'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
		);
	} else {
		const names = [
			'google-chrome',
			'google-chrome-stable',
			'chromium',
			'chromium-browser',
			'brave-browser',
			'microsoft-edge'
		];
		for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
			for (const name of names) list.push(join(dir, name));
		}
	}
	return list;
}

let cached: string | null | undefined;

/** Primer navegador basado en Chromium instalado (o `DIFF_REVIEW_CHROME`). */
export function findBrowser(): string | null {
	if (cached !== undefined) return cached;
	cached = candidates().find((p) => existsSync(p)) ?? null;
	return cached;
}

/** Imprime el HTML a PDF con el navegador en modo headless; los títulos h1–h3 quedan como marcadores. */
export async function renderPdf(html: string): Promise<Buffer> {
	const browser = findBrowser();
	if (!browser) throw new Error('No se encontró Chrome, Edge ni Chromium instalado.');
	const dir = await mkdtemp(join(tmpdir(), 'diff-review-pdf-'));
	const input = join(dir, 'report.html');
	const output = join(dir, 'report.pdf');
	try {
		await writeFile(input, html, 'utf8');
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				browser,
				[
					'--headless',
					'--disable-gpu',
					'--no-first-run',
					'--no-default-browser-check',
					'--disable-extensions',
					`--user-data-dir=${join(dir, 'profile')}`,
					'--no-pdf-header-footer',
					'--generate-pdf-document-outline',
					`--print-to-pdf=${output}`,
					pathToFileURL(input).href
				],
				{ stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
			);
			let stderr = '';
			child.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error('El navegador tardó demasiado en generar el PDF.'));
			}, TIMEOUT_MS);
			child.on('error', (e) => {
				clearTimeout(timer);
				reject(e);
			});
			child.on('exit', () => {
				clearTimeout(timer);
				if (existsSync(output)) resolve();
				else reject(new Error(`El navegador no generó el PDF. ${stderr.trim()}`.trim()));
			});
		});
		return await readFile(output);
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}
