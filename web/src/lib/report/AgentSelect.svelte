<script lang="ts">
	import type { Attachment } from 'svelte/attachments';
	import AgentIcon from './AgentIcon.svelte';

	export type AgentSelectOption = { id: string; label: string };

	let {
		value = $bindable(''),
		options,
		disabled = false,
		onchange
	}: {
		value?: string;
		options: AgentSelectOption[];
		disabled?: boolean;
		onchange?: () => void;
	} = $props();

	let open = $state(false);

	const selected = $derived(options.find((o) => o.id === value) ?? null);

	function assign(id: string, close = true) {
		if (id !== value) {
			value = id;
			onchange?.();
		}
		if (close) open = false;
	}

	function toggle() {
		if (disabled || !options.length) return;
		open = !open;
	}

	const closeOnOutside: Attachment = (node) => {
		function onPointerDown(e: PointerEvent) {
			if (!open) return;
			if (!node.contains(e.target as Node)) open = false;
		}
		window.addEventListener('pointerdown', onPointerDown);
		return () => window.removeEventListener('pointerdown', onPointerDown);
	};

	function onWindowKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			open = false;
			return;
		}
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!options.length) return;
			const idx = Math.max(
				0,
				options.findIndex((o) => o.id === value)
			);
			const next =
				e.key === 'ArrowDown'
					? options[Math.min(options.length - 1, idx + 1)]
					: options[Math.max(0, idx - 1)];
			if (next) assign(next.id, false);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			open = false;
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="agent-select" class:open class:disabled {@attach closeOnOutside}>
	<button
		type="button"
		class="trigger"
		aria-haspopup="listbox"
		aria-expanded={open}
		{disabled}
		onclick={toggle}
	>
		{#if selected}
			<AgentIcon id={selected.id} size={15} />
			<span class="label">{selected.label}</span>
		{:else}
			<span class="label muted">Elegí un agente</span>
		{/if}
		<svg class="caret" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
			<path
				d="M2.5 4.5 6 8l3.5-3.5"
				fill="none"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	</button>
	{#if open}
		<div class="menu" role="listbox" tabindex="-1">
			{#each options as opt (opt.id)}
				<button
					type="button"
					class="option"
					class:selected={opt.id === value}
					role="option"
					aria-selected={opt.id === value}
					onclick={() => assign(opt.id)}
				>
					<AgentIcon id={opt.id} size={15} />
					<span class="label">{opt.label}</span>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.agent-select {
		position: relative;
		flex: 1;
		min-width: 0;
		width: 100%;
	}

	.trigger {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
		min-height: 38px;
		padding: 9px 12px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		color: var(--text);
		font: inherit;
		font-size: inherit;
		text-align: left;
		cursor: pointer;
	}

	.trigger:hover:not(:disabled) {
		border-color: var(--accent);
	}

	.trigger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.label.muted {
		color: var(--text-faint);
	}

	.caret {
		flex-shrink: 0;
		opacity: 0.7;
		color: var(--text-dim);
	}

	.agent-select.open .caret {
		transform: rotate(180deg);
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		z-index: 40;
		display: flex;
		flex-direction: column;
		gap: 0;
		padding: 4px;
		border: 1px solid var(--border);
		background: var(--bg-card);
		box-shadow: 0 8px 24px color-mix(in srgb, #000 18%, transparent);
	}

	.option {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 10px;
		border: 0;
		border-radius: 2px;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: inherit;
		text-align: left;
		cursor: pointer;
	}

	.option:hover,
	.option.selected {
		background: var(--accent-soft);
	}
</style>
