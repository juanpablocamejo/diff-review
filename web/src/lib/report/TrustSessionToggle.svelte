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

	const id = `trust-${Math.random().toString(36).slice(2, 9)}`;

	function onInput(e: Event) {
		const el = e.currentTarget as HTMLInputElement;
		onchange?.(el.checked);
	}
</script>

<label class="trust" class:inline class:on={enabled} for={id} title="Si está activo, no pide confirmación cuando la política niega un permiso (solo esta sesión).">
	<input
		{id}
		type="checkbox"
		role="switch"
		class="sr"
		checked={enabled}
		aria-checked={enabled}
		aria-label="Auto-aprobar permisos"
		onchange={onInput}
	/>
	<span class="switch" aria-hidden="true">
		<span class="knob"></span>
	</span>
	<span class="trust-text">
		<span class="label">{inline ? 'Auto-aprobar' : 'Auto-aprobar permisos'}</span>
		{#if !inline}
			<small>Solo esta sesión</small>
		{/if}
	</span>
</label>

<style>
	.trust {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
		user-select: none;
		font: inherit;
		color: var(--text-dim);
	}
	.trust.inline {
		max-width: 100%;
	}
	.trust.on {
		color: var(--text);
	}
	.trust:focus-within .switch {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.switch {
		position: relative;
		flex: none;
		width: 28px;
		height: 16px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--bg-elev, var(--bg));
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
		opacity: 0.45;
		transition:
			transform 0.15s ease,
			background 0.15s ease,
			opacity 0.15s ease;
	}
	.trust.on .knob {
		transform: translateX(12px);
		background: #fff;
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
	.label {
		font-size: 12px;
		font-weight: 500;
	}
	.trust-text small {
		font-size: 11px;
		color: var(--text-faint);
	}
</style>
