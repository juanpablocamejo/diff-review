<script lang="ts">
	import AgentIcon from './AgentIcon.svelte';

	let {
		agentId = '',
		title = 'Preguntar al agente',
		onclick
	}: {
		agentId?: string;
		title?: string;
		onclick: () => void;
	} = $props();
</script>

<button type="button" class="ask-agent" {title} aria-label={title} {onclick}>
	<AgentIcon id={agentId} size={14} />
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
		border-radius: 6px;
		cursor: pointer;
		flex-shrink: 0;
	}

	.ask-agent:hover {
		border-color: var(--border-strong, var(--border));
		color: var(--text);
		background: var(--bg-elev, var(--bg-card));
	}
</style>
