<script lang="ts">
	import { tick } from 'svelte';
	import type { SeqEvent } from './agent-events';
	import MarkdownBody from './MarkdownBody.svelte';

	export type PermissionScope = 'once' | 'session' | 'always';

	export type PermissionResponse = {
		requestId?: string;
		allow: boolean;
		allowAll?: boolean;
		/** once (default) | session | always (ACP allow_always). */
		scope?: PermissionScope;
	};

	let {
		events,
		busy = false,
		sessionId = null,
		onrespondpermission,
		onretry
	}: {
		events: SeqEvent[];
		busy?: boolean;
		sessionId?: string | null;
		onrespondpermission?: (detail: PermissionResponse) => void;
		/** Reintentar tras un review fallido final (misma sesión). */
		onretry?: () => void;
	} = $props();

	const lastFinalFailSeq = $derived.by(() => {
		let seq = -1;
		for (const e of events) {
			if (e.type === 'review' && !e.ok && e.final) seq = e.seq;
		}
		return seq;
	});

	let box = $state<HTMLDivElement | null>(null);
	/** Seguir el final solo si el usuario no scrolleó hacia arriba. */
	let pinned = true;
	/** Cursor de navegación entre permisos pendientes (se clampea al largo actual). */
	let pendingCursor = $state(0);

	const pending = $derived(
		events.filter(
			(e): e is Extract<SeqEvent, { type: 'permission' }> => e.type === 'permission' && e.pending
		)
	);
	const pendingIndex = $derived(
		pending.length === 0 ? 0 : Math.min(pendingCursor, pending.length - 1)
	);
	const currentPending = $derived(pending[pendingIndex] ?? null);

	$effect(() => {
		void events.length;
		const last = events[events.length - 1];
		void (last?.type === 'text' ? last.text.length : 0);
		void pending.length;
		if (!pinned || !box) return;
		void tick().then(() => box && (box.scrollTop = box.scrollHeight));
	});

	function onScroll() {
		if (!box) return;
		pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
	}

	function toolMark(status: string) {
		if (status === 'completed') return '✓';
		if (status === 'failed') return '✗';
		return '…';
	}

	function showEvent(event: SeqEvent): boolean {
		if (event.type === 'phase') return false;
		if (event.type === 'permission') {
			if (event.pending || event.quiet) return false;
		}
		return true;
	}

	function stepPending(delta: number) {
		const n = pending.length;
		if (n <= 1) return;
		pendingCursor = (pendingIndex + delta + n) % n;
	}

	function onPermKeydown(e: KeyboardEvent) {
		if (pending.length <= 1) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			stepPending(-1);
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			stepPending(1);
		}
	}

	function respond(detail: PermissionResponse) {
		onrespondpermission?.(detail);
	}

	const USER_LABEL = { review: 'Review', ask: 'Pregunta', edit: 'Cambio', fix: 'Corrección' } as const;
</script>

<div class="log" bind:this={box} onscroll={onScroll} aria-live="polite">
	{#each events as event (event.seq + ':' + event.type)}
		{#if showEvent(event)}
			{#if event.type === 'user'}
				<div class="user">
					<span class="tag">{USER_LABEL[event.mode]}</span>
					<p>{event.text}</p>
				</div>
			{:else if event.type === 'text' && event.kind === 'message'}
				<div class="message">
					<MarkdownBody text={event.text} />
				</div>
			{:else if event.type === 'text'}
				<details class="thought">
					<summary>Pensando…</summary>
					<p>{event.text}</p>
				</details>
			{:else if event.type === 'tool'}
				<div class="tool" class:failed={event.status === 'failed'}>
					<span class="mark">{toolMark(event.status)}</span>
					<span class="title">{event.title || event.kind || 'herramienta'}</span>
				</div>
			{:else if event.type === 'permission'}
				<div class="permission" class:allowed={event.allow}>
					{#if event.allow}
						Permitido: {event.title}
					{:else}
						Rechazado: {event.title} <span>({event.reason})</span>
					{/if}
				</div>
			{:else if event.type === 'permission_summary'}
				<div class="permission" class:allowed={event.allow}>
					{event.allow ? `Permitidos ${event.count}` : `Rechazados ${event.count}`}
				</div>
			{:else if event.type === 'plan'}
				<ul class="plan">
					{#each event.entries as entry, i (i)}
						<li class:done={entry.status === 'completed'}>{entry.content}</li>
					{/each}
				</ul>
			{:else if event.type === 'review'}
				{#if event.ok}
					<div class="review ok">JSON válido: <code>{event.filename}</code></div>
				{:else}
					<div class="review bad">
						<strong
							>{event.final
								? 'El JSON quedó inválido'
								: 'JSON inválido; le pido al agente que lo corrija'}</strong
						>
						<ul>
							{#each event.errors.slice(0, 8) as err, i (i)}
								<li>{err}</li>
							{/each}
						</ul>
						{#if event.final && event.seq === lastFinalFailSeq && sessionId && onretry}
							<button
								type="button"
								class="retry"
								disabled={busy}
								onclick={() => onretry()}
								>Reintentar</button
							>
						{/if}
					</div>
				{/if}
			{:else if event.type === 'status' && event.status === 'error'}
				<div class="error">{event.message || 'Error del agente.'}</div>
			{:else if event.type === 'status' && event.message}
				<div class="note">{event.message}</div>
			{:else if event.type === 'turn' && event.stopReason !== 'end_turn'}
				<div class="note">Turno terminado: {event.stopReason}</div>
			{/if}
		{/if}
	{/each}

	{#if currentPending && sessionId && onrespondpermission}
		<div class="permission pending grouped" role="group" aria-label="Permisos pendientes">
			<div class="perm-head">
				<strong>Permiso</strong>
				{#if currentPending.kind}
					<span class="kind">{currentPending.kind}</span>
				{/if}
				{#if pending.length > 1}
					<span class="counter" aria-live="polite">{pendingIndex + 1} / {pending.length}</span>
					<span class="nav">
						<button
							type="button"
							class="nav-btn"
							title="Anterior"
							aria-label="Permiso anterior"
							onkeydown={onPermKeydown}
							onclick={() => stepPending(-1)}>◀</button
						>
						<button
							type="button"
							class="nav-btn"
							title="Siguiente"
							aria-label="Permiso siguiente"
							onkeydown={onPermKeydown}
							onclick={() => stepPending(1)}>▶</button
						>
					</span>
				{/if}
			</div>
			<p class="perm-title">{currentPending.title}</p>
			<p class="perm-reason">{currentPending.reason}</p>
			<div class="perm-actions">
				<button
					type="button"
					class="allow"
					title="Solo este pedido. El próximo denegado vuelve a preguntar."
					onkeydown={onPermKeydown}
					onclick={() =>
						respond({ requestId: currentPending.requestId, allow: true, scope: 'once' })}
					>Permitir una vez</button
				>
				<button
					type="button"
					class="deny"
					title="Niega solo este pedido."
					onkeydown={onPermKeydown}
					onclick={() => respond({ requestId: currentPending.requestId, allow: false })}
					>Rechazar</button
				>
				{#if pending.length > 1}
					<button
						type="button"
						class="allow-all"
						title="Aprueba todos los pedidos pendientes de ahora. No cambia los futuros."
						onkeydown={onPermKeydown}
						onclick={() => respond({ allow: true, allowAll: true, scope: 'once' })}
						>Permitir todo</button
					>
					<button
						type="button"
						class="deny-all"
						title="Niega todos los pedidos pendientes de ahora."
						onkeydown={onPermKeydown}
						onclick={() => respond({ allow: false, allowAll: true })}>Rechazar todo</button
					>
				{/if}
			</div>
		</div>
	{/if}

	{#if busy}
		<div class="working" aria-hidden="true"><span></span><span></span><span></span></div>
	{/if}
</div>

<style>
	.log {
		display: flex;
		flex-direction: column;
		gap: 6px;
		overflow-y: auto;
		min-height: 0;
		font-size: 13px;
		line-height: 1.45;
	}
	p {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.user {
		align-self: flex-end;
		max-width: 90%;
		background: var(--accent-soft);
		border: 1px solid var(--btn-primary-border);
		border-radius: 8px;
		padding: 6px 10px;
	}
	.tag {
		display: block;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
	}
	.message {
		color: var(--text);
		max-width: 100%;
	}
	.thought {
		color: var(--text-faint);
		font-size: 12px;
	}
	.thought summary {
		cursor: pointer;
		font-style: italic;
	}
	.thought p {
		margin-top: 4px;
		max-height: 200px;
		overflow-y: auto;
	}
	.tool {
		display: flex;
		gap: 6px;
		font-family: var(--mono);
		font-size: 12px;
		color: var(--text-dim);
	}
	.tool .mark {
		width: 12px;
		flex: none;
		color: var(--ok);
	}
	.tool.failed .mark,
	.tool.failed .title {
		color: var(--danger);
	}
	.tool .title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.permission {
		font-size: 12px;
		color: var(--warn);
	}
	.permission.allowed {
		color: var(--ok);
	}
	.permission.pending {
		border: 1px solid var(--warn);
		border-radius: 6px;
		padding: 8px 10px;
		background: var(--bg-card);
		color: var(--text);
	}
	.perm-head {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--warn);
	}
	.perm-head .kind {
		color: var(--text-faint);
		font-family: var(--mono);
		text-transform: none;
		letter-spacing: 0;
	}
	.perm-head .counter {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
		color: var(--text-dim);
		text-transform: none;
		letter-spacing: 0;
		font-family: var(--mono);
	}
	.perm-head .nav {
		display: flex;
		gap: 2px;
	}
	.nav-btn {
		padding: 2px 6px;
		font-size: 11px;
		line-height: 1.2;
		border: 1px solid var(--border);
		background: var(--bg-elev);
		color: var(--text-dim);
	}
	.perm-title {
		margin: 4px 0 0;
		font-family: var(--mono);
		font-size: 12px;
	}
	.perm-reason {
		margin: 2px 0 0;
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.perm-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}
	.perm-actions button {
		padding: 5px 10px;
		font-size: 12px;
		border: 1px solid var(--border);
		background: var(--bg-elev);
		color: var(--text);
	}
	.perm-actions .allow,
	.perm-actions .allow-all {
		background: var(--ok-bg);
		border-color: var(--ok);
		color: var(--ok);
	}
	.perm-actions .deny,
	.perm-actions .deny-all {
		background: var(--danger-bg);
		border-color: var(--danger-border);
		color: var(--danger);
	}
	.permission span {
		color: var(--text-faint);
	}
	.plan {
		margin: 0;
		padding-left: 18px;
		color: var(--text-dim);
		font-size: 12px;
	}
	.plan li.done {
		text-decoration: line-through;
		color: var(--text-faint);
	}
	.review {
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 12px;
	}
	.review.ok {
		background: var(--ok-bg);
		color: var(--ok);
	}
	.review.bad .retry {
		margin-top: 8px;
		padding: 5px 12px;
		font-size: 12px;
		border: 1px solid var(--danger-border);
		border-radius: 6px;
		background: var(--bg-elev);
		color: var(--text);
		cursor: pointer;
	}
	.review.bad .retry:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.review.bad .retry:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.review.bad,
	.error {
		background: var(--danger-bg);
		border: 1px solid var(--danger-border);
		color: var(--danger);
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 12px;
	}
	.review ul {
		margin: 4px 0 0;
		padding-left: 16px;
	}
	.note {
		font-size: 12px;
		color: var(--text-faint);
	}
	.working {
		display: flex;
		gap: 4px;
		padding: 4px 0;
	}
	.working span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-faint);
		animation: blink 1.2s infinite ease-in-out;
	}
	.working span:nth-child(2) {
		animation-delay: 0.2s;
	}
	.working span:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes blink {
		0%,
		80%,
		100% {
			opacity: 0.2;
		}
		40% {
			opacity: 1;
		}
	}
</style>
