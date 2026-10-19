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
	.perm-actions .allow,
	.perm-actions .allow-all {
		background: var(--ok-bg);
		border-color: var(--ok);
		color: var(--ok);
	}
	.perm-actions .deny,
	.perm-actions .deny-all {
		background: var(--danger-bg);
		border-color: var(--danger-border);
		color: var(--danger);
	}
</style>
