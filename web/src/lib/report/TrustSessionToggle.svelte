<script lang="ts">
	let {
		enabled = false,
		onchange
	}: {
		enabled?: boolean;
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
		<strong>Auto-aprobar permisos</strong>
		<small>Solo esta sesión</small>
	</span>
</button>

<style>
	.trust {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: none;
		width: 100%;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		text-align: left;
		cursor: pointer;
		user-select: none;
		font: inherit;
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
		width: 36px;
		height: 20px;
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
		top: 2px;
		left: 2px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--text);
		opacity: 0.55;
		transition:
			transform 0.15s ease,
			background 0.15s ease,
			opacity 0.15s ease;
	}
	.trust.on .knob {
		transform: translateX(16px);
		background: var(--bg-card);
		opacity: 1;
	}
	.trust-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.trust-text strong {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--text);
	}
	.trust-text small {
		font-size: 11.5px;
		color: var(--text-faint);
	}
</style>
