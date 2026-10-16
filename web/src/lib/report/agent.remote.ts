import { error } from '@sveltejs/kit';
import { command, query } from '$app/server';
import {
	agentModels,
	cancelTurn,
	listAcpAgents,
	openChat as openChatSession,
	sendMessage as sendSessionMessage,
	sessionInfo,
	startReview as startReviewSession
} from '$lib/server/agent-sessions';
import { resolveOutputName } from '$lib/server/git-review';
import type { AcpAgentOption, AcpModels, AgentSessionInfo, ChatMode } from './agent-events';
import type { AgentSessionRef } from './types';

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

/** Modelos reales del agente (por ACP). La primera consulta tarda unos segundos: abre una sesión de prueba. */
export const acpAgentModels = query(
	'unchecked',
	async (input: { agentId: string; repo: string }): Promise<AcpModels | null> => {
		try {
			return await agentModels(String(input?.agentId || ''), String(input?.repo || '').trim() || process.cwd());
		} catch (err) {
			console.error('[diff-review agent] models', err instanceof Error ? err.message : err);
			return null;
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

export const openChat = command(
	'unchecked',
	async (input: AgentSessionRef & { repo: string; branch: string; base: string; model?: string }): Promise<AgentSessionInfo> => {
		try {
			return openChatSession({
				agentId: String(input?.agentId || ''),
				sessionId: String(input?.sessionId || ''),
				outputFilename: String(input?.outputFilename || ''),
				repo: String(input?.repo || '').trim(),
				branch: String(input?.branch || '').trim(),
				base: String(input?.base || 'develop').trim(),
				model: input?.model
			});
		} catch (err) {
			fail(err);
		}
	}
);

export const sendMessage = command(
	'unchecked',
	async (input: { id: string; text: string; mode: ChatMode }): Promise<AgentSessionInfo> => {
		try {
			return sendSessionMessage(String(input?.id || ''), String(input?.text || ''), input?.mode === 'edit' ? 'edit' : 'ask');
		} catch (err) {
			fail(err);
		}
	}
);

export const cancelAgent = command('unchecked', async (input: { id: string }): Promise<void> => {
	await cancelTurn(String(input?.id || ''));
});
