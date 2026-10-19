<script lang="ts">
	import { untrack } from 'svelte';
	import AgentLog from './AgentLog.svelte';
	import AgentSelect from './AgentSelect.svelte';
	import TrustSessionToggle from './TrustSessionToggle.svelte';
	import {
		acpAgentModels,
		acpAgents,
		cancelAgent,
		openChat,
		respondPermission,
		sendMessage,
		setPermissionTrust
	} from './agent.remote';
	import type { AcpAgentOption, AcpModels, AgentSessionInfo, ChatMode, SeqEvent } from './agent-events';
	import { AgentStream } from './agent-stream.svelte';
	import { parseReportMeta, reviewSeedDiff, reviewSeedPayload } from './document';
	import { hydrateFromGit, loadDetectedOutput } from './git.remote';
	import { buildAcpModelSelectOptions, sortModelSelectOptions } from './model-label';
	import ModelSelect from './ModelSelect.svelte';
	import { loadChat, replaceReportDocument, saveChat, updateReportMeta } from './storage';
	import type { SavedReport } from './types';

	let {
		report,
		onclose,
		onreportupdated,
		pendingAsk = null,
		onpendingaskconsumed
	}: {
		report: SavedReport;
		onclose: () => void;
		onreportupdated: (report: SavedReport) => void;
		/** Borrador para el compositor en modo ask (referencia a tema/bloque/hallazgo); no se envía solo. */
		pendingAsk?: string | null;
		onpendingaskconsumed?: () => void;
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
	let starting = $state(false);
	/** Reabriendo sesión ACP guardada (openChat / ensureAcp). */
	let connecting = $state(false);
	/** Hubo un pedido de cambio: el próximo JSON válido reemplaza el reporte. */
	let pendingEdit = false;
	let composerEl = $state<HTMLTextAreaElement | null>(null);

	let agentOptions = $state<AcpAgentOption[]>([]);
	let agentChoice = $state('');
	let modelChoice = $state('');
	let agentModels = $state<Record<string, AcpModels | 'loading'>>({});
	let modelsForce = $state<Record<string, boolean>>({});

	const ref = $derived(report.meta.agentSession);
	const busy = $derived(sending || starting || connecting || Boolean(stream?.busy));
	/** Reconectar solo si cambia el reporte o la sesión (no cuando el agente actualiza el documento). */
	const sessionKey = $derived(`${report.id}|${ref?.agentId ?? ''}|${ref?.sessionId ?? ''}`);
	/** Agente del que listamos modelos: sesión activa, ref guardada, o picker. */
	const modelsAgentId = $derived(info?.agentId || ref?.agentId || agentChoice);
	const sessionReady = $derived(Boolean(info));
	const showPicker = $derived(!ref && !info && !connecting);
	const displayModel = $derived(modelChoice || info?.model || report.meta.model || '');

	const chosenAgent = $derived(agentOptions.find((a) => a.id === modelsAgentId) ?? null);
	const modelOptions = $derived.by(() => {
		const live = agentModels[modelsAgentId];
		const fixed = {
			options: chosenAgent?.models ?? [],
			initialValue: ''
		};
		const fallback = fixed.options.filter((m) => m.value !== '');
		if (live && live !== 'loading' && live.models.length) {
			return buildAcpModelSelectOptions(
				{ models: live.models, currentModel: live.currentModel || info?.model || report.meta.model || '' },
				fixed
			).options;
		}
		if (live === 'loading' && !fallback.length) {
			return [{ value: '', label: 'Cargando modelos…', title: 'Cargando modelos…', badges: [] }];
		}
		return sortModelSelectOptions(
			fixed.options.map((m) => ({
				value: m.value,
				label: m.label,
				title: m.label,
				badges: [] as string[],
				...(m.hint ? { hint: m.hint } : {})
			}))
		);
	});
	const modelsStatus = $derived(agentModels[modelsAgentId]);
	const modelsError = $derived(
		modelsStatus && modelsStatus !== 'loading' ? modelsStatus.error : undefined
	);
	const modelsEmpty = $derived(
		Boolean(
			modelsStatus &&
				modelsStatus !== 'loading' &&
				!modelsStatus.error &&
				!modelsStatus.models.length
		)
	);

	function resolvedModel(): string | undefined {
		const raw = String(modelChoice || '').trim();
		return raw || undefined;
	}

	const seed = $derived({
		payload: reviewSeedPayload(report.document, report.meta),
		diff: reviewSeedDiff(report.document)
	});

	$effect(() => {
		void sessionKey;
		const reportId = report.id;
		const agentSession = report.meta.agentSession;
		// Sin sesión guardada: el picker / startFresh se encargan (no desarmar un chat recién abierto).
		if (!agentSession) return;
		// Ya conectados a esta sesión ACP (p. ej. tras persistir meta desde startFresh).
		if (
			untrack(
				() =>
					Boolean(
						info?.acpSessionId === agentSession.sessionId &&
							info?.outputFilename === agentSession.outputFilename &&
							stream
					)
			)
		) {
			return;
		}
		untrack(() => void connect(reportId, agentSession));
		return () => untrack(() => stream?.close());
	});

	$effect(() => {
		void loadAgents();
	});

	$effect(() => {
		const id = modelsAgentId;
		if (!id) return;
		if (id in untrack(() => agentModels)) return;
		const force = Boolean(untrack(() => modelsForce[id]));
		agentModels = { ...untrack(() => agentModels), [id]: 'loading' };
		void acpAgentModels({ agentId: id, repo: report.meta.repo, force }).then((res) => {
			agentModels = { ...agentModels, [id]: res };
			if (force) modelsForce = { ...modelsForce, [id]: false };
		});
	});

	function retryAgentModels() {
		const id = modelsAgentId;
		if (!id || agentModels[id] === 'loading') return;
		modelsForce = { ...modelsForce, [id]: true };
		const next = { ...agentModels };
		delete next[id];
		agentModels = next;
	}

	// Guardar la conversación con el reporte (la del server se pierde si se reinicia).
	$effect(() => {
		const events = stream?.events;
		if (!info || !events) return;
		saveChat(report.id, { sessionId: info.id, events: [...history, ...events] });
	});

	// Persistí agentSession cuando llega el id ACP (sesión nueva o retomada).
	$effect(() => {
		const acpId = info?.acpSessionId;
		if (!info || !acpId) return;
		const current = report.meta.agentSession;
		if (
			current?.sessionId === acpId &&
			current.agentId === info.agentId &&
			current.outputFilename === info.outputFilename
		) {
			return;
		}
		const updated = updateReportMeta(report.id, {
			agentSession: {
				agentId: info.agentId,
				sessionId: acpId,
				outputFilename: info.outputFilename
			},
			...(info.model ? { model: info.model } : {}),
			...(info.agentLabel ? { agent: info.agentLabel } : {})
		});
		if (updated) onreportupdated(updated);
	});

	// Precargar borrador en el compositor (sin enviar): el usuario completa y manda.
	$effect(() => {
		const ask = pendingAsk;
		if (!ask) return;
		text = ask;
		mode = 'ask';
		onpendingaskconsumed?.();
		queueMicrotask(() => {
			composerEl?.focus();
			const len = composerEl?.value.length ?? 0;
			composerEl?.setSelectionRange(len, len);
		});
	});

	async function loadAgents() {
		try {
			agentOptions = await acpAgents();
			if (!agentOptions.some((a) => a.id === agentChoice)) agentChoice = agentOptions[0]?.id ?? '';
		} catch {
			agentOptions = [];
		}
	}

	async function connect(reportId: string, agentSession: SavedReport['meta']['agentSession']) {
		if (!agentSession) return;
		connecting = true;
		stream?.close();
		stream = null;
		info = null;
		error = '';
		try {
			const opened = await openChat({
				agentId: agentSession.agentId,
				sessionId: agentSession.sessionId,
				outputFilename: agentSession.outputFilename,
				repo: report.meta.repo,
				branch: report.meta.branch,
				base: report.meta.base,
				model: resolvedModel() || report.meta.model,
				seed
			});
			attachSession(reportId, opened);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			connecting = false;
		}
	}

	function attachSession(reportId: string, opened: AgentSessionInfo) {
		const saved = loadChat(reportId);
		history = saved.sessionId === opened.id ? [] : saved.events;
		info = opened;
		if (!modelChoice && opened.model) modelChoice = opened.model;
		else if (!modelChoice && report.meta.model) modelChoice = report.meta.model;
		const next = new AgentStream(opened.id, (event) => void onEvent(event));
		stream = next;
		next.connect();
	}

	async function startFresh() {
		const agent = agentOptions.find((a) => a.id === agentChoice) ?? null;
		if (!agent || starting) return;
		starting = true;
		error = '';
		try {
			const opened = await openChat({
				agentId: agent.id,
				sessionId: '',
				outputFilename: report.meta.agentSession?.outputFilename || '',
				repo: report.meta.repo,
				branch: report.meta.branch,
				base: report.meta.base,
				model: resolvedModel(),
				seed
			});
			attachSession(report.id, opened);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			starting = false;
		}
	}

	async function onEvent(event: SeqEvent) {
		if (event.type === 'status' && event.status === 'error') pendingEdit = false;
		if (event.type !== 'review' || !event.ok || !pendingEdit || !info) return;
		pendingEdit = false;
		await reloadReport(event.filename);
	}

	/** El agente dejó el JSON válido: hidratar el viewer (reusa el companion `.diff` si existe). */
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
				payload: loaded.payload,
				outputFilename: filename
			});
			const updated = replaceReportDocument(report.id, document, meta);
			if (updated) onreportupdated(updated);
		} catch (err) {
			error = `No se pudo actualizar el reporte: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			updating = false;
		}
	}

	async function sendText(body: string, sendMode: ChatMode) {
		if (!body || !info || busy) return;
		sending = true;
		error = '';
		try {
			if (sendMode === 'edit') pendingEdit = true;
			const next = await sendMessage({
				id: info.id,
				text: body,
				mode: sendMode,
				model: resolvedModel()
			});
			info = next;
			if (next.model) modelChoice = next.model;
		} catch (err) {
			pendingEdit = false;
			error = err instanceof Error ? err.message : String(err);
		} finally {
			sending = false;
		}
	}

	async function send() {
		const body = text.trim();
		if (!body || !info || busy) return;
		const sendMode = mode;
		text = '';
		await sendText(body, sendMode);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void send();
		}
	}

	function onRespondPermission(detail: {
		requestId?: string;
		allow: boolean;
		allowAll?: boolean;
		scope?: 'once' | 'session' | 'always';
	}) {
		if (!info) return;
		void respondPermission({
			id: info.id,
			requestId: detail.requestId,
			allow: detail.allow,
			allowAll: detail.allowAll,
			scope: detail.scope
		})
			.then((next) => {
				info = next;
			})
			.catch((err) => {
				error = err instanceof Error ? err.message : String(err);
			});
	}

	function onSessionTrust(enabled: boolean) {
		if (!info) return;
		void setPermissionTrust({ id: info.id, enabled })
			.then((next) => {
				info = next;
			})
			.catch((err) => {
				error = err instanceof Error ? err.message : String(err);
			});
	}
</script>

<aside class="chat" aria-label="Chat con el agente">
	<header>
		<div class="title">
			<strong>{info?.agentLabel || report.meta.agent || 'Agente'}</strong>
			{#if displayModel}
				<small title={displayModel}>{displayModel}</small>
			{/if}
		</div>
		<button type="button" class="close" title="Cerrar" aria-label="Cerrar chat" onclick={onclose}>✕</button>
	</header>

	{#if showPicker}
		<div class="picker">
			<p class="hint">
				Este reporte no tiene sesión de agente. Elegí uno para chatear (se abre una sesión nueva con el contexto de
				la review).
			</p>
			{#if agentOptions.length}
				<label class="field">
					<span>Agente</span>
					<AgentSelect
						bind:value={agentChoice}
						options={agentOptions}
						onchange={() => (modelChoice = '')}
					/>
				</label>
				<label class="field">
					<span
						>Modelo{#if modelsStatus === 'loading'}
							<small> · consultando modelos (puede tardar)…</small>{/if}</span
					>
					<ModelSelect
						bind:value={modelChoice}
						options={modelOptions}
						disabled={modelsStatus === 'loading' && !chosenAgent?.models.length}
					/>
				</label>
				{#if modelsError}
					<p class="err models-error">
						{modelsError}
						<button type="button" class="linkish" onclick={retryAgentModels}>Reintentar</button>
					</p>
				{:else if modelsEmpty}
					<p class="hint models-error">
						El agente no listó modelos por ACP; usá el default o la lista fija.
						<button type="button" class="linkish" onclick={retryAgentModels}>Reintentar</button>
					</p>
				{/if}
				<button
					type="button"
					class="primary start"
					onclick={() => void startFresh()}
					disabled={!agentChoice || starting || (modelsStatus === 'loading' && !chosenAgent?.models.length)}
				>
					{starting ? 'Abriendo…' : 'Iniciar chat'}
				</button>
			{:else}
				<p class="hint">No hay agentes ACP instalados en este equipo.</p>
			{/if}
			{#if error}
				<p class="err">{error}</p>
			{/if}
		</div>
	{:else}
		<div class="log-area">
			{#if !sessionReady}
				<div class="connecting" role="status" aria-live="polite">
					{#if error && !connecting}
						<p class="connecting-title">No se pudo abrir la sesión</p>
						<p class="err" style="padding: 0; text-align: left">{error}</p>
						{#if ref}
							<button
								type="button"
								class="primary start"
								style="align-self: center; margin-top: 8px"
								onclick={() => void connect(report.id, ref)}
							>
								Reintentar
							</button>
						{/if}
					{:else}
						<p class="connecting-title">Conectando con el agente…</p>
						<p class="connecting-detail">
							{report.meta.agent || 'Agente'}
							{#if displayModel}
								· {displayModel}
							{/if}
						</p>
						<p class="connecting-hint">Puede tardar unos segundos al lanzar o retomar la sesión ACP.</p>
					{/if}
				</div>
			{:else}
				{#if info?.id}
					<TrustSessionToggle
						enabled={Boolean(info.sessionTrust)}
						onchange={onSessionTrust}
					/>
				{/if}
				<div class="log">
					<AgentLog
						events={[...history, ...(stream?.events ?? [])]}
						busy={busy || updating}
						sessionId={info?.id ?? null}
						onrespondpermission={onRespondPermission}
					/>
				</div>
			{/if}
		</div>
		{#if updating}
			<p class="note">Actualizando el reporte…</p>
		{/if}
		{#if stream?.gone}
			<p class="err">La sesión del agente se cerró. Recargá la página para retomarla.</p>
		{/if}
		{#if error && sessionReady}
			<p class="err">{error}</p>
		{/if}
		<div class="composer">
			<div class="composer-top">
				<div class="mode-toggle">
					<button type="button" class:on={mode === 'ask'} onclick={() => (mode = 'ask')}>Preguntar</button>
					<button type="button" class:on={mode === 'edit'} onclick={() => (mode = 'edit')}
						>Modificar el reporte</button
					>
				</div>
				<div class="model-field">
					<ModelSelect
						bind:value={modelChoice}
						options={modelOptions}
						disabled={!sessionReady || (Boolean(stream?.busy) && sending)}
					/>
				</div>
			</div>
			{#if modelsError}
				<p class="err models-error">
					{modelsError}
					<button type="button" class="linkish" onclick={retryAgentModels}>Reintentar</button>
				</p>
			{/if}
			<textarea
				bind:this={composerEl}
				bind:value={text}
				rows="3"
				placeholder={connecting || !sessionReady
					? 'Podés ir escribiendo; se habilita el envío cuando la sesión esté lista…'
					: mode === 'ask'
						? '¿Por qué el hallazgo f2 es bloqueante?'
						: 'Bajá la severidad de f3 a low: el caso no llega a producción.'}
				onkeydown={onKeydown}
			></textarea>
			<div class="actions">
				<span class="kbd">Ctrl+Enter</span>
				{#if stream?.busy && info}
					<button type="button" onclick={() => void cancelAgent({ id: info!.id })}>Cancelar</button>
				{/if}
				<button
					type="button"
					class="primary"
					onclick={() => void send()}
					disabled={!text.trim() || busy || !sessionReady}
				>
					{#if connecting || !sessionReady}
						Conectando…
					{:else if sending || stream?.busy}
						Enviando…
					{:else}
						{mode === 'ask' ? 'Preguntar' : 'Pedir cambio'}
					{/if}
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
	.log-area {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
	}
	.log {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.log :global(.log) {
		flex: 1;
		min-height: 0;
	}
	.picker {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		flex: 1;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
		color: var(--text-dim);
	}
	.field input {
		font: inherit;
		font-size: 13px;
		padding: 6px 8px;
		background: var(--bg-card);
		color: var(--text);
		border: 1px solid var(--border);
	}
	.field :global(.agent-select .trigger) {
		font-size: 13px;
		padding: 6px 8px;
	}
	.field small {
		color: var(--text-faint);
	}
	.start {
		align-self: flex-start;
		padding: 8px 14px;
		font-size: 13px;
		background: var(--btn-primary-bg);
		border: 1px solid var(--btn-primary-border);
		color: var(--btn-primary-text);
	}
	.start:disabled {
		opacity: 0.5;
	}
	.hint,
	.note,
	.err {
		margin: 0;
		padding: 8px 14px;
		font-size: 12.5px;
		color: var(--text-faint);
	}
	.picker .hint {
		padding: 0;
	}
	.err {
		color: var(--danger);
	}
	.models-error {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px;
		padding-inline: 0;
	}
	button.linkish {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent, #3b82f6);
		cursor: pointer;
		text-decoration: underline;
		font: inherit;
	}
	.connecting {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 6px;
		padding: 18px 8px;
		text-align: center;
	}
	.connecting-title {
		margin: 0;
		font-size: 13.5px;
		font-weight: 650;
		color: var(--text);
	}
	.connecting-detail {
		margin: 0;
		font-size: 12px;
		font-family: var(--mono);
		color: var(--text-dim);
		word-break: break-all;
	}
	.connecting-hint {
		margin: 4px 0 0;
		font-size: 12px;
		color: var(--text-faint);
	}
	.composer {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 14px 14px;
		border-top: 1px solid var(--border);
	}
	.composer-top {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 10px;
	}
	.model-field {
		flex: 1;
		min-width: 140px;
	}
	.model-field :global(.model-select .trigger) {
		font-size: 12px;
		padding: 5px 8px;
	}
	.mode-toggle {
		display: flex;
		border: 1px solid var(--border);
		align-self: flex-start;
		flex-shrink: 0;
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
