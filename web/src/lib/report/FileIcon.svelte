<script lang="ts">
	import { fileIcon } from './icons';

	let { path, size = 16 }: { path: string; size?: number } = $props();

	const icon = $derived(fileIcon(path));
</script>

<span
	class="file-icon"
	class:branded={icon.preserveFill}
	style:color={icon.color}
	style:width="{size}px"
	style:height="{size}px"
	aria-hidden="true">{@html icon.svg}</span
>

<style>
	.file-icon {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.file-icon :global(svg) {
		width: 100%;
		height: 100%;
	}

	/* Logos con marca a sangre (Svelte): un poco más chicos para empatar el padding óptico de Seti. */
	.file-icon.branded :global(svg) {
		width: 78%;
		height: 78%;
	}

	.file-icon:not(.branded) :global(svg) {
		fill: currentColor;
	}
</style>
