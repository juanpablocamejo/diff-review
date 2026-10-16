/**
 * Sesiones con agentes por ACP, del lado del server: el server es dueño del proceso del agente y la web lo sigue
 * por SSE (`/api/agent/[id]/events`). Una sesión genera la review y después queda viva para preguntas y cambios.
 *
 * Todo vive en memoria. Si el server se reinicia, el reporte guarda `meta.agentSession` y `openChat` retoma la
 * sesión del agente (`session/load`) si el agente lo soporta.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { detectAgents, modelChoices, type DetectedAgent } from '$review/lib/agents.mjs';
import { listAcpModels, startAcpSession, supportsAcp, type AcpSession } from '$review/lib/acp.mjs';
import { decidePermission, type PolicyMode } from '$review/lib/acp-policy.mjs';
import { checkReportFile, formatCheckReport } from '$review/lib/check-report.mjs';
import { stampReviewProvenance } from '$review/lib/review-meta.mjs';
import { buildPrompt, validateCliCommand } from '$review/lib/prompt.mjs';
import { getRemoteUrl } from '$review/lib/git.mjs';
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
};

/**
 * En estas sesiones valida el server al terminar cada turno (y le devuelve los errores al agente): correr el
 * validate por npx es lento y puede resolver otra versión del paquete.
 */
/** Para que el agente no gaste turnos en comandos que la política va a rechazar. */
const TOOL_RULES =
	'Tool rules for this session: read files with your file tools (read/search/glob). In the terminal only read-only commands run (git diff/log/show/blame/…, cat, head, tail, grep, rg, find, ls, wc, sed -n). No redirections to files, no command substitution, no installs, no network. Anything else is rejected automatically: do not retry it, use another read-only way.';

const SERVER_VALIDATES =
	'Note: in this session diff-review validates the JSON automatically when your turn ends and sends you any problems. Do not run the validate command yourself.';

/** Sin actividad por este tiempo se cierra el proceso del agente (se retoma con `session/load`). */
const IDLE_CLOSE_MS = 30 * 60 * 1000;
const MAX_EVENTS = 4000;

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

/** Modelos que ofrece el agente por ACP (abre una sesión de prueba la primera vez; después, de la caché). */
export function agentModels(agentId: string, cwd: string): Promise<AcpModels> {
	let hit = modelsCache.get(agentId);
	if (!hit) {
		hit = listAcpModels(findAgent(agentId), { cwd });
		hit.catch(() => modelsCache.delete(agentId));
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
	const { id, agentId, agentLabel, model, repo, branch, base, outputFilename, status, busy } = entry;
	return { id, agentId, agentLabel, model, repo, branch, base, outputFilename, status, busy };
}

export function sessionInfo(id: string): AgentSessionInfo | null {
	const entry = sessions.get(id);
	return entry ? info(entry) : null;
}

/** Con la CLI mirando (`DIFF_REVIEW_MIRROR=1`), un resumen de cada sesión va también a la terminal. */
function mirror(entry: Entry, event: AgentEvent) {
	if (process.env.DIFF_REVIEW_MIRROR !== '1') return;
	const line = (() => {
		switch (event.type) {
			case 'user':
				return `» ${event.text}`;
			case 'tool': {
				// El título con detalle (comando, archivo) llega en un update: se imprime al terminar la tool.
				if (event.status !== 'completed' && event.status !== 'failed') return null;
				const prev = entry.events.find((e) => e.type === 'tool' && e.id === event.id);
				const title = event.title || (prev?.type === 'tool' ? prev.title : '') || event.kind;
				return `  ${event.status === 'completed' ? '·' : '✗'} ${title}`;
			}
			case 'permission':
				return `  ✗ rechazado: ${event.title} (${event.reason})`;
			case 'review':
				return event.ok ? `✓ JSON válido: ${event.filename}` : `✗ JSON inválido (${event.errors.length} error(es))`;
			case 'status':
				return event.status === 'error' ? `✗ ${event.message || 'error del agente'}` : null;
			default:
				return null;
		}
	})();
	if (line) console.log(line);
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
	emit(entry, { type: 'status', status, ...(message ? { message } : {}) });
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

/** Proceso del agente vivo para esta entrada: lo lanza, o lo relanza retomando la sesión. */
function ensureAcp(entry: Entry, model?: string): Promise<AcpSession> {
	if (entry.acp) return Promise.resolve(entry.acp);
	if (entry.starting) return entry.starting;
	entry.starting = startAcpSession(entry.agent, {
		cwd: entry.repo,
		model,
		resumeSessionId: entry.acpSessionId || undefined,
		decide: (toolCall: ToolCallUpdate) =>
			decidePermission(toolCall, { repo: entry.repo, outputFilename: entry.outputFilename, mode: entry.mode }),
		onUpdate: (update) => {
			// Al retomar con `session/load` el agente repite la historia: la web ya la tiene en el reporte.
			if (!entry.acp) return;
			const event = toEvent(update);
			if (event) emit(entry, event);
		},
		onPermission: (toolCall, decision) => {
			if (decision.allow) return;
			entry.rejections.push(`${toolCall.title || toolCall.kind || 'herramienta'} (${decision.reason})`);
			emit(entry, {
				type: 'permission',
				title: toolCall.title || toolCall.kind || 'herramienta',
				allow: false,
				reason: decision.reason
			});
		},
		onExit: ({ code, stderr }) => {
			const wasBusy = entry.busy;
			entry.acp = null;
			if (wasBusy) {
				const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' · ');
				setStatus(entry, 'error', `${entry.agentLabel} terminó (código ${code ?? '?'}). ${tail}`.trim());
			}
		}
	})
		.then((acp) => {
			entry.acp = acp;
			entry.acpSessionId = acp.sessionId;
			// "default" (Claude) / "default[]" (Cursor) no dicen qué modelo es: se queda el que escriba el agente.
			if (acp.currentModel && !acp.currentModel.startsWith('default')) entry.model = acp.currentModel;
			if (acp.modelWarning) emit(entry, { type: 'status', status: entry.status, message: acp.modelWarning });
			return acp;
		})
		.finally(() => {
			entry.starting = null;
		});
	return entry.starting;
}

function mtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Después de un turno que podía escribir el JSON: validarlo, estamparle la sesión y, si quedó mal, pedirle al
 * agente que lo corrija (una vez).
 */
async function checkOutput(entry: Entry, since: number, retry: boolean): Promise<void> {
	const path = join(entry.repo, entry.outputFilename);
	const touched = existsSync(path) && mtime(path) >= since;
	if (!touched) {
		// Algunos agentes (Copilot) cortan el turno cuando se les rechaza un comando, como si el usuario los frenara.
		if (retry && entry.rejections.length) {
			const list = entry.rejections
				.slice(-5)
				.map((r) => `- ${r}`)
				.join('\n');
			const goal = entry.mode === 'review' ? ` by writing ${entry.outputFilename}` : '';
			const again = await followUp(
				entry,
				`These commands were rejected by diff-review's policy and did not run:\n${list}\n\nThe user did not stop you: continue the task with read-only alternatives (your file tools, or allowed commands without redirections) and finish it${goal}.\n\n${TOOL_RULES}\n\n${SERVER_VALIDATES}`,
				'Seguí: hubo comandos rechazados por la política.'
			);
			return checkOutput(entry, again, false);
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

	const result = checkReportFile(path, { repo: entry.repo, branch: entry.branch, base: entry.base });
	if (result.ok) {
		stampReviewProvenance(path, {
			agent: entry.agentLabel,
			model: entry.model,
			agentSession: { agentId: entry.agentId, sessionId: entry.acpSessionId, outputFilename: entry.outputFilename }
		});
		emit(entry, { type: 'review', ok: true, filename: entry.outputFilename, errors: [], final: true });
		return;
	}

	emit(entry, { type: 'review', ok: false, filename: entry.outputFilename, errors: result.errors, final: !retry });
	if (!retry) return;
	const fixPrompt = `${formatCheckReport(path, validateCliCommand(entry.outputFilename), result)}\n\n${SERVER_VALIDATES}`;
	const again = await followUp(entry, fixPrompt, 'Corregí los errores de validación del JSON.');
	await checkOutput(entry, again, false);
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
		setStatus(entry, 'working');
		const since = Date.now();
		entry.rejections = [];
		const { stopReason } = await acp.prompt(text);
		emit(entry, { type: 'turn', stopReason });
		if (mode !== 'ask' && stopReason !== 'cancelled') await checkOutput(entry, since, true);
		entry.busy = false;
		setStatus(entry, 'idle');
	} catch (err) {
		entry.busy = false;
		setStatus(entry, 'error', err instanceof Error ? err.message : String(err));
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
	const entry: Entry = {
		id: fields.id || crypto.randomUUID(),
		agentId: agent.def.id,
		agentLabel: agent.def.label,
		model: fields.model,
		repo: fields.repo,
		branch: fields.branch,
		base: fields.base,
		outputFilename: fields.outputFilename,
		status: 'idle',
		busy: false,
		agent,
		acpSessionId: fields.acpSessionId ?? '',
		acp: null,
		starting: null,
		mode: 'ask',
		events: [],
		seq: 0,
		textSeq: null,
		listeners: new Set(),
		idleTimer: null,
		rejections: []
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
	const review = buildPrompt(
		{
			source: 'local',
			repo: input.repo,
			branch: input.branch,
			base: input.base,
			remoteUrl: getRemoteUrl(input.repo) || undefined
		},
		{ outputFilename: input.outputFilename }
	);
	const prompt = `${review}\n\n${TOOL_RULES}\n\n${SERVER_VALIDATES}`;
	void runTurn(entry, prompt, 'review', {
		model: input.model,
		shown: `Review de ${input.branch} contra ${input.base}`
	});
	return info(entry);
}

/**
 * Sesión para chatear sobre un reporte: la que sigue viva en este server, o una nueva que retoma la del agente
 * (el proceso se lanza recién con el primer mensaje).
 */
export function openChat(input: {
	agentId: string;
	sessionId: string;
	outputFilename: string;
	repo: string;
	branch: string;
	base: string;
	model?: string;
}): AgentSessionInfo {
	for (const entry of sessions.values()) {
		if (entry.acpSessionId === input.sessionId && entry.repo === input.repo) return info(entry);
	}
	const agent = findAgent(input.agentId);
	const entry = newEntry(agent, { ...input, model: input.model || '', acpSessionId: input.sessionId });
	return info(entry);
}

export function sendMessage(id: string, text: string, mode: ChatMode): AgentSessionInfo {
	const entry = sessions.get(id);
	if (!entry) throw new Error('La sesión del agente ya no existe. Recargá la página.');
	const body = text.trim();
	if (!body) throw new Error('El mensaje está vacío.');
	if (entry.busy) throw new Error('El agente todavía está trabajando en el pedido anterior.');
	const prompt =
		mode === 'edit'
			? `${body}\n\nApply this by editing ${entry.outputFilename} in place (keep everything else as is). Reply briefly in Spanish with what you changed.\n\n${SERVER_VALIDATES}`
			: `${body}\n\nAnswer in Spanish. This is a question about the review: do not modify any file.`;
	void runTurn(entry, prompt, mode, { shown: body });
	return info(entry);
}

export async function cancelTurn(id: string): Promise<void> {
	const entry = sessions.get(id);
	if (!entry?.acp || !entry.busy) return;
	await entry.acp.cancel();
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
