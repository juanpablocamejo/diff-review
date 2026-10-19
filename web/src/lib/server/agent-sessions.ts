/**
 * Sesiones con agentes por ACP, del lado del server: el server es dueño del proceso del agente y la web lo sigue
 * por SSE (`/api/agent/[id]/events`). Una sesión genera la review y después queda viva para preguntas y cambios.
 *
 * Los procesos viven en memoria; lo que tiene que sobrevivir va a `.diff-review/` del repo: el JSON, el diff y la
 * sesión del agente (`<nombre>.session.json`). Para chatear sobre un reporte se retoma esa sesión
 * (`session/load`); si no se puede (se borró, otro agente, otra máquina) se abre una nueva y el primer mensaje le
 * pasa el contexto: repo, branch, base y dónde están el diff y el JSON.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import type { SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { detectAgents, modelChoices, type DetectedAgent } from '$review/lib/agents.mjs';
import { listAcpModelsCached, startAcpSession, supportsAcp, type AcpSession } from '$review/lib/acp.mjs';
import {
	decidePermission,
	humanizePolicyReason,
	toolCallCommand,
	toolCallLabel,
	type PolicyMode
} from '$review/lib/acp-policy.mjs';
import {
	authFailureMessage as formatAuthFailure,
	loginCommand,
	looksLikeAuthFailure,
	openLoginTerminal
} from '$review/lib/agent-login.mjs';
import { checkReportFile, formatCheckReport } from '$review/lib/check-report.mjs';
import { stampReviewProvenance } from '$review/lib/review-meta.mjs';
import { buildPrompt, outputRelPath, validateCliCommand } from '$review/lib/prompt.mjs';
import { getRemoteUrl } from '$review/lib/git.mjs';
import { prepareReviewPromptOpts } from '$review/lib/review-prep.mjs';
import {
	companionPaths,
	ensureReviewDir,
	readSessionRef,
	writeDiffCache,
	writeDiffText,
	writeSessionRef
} from '$review/lib/review-dir.mjs';
import {
	applyEvent,
	type AcpAgentOption,
	type AcpModels,
	type AgentEvent,
	type AgentSessionInfo,
	type ChatMode,
	type SeqEvent,
	type SessionStatus
} from '$lib/report/agent-events';

type Listener = (event: SeqEvent | { type: 'reset' }) => void;

/** once = este pedido; session = auto-aprobar denegados el resto de la sesión; always = ACP allow_always. */
export type PermissionScope = 'once' | 'session' | 'always';

type ResolvePermissionOpts = { quiet?: boolean; scope?: PermissionScope };

type PendingPermission = {
	resolve: (allow: boolean, opts?: ResolvePermissionOpts) => void;
	timer: ReturnType<typeof setTimeout>;
};

type UserPermissionAnswer = { allow: boolean; always?: boolean };

type Entry = AgentSessionInfo & {
	agent: DetectedAgent;
	/** Id de la sesión del lado del agente (sirve para `session/load`). */
	acpSessionId: string;
	acp: AcpSession | null;
	starting: Promise<AcpSession> | null;
	mode: PolicyMode;
	events: SeqEvent[];
	seq: number;
	/** `seq` del último chunk de texto, para pegar los siguientes al mismo evento. */
	textSeq: { kind: 'message' | 'thought'; seq: number } | null;
	listeners: Set<Listener>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	/** Comandos rechazados en el turno en curso (para avisarle al agente si corta el turno por eso). */
	rejections: string[];
	/** La sesión del agente es nueva (no se pudo retomar): el próximo mensaje lleva el contexto de la review. */
	needsContext: boolean;
	/** Lo que muestra la web (JSON sin diffs + diff), para escribirlo en `.diff-review/` antes de pasar el contexto. */
	seed: { payload?: unknown; diff?: string } | null;
	/** Paths del diff ya resueltos al arrancar la review (evita `git diff` al validar). */
	diffPaths: string[] | null;
	/** Permisos pendientes de confirmación del usuario (política negó). */
	pendingPermissions: Map<string, PendingPermission>;
	/**
	 * Si el usuario eligió “Permitir en esta sesión” / “siempre”: no volver a preguntar
	 * cuando la política niegue (se auto-aprueba hacia ACP).
	 */
	sessionAllowDenied: boolean;
	/** Cancelaron desde la UI antes de que arranque / termine el turno. */
	cancelled: boolean;
};

/** Para que el agente no gaste turnos en comandos que la política va a rechazar. */
const TOOL_RULES =
	'Tool rules for this session: read files with your file tools (read/search/glob). For the review JSON path: use forward slashes (e.g. .diff-review/foo.json). If that file already exists, Read it first, then Edit/Write — Write fails with "File has not been read yet" unless you Read that exact path. Never shell redirection (>, >>, Out-File, tee). The .diff-review/ folder already exists — do not mkdir it. In the terminal only read-only commands run (git diff/log/show/blame/…, cat, head, tail, grep, rg, find, ls, wc, sed -n). No redirections to files, no command substitution, no installs, no network. Anything else is rejected automatically: do not retry the same rejected command; use the file tool or another read-only way.';

/**
 * En estas sesiones valida el server al terminar cada turno (y le devuelve los errores al agente): correr el
 * validate por npx es lento y puede resolver otra versión del paquete.
 */
const SERVER_VALIDATES =
	'Note: in this session diff-review validates the JSON automatically when your turn ends and sends you any problems. Do not run the validate command yourself.';

/** Sin actividad por este tiempo se cierra el proceso del agente (se retoma con `session/load`). */
const IDLE_CLOSE_MS = 30 * 60 * 1000;
const MAX_EVENTS = 4000;
/** Si el usuario no responde un permiso pendiente, se rechaza para no colgar el turno. */
const PERMISSION_TIMEOUT_MS = 2 * 60 * 1000;

const sessions = new Map<string, Entry>();

process.once('exit', () => {
	for (const entry of sessions.values()) entry.acp?.close();
});

export function listAcpAgents(): AcpAgentOption[] {
	return detectAgents()
		.filter(supportsAcp)
		.map((a) => ({ id: a.def.id, label: a.def.label, path: a.path, models: modelChoices(a.def).options }));
}

const modelsCache = new Map<string, Promise<AcpModels>>();

/**
 * Modelos que ofrece el agente por ACP (abre una sesión de prueba; tarda unos segundos).
 * Solo cachea listas no vacías. `force` invalida la caché. Vacío o error → se puede reintentar.
 */
export function agentModels(
	agentId: string,
	cwd: string,
	opts?: { force?: boolean }
): Promise<AcpModels> {
	if (opts?.force) modelsCache.delete(agentId);
	let hit = modelsCache.get(agentId);
	if (!hit) {
		const agent = findAgent(agentId);
		hit = listAcpModelsCached(agent, { cwd, force: Boolean(opts?.force) })
			.then((result) => {
				if (!result.models.length) modelsCache.delete(agentId);
				const { fromCache: _fromCache, ...rest } = result;
				return rest;
			})
			.catch((err) => {
				modelsCache.delete(agentId);
				const raw = err instanceof Error ? err.message : String(err);
				const auth = authFailureMessage(agentId, agent.def.label, raw);
				throw new Error(auth || raw);
			});
		modelsCache.set(agentId, hit);
	}
	return hit;
}

function findAgent(agentId: string): DetectedAgent {
	const agent = detectAgents().find((a) => a.def.id === agentId);
	if (!agent) throw new Error(`No encontré el agente "${agentId}" instalado.`);
	if (!supportsAcp(agent)) throw new Error(`${agent.def.label} no tiene modo ACP.`);
	return agent;
}

function info(entry: Entry): AgentSessionInfo {
	const {
		id,
		agentId,
		agentLabel,
		model,
		repo,
		branch,
		base,
		outputFilename,
		acpSessionId,
		status,
		busy,
		statusMessage,
		sessionAllowDenied
	} = entry;
	return {
		id,
		agentId,
		agentLabel,
		model,
		repo,
		branch,
		base,
		outputFilename,
		acpSessionId,
		status,
		busy,
		sessionTrust: Boolean(sessionAllowDenied),
		...(statusMessage ? { statusMessage } : {})
	};
}

function authFailureMessage(agentId: string, agentLabel: string, detail: string): string | null {
	return formatAuthFailure(agentId, agentLabel, detail);
}

/** Abre una terminal con el login del agente (Claude `/login`, `gh auth login`, …). */
export function openAgentLogin(agentId: string): { display: string } {
	return openLoginTerminal(String(agentId || ''));
}

export { looksLikeAuthFailure, loginCommand };

/** Escribe seed (JSON + .diff) en `.diff-review/` para que el agente los lea. */
function materializeSeed(entry: Entry) {
	const seed = entry.seed;
	if (!seed) return;
	try {
		ensureReviewDir(entry.repo);
		const paths = companionPaths(entry.repo, entry.outputFilename);
		if (seed.payload !== undefined) {
			writeFileSync(paths.json, `${JSON.stringify(seed.payload, null, 2)}\n`);
		}
		if (typeof seed.diff === 'string' && seed.diff.length) {
			writeDiffText(entry.repo, entry.outputFilename, seed.diff);
		} else {
			writeDiffCache(entry.repo, entry.outputFilename, { branch: entry.branch, base: entry.base });
		}
	} catch {
		/* sin .diff-review escribible: el prompt de contexto lo dice explícitamente */
	}
}

/** Prefijo del primer mensaje cuando la sesión ACP es nueva. */
function contextPreamble(entry: Entry): string {
	materializeSeed(entry);
	const paths = companionPaths(entry.repo, entry.outputFilename);
	const jsonRel = outputRelPath(entry.outputFilename);
	const diffRel = `${outputRelPath(entry.outputFilename).replace(/\.json$/i, '')}.diff`;
	const hasJson = existsSync(paths.json);
	const hasDiff = existsSync(paths.diff);
	const lines = [
		'Context for this chat (new agent session — read these files before answering):',
		`- Repo: ${entry.repo}`,
		`- Branch under review: ${entry.branch}`,
		`- Base: ${entry.base}`,
		hasJson
			? `- Review JSON (relative to repo root): \`${jsonRel}\` — read this file.`
			: `- Review JSON: not available on disk (no seed/payload was provided). Say so if you need it.`,
		hasDiff
			? `- Diff (relative to repo root): \`${diffRel}\` — read this file.`
			: `- Diff file: not available on disk (no seed/diff and git cache failed). Say so if you need it.`,
		'',
		'User message:'
	];
	return lines.join('\n');
}

function permissionReasonLabel(allow: boolean, scope: PermissionScope | undefined, deniedReason: string): string {
	if (!allow) return deniedReason;
	if (scope === 'always') return 'permitido siempre';
	if (scope === 'session') return 'permitido en esta sesión';
	return 'permitido una vez';
}

function askUserPermission(
	entry: Entry,
	toolCall: ToolCallUpdate,
	decision: { allow: boolean; reason: string }
): Promise<UserPermissionAnswer> {
	if (entry.sessionAllowDenied) {
		return Promise.resolve({ allow: true, always: false });
	}

	const requestId = crypto.randomUUID();
	const kind = toolCall.kind || '';
	const command = toolCallCommand(toolCall);
	const title = toolCallLabel(toolCall, command) || (command ? '' : toolCall.title || kind || 'herramienta');
	const reason = humanizePolicyReason(decision.reason);
	const base = { requestId, title, kind, reason, command: command || undefined };
	emit(entry, {
		type: 'permission',
		...base,
		allow: false,
		pending: true
	});
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			entry.pendingPermissions.delete(requestId);
			emit(entry, {
				type: 'permission',
				...base,
				reason: 'tiempo agotado',
				allow: false,
				pending: false
			});
			resolve({ allow: false });
		}, PERMISSION_TIMEOUT_MS);
		timer.unref?.();
		entry.pendingPermissions.set(requestId, {
			resolve: (allow, opts) => {
				clearTimeout(timer);
				entry.pendingPermissions.delete(requestId);
				const scope = opts?.scope ?? 'once';
				if (allow && (scope === 'session' || scope === 'always')) {
					entry.sessionAllowDenied = true;
				}
				emit(entry, {
					type: 'permission',
					...base,
					reason: permissionReasonLabel(allow, scope, reason),
					allow,
					pending: false,
					quiet: opts?.quiet
				});
				resolve({ allow, always: allow && scope === 'always' });
			},
			timer
		});
	});
}

export function sessionInfo(id: string): AgentSessionInfo | null {
	const entry = sessions.get(id);
	return entry ? info(entry) : null;
}

/**
 * Con la CLI mirando (`DIFF_REVIEW_MIRROR=1`), solo fallos duros a la terminal.
 * El progreso (tools, permisos, mensajes) vive en la web.
 */
function mirror(_entry: Entry, event: AgentEvent) {
	if (process.env.DIFF_REVIEW_MIRROR !== '1') return;
	if (event.type === 'status' && event.status === 'error') {
		console.log(`✗ ${event.message || 'error del agente'}`);
	} else if (event.type === 'review' && event.ok) {
		console.log(`✓ JSON válido: ${event.filename}`);
	}
}

function emit(entry: Entry, event: AgentEvent) {
	let seq: number;
	if (event.type === 'text' && entry.textSeq?.kind === event.kind) {
		seq = entry.textSeq.seq;
	} else {
		seq = ++entry.seq;
		entry.textSeq = event.type === 'text' ? { kind: event.kind, seq } : null;
	}
	const full = { ...event, seq } as SeqEvent;
	mirror(entry, event);
	entry.events = applyEvent(entry.events, full);
	if (entry.events.length > MAX_EVENTS) entry.events = entry.events.slice(-MAX_EVENTS);
	for (const listener of entry.listeners) listener(full);
}

function setStatus(entry: Entry, status: SessionStatus, message?: string) {
	entry.status = status;
	// Solo persistimos mensaje en errores (la UI lo usa como fallback si el SSE llega tarde).
	// En starting/working el texto va en el evento, pero no debe quedar como "error" fantasma.
	if (status === 'error') {
		entry.statusMessage = message || entry.statusMessage || 'Error del agente.';
	} else if (message !== undefined) {
		delete entry.statusMessage;
	}
	emit(entry, {
		type: 'status',
		status,
		...(message || status === 'error' ? { message: message || entry.statusMessage } : {})
	});
}

/** SessionUpdate de ACP → evento de la web (lo que no se muestra se descarta). */
function toEvent(update: SessionUpdate): AgentEvent | null {
	switch (update.sessionUpdate) {
		case 'agent_message_chunk':
		case 'agent_thought_chunk': {
			const content = update.content;
			if (content.type !== 'text' || !content.text) return null;
			return {
				type: 'text',
				kind: update.sessionUpdate === 'agent_message_chunk' ? 'message' : 'thought',
				text: content.text
			};
		}
		case 'tool_call':
		case 'tool_call_update':
			return {
				type: 'tool',
				id: update.toolCallId,
				title: update.title ?? '',
				kind: update.kind ?? '',
				status: update.status ?? ''
			};
		case 'plan':
			return {
				type: 'plan',
				entries: update.entries.map((e) => ({ content: e.content, status: e.status }))
			};
		default:
			return null;
	}
}

function scheduleIdleClose(entry: Entry) {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		if (entry.busy || !entry.acp) return;
		entry.acp.close();
		entry.acp = null;
	}, IDLE_CLOSE_MS);
	entry.idleTimer.unref?.();
}

/** Aplica el modelo pedido a la sesión ACP viva (o no-op si ya está). */
async function applyAcpModel(entry: Entry, acp: AcpSession, model?: string) {
	const wanted = String(model || '').trim();
	if (!wanted) return acp;
	const result = await acp.setModel(wanted);
	// "default" (Claude) / "default[]" (Cursor) no dicen qué modelo es: se queda el que escriba el agente.
	if (result.currentModel && !result.currentModel.startsWith('default')) entry.model = result.currentModel;
	if (result.warning) emit(entry, { type: 'status', status: entry.status, message: result.warning });
	return acp;
}

/** Proceso del agente vivo para esta entrada: lo lanza, o lo relanza retomando la sesión. */
async function ensureAcp(entry: Entry, model?: string): Promise<AcpSession> {
	if (entry.acp) return applyAcpModel(entry, entry.acp, model);
	if (entry.starting) {
		const acp = await entry.starting;
		return applyAcpModel(entry, acp, model);
	}
	entry.starting = startAcpSession(entry.agent, {
		cwd: entry.repo,
		model,
		resumeSessionId: entry.acpSessionId || undefined,
		decide: (toolCall: ToolCallUpdate) =>
			decidePermission(toolCall, { repo: entry.repo, outputFilename: entry.outputFilename, mode: entry.mode }),
		onUpdate: (update) => {
			// `session/load` repite historia: no emitir hasta tener `entry.acp` (recién asignado al retomar).
			// Sesión nueva (`acpSessionId` vacío): emitir desde el primer update para que la web vea el progreso.
			if (!entry.acp && entry.acpSessionId) return;
			const event = toEvent(update);
			if (event) emit(entry, event);
		},
		onDeniedPermission: (toolCall, decision) => askUserPermission(entry, toolCall, decision),
		onPermission: (toolCall, decision) => {
			if (decision.allow) return;
			entry.rejections.push(`${toolCall.title || toolCall.kind || 'herramienta'} (${decision.reason})`);
		},
		onExit: ({ code, stderr }) => {
			const wasBusy = entry.busy;
			entry.acp = null;
			if (wasBusy) {
				entry.busy = false;
				const auth = authFailureMessage(entry.agentId, entry.agentLabel, stderr);
				if (auth) {
					setStatus(entry, 'error', auth);
					return;
				}
				const raw = stderr.trim() || `código ${code ?? '?'}`;
				const authFromCode = authFailureMessage(entry.agentId, entry.agentLabel, raw);
				if (authFromCode) {
					setStatus(entry, 'error', authFromCode);
					return;
				}
				const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' · ');
				setStatus(entry, 'error', `${entry.agentLabel} terminó (código ${code ?? '?'}). ${tail}`.trim());
			}
		}
	})
		.then((acp) => {
			const wanted = entry.acpSessionId;
			entry.acp = acp;
			entry.acpSessionId = acp.sessionId;
			if (wanted && !acp.resumed) {
				entry.needsContext = true;
				emit(entry, {
					type: 'status',
					status: entry.status,
					message:
						'No pude retomar la sesión anterior del agente: abro una nueva y le paso el contexto de la review.'
				});
			}
			try {
				writeSessionRef(entry.repo, entry.outputFilename, {
					agentId: entry.agentId,
					sessionId: acp.sessionId,
					...(entry.model ? { model: entry.model } : {})
				});
			} catch {
				/* sin .diff-review escribible: la sesión sigue en meta.agentSession del reporte */
			}
			if (acp.currentModel && !acp.currentModel.startsWith('default')) entry.model = acp.currentModel;
			if (acp.modelWarning) emit(entry, { type: 'status', status: entry.status, message: acp.modelWarning });
			return acp;
		})
		.finally(() => {
			entry.starting = null;
		});
	const acp = await entry.starting;
	return applyAcpModel(entry, acp, model);
}

function mtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Cuántas veces el server le pide solo al agente corregir/escribir el JSON antes de cortar con Reintentar. */
const OUTPUT_AUTO_RETRIES = 2;

/**
 * Después de un turno que podía escribir el JSON: validarlo, estamparle la sesión y, si quedó mal, pedirle al
 * agente que lo corrija (hasta `OUTPUT_AUTO_RETRIES` veces).
 */
function checkEntryReport(entry: Entry) {
	const path = companionPaths(entry.repo, entry.outputFilename).json;
	if (!existsSync(path)) return null;
	return {
		path,
		result: checkReportFile(path, {
			repo: entry.repo,
			branch: entry.branch,
			base: entry.base,
			...(entry.diffPaths?.length ? { paths: entry.diffPaths } : {})
		})
	};
}

/** Prompt cuando el JSON existe pero no pasa validación (auto-fix o Reintentar). */
function invalidJsonFixPrompt(entry: Entry, path: string, result: { ok: boolean; errors: string[]; notes: string[] }) {
	return `${formatCheckReport(path, validateCliCommand(entry.outputFilename), result)}

Critical: do NOT only bump meta.generatedAt or rewrite notes. Edit \`${outputRelPath(entry.outputFilename).replace(/\\/g, '/')}\` so every problem above is fixed (add blocks or skipped for each missing path). Do not claim success until coverage is complete.

${TOOL_RULES}

${SERVER_VALIDATES}`;
}

function noWriteFollowUpPrompt(entry: Entry): string {
	const rel = outputRelPath(entry.outputFilename);
	const rejected = entry.rejections.length
		? `These commands were rejected by diff-review's policy and did not run:\n${entry.rejections
				.slice(-5)
				.map((r) => `- ${r}`)
				.join('\n')}\n\n`
		: '';
	const posixRel = rel.replace(/\\/g, '/');
	const existing = checkEntryReport(entry);
	const invalidHint =
		existing && !existing.result.ok
			? `\nThe file on disk is also INVALID — fix these when you Write/Edit (do not only bump generatedAt):\n${(existing.result.errors || [])
					.map((e) => `- ${e}`)
					.join('\n')}\n`
			: '';
	return `${rejected}Your turn ended without writing \`${posixRel}\` in this turn (mtime must change now). The user did not stop you.
${invalidHint}
Do this now:
1. Read \`${posixRel}\` if it exists (required before Write/Edit on an existing file).
2. Edit or Write the full review JSON to that same path (forward slashes only).
Do NOT mkdir, and do NOT use shell redirection. Do not claim success just because an older file is present — overwrite it.

${TOOL_RULES}

${SERVER_VALIDATES}`;
}

async function checkOutput(entry: Entry, since: number, retriesLeft: number): Promise<void> {
	const path = companionPaths(entry.repo, entry.outputFilename).json;
	const touched = existsSync(path) && mtime(path) >= since;
	if (!touched) {
		// Redirect bloqueado, “éxito” sobre JSON viejo, etc.
		if (retriesLeft > 0) {
			const again = await followUp(
				entry,
				noWriteFollowUpPrompt(entry),
				entry.rejections.length
					? 'Seguí: hubo comandos rechazados; escribí el JSON con la tool de archivos.'
					: 'Seguí: el JSON no se escribió en este turno.'
			);
			return checkOutput(entry, again, retriesLeft - 1);
		}
		if (entry.mode === 'review') {
			emit(entry, {
				type: 'review',
				ok: false,
				filename: entry.outputFilename,
				errors: [`${entry.agentLabel} terminó sin escribir ${entry.outputFilename}.`],
				final: true
			});
		}
		return;
	}

	const result = checkReportFile(path, {
		repo: entry.repo,
		branch: entry.branch,
		base: entry.base,
		...(entry.diffPaths?.length ? { paths: entry.diffPaths } : {})
	});
	if (result.ok) {
		stampReviewProvenance(path, {
			agent: entry.agentLabel,
			model: entry.model,
			agentSession: { agentId: entry.agentId, sessionId: entry.acpSessionId, outputFilename: entry.outputFilename }
		});
		emit(entry, { type: 'review', ok: true, filename: entry.outputFilename, errors: [], final: true });
		return;
	}

	const canRetry = retriesLeft > 0;
	emit(entry, { type: 'review', ok: false, filename: entry.outputFilename, errors: result.errors, final: !canRetry });
	if (!canRetry) return;
	const again = await followUp(
		entry,
		invalidJsonFixPrompt(entry, path, result),
		'Corregí los errores de validación del JSON.'
	);
	await checkOutput(entry, again, retriesLeft - 1);
}

/** Turno extra que pide el server (corregir el JSON, seguir después de un rechazo). Devuelve cuándo empezó. */
async function followUp(entry: Entry, prompt: string, shown: string): Promise<number> {
	emit(entry, { type: 'user', text: shown, mode: 'fix' });
	const acp = await ensureAcp(entry);
	const started = Date.now();
	entry.rejections = [];
	const { stopReason } = await acp.prompt(prompt);
	emit(entry, { type: 'turn', stopReason });
	return started;
}

async function runTurn(entry: Entry, text: string, mode: PolicyMode, opts: { model?: string; shown: string }) {
	if (entry.busy) throw new Error('El agente todavía está trabajando en el pedido anterior.');
	entry.busy = true;
	entry.mode = mode;
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	emit(entry, { type: 'user', text: opts.shown, mode: mode === 'review' ? 'review' : mode });
	try {
		if (!entry.acp) setStatus(entry, 'starting', `Lanzando ${entry.agentLabel}…`);
		const acp = await ensureAcp(entry, opts.model);
		setStatus(entry, 'working', 'El agente está revisando…');
		const since = Date.now();
		entry.rejections = [];
		const { stopReason } = await acp.prompt(text);
		emit(entry, { type: 'turn', stopReason });
		if (mode !== 'ask' && stopReason !== 'cancelled') await checkOutput(entry, since, OUTPUT_AUTO_RETRIES);
		entry.busy = false;
		setStatus(entry, 'idle');
	} catch (err) {
		entry.busy = false;
		const raw = err instanceof Error ? err.message : String(err);
		const auth = authFailureMessage(entry.agentId, entry.agentLabel, raw);
		setStatus(entry, 'error', auth || raw);
	} finally {
		scheduleIdleClose(entry);
	}
}

function newEntry(agent: DetectedAgent, fields: {
	repo: string;
	branch: string;
	base: string;
	outputFilename: string;
	model: string;
	acpSessionId?: string;
	id?: string;
}): Entry {
	const acpSessionId = fields.acpSessionId ?? '';
	const entry: Entry = {
		id: fields.id || crypto.randomUUID(),
		agentId: agent.def.id,
		agentLabel: agent.def.label,
		model: fields.model,
		repo: fields.repo,
		branch: fields.branch,
		base: fields.base,
		outputFilename: fields.outputFilename,
		acpSessionId,
		status: 'idle',
		busy: false,
		agent,
		acp: null,
		starting: null,
		mode: 'ask',
		events: [],
		seq: 0,
		textSeq: null,
		listeners: new Set(),
		idleTimer: null,
		rejections: [],
		// openChat lo prende si la sesión es nueva o no se pudo retomar; startReview no lo usa.
		needsContext: false,
		seed: null,
		diffPaths: null,
		pendingPermissions: new Map(),
		sessionAllowDenied: false,
		cancelled: false
	};
	sessions.set(entry.id, entry);
	return entry;
}

/** Lanza la review con el agente elegido. Devuelve el id de la sesión enseguida; el resto llega por SSE. */
export function startReview(input: {
	repo: string;
	branch: string;
	base: string;
	outputFilename: string;
	agentId: string;
	model?: string;
	/** Id fijado de antemano (la CLI lo elige para abrir la URL antes de que arranque el server). */
	id?: string;
}): AgentSessionInfo {
	const agent = findAgent(input.agentId);
	const entry = newEntry(agent, { ...input, model: input.model || '' });
	emit(entry, { type: 'phase', phase: 'diff', detail: 'Calculando el diff…' });
	setStatus(entry, 'starting', 'Calculando el diff…');
	// Devolver ya la sesión y seguir en el event loop: la UI puede suscribirse y mostrar
	// "calculando el diff" mientras preparamos el contexto.
	void continueReviewAfterDiff(entry, input);
	return info(entry);
}

async function continueReviewAfterDiff(
	entry: Entry,
	input: {
		repo: string;
		branch: string;
		base: string;
		outputFilename: string;
		model?: string;
	}
) {
	// Cedé el event loop para que SSE/HTTP atiendan antes del prep (git puede tardar).
	await new Promise<void>((resolve) => setImmediate(resolve));
	if (!sessions.has(entry.id) || entry.cancelled) return;

	let promptOpts: ReturnType<typeof prepareReviewPromptOpts> = {
		outputFilename: input.outputFilename,
		acp: true,
		diffRelPath: null,
		files: [],
		ignored: [],
		ignoreGlobs: []
	};
	try {
		promptOpts = prepareReviewPromptOpts({
			repo: input.repo,
			branch: input.branch,
			base: input.base,
			outputFilename: input.outputFilename,
			acp: true
		});
		if (entry.cancelled || !sessions.has(entry.id)) return;
		entry.diffPaths = (promptOpts.files || []).map((f) => f.path);
		const n = entry.diffPaths.length;
		const detail =
			n > 0
				? `Diff listo · ${n} archivo${n === 1 ? '' : 's'}. Pasando el contexto al agente…`
				: 'Diff listo. Pasando el contexto al agente…';
		emit(entry, { type: 'phase', phase: 'diff', detail });
		setStatus(entry, 'starting', detail);
	} catch (err) {
		if (entry.cancelled || !sessions.has(entry.id)) return;
		const msg = `No pude precomputar el diff (${err instanceof Error ? err.message : String(err)}); el agente lo resolverá.`;
		emit(entry, { type: 'phase', phase: 'diff', detail: msg });
		emit(entry, { type: 'status', status: entry.status, message: msg });
	}

	if (!sessions.has(entry.id) || entry.cancelled) return;
	emit(entry, { type: 'phase', phase: 'agent', detail: 'El agente está revisando el branch…' });
	const review = buildPrompt(
		{
			source: 'local',
			repo: input.repo,
			branch: input.branch,
			base: input.base,
			remoteUrl: getRemoteUrl(input.repo) || undefined
		},
		promptOpts
	);
	const prompt = `${review}\n\n${TOOL_RULES}\n\n${SERVER_VALIDATES}`;
	void runTurn(entry, prompt, 'review', {
		model: input.model,
		shown: `Review de ${input.branch} contra ${input.base}`
	});
}

/**
 * Sesión para chatear sobre un reporte: la que sigue viva en este server, o una nueva que retoma la del agente.
 * `sessionId` vacío = sesión brand-new (`session/new`) con `needsContext` desde el inicio.
 * Opcional `seed` (JSON + diff del reporte abierto) para materializarlos en `.diff-review/` antes del primer turno.
 */
export async function openChat(input: {
	agentId: string;
	sessionId?: string;
	outputFilename: string;
	repo: string;
	branch: string;
	base: string;
	model?: string;
	seed?: { payload?: unknown; diff?: string } | null;
}): Promise<AgentSessionInfo> {
	const sessionId = String(input.sessionId || '').trim();
	if (sessionId) {
		for (const entry of sessions.values()) {
			if (entry.acpSessionId === sessionId && entry.repo === input.repo) {
				if (input.seed) entry.seed = input.seed;
				return info(entry);
			}
		}
	}
	const agent = findAgent(input.agentId);
	const entry = newEntry(agent, {
		...input,
		model: input.model || '',
		acpSessionId: sessionId
	});
	if (input.seed) entry.seed = input.seed;
	if (!sessionId) entry.needsContext = true;
	// Lanzar el proceso ya: la UI puede persistir acpSessionId y encolar el primer mensaje.
	try {
		if (!entry.acp) setStatus(entry, 'starting', `Lanzando ${entry.agentLabel}…`);
		await ensureAcp(entry, input.model);
		if (entry.status === 'starting') setStatus(entry, 'idle');
	} catch (err) {
		const raw = err instanceof Error ? err.message : String(err);
		const auth = authFailureMessage(entry.agentId, entry.agentLabel, raw);
		setStatus(entry, 'error', auth || raw);
	}
	return info(entry);
}

export function sendMessage(
	id: string,
	text: string,
	mode: ChatMode,
	opts?: { model?: string }
): AgentSessionInfo {
	const entry = sessions.get(id);
	if (!entry) throw new Error('La sesión del agente ya no existe. Recargá la página.');
	const body = text.trim();
	if (!body) throw new Error('El mensaje está vacío.');
	if (entry.busy) throw new Error('El agente todavía está trabajando en el pedido anterior.');
	let agentText = body;
	if (entry.needsContext) {
		agentText = `${contextPreamble(entry)}\n${body}`;
		entry.needsContext = false;
		entry.seed = null;
	}
	const prompt =
		mode === 'edit'
			? `${agentText}\n\nApply this by editing ${entry.outputFilename} in place (keep everything else as is). Reply briefly in Spanish with what you changed.\n\n${SERVER_VALIDATES}`
			: `${agentText}\n\nAnswer in Spanish. This is a question about the review: do not modify any file.`;
	const model = String(opts?.model || '').trim() || undefined;
	void runTurn(entry, prompt, mode, { shown: body, model });
	return info(entry);
}

/**
 * Reintento manual tras un turno de review que no dejó el JSON válido (p. ej. redirect bloqueado o JSON viejo).
 * Misma sesión ACP; no recalcula el diff.
 * Si el JSON ya existe e inválido, reenvía los errores concretos (cobertura faltante, etc.) — no un “escribí de nuevo” genérico.
 */
export function retryReview(id: string): AgentSessionInfo {
	const entry = sessions.get(String(id || ''));
	if (!entry) throw new Error('La sesión del agente ya no existe. Recargá la página.');
	if (entry.busy) throw new Error('El agente todavía está trabajando en el pedido anterior.');
	if (entry.status === 'error') {
		throw new Error(entry.statusMessage || 'La sesión está en error; iniciá una nueva review.');
	}
	const rel = outputRelPath(entry.outputFilename);
	const posixRel = rel.replace(/\\/g, '/');
	const existing = checkEntryReport(entry);
	const prompt =
		existing && !existing.result.ok
			? invalidJsonFixPrompt(entry, existing.path, existing.result)
			: `Continue the code review. For \`${posixRel}\`: Read it first if it exists, then Edit/Write the full JSON (forward slashes only). Do not mkdir. Never use shell redirection.

${TOOL_RULES}

${SERVER_VALIDATES}`;
	void runTurn(entry, prompt, 'review', {
		shown:
			existing && !existing.result.ok
				? 'Reintentar: corregir el JSON inválido'
				: 'Reintentar: escribir el JSON de la review'
	});
	return info(entry);
}

/**
 * Respuesta del usuario a permiso(s) pendiente(s).
 * `scope`: once (default) | session (no volver a preguntar en esta sesión) | always (ACP allow_always).
 * `allowAll` / `requestIds` resuelven en lote (misma scope para todos).
 */
export function respondPermission(input: {
	id: string;
	requestId?: string;
	requestIds?: string[];
	allow: boolean;
	allowAll?: boolean;
	scope?: PermissionScope;
}): AgentSessionInfo {
	const entry = sessions.get(String(input.id || ''));
	if (!entry) throw new Error('La sesión del agente ya no existe. Recargá la página.');

	const allow = Boolean(input.allow);
	const scope: PermissionScope =
		input.scope === 'session' || input.scope === 'always' ? input.scope : 'once';
	if (allow && (scope === 'session' || scope === 'always')) {
		entry.sessionAllowDenied = true;
	}

	let ids: string[];
	if (input.allowAll) {
		ids = [...entry.pendingPermissions.keys()];
	} else if (Array.isArray(input.requestIds) && input.requestIds.length) {
		ids = input.requestIds.map((id) => String(id || '')).filter(Boolean);
	} else {
		const one = String(input.requestId || '');
		ids = one ? [one] : [];
	}
	if (!ids.length) throw new Error('No hay pedidos de permiso pendientes.');

	const batch = ids.length > 1 || Boolean(input.allowAll);
	let resolved = 0;
	for (const requestId of ids) {
		const pending = entry.pendingPermissions.get(requestId);
		if (!pending) {
			if (!batch) throw new Error('Ese pedido de permiso ya no está pendiente.');
			continue;
		}
		pending.resolve(allow, { quiet: batch, scope });
		resolved += 1;
	}
	if (!resolved) throw new Error('Ese pedido de permiso ya no está pendiente.');
	if (batch) {
		emit(entry, { type: 'permission_summary', allow, count: resolved });
	}
	return info(entry);
}

/**
 * Activa/desactiva “confiar en esta sesión” (no pedir confirmación cuando la política niega).
 * Al activar, aprueba los pedidos pendientes actuales.
 */
export function setPermissionTrust(id: string, enabled: boolean): AgentSessionInfo {
	const entry = sessions.get(String(id || ''));
	if (!entry) throw new Error('La sesión del agente ya no existe. Recargá la página.');

	entry.sessionAllowDenied = Boolean(enabled);
	if (enabled) {
		const ids = [...entry.pendingPermissions.keys()];
		let resolved = 0;
		for (const requestId of ids) {
			const pending = entry.pendingPermissions.get(requestId);
			if (!pending) continue;
			pending.resolve(true, { quiet: ids.length > 1, scope: 'session' });
			resolved += 1;
		}
		if (resolved > 1) {
			emit(entry, { type: 'permission_summary', allow: true, count: resolved });
		}
		emit(entry, {
			type: 'status',
			status: entry.status,
			message: 'Confianza de sesión: no se pedirá confirmación de permisos.'
		});
	} else {
		emit(entry, {
			type: 'status',
			status: entry.status,
			message: 'Confianza de sesión desactivada: se vuelve a pedir confirmación.'
		});
	}
	return info(entry);
}

export async function cancelTurn(id: string): Promise<void> {
	const entry = sessions.get(id);
	if (!entry) return;
	entry.cancelled = true;
	if (entry.acp && entry.busy) {
		await entry.acp.cancel();
		return;
	}
	// Aún en “preparando el contexto” (sin ACP): cortar el prep y avisar a la UI.
	entry.busy = false;
	setStatus(entry, 'error', 'Cancelado.');
}

export function subscribe(id: string, listener: Listener): (() => void) | null {
	const entry = sessions.get(id);
	if (!entry) return null;
	listener({ type: 'reset' });
	for (const event of entry.events) listener(event);
	entry.listeners.add(listener);
	return () => entry.listeners.delete(listener);
}

/**
 * Review que pidió la CLI al lanzar el server (`DIFF_REVIEW_AGENT_RUN`, JSON). Se arranca una sola vez, al iniciar,
 * así corre aunque no se abra el navegador.
 */
export function startPendingAgentRun() {
	const raw = String(process.env.DIFF_REVIEW_AGENT_RUN || '').trim();
	if (!raw) return;
	delete process.env.DIFF_REVIEW_AGENT_RUN;
	try {
		const run = JSON.parse(raw) as Parameters<typeof startReview>[0];
		startReview(run);
	} catch (err) {
		console.error('[diff-review agent] no pude lanzar la review pedida por la CLI:', err instanceof Error ? err.message : err);
	}
}
