<script lang="ts">
	import { fileIcon } from './icons';

	let { path, size = 14 }: { path: string; size?: number } = $props();

	const icon = $derived(fileIcon(path));
</script>

<span
	class="file-icon"
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
		opacity: 0.9;
	}

	.file-icon :global(svg) {
		width: 100%;
		height: 100%;
		fill: currentColor;
	}
</style>
