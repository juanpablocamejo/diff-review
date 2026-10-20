<script lang="ts">
	let {
		reviewedLabel,
		hasFixSelection,
		fixSelectionCount,
		ignoredCount = 0,
		agentName = 'Agente',
		onfixwithagent,
		oncopyfixprompt,
		onopenpublishprompt,
		onpurgeignored
	}: {
		reviewedLabel: string;
		hasFixSelection: boolean;
		fixSelectionCount: number;
		ignoredCount?: number;
		/** Nombre corto del agente (mismo que el header / chat: Claude, Cursor, …). */
		agentName?: string;
		onfixwithagent: () => void;
		oncopyfixprompt: () => void;
		onopenpublishprompt: () => void;
		onpurgeignored?: () => void;
	} = $props();

	const fixLabel = $derived(`Corregir con ${agentName} (${fixSelectionCount})`);
</script>

<footer class="footer">
	<span class="reviewed">{reviewedLabel}</span>
	<div class="right">
		{#if ignoredCount > 0 && onpurgeignored}
			<button type="button" class="purge" onclick={onpurgeignored}
				>Eliminar ignorados ({ignoredCount})</button
			>
		{/if}
		{#if hasFixSelection}
			<button type="button" class="ghost" onclick={oncopyfixprompt}>Copiar prompt</button>
			<button type="button" class="publish" onclick={onopenpublishprompt}
				>Publicar Revisión ({fixSelectionCount})</button
			>
			<button type="button" class="fix" onclick={onfixwithagent} aria-label={fixLabel}
				>{fixLabel}</button
			>
		{/if}
	</div>
</footer>

<style>
	.footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 6px 16px;
		border-top: 1px solid var(--border);
		background: var(--bg-elev);
		flex-shrink: 0;
		/* Sin acciones la barra queda vacía, pero el alto no puede saltar al aparecer. */
		min-height: 33px;
	}

	.right {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.reviewed {
		font-size: 11px;
		color: var(--text-faint);
	}

	.fix,
	.publish,
	.ghost,
	.purge {
		padding: 6px 12px;
		font-weight: 600;
		font-size: 11.5px;
		border: 1px solid;
		cursor: pointer;
	}

	.fix {
		background: var(--fix-bg);
		border-color: var(--fix-border);
		color: var(--ok);
	}

	.publish {
		background: var(--publish-bg);
		border-color: var(--publish-border);
		color: var(--publish-text);
	}

	.ghost {
		background: transparent;
		border-color: var(--border);
		color: var(--text);
		font-weight: 500;
	}

	.ghost:hover {
		border-color: var(--accent);
	}

	.purge {
		background: transparent;
		border-color: var(--border);
		color: var(--danger);
		font-weight: 500;
	}

	.purge:hover {
		border-color: var(--danger);
	}
</style>
