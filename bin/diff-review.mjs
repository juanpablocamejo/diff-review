#!/usr/bin/env node
/**
 * CLI: levanta la UI local (build de SvelteKit) y abre el browser.
 *
 *   diff-review
 *   diff-review --port 5191
 *   diff-review --no-open
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
	console.log(`diff-review — UI local para revisar un branch con tu agente.

Usage:
  diff-review [options]

Options:
  -p, --port <n>   Puerto (default ${DEFAULT_PORT})
      --host <h>   Host (default ${DEFAULT_HOST})
      --no-open    No abrir el navegador
  -h, --help       Esta ayuda

Requiere git en PATH. Los reportes viven en localStorage del navegador.
`);
}

function parseArgs(argv) {
	const opts = { port: DEFAULT_PORT, host: DEFAULT_HOST, open: true, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h' || a === '--help') opts.help = true;
		else if (a === '--no-open') opts.open = false;
		else if (a === '--host') opts.host = argv[++i] || opts.host;
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

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		printHelp();
		process.exit(0);
	}

	if (!existsSync(entry)) {
		console.error(`No encontré el build en ${entry}
Corré desde el repo: npm run build
O reinstalá el paquete (el tarball de npm incluye el build).`);
		process.exit(1);
	}

	if (!(await canListen(opts.host, opts.port))) {
		console.error(`No se pudo usar ${opts.host}:${opts.port} (¿ocupado?). Probá --port otro.`);
		process.exit(1);
	}

	const origin = `http://${opts.host}:${opts.port}`;
	const nodeBin = resolveNodeBin();
	const child = spawn(nodeBin, [entry], {
		cwd: buildDir,
		env: {
			...process.env,
			HOST: opts.host,
			PORT: String(opts.port),
			ORIGIN: origin
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
					if (opts.open) openBrowser(origin);
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

main();
