<script lang="ts">
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import { applyTheme, loadTheme } from '$lib/theme';
	import '../app.css';

	let { children }: { children: Snippet } = $props();

	onMount(() => {
		applyTheme(loadTheme());
	});
</script>

<svelte:head>
	<title>diff-review</title>
</svelte:head>

<svelte:boundary>
	{@render children()}
	{#snippet pending()}
		<div class="boot">Cargando…</div>
	{/snippet}
	{#snippet failed(error, reset)}
		<div class="boot">
			<p>{error instanceof Error ? error.message : String(error)}</p>
			<button type="button" onclick={reset}>Reintentar</button>
		</div>
	{/snippet}
</svelte:boundary>

<style>
	.boot {
		padding: 48px 28px;
		color: var(--text-dim);
		font-family: var(--mono);
		font-size: 13px;
	}

	.boot button {
		margin-top: 12px;
		background: var(--btn-primary-bg);
		border: 1px solid var(--btn-primary-border);
		color: var(--btn-primary-text);
		padding: 8px 14px;
		border-radius: 8px;
	}
</style>
