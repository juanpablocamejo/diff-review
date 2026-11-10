<script lang="ts">
	let {
		// Conservado por compat: el icono de abrir chat es genérico (no marca del agente).
		agentId: _agentId = '',
		title = 'Preguntar al agente',
		onclick
	}: {
		agentId?: string;
		title?: string;
		onclick: () => void;
	} = $props();
</script>

<button type="button" class="ask-agent" {title} aria-label={title} {onclick}>
	<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
		<path
			d="M2.5 3.25h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.2L4 13.75V11.25H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"
			fill="none"
			stroke="currentColor"
			stroke-width="1.35"
			stroke-linejoin="round"
		/>
	</svg>
</button>

<style>
	.ask-agent {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--border);
		background: var(--bg-card);
		color: var(--text-dim);
		border-radius: var(--radius);
		cursor: pointer;
		flex-shrink: 0;
	}

	.ask-agent:hover {
		border-color: var(--border-strong, var(--border));
		color: var(--text);
		background: var(--bg-elev, var(--bg-card));
	}
</style>
