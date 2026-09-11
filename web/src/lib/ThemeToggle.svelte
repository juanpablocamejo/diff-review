<script lang="ts">
	import { onMount } from 'svelte';
	import { applyTheme, loadTheme, saveTheme, type Theme } from './theme';

	let theme = $state<Theme>('dark');

	onMount(() => {
		theme = loadTheme();
	});

	function toggle() {
		theme = theme === 'dark' ? 'light' : 'dark';
		applyTheme(theme);
		saveTheme(theme);
	}
</script>

<button type="button" class="theme-toggle" onclick={toggle} title={theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}>
	{theme === 'dark' ? '◐' : '◑'}
</button>

<style>
	.theme-toggle {
		background: var(--bg-card);
		border: 1px solid var(--border);
		width: 30px;
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		font-size: 14px;
		color: var(--text-dim);
		flex-shrink: 0;
	}

	.theme-toggle:hover {
		border-color: var(--accent);
		color: var(--text);
	}
</style>
