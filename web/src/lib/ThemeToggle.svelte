<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
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

<button
	type="button"
	class="theme-toggle"
	onclick={toggle}
	title={theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}
	aria-label={theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}
>
	<Icon name={theme === 'dark' ? 'sun' : 'moon'} />
</button>

<style>
	.theme-toggle {
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius);
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		color: var(--text-dim);
		flex-shrink: 0;
		cursor: pointer;
	}

	.theme-toggle:hover {
		background: color-mix(in srgb, var(--text) 7%, transparent);
		color: var(--text);
	}

	.theme-toggle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
