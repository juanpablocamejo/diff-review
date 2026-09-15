#!/usr/bin/env node
/**
 * CLI híbrido C:
 *   diff-review              → terminal: prompt + clipboard + espera JSON → abre viewer
 *   diff-review --ui         → web-first (UI inmediata)
 *
 *   diff-review --port 5191
 *   diff-review --no-open
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTextToClipboard } from '../lib/clipboard.mjs';
import { branchTips, getRemoteUrl, listBranches, tryResolveGitRoot } from '../lib/git.mjs';
import { formatOutputStamp, makeOutputFilename } from '../lib/output-name.mjs';
import { buildPrompt } from '../lib/prompt.mjs';
import { waitForReviewOutput } from '../lib/wait-output.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const buildDir = join(packageRoot, 'web', 'build');
const entry = join(buildDir, 'index.js');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5190;

/** El server debe ser Node: Bun como runtime hijo suele romper diálogos nativos de Windows. */
function resolveNodeBin() {
	if (process.execPath && /node(\.exe)?$/i.test(process.execPath)) return process.execPath;
	const which = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], {
		encoding: 'utf8',
		windowsHide: true
	});
	const first = String(which.stdout || '')
		.split(/\r?\n/)
		.map((s) => s.trim())
		.find(Boolean);
	if (first) return first;
	return 'node';
}

function printHelp() {
	console.log(`diff-review — review de branch con tu agente + UI local.

Usage:
  diff-review [options]

Por defecto (desde un repo git): copia el prompt, espera el JSON y abre el viewer.
Si branch y base coinciden, abre la UI para que elijas otra combinación.
Con --ui: abre la UI de inmediato (web-first).

Options:
  -p, --port <n>   Puerto (default ${DEFAULT_PORT})
      --host <h>   Host (default ${DEFAULT_HOST})
      --ui         Abrir la UI primero (sin esperar JSON)
      --base <b>   Base del merge-base (default: develop / detección)
      --branch <b> Branch a revisar (default: branch actual)
      --no-open    No abrir el navegador
  -h, --help       Esta ayuda

Requiere git en PATH. Los reportes viven en localStorage del navegador.
`);
}

function parseArgs(argv) {
	const opts = {
		port: DEFAULT_PORT,
		host: DEFAULT_HOST,
		open: true,
		help: false,
		ui: false,
		base: '',
		branch: ''
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h' || a === '--help') opts.help = true;
		else if (a === '--no-open') opts.open = false;
		else if (a === '--ui') opts.ui = true;
		else if (a === '--host') opts.host = argv[++i] || opts.host;
		else if (a === '--base') opts.base = argv[++i] || opts.base;
		else if (a === '--branch') opts.branch = argv[++i] || opts.branch;
		else if (a === '-p' || a === '--port') {
			const n = Number(argv[++i]);
			if (!Number.isFinite(n) || n <= 0) {
				console.error(`Puerto inválido: ${argv[i]}`);
				process.exit(1);
			}
			opts.port = Math.floor(n);
		} else if (a.startsWith('-')) {
			console.error(`Opción desconocida: ${a}`);
			printHelp();
			process.exit(1);
		}
	}
	return opts;
}

function openBrowser(url) {
	try {
		if (process.platform === 'win32') {
			spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
		} else if (process.platform === 'darwin') {
			spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
		} else {
			spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
		}
	} catch {
		/* el usuario puede abrir la URL a mano */
	}
}

/** Hipervínculo OSC 8 (Windows Terminal, VS Code, iTerm, Zed, etc.). */
function terminalLink(url, label = url) {
	return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
}

function canListen(host, port) {
	return new Promise((resolve) => {
		const server = createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => {
			server.close(() => resolve(true));
		});
		server.listen(port, host);
	});
}

/**
 * @returns {{ repo: string, branch: string, base: string, remoteUrl?: string } | null}
 */
function resolveLaunchRepo(opts) {
	const cwd = process.cwd();
	const root = tryResolveGitRoot(cwd);
	if (!root) return null;
	const listed = listBranches(root);
	const branch =
		String(opts.branch || '').trim() ||
		(listed.current && listed.current !== 'HEAD' ? listed.current : listed.branches[0] || '');
	const base =
		String(opts.base || '').trim() ||
		(listed.branches.includes('develop') ? 'develop' : listed.defaultBase);
	const remoteUrl = getRemoteUrl(root) || undefined;
	return { repo: root, branch, base, remoteUrl };
}

function logRepoContext(ctx) {
	console.log(`Repo:   ${ctx.repo}`);
	console.log(`Branch: ${ctx.branch}  (base: ${ctx.base})`);
}

function copyPromptOrWarn(prompt) {
	if (copyTextToClipboard(prompt)) {
		console.log('Prompt copiado al portapapeles.');
		return true;
	}
	console.log('No pude copiar al portapapeles; pegá el prompt a mano desde la UI o reintentá.');
	return false;
}

/**
 * @param {{ host: string, port: number, open: boolean, launchCwd: string, importFile?: string, openPath?: string }} cfg
 */
async function startServer(cfg) {
	if (!existsSync(entry)) {
		console.error(`No encontré el build en ${entry}
Corré desde el repo: npm run build
O reinstalá el paquete (el tarball de npm incluye el build).`);
		process.exit(1);
	}

	if (!(await canListen(cfg.host, cfg.port))) {
		console.error(`No se pudo usar ${cfg.host}:${cfg.port} (¿ocupado?). Probá --port otro.`);
		process.exit(1);
	}

	const origin = `http://${cfg.host}:${cfg.port}`;
	const openUrl = cfg.openPath ? `${origin}${cfg.openPath}` : origin;
	const nodeBin = resolveNodeBin();
	const child = spawn(nodeBin, [entry], {
		cwd: buildDir,
		env: {
			...process.env,
			HOST: cfg.host,
			PORT: String(cfg.port),
			ORIGIN: origin,
			DIFF_REVIEW_LAUNCH_CWD: cfg.launchCwd,
			...(cfg.importFile ? { DIFF_REVIEW_IMPORT_FILE: cfg.importFile } : {})
		},
		stdio: ['ignore', 'pipe', 'inherit'],
		windowsHide: false
	});

	let ready = false;
	let stdoutBuf = '';
	child.stdout?.on('data', (chunk) => {
		stdoutBuf += String(chunk);
		const parts = stdoutBuf.split(/\r?\n/);
		stdoutBuf = parts.pop() ?? '';
		for (const line of parts) {
			if (/Listening on/i.test(line)) {
				if (!ready) {
					ready = true;
					console.log(`diff-review listo en ${terminalLink(origin)} — Ctrl+C para salir.`);
					if (cfg.open) openBrowser(openUrl);
				}
				continue;
			}
			if (line.length) process.stdout.write(`${line}\n`);
		}
	});
	child.on('error', (err) => {
		console.error('No se pudo arrancar el server:', err.message);
		process.exit(1);
	});
	child.on('exit', (code, signal) => {
		if (signal) process.exit(0);
		process.exit(code ?? 1);
	});

	const stop = () => {
		if (!child.killed) child.kill('SIGTERM');
	};
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		printHelp();
		process.exit(0);
	}

	const launchCwd = process.cwd();
	const ctx = resolveLaunchRepo(opts);
	const outputStamp = formatOutputStamp();
	/** @type {string} */
	let outputFilename = makeOutputFilename({ stamp: outputStamp });
	if (ctx) {
		try {
			const tips = branchTips(ctx.repo, ctx.branch, ctx.base);
			outputFilename = makeOutputFilename({
				branchSha: tips.branchSha,
				baseSha: tips.baseSha,
				stamp: outputStamp
			});
		} catch (err) {
			console.warn(
				'No pude resolver tips para el nombre del JSON:',
				err instanceof Error ? err.message : err
			);
		}
	}

	/** Si branch===base el three-dot está vacío: forzar UI para elegir. */
	let openUi = opts.ui;
	let skipPromptCopy = false;
	if (!openUi && ctx && ctx.branch && ctx.branch === ctx.base) {
		console.log(
			`Branch y base son iguales (${ctx.branch}): el diff estaría vacío.\nAbro la UI para que elijas otra base o branch.`
		);
		openUi = true;
		skipPromptCopy = true;
	}

	if (openUi) {
		if (ctx) {
			logRepoContext(ctx);
			if (!skipPromptCopy) {
				const prompt = buildPrompt(
					{
						source: 'local',
						repo: ctx.repo,
						branch: ctx.branch,
						base: ctx.base,
						remoteUrl: ctx.remoteUrl
					},
					{ outputFilename }
				);
				copyPromptOrWarn(prompt);
			}
		} else {
			console.log('Sin repo git en el CWD — la UI arranca vacía.');
		}
		await startServer({
			host: opts.host,
			port: opts.port,
			open: opts.open,
			launchCwd,
			openPath:
				ctx && !skipPromptCopy
					? `/?notify=prompt&out=${encodeURIComponent(outputFilename)}`
					: '/'
		});
		return;
	}

	// Flujo terminal por defecto
	if (!ctx) {
		console.error(
			'No hay un repositorio git en el directorio actual.\nUsá --ui para abrir la interfaz, o corré diff-review desde un repo.'
		);
		process.exit(1);
	}

	logRepoContext(ctx);
	console.log(`Salida: ${outputFilename}`);
	const prompt = buildPrompt(
		{
			source: 'local',
			repo: ctx.repo,
			branch: ctx.branch,
			base: ctx.base,
			remoteUrl: ctx.remoteUrl
		},
		{ outputFilename }
	);
	copyPromptOrWarn(prompt);
	console.log(`Esperando ${outputFilename} en la raíz del repo… (Ctrl+C para cancelar)`);

	const result = await waitForReviewOutput(ctx.repo, outputFilename, {
		onInvalid: (errors) => {
			console.log(`JSON encontrado pero inválido (${errors.length} error(es)). Esperando corrección…`);
			for (const e of errors.slice(0, 5)) console.log(`  · ${e}`);
		}
	});

	console.log('JSON OK. Abriendo viewer…');
	await startServer({
		host: opts.host,
		port: opts.port,
		open: opts.open,
		launchCwd: ctx.repo,
		importFile: result.path,
		openPath: '/?import=1'
	});
}

main().catch((err) => {
	console.error(err?.message || err);
	process.exit(1);
});
