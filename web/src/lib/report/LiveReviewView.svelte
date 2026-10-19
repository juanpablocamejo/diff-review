<script lang="ts">
	import ThemeToggle from '$lib/ThemeToggle.svelte';
	import AgentIcon from './AgentIcon.svelte';
	import AgentLog from './AgentLog.svelte';
	import type { PermissionResponse } from './AgentLog.svelte';
	import PermissionActions from './PermissionActions.svelte';
	import TrustSessionToggle from './TrustSessionToggle.svelte';
	import { agentShortName } from './agent-icons';
	import type { AgentSessionInfo, SeqEvent } from './agent-events';
	import { openAgentLogin } from './agent.remote';

	let {
		info,
		events,
		busy = false,
		gone = false,
		error = '',
		oncancel,
		onreset,
		onrespondpermission,
		onsessiontrust,
		onretry
	}: {
		info: AgentSessionInfo;
		events: SeqEvent[];
		busy?: boolean;
		gone?: boolean;
		error?: string;
		oncancel: () => void;
		onreset: () => void;
		onrespondpermission?: (detail: PermissionResponse) => void;
		onsessiontrust?: (enabled: boolean) => void;
		onretry?: () => void;
	} = $props();

	let loginBusy = $state(false);
	let loginNote = $state('');
	let loginErr = $state('');
	/** Optimistic: true as soon as the user clicks Cancelar (before the SSE idle event). */
	let userCancelled = $state(false);

	type Stage = 'diff' | 'launching' | 'reviewing' | 'opening' | 'cancelled' | 'error' | 'gone';

	const hasAgentActivity = $derived(
		events.some(
			(e) =>
				e.type === 'user' ||
				e.type === 'tool' ||
				e.type === 'text' ||
				e.type === 'plan' ||
				e.type === 'permission'
		)
	);

	const hasReviewContent = $derived(
		events.some((e) => e.type === 'tool' || e.type === 'text' || e.type === 'plan')
	);

	const phase = $derived.by(() => {
		let current: 'diff' | 'agent' = 'diff';
		let detail = 'Calculando el diff…';
		for (const e of events) {
			if (e.type === 'phase') {
				current = e.phase;
				if (e.detail) detail = e.detail;
			}
		}
		if (current === 'diff' && hasAgentActivity) current = 'agent';
		return { current, detail };
	});

	const lastStatusMessage = $derived.by(() => {
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i];
			if (e.type === 'status' && e.message) return e.message;
		}
		return '';
	});

	/** Last status event was idle + "Cancelado…" (server ack after cancel). */
	const cancelledByEvent = $derived.by(() => {
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i];
			if (e.type === 'status') {
				return e.status === 'idle' && /Cancelado/i.test(e.message || '');
			}
		}
		return false;
	});

	const cancelled = $derived(userCancelled || cancelledByEvent);

	/**
	 * Solo fallos reales (`status: error`), no el último status informativo
	 * (p. ej. "Lanzando…" no debe pintar la pantalla de error).
	 */
	const displayError = $derived.by(() => {
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i];
			if (e.type === 'status' && e.status === 'error') {
				return e.message || error || 'Error del agente.';
			}
		}
		if (info.status === 'error') {
			return error || info.statusMessage || 'Error del agente.';
		}
		// Prop de error del padre solo si no hay status conflictivo de "en curso".
		if (error && !busy) return error;
		return '';
	});

	const isAuthError = $derived(
		/autenticad|authentication|login|no está autenticado/i.test(displayError)
	);

	const canOpenLogin = $derived(
		isAuthError && ['claude', 'copilot', 'codex', 'gemini'].includes(info.agentId)
	);

	const stage = $derived.by((): Stage => {
		if (displayError) return 'error';
		if (gone) return 'gone';
		if (cancelled && !busy) return 'cancelled';
		if (events.some((e) => e.type === 'review' && e.ok)) return 'opening';
		if (hasReviewContent) return 'reviewing';
		if (
			phase.current === 'agent' ||
			/Lanzando/i.test(lastStatusMessage) ||
			(hasAgentActivity && !hasReviewContent)
		) {
			return 'launching';
		}
		return 'diff';
	});

	const statusLabel = $derived(
		displayError
			? 'error'
			: busy
				? 'en curso'
				: gone
					? 'sesión cerrada'
					: cancelled
						? 'cancelado'
						: 'listo'
	);

	const statusTone = $derived(
		displayError ? 'error' : busy ? 'busy' : gone ? 'gone' : 'idle'
	);

	async function onOpenLogin() {
		loginBusy = true;
		loginErr = '';
		loginNote = '';
		try {
			const result = await openAgentLogin({ agentId: info.agentId });
			loginNote = `Se abrió una terminal con ${result.display}. Cuando termines, cortá diff-review (Ctrl+C) y volvé a lanzar.`;
		} catch (err) {
			loginErr = err instanceof Error ? err.message : String(err);
		} finally {
			loginBusy = false;
		}
	}

	const repoLabel = $derived.by(() => {
		const r = info.repo.replace(/\\/g, '/');
		const parts = r.split('/');
		return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : r;
	});

	/** Oculta fase y el bubble de kickoff; deja permisos (pending incluido). */
	const logEvents = $derived(
		events.filter((e) => {
			if (e.type === 'phase') return false;
			if (e.type === 'user' && e.mode === 'review') return false;
			return true;
		})
	);

	let permCursor = $state(0);

	const pendingPerms = $derived(
		logEvents.filter(
			(e): e is Extract<SeqEvent, { type: 'permission' }> => e.type === 'permission' && e.pending
		)
	);
	const pendingIndex = $derived(
		pendingPerms.length === 0 ? 0 : Math.min(permCursor, pendingPerms.length - 1)
	);
	const currentPending = $derived(pendingPerms[pendingIndex] ?? null);

	const showStageFooter = $derived(
		Boolean(info.id && onsessiontrust) || Boolean(currentPending && onrespondpermission)
	);

	function onPermKeydown(e: KeyboardEvent) {
		const n = pendingPerms.length;
		if (n <= 1) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			permCursor = (pendingIndex + n - 1) % n;
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			permCursor = (pendingIndex + 1) % n;
		}
	}

	function respondPermission(detail: PermissionResponse) {
		onrespondpermission?.(detail);
	}

	const launchingTitle = $derived(
		/Lanzando/i.test(lastStatusMessage)
			? lastStatusMessage
			: /revisando/i.test(lastStatusMessage)
				? lastStatusMessage
				: `Lanzando ${info.agentLabel}…`
	);

	const launchingDetail = $derived(
		phase.detail && phase.current === 'agent' && phase.detail !== launchingTitle ? phase.detail : ''
	);

	/**
	 * En curso (diff / lanzando / agente): Cancelar.
	 * Cancelado / error / gone / opening-done: Nueva review.
	 */
	const showCancel = $derived(
		!cancelled &&
			(stage === 'diff' ||
				stage === 'launching' ||
				stage === 'reviewing' ||
				stage === 'opening' ||
				busy)
	);

	function onHeaderAction() {
		if (showCancel) {
			if (info.id) {
				userCancelled = true;
				oncancel();
			} else onreset();
			return;
		}
		onreset();
	}
</script>

<section class="live" aria-label="Review en vivo">
	<header class="bar">
		<div class="brand">
			<span class="dot" aria-hidden="true"></span>
			<strong>diff-review</strong>
			<span class="pill" class:busy={statusTone === 'busy'} class:error={statusTone === 'error'} class:gone={statusTone === 'gone'}>
				{statusLabel}
			</span>
		</div>
		<div class="actions">
			<button type="button" class="ghost" onclick={onHeaderAction}>
				{showCancel ? 'Cancelar' : 'Nueva review'}
			</button>
			<ThemeToggle />
		</div>
	</header>

	<div class="body">
		<aside class="card" aria-label="Contexto de la review">
			<dl class="fields">
				<div>
					<dt>Repo</dt>
					<dd title={info.repo}>{repoLabel}</dd>
				</div>
				<div>
					<dt>Branch → Base</dt>
					<dd>
						<span class="branch">{info.branch}</span>
						<span class="arrow">→</span>
						{info.base}
					</dd>
				</div>
				<div>
					<dt>Agente</dt>
					<dd>{info.agentLabel}</dd>
				</div>
				<div>
					<dt>Modelo</dt>
					<dd>{info.model || 'por defecto'}</dd>
				</div>
				<div>
					<dt>Salida</dt>
					<dd title={info.outputFilename}>{info.outputFilename}</dd>
				</div>
			</dl>
			<p class="card-note">Cuando el resultado esté listo, se abrirá el reporte.</p>
		</aside>

		<div class="stage" role="status" aria-live="polite" aria-busy={busy}>
			{#if stage === 'diff'}
				<div class="center">
					<div class="spinner" aria-hidden="true"></div>
					<p class="title">Preparando el contexto</p>
					<p class="detail">{phase.detail}</p>
					<p class="hint">
						El diff se calcula acá y se le pasa al agente; no hace falta que lo arme él.
					</p>
				</div>
			{:else if stage === 'opening'}
				<div class="center">
					<div class="spinner" aria-hidden="true"></div>
					<p class="title">Abriendo el reporte…</p>
				</div>
			{:else if stage === 'cancelled'}
				<div class="center fail">
					<p class="title">Cancelado</p>
					<p class="detail">La review fue cancelada. Podés empezar una nueva.</p>
					<div class="auth-actions">
						<button type="button" class="ghost" onclick={onreset}>Nueva review</button>
					</div>
				</div>
			{:else if stage === 'error' || stage === 'gone'}
				<div class="center fail">
					<p class="title">{stage === 'gone' && !displayError ? 'Sesión cerrada' : isAuthError ? 'Autenticación requerida' : 'Error'}</p>
					<p class="detail">
						{#if displayError}
							{displayError}
						{:else}
							La sesión del agente se cerró. Podés empezar una nueva review.
						{/if}
					</p>
					{#if canOpenLogin}
						<div class="auth-actions">
							<button type="button" class="primary" onclick={() => void onOpenLogin()} disabled={loginBusy}>
								{loginBusy ? 'Abriendo…' : `Abrir login de ${info.agentLabel}`}
							</button>
							<button type="button" class="ghost" onclick={onreset}>Nueva review</button>
						</div>
						{#if loginNote}
							<p class="auth-note">{loginNote}</p>
						{/if}
						{#if loginErr}
							<p class="auth-err">{loginErr}</p>
						{/if}
					{:else if stage === 'error'}
						<div class="auth-actions">
							<button type="button" class="ghost" onclick={onreset}>Nueva review</button>
						</div>
					{/if}
				</div>
			{:else}
				<!-- launching + reviewing: el log siempre visible para que el progreso no quede solo en la terminal -->
				<header class="stage-header">
					<AgentIcon id={info.agentId} size={16} />
					<strong>{agentShortName(info.agentId, info.agentLabel)}</strong>
					{#if info.model}
						<small title={info.model}>{info.model}</small>
					{/if}
				</header>
				<div class="log-wrap">
					{#if stage === 'launching'}
						<div class="launch-banner">
							<div class="spinner sm" aria-hidden="true"></div>
							<div>
								<p class="title">{launchingTitle}</p>
								{#if launchingDetail}
									<p class="detail">{launchingDetail}</p>
								{/if}
							</div>
						</div>
					{/if}
					<AgentLog
						events={logEvents}
						{busy}
						sessionId={info.id}
						{onrespondpermission}
						{onretry}
						actionsExternal={true}
						bind:pendingCursor={permCursor}
					/>
					{#if showStageFooter}
						<footer class="stage-footer">
							{#if info.id && onsessiontrust}
								<TrustSessionToggle
									enabled={Boolean(info.sessionTrust)}
									onchange={onsessiontrust}
								/>
							{/if}
							<span class="footer-spacer"></span>
							{#if currentPending && onrespondpermission}
								<PermissionActions
									currentPending={currentPending}
									pendingCount={pendingPerms.length}
									onrespond={respondPermission}
									onkeydown={onPermKeydown}
								/>
							{/if}
						</footer>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</section>

<style>
	.live {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background:
			radial-gradient(
				900px 420px at 8% -8%,
				color-mix(in srgb, var(--accent) 10%, transparent),
				transparent 70%
			),
			var(--bg);
	}

	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 20px;
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--bg-elev) 90%, transparent);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 14px;
		min-width: 0;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: none;
		background: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
	}

	.pill {
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.02em;
		padding: 3px 9px;
		border-radius: 0;
		border: 1px solid var(--border);
		color: var(--text-dim);
		background: var(--bg-card);
		text-transform: lowercase;
	}

	.pill.busy {
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
		color: var(--accent);
		background: var(--accent-soft);
	}

	.pill.error {
		border-color: var(--danger-border, var(--danger));
		color: var(--danger);
		background: var(--danger-bg, transparent);
	}

	.pill.gone {
		color: var(--text-faint);
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: none;
	}

	.ghost {
		padding: 6px 11px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}

	.ghost:hover {
		border-color: var(--accent);
	}

	.body {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(280px, 320px) 1fr;
		gap: 20px;
		padding: 20px 24px 24px;
	}

	.card {
		align-self: start;
		padding: 16px 16px 14px;
		border: 1px solid var(--border);
		border-radius: 0;
		background: var(--bg-elev);
	}

	.fields {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.fields dt {
		margin: 0 0 3px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-faint);
	}

	.fields dd {
		margin: 0;
		font-size: 13px;
		font-family: var(--mono);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
	}

	.branch {
		color: var(--accent);
		font-weight: 600;
	}

	.arrow {
		color: var(--text-faint);
		margin: 0 2px;
	}

	.card-note {
		margin: 16px 0 0;
		padding-top: 12px;
		border-top: 1px solid var(--border-soft, var(--border));
		font-size: 12.5px;
		line-height: 1.4;
		color: var(--text-faint);
	}

	.stage {
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: 0;
		background: var(--bg-elev);
		overflow: hidden;
	}

	.center {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		text-align: center;
		padding: 40px 24px;
	}

	.center.fail .title {
		color: var(--danger);
	}

	.auth-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: center;
		margin-top: 12px;
	}

	.primary {
		padding: 7px 14px;
		border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border));
		border-radius: 0;
		background: var(--accent-soft);
		color: var(--accent);
		font: inherit;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}

	.primary:hover:not(:disabled) {
		border-color: var(--accent);
	}

	.primary:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.auth-note {
		margin: 10px 0 0;
		max-width: 28rem;
		font-size: 13px;
		color: var(--text-dim);
	}

	.auth-err {
		margin: 8px 0 0;
		max-width: 28rem;
		font-size: 13px;
		color: var(--danger);
	}

	.spinner {
		width: 34px;
		height: 34px;
		margin-bottom: 6px;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.title {
		margin: 0;
		font-size: 17px;
		font-weight: 600;
	}

	.detail {
		margin: 0;
		font-size: 14px;
		color: var(--text-dim);
		max-width: 28rem;
	}

	.hint {
		margin: 6px 0 0;
		max-width: 32rem;
		font-size: 13px;
		color: var(--text-faint);
	}

	.stage-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
		min-width: 0;
		flex: none;
		border-radius: 0;
	}

	.stage-header strong {
		font-size: 13.5px;
		font-weight: 650;
	}

	.stage-header small {
		font-family: var(--mono);
		font-size: 11.5px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.log-wrap {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 12px 14px;
		gap: 10px;
		border-radius: 0;
	}

	.log-wrap :global(.log) {
		flex: 1;
		min-height: 0;
	}

	.stage-footer {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: none;
		flex-wrap: wrap;
		padding-top: 10px;
		margin-top: auto;
		border-top: 1px solid var(--border);
		border-radius: 0;
		min-width: 0;
	}

	/* TrustSessionToggle trae width:100%; en el footer no puede comerse Permitir/Rechazar. */
	.stage-footer :global(.trust) {
		width: auto;
		flex: 0 1 auto;
		min-width: 0;
		max-width: 100%;
	}

	.footer-spacer {
		flex: 1 1 8px;
		min-width: 8px;
	}

	.stage-footer :global(.perm-actions) {
		flex: none;
	}

	.launch-banner {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 0;
		background: color-mix(in srgb, var(--accent-soft) 70%, var(--bg-card));
	}

	.launch-banner .title {
		font-size: 14px;
	}

	.launch-banner .detail {
		font-size: 12.5px;
		margin-top: 2px;
	}

	.spinner.sm {
		width: 18px;
		height: 18px;
		margin: 2px 0 0;
		flex: none;
	}

	@media (max-width: 800px) {
		.body {
			grid-template-columns: 1fr;
			grid-template-rows: auto 1fr;
			padding: 16px;
			gap: 14px;
		}

		.card {
			align-self: stretch;
		}

		.stage {
			min-height: 280px;
		}
	}

	@media (max-width: 480px) {
		.bar {
			padding: 10px 14px;
			flex-wrap: wrap;
		}

		.pill {
			font-size: 10px;
		}
	}
</style>
