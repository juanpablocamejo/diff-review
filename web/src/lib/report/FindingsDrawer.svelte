<script lang="ts">
	import type { DecoratedFinding } from './decorate';
	import FileIcon from './FileIcon.svelte';

	let {
		filePath,
		findings,
		expandedId,
		onclose,
		ontoggle,
		onignore,
		onfix,
		onclear
	}: {
		filePath: string | null;
		findings: DecoratedFinding[];
		expandedId: string | null;
		onclose: () => void;
		ontoggle: (id: string) => void;
		onignore: (id: string) => void;
		onfix: (id: string) => void;
		onclear: (id: string) => void;
	} = $props();

	const open = $derived(!!filePath);

	function fileName(path: string) {
		const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		return slash >= 0 ? path.slice(slash + 1) : path;
	}

	function fileDir(path: string) {
		const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		return slash >= 0 ? path.slice(0, slash) : '';
	}

	const name = $derived(filePath ? fileName(filePath) : '');
	const dir = $derived(filePath ? fileDir(filePath) : '');
</script>

{#if open}
	<div class="backdrop" onclick={onclose} role="presentation"></div>
{/if}

<div class="drawer" class:open>
	{#if filePath}
		<div class="drawer-head">
			<span class="drawer-title" title={filePath}>
				<FileIcon path={filePath} />
				<span class="file-ref">
					<span class="name">{name}</span>
					{#if dir}
						<span class="dir">{dir}</span>
					{/if}
				</span>
			</span>
			<button type="button" class="close" onclick={onclose}>✕</button>
		</div>
		<div class="list">
			{#each findings as f (f.id)}
				{@const expanded = f.id === expandedId}
				<div class="item">
					<button
						type="button"
						class="item-head"
						style:border-left-color={f.accentColor}
						style:opacity={f.opacity}
						onclick={() => ontoggle(f.id)}
					>
						<span class="status" style:border-color={f.statusColor} style:color={f.statusColor}>{f.statusMark}</span>
						<span class="badge" style:color={f.badgeColor}>{f.badge}</span>
						<span class="what" style:text-decoration={f.strike}>{f.what}</span>
						<span class="chevron">{expanded ? '▾' : '▸'}</span>
					</button>
					{#if expanded}
						<div class="item-body">
							<div>
								<h4>Qué pasa</h4>
								<p>{f.what}</p>
							</div>
							<div>
								<h4>Sugerencia de corrección</h4>
								<p class="fix">{f.fix}</p>
							</div>
							<div class="decision-group">
								<button type="button" class:on={f.decided && !f.fixSelected} onclick={() => onignore(f.id)}
									>Ignorar</button
								>
								<button type="button" class:on={f.decided && f.fixSelected} onclick={() => onfix(f.id)}
									>Corregir</button
								>
								{#if f.decided}
									<button type="button" class="clear" title="Limpiar decisión" onclick={() => onclear(f.id)}>✕</button
									>
								{/if}
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.35);
		z-index: 9;
	}

	.drawer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: 420px;
		background: var(--bg-card);
		border-left: 1px solid var(--border);
		z-index: 10;
		transform: translateX(100%);
		transition: transform 0.2s ease;
		display: flex;
		flex-direction: column;
	}

	.drawer.open {
		transform: translateX(0);
	}

	.drawer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--border-soft);
		flex-shrink: 0;
		min-width: 0;
	}

	.drawer-title {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		flex: 1;
	}

	.file-ref {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		overflow: hidden;
	}

	.name {
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		font-family: var(--mono);
		flex-shrink: 0;
	}

	.dir {
		font-size: 11px;
		color: var(--text-faint);
		font-family: var(--mono);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.close {
		background: transparent;
		border: 0;
		color: var(--text-faint);
		font-size: 14px;
		padding: 0;
		flex-shrink: 0;
	}

	.list {
		display: flex;
		flex-direction: column;
		overflow: auto;
	}

	.item {
		border-bottom: 1px solid var(--border-soft);
	}

	.item-head {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		background: transparent;
		border: 0;
		padding: 10px 14px;
		border-left: 2px solid transparent;
	}

	.status {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
		border: 1px solid transparent;
		font-size: 10px;
		line-height: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.badge {
		font-size: 10px;
		font-weight: 700;
		flex-shrink: 0;
	}

	.what {
		font-size: 12.5px;
		color: var(--text);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chevron {
		font-size: 11px;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.item-body {
		padding: 0 14px 14px 20px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.item-body h4 {
		margin: 0 0 4px;
		font-size: 10px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		font-weight: 650;
	}

	.item-body p {
		margin: 0;
		font-size: 13px;
		color: var(--text);
		line-height: 1.5;
	}

	.item-body p.fix {
		color: var(--text-dim);
	}

	.decision-group {
		display: flex;
		border: 1px solid var(--border);
		overflow: hidden;
		width: fit-content;
	}

	.decision-group button {
		padding: 7px 14px;
		font-size: 12px;
		border: 0;
		background: transparent;
		color: var(--text-dim);
		font-weight: 600;
	}

	.decision-group button:nth-child(1).on {
		background: var(--danger-bg);
		color: var(--danger);
	}

	.decision-group button:nth-child(2).on {
		background: var(--fix-bg);
		color: var(--ok);
	}

	.decision-group button + button {
		border-left: 1px solid var(--border);
	}

	.decision-group .clear {
		padding: 7px 10px;
		color: var(--text-faint);
	}
</style>
