<script lang="ts">
	import { tick } from 'svelte';
	import type { SeqEvent } from './agent-events';
	import MarkdownBody from './MarkdownBody.svelte';
	import PermissionActions from './PermissionActions.svelte';
	import type {
		PermissionResponse as PermissionResponseType,
		PermissionScope as PermissionScopeType
	} from './permission-response';

	export type PermissionResponse = PermissionResponseType;
	export type PermissionScope = PermissionScopeType;

	let {
		events,
		busy = false,
		sessionId = null,
		onrespondpermission,
		onretry,
		actionsExternal = false,
		pendingCursor = $bindable(0)
	}: {
		events: SeqEvent[];
		busy?: boolean;
		sessionId?: string | null;
		onrespondpermission?: (detail: PermissionResponseType) => void;
		/** Reintentar tras un review fallido final (misma sesión). */
		onretry?: () => void;
		/** Si true, los botones de permiso los renderiza el padre (p. ej. footer del stage). */
		actionsExternal?: boolean;
		pendingCursor?: number;
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

	function respond(detail: PermissionResponseType) {
		onrespondpermission?.(detail);
	}

	const KIND_LABELS: Record<string, string> = {
		execute: 'Shell',
		read: 'Lectura',
		edit: 'Edición',
		delete: 'Borrado',
		search: 'Búsqueda',
		think: 'Pensar'
	};

	function kindLabel(kind: string): string {
		return KIND_LABELS[kind] ?? kind;
	}

	const COMMAND_COLLAPSE_CHARS = 280;
	const COMMAND_COLLAPSE_LINES = 8;
	const RESOLVED_COMMAND_CHARS = 72;

	/** requestId → expandido en la tarjeta pendiente. */
	let expandedCommands = $state<Record<string, boolean>>({});

	function commandNeedsTruncate(text: string): boolean {
		if (text.length > COMMAND_COLLAPSE_CHARS) return true;
		return text.split('\n').length > COMMAND_COLLAPSE_LINES;
	}

	function truncateCommand(text: string, maxChars: number, maxLines: number): string {
		const lines = text.split('\n');
		if (lines.length > maxLines) {
			return lines.slice(0, maxLines).join('\n') + '…';
		}
		if (text.length > maxChars) {
			return text.slice(0, maxChars) + '…';
		}
		return text;
	}

	function pendingCommandDisplay(text: string, requestId: string): string {
		if (expandedCommands[requestId] || !commandNeedsTruncate(text)) return text;
		return truncateCommand(text, COMMAND_COLLAPSE_CHARS, COMMAND_COLLAPSE_LINES);
	}

	function toggleCommandExpanded(requestId: string) {
		expandedCommands[requestId] = !expandedCommands[requestId];
	}

	function resolvedPermissionSubject(event: Extract<SeqEvent, { type: 'permission' }>): string {
		if (event.command) {
			const short = truncateCommand(event.command, RESOLVED_COMMAND_CHARS, 1);
			return `${kindLabel(event.kind)} — ${short}`;
		}
		return event.title || kindLabel(event.kind);
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
						Permitido: {resolvedPermissionSubject(event)}
					{:else}
						Rechazado: {resolvedPermissionSubject(event)} <span>({event.reason})</span>
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

	{#if currentPending && sessionId && (onrespondpermission || actionsExternal)}
		<div class="permission pending grouped" role="group" aria-label="Permisos pendientes">
			<div class="perm-head">
				<strong>Permiso</strong>
				{#if currentPending.kind}
					<span class="kind">{kindLabel(currentPending.kind)}</span>
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
			{#if currentPending.command}
				{#if currentPending.title}
					<p class="perm-subtitle">{currentPending.title}</p>
				{/if}
				<pre
					class="perm-command"
					class:collapsed={!expandedCommands[currentPending.requestId] &&
						commandNeedsTruncate(currentPending.command)}>{pendingCommandDisplay(
						currentPending.command,
						currentPending.requestId
					)}</pre>
				{#if commandNeedsTruncate(currentPending.command)}
					<button
						type="button"
						class="perm-expand"
						onclick={() => toggleCommandExpanded(currentPending.requestId)}
					>
						{expandedCommands[currentPending.requestId] ? 'Ver menos' : 'Ver más'}
					</button>
				{/if}
			{:else if currentPending.title}
				<p class="perm-title">{currentPending.title}</p>
			{/if}
			<p class="perm-reason">{currentPending.reason}</p>
			{#if !actionsExternal && onrespondpermission}
				<PermissionActions
					currentPending={currentPending}
					pendingCount={pending.length}
					onrespond={respond}
					onkeydown={onPermKeydown}
				/>
			{/if}
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
		border-radius: 0;
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
		border-radius: 0;
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
		border-radius: 0;
		background: var(--bg-elev);
		color: var(--text-dim);
	}
	.perm-subtitle {
		margin: 4px 0 0;
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.perm-title {
		margin: 4px 0 0;
		font-family: var(--mono);
		font-size: 12px;
	}
	.perm-command {
		margin: 6px 0 0;
		padding: 8px 10px;
		font-family: var(--mono);
		font-size: 11.5px;
		line-height: 1.4;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		word-break: break-word;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: 0;
		max-width: 100%;
	}
	.perm-command.collapsed {
		max-height: 10.5em;
		overflow: hidden;
	}
	.perm-expand {
		margin: 4px 0 0;
		padding: 0;
		font-size: 11.5px;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--accent);
		text-decoration: underline;
		cursor: pointer;
	}
	.perm-expand:hover {
		color: var(--text);
	}
	.perm-reason {
		margin: 2px 0 0;
		font-size: 11.5px;
		color: var(--text-faint);
	}
	.permission.pending :global(.perm-actions) {
		margin-top: 8px;
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
		border-radius: 0;
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
		border-radius: 0;
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
		border-radius: 0;
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
