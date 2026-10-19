<script lang="ts">
	import { agentIcon } from './agent-icons';

	let { id, size = 16 }: { id: string; size?: number } = $props();

	const icon = $derived(agentIcon(id));
</script>

<span
	class="agent-icon"
	style:color={icon.color}
	style:width="{size}px"
	style:height="{size}px"
	aria-hidden="true"
>
	<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill={icon.color} fill-rule={icon.evenodd ? 'evenodd' : undefined}>
		<path d={icon.path} />
	</svg>
</span>

<style>
	.agent-icon {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.agent-icon svg {
		width: 100%;
		height: 100%;
		display: block;
	}
</style>
