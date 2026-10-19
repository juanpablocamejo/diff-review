#!/usr/bin/env node
/**
 * CLI híbrido C:
 *   diff-review              → terminal: elegir branch/base → prompt + wait JSON → viewer
 *   diff-review --ui         → web-first (UI inmediata)
 *
 *   diff-review --port 5191
 *   diff-review --branch x --base y   → saltea selects de Clack
 *   diff-review --agent      → elegir agente + modelo y lanzarlo con el prompt (sin portapapeles)
 *   diff-review --headless   → con agente: correrlo en la terminal en vez de por ACP con la web
 *   diff-review --no-open
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { AGENTS, detectAgents, modelChoices, resolvedRunModel, runAgent } from '../lib/agents.mjs';
import { listAcpModelsCached, supportsAcp } from '../lib/acp.mjs';
import { buildAcpModelSelectOptions, sortModelSelectOptions } from '../lib/model-label.mjs';
import { autocompleteEs } from '../lib/autocomplete-es.mjs';
import { copyTextToClipboard } from '../lib/clipboard.mjs';
import { branchTips, getRemoteUrl, listBranches, tryResolveGitRoot } from '../lib/git.mjs';
import { makeOutputFilename } from '../lib/output-name.mjs';
import { buildPrompt, outputRelPath } from '../lib/prompt.mjs';
import { prepareReviewPromptOpts } from '../lib/review-prep.mjs';
import { ensureReviewDir, writeDiffCache } from '../lib/review-dir.mjs';
import { existingReviewOutput, waitForReviewOutput } from '../lib/wait-output.mjs';
import { stampReviewProvenance } from '../lib/review-meta.mjs';
import { runValidateCli } from '../lib/check-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
// `DIFF_REVIEW_OUT=build-next` cuando `web/build` está bloqueado por un server en marcha (EBUSY en Windows).
const buildDir = (() => {
	const primary = join(packageRoot, 'web', 'build');
	const overlay = join(packageRoot, 'web', 'build-next');
	if (existsSync(join(overlay, 'index.js'))) return overlay;
	return primary;
})();
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
  diff-review validate <file.json>

Por defecto (desde un repo git): elegís branch/base en la terminal (Clack),
copia el prompt, espera el JSON y abre el viewer. Si hay agentes instalados,
un solo select lista el portapapeles y cada agente detectado.
\`validate\` revisa el JSON y, si falla, dice cómo seguir (exit 0 = OK).
Si pasás --branch y --base juntos, saltea los selects.
Con --agent: saltea esa lista; elegís un agente instalado y el modelo,
y diff-review lo lanza con el prompt.
Si el agente habla ACP (Claude Code), corre desde la UI web: ves el
proceso en vivo y después podés preguntarle o pedirle cambios al reporte.
Con --headless corre en la terminal como antes.
Con --ui: abre la UI de inmediato (web-first).

Options:
  -p, --port <n>   Puerto (default ${DEFAULT_PORT}; si está ocupado, el siguiente libre)
      --host <h>   Host (default ${DEFAULT_HOST})
      --ui         Abrir la UI primero (sin esperar JSON)
      --base <b>   Base del merge-base (salta el select de base)
      --branch <b> Branch a revisar (salta el select de branch)
      --agent      Lanzar un agente instalado (${AGENTS.map((a) => a.bins[0]).join(', ')}) con el prompt
      --headless   Con agente: correrlo en la terminal (sin ACP ni chat en la web)
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
		agent: false,
		headless: false,
		base: '',
		branch: ''
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '-h' || a === '--help') opts.help = true;
		else if (a === '--no-open') opts.open = false;
		else if (a === '--ui') opts.ui = true;
		else if (a === '--agent') opts.agent = true;
		else if (a === '--headless') opts.headless = true;
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

const PORT_SCAN = 50;

/** Primer puerto libre desde `start`, o `null` si ninguno de los siguientes cabe. */
async function findFreePort(host, start) {
	const first = Math.max(1, Math.floor(start));
	const last = Math.min(65535, first + PORT_SCAN - 1);
	for (let port = first; port <= last; port++) {
		if (await canListen(host, port)) return port;
	}
	return null;
}

/**
 * @returns {{
 *   repo: string,
 *   listed: { branches: string[], current: string, defaultBase: string },
 *   remoteUrl?: string
 * } | null}
 */
function loadRepoLaunch() {
	const cwd = process.cwd();
	const root = tryResolveGitRoot(cwd);
	if (!root) return null;
	const listed = listBranches(root);
	const remoteUrl = getRemoteUrl(root) || undefined;
	return { repo: root, listed, remoteUrl };
}

function defaultBranch(listed) {
	return listed.current && listed.current !== 'HEAD' ? listed.current : listed.branches[0] || '';
}

function defaultBase(listed, branch) {
	const preferred = listed.branches.includes('develop') ? 'develop' : listed.defaultBase;
	if (preferred && preferred !== branch) return preferred;
	return listed.branches.find((b) => b !== branch) || preferred || '';
}

function branchOptions(listed, exclude = '') {
	const skip = String(exclude || '').trim();
	return listed.branches
		.filter((b) => !skip || b !== skip)
		.map((b) => ({
			value: b,
			label: b,
			hint: b === listed.current ? 'actual' : b === listed.defaultBase ? 'base típica' : undefined
		}));
}

/** Selects solo con terminal interactiva. (`p.isTTY` de Clack es una función, no un booleano.) */
function isInteractive() {
	return p.isTTY(process.stdin) && p.isTTY(process.stdout);
}

function ensureValue(value, label) {
	if (p.isCancel(value)) {
		p.cancel('Cancelado.');
		process.exit(0);
	}
	if (value == null || value === '') {
		p.cancel(`Falta ${label}.`);
		process.exit(1);
	}
	return /** @type {string} */ (value);
}

/**
 * Selects interactivos salvo que --branch y --base vengan juntos.
 * @param {{ listed: { branches: string[], current: string, defaultBase: string }, repo: string }} launch
 * @param {{ branch: string, base: string }} opts
 * @param {{ skipIntro?: boolean }} [pickOpts]
 */
async function resolveBranchBase(launch, opts, pickOpts = {}) {
	const flagBranch = String(opts.branch || '').trim();
	const flagBase = String(opts.base || '').trim();
	const bothFlags = Boolean(flagBranch && flagBase);

	if (bothFlags) {
		return { branch: flagBranch, base: flagBase, prompted: false };
	}

	if (!isInteractive()) {
		const branch = flagBranch || defaultBranch(launch.listed);
		const base = flagBase || defaultBase(launch.listed, branch);
		return { branch, base, prompted: false };
	}

	if (!launch.listed.branches.length) {
		p.cancel('No hay branches en este repo.');
		process.exit(1);
	}

	const options = branchOptions(launch.listed);
	if (!pickOpts.skipIntro) {
		p.intro('diff-review');
		p.log.info(launch.repo);
	}

	/** @type {string} */
	let branch = flagBranch;
	/** @type {string} */
	let base = flagBase;
	let first = true;

	for (;;) {
		if (!first) {
			// Diff vacío / tips iguales: volver a preguntar branch y base (no solo la base).
			branch = '';
			base = '';
		}
		first = false;

		if (!branch) {
			branch = ensureValue(
				await autocompleteEs({
					message: 'Branch a revisar',
					options,
					initialValue: defaultBranch(launch.listed) || undefined,
					maxItems: 12
				}),
				'branch'
			);
		} else {
			p.log.step(`Branch: ${branch}`);
		}

		const baseOptions = branchOptions(launch.listed, branch);
		if (!baseOptions.length) {
			p.cancel(`No hay otra base disponible distinta de \`${branch}\`.`);
			process.exit(1);
		}

		if (!base) {
			base = ensureValue(
				await autocompleteEs({
					message: 'Base (merge-base)',
					options: baseOptions,
					initialValue: defaultBase(launch.listed, branch) || undefined,
					maxItems: 12
				}),
				'base'
			);
		} else {
			p.log.step(`Base: ${base}`);
		}

		if (branch === base || sameCommitTips(launch.repo, branch, base)) {
			p.log.warn(emptyDiffPickMessage(branch, base));
			continue;
		}
		break;
	}

	return { branch, base, prompted: true };
}

/** ¿Branch y base resuelven al mismo SHA? (diff committed vacío aunque los nombres difieran). */
function sameCommitTips(repo, branch, base) {
	try {
		const { branchSha, baseSha } = branchTips(repo, branch, base);
		return Boolean(branchSha && baseSha && branchSha === baseSha);
	} catch {
		return false;
	}
}

function emptyDiffPickMessage(branch, base) {
	if (branch === base) {
		return `Branch y base son iguales (${branch}): no hay diff que revisar.`;
	}
	return `\`${branch}\` y \`${base}\` apuntan al mismo commit: no hay diff que revisar.`;
}

function buildOutputFilename(repo, branch, base) {
	try {
		const tips = branchTips(repo, branch, base);
		return makeOutputFilename({
			branchSha: tips.branchSha,
			baseSha: tips.baseSha
		});
	} catch (err) {
		console.warn(
			'No pude resolver tips para el nombre del JSON:',
			err instanceof Error ? err.message : err
		);
		return makeOutputFilename({});
	}
}

/**
 * Precomputa el diff en CLI (spinner si hay Clack).
 * @returns {{ empty: true, message: string } | { empty: false, promptOpts: ReturnType<typeof prepareReviewPromptOpts> }}
 */
function prepareContext(launch, branch, base, outputFilename, { useClack }) {
	const spin = useClack ? p.spinner() : null;
	if (!useClack) console.log('Preparando el contexto…');
	spin?.start('Preparando el contexto…');

	/** @type {ReturnType<typeof prepareReviewPromptOpts>} */
	let promptOpts = { outputFilename };
	try {
		promptOpts = prepareReviewPromptOpts({
			repo: launch.repo,
			branch,
			base,
			outputFilename
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		spin?.stop('No pude precomputar el diff');
		if (useClack) p.log.warn(`No pude precomputar el diff: ${msg}`);
		else console.warn('No pude precomputar el diff:', msg);
		ensureReviewDir(launch.repo);
		writeDiffCache(launch.repo, outputFilename, { branch, base });
		return { empty: false, promptOpts };
	}

	const n = Array.isArray(promptOpts.files) ? promptOpts.files.length : 0;
	if (n === 0) {
		spin?.stop('Diff vacío');
		return {
			empty: true,
			message: `El diff entre \`${branch}\` y \`${base}\` está vacío: no hay nada que revisar.`
		};
	}

	const done = `Contexto listo · ${n} archivo${n === 1 ? '' : 's'}`;
	spin?.stop(done);
	if (!useClack) console.log(done);
	return { empty: false, promptOpts };
}

function copyPromptOrWarn(prompt) {
	if (copyTextToClipboard(prompt)) return true;
	p.log.warn(
		'No pude copiar al portapapeles. Copiá el prompt a mano desde la terminal o reintentá.'
	);
	return false;
}

/**
 * Opciones de modelo: las que ofrece el agente por ACP (si va a correr así) o, si no, la lista fija.
 * @param {import('../lib/agents.mjs').DetectedAgent} agent
 * @param {{ acpCwd?: string }} opts
 */
async function modelOptions(agent, { acpCwd }) {
	const fixed = modelChoices(agent.def);
	const sortedFixed = {
		...fixed,
		options: sortModelSelectOptions(fixed.options)
	};
	if (!acpCwd) return sortedFixed;
	const spin = p.spinner();
	spin.start(`Consultando los modelos de ${agent.def.label}`);
	try {
		const { models, currentModel, fromCache } = await listAcpModelsCached(agent, { cwd: acpCwd });
		spin.stop(
			fromCache
				? `Modelos de ${agent.def.label} (caché)`
				: `Modelos de ${agent.def.label}`
		);
		if (!models.length) return sortedFixed;
		// Misma fusión/labels/orden que la UI.
		return buildAcpModelSelectOptions({ models, currentModel }, fixed);
	} catch (err) {
		spin.stop(`No pude consultar los modelos (${err instanceof Error ? err.message.split('\n')[0] : err}).`);
		return sortedFixed;
	}
}

/**
 * Modelo del agente: autocomplete con búsqueda; sin TTY, el default (string vacío).
 * @param {import('../lib/agents.mjs').DetectedAgent} agent
 * @param {{ acpCwd?: string }} [opts] con `acpCwd`, la lista sale del agente por ACP
 */
async function pickModel(agent, opts = {}) {
	if (!isInteractive()) return '';

	const { options, initialValue } = await modelOptions(agent, opts);
	return /** @type {string} */ (
		ensureValue(
			await autocompleteEs({
				message: 'Modelo',
				options,
				initialValue,
				placeholder: 'opus, sonnet, gpt…'
			}),
			'modelo'
		)
	);
}

/**
 * Agente y modelo: selects con TTY; sin TTY, el primer agente detectado con su modelo por defecto.
 * Si `preset` ya viene elegido, solo pregunta el modelo.
 * @param {import('../lib/agents.mjs').DetectedAgent[]} detected
 * @param {import('../lib/agents.mjs').DetectedAgent} [preset]
 * @param {{ repo: string, headless: boolean }} [run] para consultar los modelos por ACP
 */
async function pickAgentAndModel(detected, preset, run) {
	if (!isInteractive()) return { agent: preset ?? detected[0], model: '' };

	let agent = preset;
	if (!agent) {
		const id = ensureValue(
			await p.select({
				message: 'Agente',
				options: detected.map((a) => ({ value: a.def.id, label: a.def.label, hint: a.path })),
				initialValue: detected[0].def.id
			}),
			'agente'
		);
		agent = detected.find((a) => a.def.id === id) ?? detected[0];
	}

	const acpCwd = run && !run.headless && supportsAcp(agent) ? run.repo : undefined;
	return { agent, model: await pickModel(agent, { acpCwd }) };
}

/**
 * Agentes detectados primero (default el primero); portapapeles como opción secundaria.
 * @param {import('../lib/agents.mjs').DetectedAgent[]} detected
 * @returns {Promise<import('../lib/agents.mjs').DetectedAgent | null>} `null` = portapapeles
 */
async function pickDelivery(detected) {
	const choice = ensureValue(
		await p.select({
			message: '¿Cómo generás el review?',
			options: [
				...detected.map((a) => ({ value: a.def.id, label: a.def.label, hint: a.path })),
				{ value: 'clipboard', label: 'Copiar el prompt al portapapeles', hint: 'lo pegás en tu agente' }
			],
			initialValue: detected[0].def.id
		}),
		'modo'
	);
	if (choice === 'clipboard') return null;
	return detected.find((a) => a.def.id === choice) ?? detected[0];
}

/**
 * Ya hay un review válido para estos commits: pregunta si abrirlo o generarlo de nuevo.
 * @param {{ path: string }} existing
 * @returns {Promise<{ path: string } | null>} el existente, o `null` para generar de nuevo
 */
async function reuseExistingReview(existing, outputFilename) {
	const choice = ensureValue(
		await p.select({
			message: `Ya hay un review válido para estos commits (${outputFilename})`,
			options: [
				{ value: 'open', label: 'Abrir el existente' },
				{ value: 'regenerate', label: 'Generar de nuevo', hint: 'el agente lo reemplaza' }
			],
			initialValue: 'open'
		}),
		'review'
	);
	if (choice !== 'open') return null;
	p.outro('Abro el review existente.');
	return existing;
}

/**
 * Lanza el agente y espera el JSON. Devuelve el reporte válido; si el agente termina sin dejarlo, sale con error.
 * @param {import('../lib/agents.mjs').DetectedAgent} agent
 * @param {{ repo: string, prompt: string, model: string, outputFilename: string, useClack: boolean }} run
 */
async function runAgentAndWait(agent, { repo, prompt, model, outputFilename, useClack }) {
	const what = `${agent.def.label} (${model || 'modelo por defecto'})`;
	const msg = `Lanzando ${what}. Espera ${outputRelPath(outputFilename)}; Ctrl+C cancela.`;
	if (useClack) p.outro(msg);
	else console.log(msg);

	// Solo cuenta lo que escriba este agente: un JSON anterior de los mismos commits no es el resultado.
	const since = Date.now();
	const { exited } = runAgent(agent, { cwd: repo, prompt, model, outputFilename });
	const waiting = waitForReviewOutput(repo, outputFilename, {
		since,
		onInvalid: (errors) => {
			console.log(`JSON encontrado pero inválido (${errors.length} error(es)). El agente puede corregirlo…`);
			for (const e of errors.slice(0, 5)) console.log(`  · ${e}`);
		}
	});

	let code;
	try {
		code = await exited;
	} catch (err) {
		console.error(`No se pudo lanzar ${agent.path}: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
	// El watcher puede ir un tick atrás de la última escritura del agente.
	const result = await Promise.race([waiting, new Promise((r) => setTimeout(() => r(null), 2000))]);
	if (!result) {
		console.error(
			code === 0
				? `${agent.def.label} terminó sin dejar un ${outputFilename} válido.`
				: `${agent.def.label} terminó con código ${code} sin dejar un ${outputFilename} válido.`
		);
		process.exit(1);
	}
	if (code !== 0) console.warn(`${agent.def.label} terminó con código ${code}, pero el JSON es válido.`);
	stampReviewProvenance(result.path, {
		agent: agent.def.label,
		model: resolvedRunModel(agent.def, model)
	});
	return /** @type {{ path: string }} */ (result);
}

/**
 * El agente corre dentro del server de la UI (ACP): la web muestra el proceso y abre el reporte; la terminal ve un
 * resumen. La sesión queda viva para preguntas y cambios desde el reporte.
 * @param {import('../lib/agents.mjs').DetectedAgent} agent
 * @param {{ repo: string, branch: string, base: string, model: string, outputFilename: string, useClack: boolean }} run
 * @param {{ host: string, port: number, open: boolean }} opts
 */
async function runAgentInUi(agent, { repo, branch, base, model, outputFilename, useClack }, opts) {
	const id = randomUUID();
	const msg = `Lanzando ${agent.def.label} (${model || 'modelo por defecto'}). El progreso se ve en la web; Ctrl+C corta.`;
	if (useClack) p.outro(msg);
	else console.log(msg);
	await startServer({
		host: opts.host,
		port: opts.port,
		open: opts.open,
		launchCwd: repo,
		openPath: `/?agent=${encodeURIComponent(id)}`,
		agentRun: { id, repo, branch, base, outputFilename, agentId: agent.def.id, ...(model ? { model } : {}) }
	});
}

function explainWaitingForAgent(outputFilename, { copied, useClack }) {
	const copyMsg = copied
		? 'Se copió un prompt al portapapeles: pegalo en el chat de tu agente de IA para generar el contenido de la review.'
		: 'Generá el JSON con tu agente de IA usando el prompt de esta sesión (no se pudo copiar solo al portapapeles).';
	const waitMsg = `Aguardando el resultado del agente (${outputRelPath(outputFilename)}). La UI web se abre cuando ese archivo esté listo.`;

	if (useClack) {
		p.log.success(copyMsg);
		p.log.info(waitMsg);
		p.outro('Ctrl+C cancela la espera.');
		return;
	}
	console.log(copyMsg);
	console.log(waitMsg);
	console.log('(Ctrl+C cancela la espera)');
}

/**
 * @typedef {{ id: string, repo: string, branch: string, base: string, outputFilename: string, agentId: string, model?: string }} AgentRun
 * @param {{ host: string, port: number, open: boolean, launchCwd: string, importFile?: string, openPath?: string, agentRun?: AgentRun }} cfg
 */
async function startServer(cfg) {
	if (!existsSync(entry)) {
		console.error(`No encontré el build en ${entry}
Corré desde el repo: npm run build
O reinstalá el paquete (el tarball de npm incluye el build).`);
		process.exit(1);
	}

	const port = await findFreePort(cfg.host, cfg.port);
	if (port == null) {
		const last = Math.min(65535, cfg.port + PORT_SCAN - 1);
		console.error(`No encontré un puerto libre entre ${cfg.port} y ${last} en ${cfg.host}.`);
		process.exit(1);
	}
	if (port !== cfg.port) {
		console.log(`Puerto ${cfg.port} ocupado; la UI usa ${port}.`);
	}

	const origin = `http://${cfg.host}:${port}`;
	const openUrl = cfg.openPath ? `${origin}${cfg.openPath}` : origin;
	const nodeBin = resolveNodeBin();
	const child = spawn(nodeBin, [entry], {
		cwd: buildDir,
		env: {
			...process.env,
			HOST: cfg.host,
			PORT: String(port),
			ORIGIN: origin,
			// Reviews con seed/diff o import JSON suelen pasar los 512K por defecto del adapter-node.
			BODY_SIZE_LIMIT: process.env.BODY_SIZE_LIMIT || '16M',
			DIFF_REVIEW_LAUNCH_CWD: cfg.launchCwd,
			...(cfg.importFile ? { DIFF_REVIEW_IMPORT_FILE: cfg.importFile } : {}),
			...(cfg.agentRun ? { DIFF_REVIEW_AGENT_RUN: JSON.stringify(cfg.agentRun), DIFF_REVIEW_MIRROR: '1' } : {})
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
					else if (cfg.agentRun) console.log(`Progreso del agente: ${terminalLink(openUrl)}`);
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

async function runUiMode(opts, launch, launchCwd) {
	const listed = launch?.listed;
	const branch = String(opts.branch || '').trim() || (listed ? defaultBranch(listed) : '');
	const base =
		String(opts.base || '').trim() || (listed ? defaultBase(listed, branch) : 'develop');
	const outputFilename = launch
		? buildOutputFilename(launch.repo, branch, base)
		: makeOutputFilename({});

	if (launch) {
		console.log(`Repo:   ${launch.repo}`);
		console.log(`Branch: ${branch}  (base: ${base})`);
		if (branch === base || sameCommitTips(launch.repo, branch, base)) {
			console.error(emptyDiffPickMessage(branch, base));
			process.exit(1);
		}
		const prep = prepareContext(launch, branch, base, outputFilename, { useClack: false });
		if (prep.empty) {
			console.error(prep.message);
			process.exit(1);
		}
		const prompt = buildPrompt(
			{
				source: 'local',
				repo: launch.repo,
				branch,
				base,
				remoteUrl: launch.remoteUrl
			},
			prep.promptOpts
		);
		if (copyTextToClipboard(prompt)) {
			console.log('Prompt copiado al portapapeles.');
		} else {
			console.log('No pude copiar al portapapeles; pegá el prompt a mano desde la UI o reintentá.');
		}
	} else {
		console.log('Sin repo git en el CWD — la UI arranca vacía.');
	}

	await startServer({
		host: opts.host,
		port: opts.port,
		open: opts.open,
		launchCwd,
		openPath: launch
			? `/?watch=1&notify=prompt&out=${encodeURIComponent(outputFilename)}`
			: '/'
	});
}

async function main() {
	const rawArgv = process.argv.slice(2);
	if (rawArgv[0] === 'validate') {
		process.exit(runValidateCli(rawArgv.slice(1)));
	}

	const opts = parseArgs(rawArgv);
	if (opts.help) {
		printHelp();
		process.exit(0);
	}

	const launchCwd = process.cwd();
	const launch = loadRepoLaunch();

	if (opts.ui) {
		await runUiMode(opts, launch, launchCwd);
		return;
	}

	if (!launch) {
		console.error(
			'No hay un repositorio git en el directorio actual.\nUsá --ui para abrir la interfaz, o corré diff-review desde un repo.'
		);
		process.exit(1);
	}

	/** @type {{ branch: string, base: string }} */
	let pick = { branch: opts.branch, base: opts.base };
	let skipIntro = false;
	/** @type {string} */
	let branch;
	/** @type {string} */
	let base;
	/** @type {boolean} */
	let prompted;
	/** @type {string} */
	let outputFilename;
	/** @type {ReturnType<typeof prepareReviewPromptOpts>} */
	let promptOpts;

	for (;;) {
		({ branch, base, prompted } = await resolveBranchBase(launch, pick, { skipIntro }));
		if (prompted) skipIntro = true;

		if (branch === base || sameCommitTips(launch.repo, branch, base)) {
			const msg = emptyDiffPickMessage(branch, base);
			if (prompted || isInteractive()) {
				p.log.warn(msg);
				pick = { branch: '', base: '' };
				continue;
			}
			console.error(msg);
			process.exit(1);
		}

		outputFilename = buildOutputFilename(launch.repo, branch, base);
		if (!prompted) {
			console.log(`Repo:   ${launch.repo}`);
			console.log(`Branch: ${branch}  (base: ${base})`);
		} else {
			p.note(`${branch}  →  ${base}\n${outputRelPath(outputFilename)}`, 'Review');
		}

		// El agente escribe en .diff-review/ (que se ignora sola) y lee de ahí el diff ya calculado.
		const prep = prepareContext(launch, branch, base, outputFilename, {
			useClack: prompted || isInteractive()
		});
		if (prep.empty) {
			if (prompted || isInteractive()) {
				p.log.warn(prep.message);
				pick = { branch: '', base: '' };
				continue;
			}
			console.error(prep.message);
			process.exit(1);
		}
		promptOpts = prep.promptOpts;
		break;
	}

	const prompt = buildPrompt(
		{
			source: 'local',
			repo: launch.repo,
			branch,
			base,
			remoteUrl: launch.remoteUrl
		},
		promptOpts
	);

	// Sin --agent también se detectan (con terminal interactiva) para ofrecer lanzar uno en vez del portapapeles.
	const detected = opts.agent || isInteractive() ? detectAgents() : [];
	if (opts.agent && !detected.length) {
		const names = AGENTS.map((a) => a.bins[0]).join(', ');
		const warn = `No encontré agentes instalados (${names}). Sigo copiando el prompt.`;
		if (prompted) p.log.warn(warn);
		else console.warn(warn);
	}

	// Hay selects (agente/modelo, o abrir vs. regenerar un review existente) solo con terminal interactiva.
	const existing = isInteractive() ? existingReviewOutput(launch.repo, outputFilename) : null;
	const useClack = prompted || (isInteractive() && (detected.length > 0 || existing != null));
	// Con flags de branch/base no hubo intro, pero estos selects abren sesión de Clack igual.
	if (useClack && !prompted) p.intro('diff-review');

	let result = existing ? await reuseExistingReview(existing, outputFilename) : null;
	/** @type {import('../lib/agents.mjs').DetectedAgent | null} */
	let chosen = null;
	if (!result && detected.length > 0 && !opts.agent && isInteractive()) {
		chosen = await pickDelivery(detected);
	}
	const useAgent = !result && detected.length > 0 && (opts.agent || chosen != null);
	if (useAgent) {
		const { agent, model } = await pickAgentAndModel(detected, chosen ?? undefined, {
			repo: launch.repo,
			headless: opts.headless
		});
		if (supportsAcp(agent) && !opts.headless) {
			await runAgentInUi(
				agent,
				{ repo: launch.repo, branch, base, model, outputFilename, useClack },
				opts
			);
			return;
		}
		result = await runAgentAndWait(agent, {
			repo: launch.repo,
			prompt,
			model,
			outputFilename,
			useClack
		});
	} else if (!result) {
		// Si eligió generar de nuevo, el JSON existente no cuenta hasta que el agente lo reescriba.
		const since = existing ? Date.now() : undefined;
		const copied = copyPromptOrWarn(prompt);
		explainWaitingForAgent(outputFilename, { copied, useClack });

		result = await waitForReviewOutput(launch.repo, outputFilename, {
			since,
			onInvalid: (errors) => {
				console.log(`JSON encontrado pero inválido (${errors.length} error(es)). Esperando corrección…`);
				for (const e of errors.slice(0, 5)) console.log(`  · ${e}`);
			}
		});
	}

	console.log('JSON OK. Abriendo la UI web…');
	await startServer({
		host: opts.host,
		port: opts.port,
		open: opts.open,
		launchCwd: launch.repo,
		importFile: result.path,
		openPath: '/?import=1'
	});
}

main().catch((err) => {
	console.error(err?.message || err);
	process.exit(1);
});
