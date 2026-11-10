<script lang="ts">
	let {
		size = 16,
		class: className = ''
	}: {
		size?: number;
		class?: string;
	} = $props();
</script>

<svg
	class={className}
	width={size}
	height={size}
	viewBox="0 0 16 16"
	fill="none"
	aria-hidden="true"
>
	<!-- Un solo tono: rojo/verde quedan para el contenido del diff. -->
	<path
		d="M1.2 3.1c0-.55.66-.86 1.1-.52L7.05 7.2a1.1 1.1 0 0 1 0 1.6L2.3 13.42c-.44.34-1.1.03-1.1-.52V3.1Z"
		fill="var(--accent)"
		opacity="0.45"
	/>
	<path
		d="M8.55 3.1c0-.55.66-.86 1.1-.52L14.4 7.2a1.1 1.1 0 0 1 0 1.6l-4.75 4.62c-.44.34-1.1.03-1.1-.52V3.1Z"
		fill="var(--accent)"
	/>
</svg>
