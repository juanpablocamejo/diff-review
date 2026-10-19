<script lang="ts">
	import type { Attachment } from 'svelte/attachments';

	export type ModelSelectOption = {
		value: string;
		label: string;
		title?: string;
		badges?: string[];
		hint?: string;
	};

	let {
		value = $bindable(''),
		options,
		disabled = false,
		onchange
	}: {
		value?: string;
		options: ModelSelectOption[];
		disabled?: boolean;
		onchange?: () => void;
	} = $props();

	let open = $state(false);
	/** Menú hacia arriba cuando no hay espacio debajo. */
	let dropUp = $state(false);
	let rootEl = $state<HTMLDivElement | null>(null);

	const selected = $derived(options.find((o) => o.value === value) ?? null);
	const selectedTitle = $derived(selected?.title || selected?.label || '');
	const selectedBadges = $derived(selected?.badges ?? []);

	function assign(next: string, close = true) {
		if (next !== value) {
			value = next;
			onchange?.();
		}
		if (close) open = false;
	}

	function placeMenu() {
		const el = rootEl;
		if (!el) {
			dropUp = false;
			return;
		}
		const rect = el.getBoundingClientRect();
		const spaceBelow = window.innerHeight - rect.bottom;
		const spaceAbove = rect.top;
		const menuMax = Math.min(360, window.innerHeight * 0.5);
		dropUp = spaceBelow < menuMax && spaceAbove > spaceBelow;
	}

	function toggle() {
		if (disabled || !options.length) return;
		if (!open) placeMenu();
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
			const idx = Math.max(0, options.findIndex((o) => o.value === value));
			const next =
				e.key === 'ArrowDown'
					? options[Math.min(options.length - 1, idx + 1)]
					: options[Math.max(0, idx - 1)];
			if (next) assign(next.value, false);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			open = false;
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
	class="model-select"
	class:open
	class:drop-up={dropUp}
	class:disabled
	bind:this={rootEl}
	{@attach closeOnOutside}
>
	<button
		type="button"
		class="trigger"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-label="Modelo"
		{disabled}
		onclick={toggle}
	>
		{#if selected}
			<span class="title">{selectedTitle}</span>
			{#if selectedBadges.length}
				<span class="badges" aria-hidden="true">
					{#each selectedBadges as b (b)}
						<span class="badge">{b}</span>
					{/each}
				</span>
			{/if}
		{:else}
			<span class="title muted">Elegí un modelo</span>
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
			{#each options as opt (opt.value)}
				<button
					type="button"
					class="option"
					class:selected={opt.value === value}
					role="option"
					aria-selected={opt.value === value}
					onclick={() => assign(opt.value)}
				>
					<span class="title">{opt.title || opt.label}</span>
					{#if opt.badges?.length}
						<span class="badges" aria-hidden="true">
							{#each opt.badges as b (b)}
								<span class="badge">{b}</span>
							{/each}
						</span>
					{:else if opt.hint && opt.value !== ''}
						<span class="hint">{opt.hint}</span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.model-select {
		position: relative;
		flex: 1;
		min-width: 0;
		width: 100%;
	}

	.trigger {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		min-width: 0;
		padding: 6px 10px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		color: var(--text);
		font: inherit;
		font-size: 12px;
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

	.title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.title.muted {
		color: var(--text-faint);
	}

	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		flex-shrink: 0;
		max-width: 45%;
		justify-content: flex-end;
	}

	.badge {
		padding: 0 5px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-elev, var(--bg-card));
		color: var(--text-dim, var(--text-faint));
		font-size: 10px;
		line-height: 1.35;
		font-family: var(--mono, ui-monospace, monospace);
		white-space: nowrap;
	}

	.hint {
		flex-shrink: 0;
		color: var(--text-faint);
		font-size: 10px;
		font-family: var(--mono, ui-monospace, monospace);
	}

	.caret {
		flex-shrink: 0;
		opacity: 0.7;
		color: var(--text-dim);
	}

	.model-select.open .caret {
		transform: rotate(180deg);
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		bottom: auto;
		left: 0;
		right: 0;
		z-index: 40;
		display: flex;
		flex-direction: column;
		max-height: min(360px, 50vh);
		overflow: auto;
		padding: 4px;
		border: 1px solid var(--border);
		background: var(--bg-card);
		box-shadow: 0 8px 24px color-mix(in srgb, #000 18%, transparent);
	}

	.model-select.drop-up .menu {
		top: auto;
		bottom: calc(100% + 4px);
		box-shadow: 0 -8px 24px color-mix(in srgb, #000 18%, transparent);
	}

	.option {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 8px;
		border: 0;
		border-radius: 2px;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}

	.option:hover,
	.option.selected {
		background: var(--accent-soft);
	}
</style>
