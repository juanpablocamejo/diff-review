<script lang="ts">
	import { untrack } from 'svelte';
	import AgentLog from './AgentLog.svelte';
	import { cancelAgent, openChat, sendMessage } from './agent.remote';
	import type { AgentSessionInfo, ChatMode, SeqEvent } from './agent-events';
	import { AgentStream } from './agent-stream.svelte';
	import { parseReportMeta } from './document';
	import { hydrateFromGit, loadDetectedOutput } from './git.remote';
	import { loadChat, replaceReportDocument, saveChat } from './storage';
	import type { SavedReport } from './types';

	let {
		report,
		onclose,
		onreportupdated
	}: {
		report: SavedReport;
		onclose: () => void;
		onreportupdated: (report: SavedReport) => void;
	} = $props();

	let info = $state<AgentSessionInfo | null>(null);
	let stream = $state<AgentStream | null>(null);
	/** Conversación de sesiones anteriores del server (antes de un reinicio), guardada con el reporte. */
	let history = $state<SeqEvent[]>([]);
	let text = $state('');
	let mode = $state<ChatMode>('ask');
	let error = $state('');
	let sending = $state(false);
	let updating = $state(false);
	/** Hubo un pedido de cambio: el próximo JSON válido reemplaza el reporte. */
	let pendingEdit = false;

	const ref = $derived(report.meta.agentSession);
	const busy = $derived(sending || Boolean(stream?.busy));
	/** Reconectar solo si cambia el reporte o la sesión (no cuando el agente actualiza el documento). */
	const sessionKey = $derived(`${report.id}|${ref?.agentId ?? ''}|${ref?.sessionId ?? ''}`);

	$effect(() => {
		void sessionKey;
		untrack(() => void connect(report.id, report.meta.agentSession));
		return () => untrack(() => stream?.close());
	});

	// Guardar la conversación con el reporte (la del server se pierde si se reinicia).
	$effect(() => {
		const events = stream?.events;
		if (!info || !events) return;
		saveChat(report.id, { sessionId: info.id, events: [...history, ...events] });
	});

	async function connect(reportId: string, agentSession: SavedReport['meta']['agentSession']) {
		stream?.close();
		stream = null;
		info = null;
		error = '';
		if (!agentSession) return;
		try {
			const opened = await openChat({
				...agentSession,
				repo: report.meta.repo,
				branch: report.meta.branch,
				base: report.meta.base,
				model: report.meta.model
			});
			const saved = loadChat(reportId);
			// Misma sesión del server: la historia llega completa por SSE. Si no, la guardada va arriba.
			history = saved.sessionId === opened.id ? [] : saved.events;
			info = opened;
			const next = new AgentStream(opened.id, (event) => void onEvent(event));
			stream = next;
			next.connect();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	async function onEvent(event: SeqEvent) {
		if (event.type === 'status' && event.status === 'error') pendingEdit = false;
		if (event.type !== 'review' || !event.ok || !pendingEdit || !info) return;
		pendingEdit = false;
		await reloadReport(event.filename);
	}

	/** El agente dejó el JSON válido: recalcular el diff y reemplazar el documento del reporte. */
	async function reloadReport(filename: string) {
		updating = true;
		try {
			const loaded = await loadDetectedOutput({ repo: report.meta.repo, filename });
			if (!loaded?.payload) throw new Error(`No pude leer ${filename}.`);
			const meta = { ...parseReportMeta(loaded.payload, report.meta), agentSession: report.meta.agentSession };
			const document = await hydrateFromGit({
				repo: meta.repo,
				branch: meta.branch,
				base: meta.base,
				source: meta.source,
				payload: loaded.payload
			});
			const updated = replaceReportDocument(report.id, document, meta);
			if (updated) onreportupdated(updated);
		} catch (err) {
			error = `No se pudo actualizar el reporte: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			updating = false;
		}
	}

	async function send() {
		const body = text.trim();
		if (!body || !info || busy) return;
		sending = true;
		error = '';
		try {
			if (mode === 'edit') pendingEdit = true;
			await sendMessage({ id: info.id, text: body, mode });
			text = '';
		} catch (err) {
			pendingEdit = false;
			error = err instanceof Error ? err.message : String(err);
		} finally {
			sending = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void send();
		}
	}
</script>

<aside class="chat" aria-label="Chat con el agente">
	<header>
		<div class="title">
			<strong>{report.meta.agent || 'Agente'}</strong>
			{#if report.meta.model}<small>{report.meta.model}</small>{/if}
		</div>
		<button type="button" class="close" title="Cerrar" aria-label="Cerrar chat" onclick={onclose}>✕</button>
	</header>

	{#if !ref}
		<p class="hint">
			Este reporte no lo generó diff-review con un agente, así que no hay una sesión para retomar. Lanzá la review desde
			“Lanzar agente” para poder preguntarle o pedirle cambios.
		</p>
	{:else}
		<div class="log">
			<AgentLog events={[...history, ...(stream?.events ?? [])]} busy={busy || updating} />
		</div>
		{#if updating}
			<p class="note">Actualizando el reporte…</p>
		{/if}
		{#if stream?.gone}
			<p class="err">La sesión del agente se cerró. Recargá la página para retomarla.</p>
		{/if}
		{#if error}
			<p class="err">{error}</p>
		{/if}
		<div class="composer">
			<div class="mode-toggle">
				<button type="button" class:on={mode === 'ask'} onclick={() => (mode = 'ask')}>Preguntar</button>
				<button type="button" class:on={mode === 'edit'} onclick={() => (mode = 'edit')}>Modificar el reporte</button>
			</div>
			<textarea
				bind:value={text}
				rows="3"
				placeholder={mode === 'ask'
					? '¿Por qué el hallazgo f2 es bloqueante?'
					: 'Bajá la severidad de f3 a low: el caso no llega a producción.'}
				onkeydown={onKeydown}
				disabled={!info}
			></textarea>
			<div class="actions">
				<span class="kbd">Ctrl+Enter</span>
				{#if stream?.busy && info}
					<button type="button" onclick={() => void cancelAgent({ id: info!.id })}>Cancelar</button>
				{/if}
				<button type="button" class="primary" onclick={() => void send()} disabled={!text.trim() || busy || !info}>
					{mode === 'ask' ? 'Preguntar' : 'Pedir cambio'}
				</button>
			</div>
		</div>
	{/if}
</aside>

<style>
	.chat {
		width: 400px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-left: 1px solid var(--border);
		background: var(--bg-elev);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
	}
	.title small {
		margin-left: 8px;
		font-family: var(--mono);
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.close {
		background: transparent;
		border: 0;
		color: var(--text-dim);
		font-size: 13px;
		cursor: pointer;
	}
	.log {
		flex: 1;
		min-height: 0;
		display: flex;
		padding: 12px 14px;
	}
	.log :global(.log) {
		flex: 1;
	}
	.hint,
	.note,
	.err {
		margin: 0;
		padding: 8px 14px;
		font-size: 12.5px;
		color: var(--text-faint);
	}
	.err {
		color: var(--danger);
	}
	.composer {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 14px 14px;
		border-top: 1px solid var(--border);
	}
	.mode-toggle {
		display: flex;
		border: 1px solid var(--border);
		align-self: flex-start;
	}
	.mode-toggle button {
		padding: 5px 10px;
		font-size: 12px;
		border: 0;
		background: transparent;
		color: var(--text);
	}
	.mode-toggle button + button {
		border-left: 1px solid var(--border);
	}
	.mode-toggle button.on {
		background: var(--accent-soft);
	}
	textarea {
		resize: vertical;
		min-height: 60px;
		font: inherit;
		font-size: 13px;
		padding: 8px;
		background: var(--bg-card);
		color: var(--text);
		border: 1px solid var(--border);
	}
	.actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
	}
	.kbd {
		margin-right: auto;
		font-size: 11px;
		color: var(--text-faint);
	}
	.actions button {
		padding: 6px 12px;
		font-size: 12.5px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		color: var(--text);
	}
	.actions button.primary {
		background: var(--btn-primary-bg);
		border-color: var(--btn-primary-border);
		color: var(--btn-primary-text);
	}
	.actions button:disabled {
		opacity: 0.5;
	}
</style>
