<script lang="ts">
	import type { PermissionResponse } from './permission-response';

	let {
		currentPending,
		pendingCount,
		onrespond,
		onkeydown
	}: {
		currentPending: { requestId: string } | null;
		pendingCount: number;
		onrespond: (detail: PermissionResponse) => void;
		onkeydown?: (e: KeyboardEvent) => void;
	} = $props();
</script>

{#if currentPending}
	<div class="perm-actions">
		<button
			type="button"
			class="allow"
			title="Solo este pedido. El próximo denegado vuelve a preguntar."
			{onkeydown}
			onclick={() => onrespond({ requestId: currentPending.requestId, allow: true, scope: 'once' })}
			>Permitir una vez</button
		>
		<button
			type="button"
			class="deny"
			title="Niega solo este pedido."
			{onkeydown}
			onclick={() => onrespond({ requestId: currentPending.requestId, allow: false })}
			>Rechazar</button
		>
		{#if pendingCount > 1}
			<button
				type="button"
				class="allow-all"
				title="Aprueba todos los pedidos pendientes de ahora. No cambia los futuros."
				{onkeydown}
				onclick={() => onrespond({ allow: true, allowAll: true, scope: 'once' })}
				>Permitir todo</button
			>
			<button
				type="button"
				class="deny-all"
				title="Niega todos los pedidos pendientes de ahora."
				{onkeydown}
				onclick={() => onrespond({ allow: false, allowAll: true })}>Rechazar todo</button
			>
		{/if}
	</div>
{/if}

<style>
	/*
	 * Opción A (default): Permitir = primary/accent filled; Rechazar = outline muted.
	 * Sin verde/rojo fuertes. Hover de Rechazar puede teñir danger suave.
	 *
	 * Alternativas (no activas):
	 * B — ambos outline; Permitir con border accent; Rechazar con border faint.
	 * C — mismo surface; solo peso tipográfico / icono distinto.
	 */
	.perm-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.perm-actions button {
		padding: 5px 10px;
		font-size: 12px;
		border: 1px solid var(--border);
		border-radius: 0;
		background: var(--bg-elev);
		color: var(--text);
	}
	.perm-actions button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.perm-actions .allow,
	.perm-actions .allow-all {
		background: var(--btn-primary-bg);
		border-color: var(--btn-primary-border);
		color: var(--btn-primary-text);
		font-weight: 600;
	}
	.perm-actions .allow:hover,
	.perm-actions .allow-all:hover {
		filter: brightness(1.06);
	}
	.perm-actions .deny,
	.perm-actions .deny-all {
		background: transparent;
		border-color: var(--border);
		color: var(--text-dim);
	}
	.perm-actions .deny:hover,
	.perm-actions .deny-all:hover {
		border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
		color: var(--danger);
		background: var(--danger-bg);
	}
</style>
