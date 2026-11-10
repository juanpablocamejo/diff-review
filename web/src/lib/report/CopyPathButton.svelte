<script lang="ts">
	let {
		path,
		title = 'Copiar ruta'
	}: {
		path: string;
		title?: string;
	} = $props();

	let copied = $state(false);
	let resetTimer: ReturnType<typeof setTimeout> | null = null;

	function copy(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		const value = String(path || '').trim();
		if (!value) return;
		const done = () => {
			copied = true;
			if (resetTimer) clearTimeout(resetTimer);
			resetTimer = setTimeout(() => {
				copied = false;
				resetTimer = null;
			}, 1200);
		};
		if (navigator.clipboard?.writeText) {
			navigator.clipboard.writeText(value).then(done).catch(done);
		} else {
			done();
		}
	}
</script>

<button
	type="button"
	class="copy-path"
	class:copied
	{title}
	aria-label={copied ? 'Ruta copiada' : title}
	onclick={copy}
>
	{#if copied}
		<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
			<path
				d="M3.5 8.5 6.5 11.5 12.5 4.5"
				fill="none"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	{:else}
		<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
			<rect
				x="5.5"
				y="5.5"
				width="7"
				height="7"
				rx="1"
				fill="none"
				stroke="currentColor"
				stroke-width="1.35"
			/>
			<path
				d="M3.5 10.5V3.5h7"
				fill="none"
				stroke="currentColor"
				stroke-width="1.35"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	{/if}
</button>

<style>
	.copy-path {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
		flex-shrink: 0;
		opacity: 0.55;
		border-radius: 0;
	}

	.copy-path:hover,
	.copy-path:focus-visible {
		opacity: 1;
		color: var(--text);
		outline: none;
	}

	.copy-path:focus-visible {
		box-shadow: inset 0 0 0 1px var(--accent);
	}

	.copy-path.copied {
		opacity: 1;
		color: var(--ok, #1f9d55);
	}
</style>
