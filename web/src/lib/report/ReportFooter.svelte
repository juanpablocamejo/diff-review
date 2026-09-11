<script lang="ts">
	let {
		reviewedLabel,
		hasFixSelection,
		fixSelectionCount,
		onopenfixprompt,
		onopenpublishprompt
	}: {
		reviewedLabel: string;
		hasFixSelection: boolean;
		fixSelectionCount: number;
		onopenfixprompt: () => void;
		onopenpublishprompt: () => void;
	} = $props();
</script>

<footer class="footer">
	<span class="reviewed">{reviewedLabel}</span>
	<div class="right">
		{#if hasFixSelection}
			<button type="button" class="fix" onclick={onopenfixprompt}>Generar correcciones ({fixSelectionCount})</button>
			<button type="button" class="publish" onclick={onopenpublishprompt}>Publicar Revisión ({fixSelectionCount})</button
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
		gap: 12px;
	}

	.reviewed {
		font-size: 11px;
		color: var(--text-faint);
	}

	.fix,
	.publish {
		padding: 6px 12px;
		font-weight: 600;
		font-size: 11.5px;
		border: 1px solid;
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
</style>
