<script lang="ts">
	import type { DecoratedFinding } from './decorate';
	import { groupAnchor } from './anchors';
	import type { FileNavItem, GroupNavItem } from './build';
	import FileIcon from './FileIcon.svelte';
	import { buildTreeRows, type FileCount } from './tree';

	let {
		collapsed,
		mode,
		onsetmode,
		groupsNav,
		fileNav,
		findings,
		activeFindingId,
		onselectfinding,
		onselectfile
	}: {
		collapsed: boolean;
		mode: 'explore' | 'findings';
		onsetmode: (mode: 'explore' | 'findings') => void;
		groupsNav: GroupNavItem[];
		fileNav: FileNavItem[];
		findings: DecoratedFinding[];
		activeFindingId: string | null;
		onselectfinding: (id: string) => void;
		onselectfile: (path: string) => void;
	} = $props();

	const reviewedCount = $derived(findings.filter((f) => f.decided).length);
	const reviewedPct = $derived(findings.length ? Math.round((reviewedCount / findings.length) * 100) : 0);

	/** Índice de Explorar: los mismos archivos, indexados por tema o por carpeta. */
	let exploreIndex = $state<'temas' | 'archivos'>('temas');
	let collapsedDirs = $state<string[]>([]);

	const fileCounts = $derived.by(() => {
		const counts = new Map<string, FileCount>();
		for (const f of findings) {
			const entry = counts.get(f.file) ?? { total: 0, done: 0 };
			entry.total += 1;
			if (f.decided) entry.done += 1;
			counts.set(f.file, entry);
		}
		return counts;
	});

	const treeRows = $derived(buildTreeRows(fileNav, fileCounts, new Set(collapsedDirs)));

	const groupCounts = $derived.by(() => {
		const decided = new Set(findings.filter((f) => f.decided).map((f) => f.id));
		return new Map(
			groupsNav.map((g) => [
				g.id,
				{ total: g.findingIds.length, done: g.findingIds.filter((id) => decided.has(id)).length }
			])
		);
	});

	function toggleDir(key: string) {
		collapsedDirs = collapsedDirs.includes(key)
			? collapsedDirs.filter((k) => k !== key)
			: [...collapsedDirs, key];
	}
</script>

<div class="sidebar" class:collapsed>
	{#if !collapsed}
		<div class="mode-toggle">
			<button type="button" class:on={mode === 'explore'} onclick={() => onsetmode('explore')}>Explorar</button>
			<button type="button" class:on={mode === 'findings'} onclick={() => onsetmode('findings')}>
				<span class="mode-label">
					Hallazgos
					{#if findings.length}
						<span class="count-badge">{findings.length}</span>
					{/if}
				</span>
			</button>
		</div>

		{#if mode === 'explore'}
			<div class="panel">
				<div class="index-tabs">
					<button type="button" class:on={exploreIndex === 'temas'} onclick={() => (exploreIndex = 'temas')}
						>Temas · {groupsNav.length}</button
					>
					<button type="button" class:on={exploreIndex === 'archivos'} onclick={() => (exploreIndex = 'archivos')}
						>Archivos · {fileNav.length}</button
					>
				</div>

				{#if exploreIndex === 'temas'}
					<div class="nav-list">
						{#each groupsNav as g (g.id)}
							{@const count = groupCounts.get(g.id)}
							<a href={`#${groupAnchor(g.id)}`} class="group-link">
								<span class="row">
									<span class="kind-chip" style:color={g.kindColor}>{g.kindLabel}</span>
									<span class="title">{g.title}</span>
									{#if count?.total}
										<span
											class="count"
											class:done={count.done === count.total}
											title="{count.total} hallazgo{count.total === 1 ? '' : 's'} en este tema{count.done ===
											count.total
												? ' · todos revisados'
												: ''}">{count.done === count.total ? '✓' : count.total}</span
										>
									{/if}
								</span>
								<span class="meta">{g.meta}</span>
							</a>
						{/each}
					</div>
				{:else}
					<div class="tree">
						{#each treeRows as row (row.key)}
							{#if row.kind === 'dir'}
								<button
									type="button"
									class="tree-row dir"
									style:padding-left="{6 + row.depth * 11}px"
									onclick={() => toggleDir(row.key)}
								>
									<span class="caret">{row.open ? '▾' : '▸'}</span>
									<span class="name">{row.label}</span>
									{#if row.findings}
										<span
											class="count"
											class:done={row.done}
											title="{row.findings} hallazgo{row.findings === 1 ? '' : 's'} en esta carpeta{row.done
												? ' · todos revisados'
												: ''}">{row.done ? '✓' : row.findings}</span
										>
									{/if}
								</button>
							{:else}
								<button
									type="button"
									class="tree-row file"
									class:skipped={!!row.skipReasonLabel}
									class:muted={!row.navigable}
									style:padding-left="{6 + row.depth * 11}px"
									disabled={!row.navigable}
									title={row.skipReasonLabel ? `${row.path} · omitido (${row.skipReasonLabel})` : row.path}
									onclick={() => onselectfile(row.path)}
								>
									<FileIcon path={row.path} />
									<span class="name">{row.label}</span>
									{#if row.findings}
										<span class="count" class:done={row.done}
											title="{row.findings} hallazgo{row.findings === 1 ? '' : 's'}{row.done ? ' · todos revisados' : ''}"
											>{row.done ? '✓' : row.findings}</span
										>
									{/if}
									<span class="mark" class:add={row.changeMark === 'A'} class:del={row.changeMark === 'D'}
										>{row.changeMark}</span
									>
								</button>
							{/if}
						{/each}
					</div>
				{/if}
			</div>
		{:else}
			<div class="panel findings-panel">
				<div class="findings-head">
					<h3>Hallazgos · {findings.length}</h3>
					<span class="reviewed">{reviewedCount} de {findings.length} revisados</span>
				</div>
				<div class="progress">
					<div class="progress-bar" style:width="{reviewedPct}%"></div>
				</div>
				<div class="findings-list">
					{#each findings as f (f.id)}
						<button
							type="button"
							class="finding-row"
							class:active={f.id === activeFindingId}
							style:border-left-color={f.accentColor}
							style:opacity={f.opacity}
							onclick={() => onselectfinding(f.id)}
						>
							<span class="top">
								<span class="left">
									<span class="status" style:border-color={f.statusColor} style:color={f.statusColor}
										>{f.statusMark}</span
									>
									<span class="number">#{f.number}</span>
									<span class="badge" style:color={f.badgeColor}>{f.badge}</span>
								</span>
								{#if f.decisionLabel}
									<span class="decision" style:color={f.decisionColor}>{f.decisionLabel}</span>
								{/if}
							</span>
							<span class="what" style:text-decoration={f.strike}>{f.what}</span>
							<span class="file-line">{f.fileLine}</span>
						</button>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.sidebar {
		border-right: 1px solid var(--border);
		background: var(--bg-elev);
		overflow-y: auto;
		overflow-x: hidden;
		min-height: 0;
		padding: 14px 0;
	}

	.sidebar.collapsed {
		border-right: 0;
	}

	.mode-toggle {
		display: flex;
		border: 1px solid var(--border);
		margin: 0 14px 12px;
		overflow: hidden;
	}

	.mode-toggle button {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 7px 8px;
		font-size: 12px;
		border: 0;
		background: transparent;
		color: var(--text);
	}

	.mode-toggle button + button {
		border-left: 1px solid var(--border);
	}

	.mode-toggle button.on {
		background: var(--accent-soft);
	}

	.mode-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		line-height: 1;
	}

	.count-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-family: var(--mono);
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		padding: 2px 6px;
		border: 1px solid var(--border);
		background: var(--bg-card);
		color: var(--text-dim);
	}

	.panel {
		padding: 0 14px 10px;
	}

	h3 {
		margin: 0 0 8px;
		font-size: 11.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		font-weight: 650;
	}

	.index-tabs {
		display: flex;
		gap: 12px;
		margin-bottom: 8px;
		border-bottom: 1px solid var(--border-soft);
	}

	.index-tabs button {
		background: transparent;
		border: 0;
		border-bottom: 2px solid transparent;
		padding: 0 0 6px;
		font-size: 11.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		font-weight: 650;
		color: var(--text-faint);
	}

	.index-tabs button.on {
		color: var(--text);
		border-bottom-color: var(--accent);
	}

	.nav-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.tree {
		display: flex;
		flex-direction: column;
	}

	.tree-row {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 3px 6px;
		border: 0;
		background: transparent;
		text-align: left;
		font-size: 12px;
		color: var(--text);
		min-width: 0;
	}

	.tree-row:hover:not(:disabled) {
		background: var(--bg-card);
	}

	.tree-row.dir {
		color: var(--text-dim);
	}

	.tree-row.muted {
		color: var(--text-faint);
		cursor: default;
	}

	.tree-row.skipped .name {
		text-decoration: line-through;
		text-decoration-color: var(--text-faint);
	}

	.caret {
		width: 9px;
		flex-shrink: 0;
		font-size: 9px;
		color: var(--text-faint);
	}

	/* Letra de cambio al estilo git: A/M/D/R. */
	.mark {
		width: 9px;
		flex-shrink: 0;
		font-family: var(--mono);
		font-size: 9.5px;
		font-weight: 700;
		color: var(--text-faint);
	}

	.mark.add {
		color: var(--diff-add-fg);
	}

	.mark.del {
		color: var(--diff-del-fg);
	}

	.tree-row .name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--mono);
		font-size: 11.5px;
	}

	/* Único contador del índice: hallazgos del archivo, de la carpeta o del tema. */
	.tree-row .count,
	.group-link .count {
		flex-shrink: 0;
		font-size: 9.5px;
		font-weight: 700;
		line-height: 1;
		padding: 2px 5px;
		color: var(--danger);
		border: 1px solid var(--danger-border);
	}

	.tree-row .count.done,
	.group-link .count.done {
		color: var(--ok);
		border-color: var(--border);
	}

	.group-link {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px 8px;
		font-size: 12.5px;
		color: var(--text);
		text-decoration: none;
	}

	.group-link:hover {
		background: var(--bg-card);
	}

	.row {
		display: flex;
		gap: 6px;
		align-items: center;
	}

	.kind-chip {
		font-size: 10px;
		font-weight: 700;
		padding: 1px 5px;
		border: 1px solid var(--border);
		background: var(--bg-card);
		flex-shrink: 0;
	}

	.meta {
		font-size: 11px;
		color: var(--text-faint);
	}

	.findings-panel {
		display: flex;
		flex-direction: column;
		height: calc(100vh - 160px);
	}

	.findings-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 8px;
	}

	.findings-head h3 {
		margin: 0;
	}

	.reviewed {
		font-size: 10.5px;
		color: var(--text-faint);
	}

	.progress {
		height: 3px;
		background: var(--border-soft);
		margin-bottom: 10px;
		overflow: hidden;
		flex-shrink: 0;
	}

	.progress-bar {
		height: 100%;
		background: var(--accent);
	}

	.findings-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		overflow-y: auto;
		overflow-x: hidden;
		flex: 1;
		min-height: 0;
	}

	.finding-row {
		text-align: left;
		padding: 8px 10px;
		border: 0;
		border-bottom: 1px solid var(--border-soft);
		border-left: 2px solid transparent;
		background: var(--bg-elev);
		display: flex;
		flex-direction: column;
		min-width: 0;
		width: 100%;
	}

	.finding-row.active {
		background: var(--accent-soft);
	}

	.finding-row .top {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 3px;
	}

	.finding-row .left {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		align-items: center;
		min-width: 0;
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

	.number {
		font-size: 9.5px;
		color: var(--text-faint);
		font-weight: 650;
	}

	.badge {
		font-size: 9.5px;
		font-weight: 700;
	}

	.decision {
		font-size: 9.5px;
		font-weight: 650;
	}

	.what {
		display: block;
		font-size: 12.5px;
		color: var(--text);
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.file-line {
		display: block;
		font-size: 10.5px;
		color: var(--text-faint);
		font-family: var(--mono);
		margin-top: 3px;
		overflow-wrap: anywhere;
	}
</style>
