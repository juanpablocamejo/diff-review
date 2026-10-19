<script lang="ts">
	let {
		enabled = false,
		/** Compacto para el footer del chat (ancho al contenido). */
		inline = false,
		onchange
	}: {
		enabled?: boolean;
		inline?: boolean;
		onchange?: (enabled: boolean) => void;
	} = $props();

	function toggle() {
		onchange?.(!enabled);
	}
</script>

<button
	type="button"
	class="trust"
	class:on={enabled}
	class:inline
	role="switch"
	aria-checked={enabled}
	title="Si está activo, no pide confirmación cuando la política niega un permiso (solo esta sesión)."
	aria-label="Auto-aprobar permisos"
	onclick={toggle}
>
	<span class="switch" aria-hidden="true">
		<span class="knob"></span>
	</span>
	<span class="trust-text">
		<strong>{inline ? 'Auto-aprobar' : 'Auto-aprobar permisos'}</strong>
		{#if !inline}
			<small>· Solo esta sesión</small>
		{/if}
	</span>
</button>

<style>
	.trust {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: none;
		width: 100%;
		padding: 5px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-card);
		text-align: left;
		cursor: pointer;
		user-select: none;
		font: inherit;
	}
	.trust.inline {
		width: auto;
		max-width: 100%;
		padding: 4px 8px;
	}
	.trust.on {
		border-color: color-mix(in srgb, var(--ok) 45%, var(--border));
		background: var(--ok-bg);
	}
	.trust:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.switch {
		position: relative;
		flex: none;
		width: 30px;
		height: 16px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-elev);
		transition:
			background 0.15s ease,
			border-color 0.15s ease;
	}
	.trust.on .switch {
		background: var(--ok);
		border-color: var(--ok);
	}
	.knob {
		position: absolute;
		top: 1px;
		left: 1px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--text);
		opacity: 0.55;
		transition:
			transform 0.15s ease,
			background 0.15s ease,
			opacity 0.15s ease;
	}
	.trust.on .knob {
		transform: translateX(14px);
		background: var(--bg-card);
		opacity: 1;
	}
	.trust-text {
		display: flex;
		align-items: baseline;
		gap: 4px;
		min-width: 0;
		flex-wrap: wrap;
		line-height: 1.2;
	}
	.trust-text strong {
		font-size: 12px;
		font-weight: 600;
		color: var(--text);
	}
	.trust-text small {
		font-size: 11px;
		color: var(--text-faint);
	}
</style>
