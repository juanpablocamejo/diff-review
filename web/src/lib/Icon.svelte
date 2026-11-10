<script lang="ts">
	export type IconName =
		| 'sidebar-left'
		| 'sidebar-right'
		| 'unified'
		| 'split'
		| 'minus'
		| 'plus'
		| 'wrap'
		| 'chat'
		| 'download'
		| 'more'
		| 'repo'
		| 'branch'
		| 'arrow-right'
		| 'sliders'
		| 'sun'
		| 'moon'
		| 'brain'
		| 'info'
		| 'chevron-right'
		| 'tree'
		| 'list';

	let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg
	class="icon"
	width={size}
	height={size}
	viewBox="0 0 16 16"
	fill="none"
	stroke="currentColor"
	stroke-width="1.5"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if name === 'sidebar-left'}
		<rect x="2" y="2.75" width="12" height="10.5" rx="1.5" />
		<path d="M6.25 2.75v10.5" />
	{:else if name === 'sidebar-right'}
		<rect x="2" y="2.75" width="12" height="10.5" rx="1.5" />
		<path d="M9.75 2.75v10.5" />
	{:else if name === 'unified'}
		<path d="M3 4.5h10M3 8h10M3 11.5h10" />
	{:else if name === 'split'}
		<path d="M2.5 4.5h4M2.5 8h4M2.5 11.5h4M9.5 4.5h4M9.5 8h4M9.5 11.5h4" />
	{:else if name === 'minus'}
		<path d="M4 8h8" />
	{:else if name === 'plus'}
		<path d="M4 8h8M8 4v8" />
	{:else if name === 'wrap'}
		<path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8.5M10 10.5 8.5 12l1.5 1.5M2.5 12h3" />
	{:else if name === 'chat'}
		<path
			d="M2.5 3.25h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.2L4 13.75V11.25H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"
		/>
	{:else if name === 'download'}
		<path d="M8 2.5v7.2M5.2 7.2 8 10l2.8-2.8M3.5 12.5h9" />
	{:else if name === 'more'}
		<circle cx="8" cy="3.5" r="0.6" fill="currentColor" />
		<circle cx="8" cy="8" r="0.6" fill="currentColor" />
		<circle cx="8" cy="12.5" r="0.6" fill="currentColor" />
	{:else if name === 'repo'}
		<path d="M3.5 12.5V3.75a1.25 1.25 0 0 1 1.25-1.25h7.75v8.5H4.75a1.25 1.25 0 0 0 0 2.5h7.75" />
	{:else if name === 'branch'}
		<circle cx="5" cy="3.75" r="1.5" />
		<circle cx="5" cy="12.25" r="1.5" />
		<circle cx="11" cy="5.25" r="1.5" />
		<path d="M5 5.25v5.5M11 6.75c0 2.5-6 1.75-6 4" />
	{:else if name === 'arrow-right'}
		<path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" />
	{:else if name === 'sliders'}
		<path d="M2.5 5h6M12.5 5h1M2.5 11h1M7.5 11h6" />
		<circle cx="10.5" cy="5" r="1.75" />
		<circle cx="5.5" cy="11" r="1.75" />
	{:else if name === 'sun'}
		<circle cx="8" cy="8" r="2.75" />
		<path
			d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"
		/>
	{:else if name === 'moon'}
		<path d="M13.25 9.6A5.5 5.5 0 1 1 6.4 2.75a4.5 4.5 0 0 0 6.85 6.85Z" />
	{:else if name === 'brain'}
		<!-- Dos hemisferios con lóbulos y un pliegue de cada lado. -->
		<path
			d="M8 3.6A1.9 1.9 0 0 0 4.7 3.3 1.9 1.9 0 0 0 3.1 6.4a1.9 1.9 0 0 0 .4 3.8 1.9 1.9 0 0 0 2.4 2.6A1.7 1.7 0 0 0 8 12.4Z"
		/>
		<path
			d="M8 3.6a1.9 1.9 0 0 1 3.3-.3 1.9 1.9 0 0 1 1.6 3.1 1.9 1.9 0 0 1-.4 3.8 1.9 1.9 0 0 1-2.4 2.6A1.7 1.7 0 0 1 8 12.4"
		/>
		<path d="M5.4 6.9c.9 0 1.6.6 1.6 1.5M10.6 6.9c-.9 0-1.6.6-1.6 1.5" />
	{:else if name === 'info'}
		<circle cx="8" cy="8" r="6" />
		<path d="M8 7.4v3.4" />
		<circle cx="8" cy="5.1" r="0.55" fill="currentColor" />
	{:else if name === 'chevron-right'}
		<path d="M6.25 4.5 9.75 8l-3.5 3.5" />
	{:else if name === 'tree'}
		<!-- Raíz arriba y dos hijos colgando de una guía: se lee como jerarquía, no como lista. -->
		<path d="M2.5 3.5h11" />
		<path d="M4.5 3.5V11a1.5 1.5 0 0 0 1.5 1.5h1.5M4.5 8h3" />
		<path d="M10 8h3.5M10 12.5h3.5" />
	{:else if name === 'list'}
		<path d="M3 4h10M3 8h10M3 12h10" />
	{/if}
</svg>

<style>
	.icon {
		display: block;
		flex-shrink: 0;
	}
</style>
