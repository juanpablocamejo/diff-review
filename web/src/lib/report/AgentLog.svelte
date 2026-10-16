<script lang="ts">
	import { tick } from 'svelte';
	import type { SeqEvent } from './agent-events';

	let { events, busy = false }: { events: SeqEvent[]; busy?: boolean } = $props();

	let box = $state<HTMLDivElement | null>(null);
	/** Seguir el final solo si el usuario no scrolleó hacia arriba. */
	let pinned = true;

	$effect(() => {
		void events.length;
		const last = events[events.length - 1];
		void (last?.type === 'text' ? last.text.length : 0);
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

	const USER_LABEL = { review: 'Review', ask: 'Pregunta', edit: 'Cambio', fix: 'Corrección' } as const;
</script>

<div class="log" bind:this={box} onscroll={onScroll} aria-live="polite">
	{#each events as event (event.seq + ':' + event.type)}
		{#if event.type === 'user'}
			<div class="user">
				<span class="tag">{USER_LABEL[event.mode]}</span>
				<p>{event.text}</p>
			</div>
		{:else if event.type === 'text' && event.kind === 'message'}
			<p class="message">{event.text}</p>
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
			<div class="permission">Rechazado: {event.title} <span>({event.reason})</span></div>
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
					<strong>{event.final ? 'El JSON quedó inválido' : 'JSON inválido; le pido al agente que lo corrija'}</strong>
					<ul>
						{#each event.errors.slice(0, 8) as err, i (i)}
							<li>{err}</li>
						{/each}
					</ul>
				</div>
			{/if}
		{:else if event.type === 'status' && event.status === 'error'}
			<div class="error">{event.message || 'Error del agente.'}</div>
		{:else if event.type === 'status' && event.message}
			<div class="note">{event.message}</div>
		{:else if event.type === 'turn' && event.stopReason !== 'end_turn'}
			<div class="note">Turno terminado: {event.stopReason}</div>
		{/if}
	{/each}
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
