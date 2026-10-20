import { error } from '@sveltejs/kit';
import { command, query } from '$app/server';
import {
	agentModels,
	cancelTurn,
	closeChat as closeChatSession,
	listAcpAgents,
	loginCommand,
	openAgentLogin as openAgentLoginSession,
	openChat as openChatSession,
	respondPermission as respondSessionPermission,
	retryReview as retryReviewSession,
	sendMessage as sendSessionMessage,
	sessionInfo,
	setPermissionTrust as setSessionPermissionTrust,
	startReview as startReviewSession
} from '$lib/server/agent-sessions';
import { resolveOutputName } from '$lib/server/git-review';
import type { AcpAgentOption, AcpModels, AgentSessionInfo, ChatMode } from './agent-events';

function fail(err: unknown): never {
	const message = err instanceof Error ? err.message : String(err);
	console.error('[diff-review agent]', message);
	error(400, message);
}

/** Agentes instalados que se pueden lanzar desde la web (los que hablan ACP). */
export const acpAgents = query(async (): Promise<AcpAgentOption[]> => {
	try {
		return listAcpAgents();
	} catch (err) {
		console.error('[diff-review agent] detect', err);
		return [];
	}
});

/**
 * Modelos reales del agente (por ACP). La primera consulta tarda unos segundos: abre una sesión de prueba.
 * Si falla, devuelve `error` + lista vacía (la UI mantiene el fallback y puede reintentar con `force`).
 */
export const acpAgentModels = query(
	'unchecked',
	async (input: {
		agentId: string;
		repo: string;
		force?: boolean;
	}): Promise<AcpModels> => {
		try {
			return await agentModels(
				String(input?.agentId || ''),
				String(input?.repo || '').trim() || process.cwd(),
				{ force: Boolean(input?.force) }
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error('[diff-review agent] models', message);
			return { models: [], currentModel: '', error: message };
		}
	}
);

export const agentSession = query('unchecked', async (input: { id: string }): Promise<AgentSessionInfo | null> =>
	sessionInfo(String(input?.id || ''))
);

export const startReview = command(
	'unchecked',
	async (input: { repo: string; branch: string; base: string; agentId: string; model?: string }): Promise<AgentSessionInfo> => {
		try {
			const repo = String(input?.repo || '').trim();
			const branch = String(input?.branch || '').trim();
			const base = String(input?.base || 'develop').trim();
			if (!repo || !branch) throw new Error('Faltan repo y branch.');
			const { filename } = resolveOutputName(repo, branch, base);
			return startReviewSession({
				repo,
				branch,
				base,
				outputFilename: filename,
				agentId: String(input?.agentId || ''),
				model: String(input?.model || '').trim() || undefined
			});
		} catch (err) {
			fail(err);
		}
	}
);

export type OpenChatInput = {
	agentId: string;
	/** Vacío = sesión nueva (`session/new` + needsContext). */
	sessionId?: string;
	outputFilename: string;
	repo: string;
	branch: string;
	base: string;
	model?: string;
	/** JSON (sin files) + diff del reporte abierto, para materializar en `.diff-review/`. */
	seed?: { payload?: unknown; diff?: string } | null;
	/** Nota de handoff (cambio de agente) antepuesta al preamble del primer mensaje. */
	handoffNote?: string;
	/** Markdown legible del chat anterior → companion `.chat.md` en `.diff-review/`. */
	handoffChatMarkdown?: string;
};

export const openChat = command('unchecked', async (input: OpenChatInput): Promise<AgentSessionInfo> => {
	try {
		const outputFilename =
			String(input?.outputFilename || '').trim() ||
			resolveOutputName(
				String(input?.repo || '').trim(),
				String(input?.branch || '').trim(),
				String(input?.base || 'develop').trim()
			).filename;
		return await openChatSession({
			agentId: String(input?.agentId || ''),
			sessionId: String(input?.sessionId || ''),
			outputFilename,
			repo: String(input?.repo || '').trim(),
			branch: String(input?.branch || '').trim(),
			base: String(input?.base || 'develop').trim(),
			model: input?.model,
			seed: input?.seed ?? null,
			handoffNote: String(input?.handoffNote || '').trim() || undefined,
			handoffChatMarkdown:
				input?.handoffChatMarkdown != null ? String(input.handoffChatMarkdown) : undefined
		});
	} catch (err) {
		fail(err);
	}
});

export const sendMessage = command(
	'unchecked',
	async (input: {
		id: string;
		text: string;
		mode: ChatMode;
		model?: string;
		handoffNote?: string;
		handoffChatMarkdown?: string;
	}): Promise<AgentSessionInfo> => {
		try {
			const mode: ChatMode =
				input?.mode === 'edit' ? 'edit' : input?.mode === 'fix' ? 'fix' : 'ask';
			return sendSessionMessage(String(input?.id || ''), String(input?.text || ''), mode, {
				model: String(input?.model || '').trim() || undefined,
				handoffNote: String(input?.handoffNote || '').trim() || undefined,
				handoffChatMarkdown:
					input?.handoffChatMarkdown != null ? String(input.handoffChatMarkdown) : undefined
			});
		} catch (err) {
			fail(err);
		}
	}
);

export const respondPermission = command(
	'unchecked',
	async (input: {
		id: string;
		requestId?: string;
		requestIds?: string[];
		allow: boolean;
		allowAll?: boolean;
		scope?: 'once' | 'session' | 'always';
	}): Promise<AgentSessionInfo> => {
		try {
			const requestIds = Array.isArray(input?.requestIds)
				? input.requestIds.map((id) => String(id || '')).filter(Boolean)
				: undefined;
			const scope =
				input?.scope === 'session' || input?.scope === 'always' ? input.scope : 'once';
			return respondSessionPermission({
				id: String(input?.id || ''),
				requestId: input?.requestId != null ? String(input.requestId) : undefined,
				requestIds,
				allow: Boolean(input?.allow),
				allowAll: Boolean(input?.allowAll),
				scope
			});
		} catch (err) {
			fail(err);
		}
	}
);

/** Activa/desactiva “confiar en esta sesión” (bypass de confirmaciones de permiso). */
export const setPermissionTrust = command(
	'unchecked',
	async (input: { id: string; enabled: boolean }): Promise<AgentSessionInfo> => {
		try {
			return setSessionPermissionTrust(String(input?.id || ''), Boolean(input?.enabled));
		} catch (err) {
			fail(err);
		}
	}
);

export const cancelAgent = command('unchecked', async (input: { id: string }): Promise<void> => {
	await cancelTurn(String(input?.id || ''));
});

/** Cierra la sesión ACP del server (cambio de agente). No toca el reporte ni el triage. */
export const closeChat = command('unchecked', async (input: { id: string }): Promise<void> => {
	await closeChatSession(String(input?.id || ''));
});

/** Reintenta escribir/validar el JSON en la misma sesión de review. */
export const retryReview = command(
	'unchecked',
	async (input: { id: string }): Promise<AgentSessionInfo> => {
		try {
			return retryReviewSession(String(input?.id || ''));
		} catch (err) {
			fail(err);
		}
	}
);

/** Abre una terminal con el login del agente (p. ej. `claude /login`). */
export const openAgentLogin = command(
	'unchecked',
	async (input: { agentId: string }): Promise<{ display: string; hint?: string }> => {
		try {
			const agentId = String(input?.agentId || '');
			const result = openAgentLoginSession(agentId);
			const cmd = loginCommand(agentId);
			return {
				display: result.display,
				...(cmd ? { hint: `Completá el login y después reintentá la review.` } : {})
			};
		} catch (err) {
			fail(err);
		}
	}
);
