<script lang="ts">
	import type { DecoratedFinding } from './decorate';
	import { groupAnchor } from './anchors';
	import type { FileNavItem, GroupNavItem } from './build';
	import FileIcon from './FileIcon.svelte';
	import { findingSeverityRank, maxFindingAccent } from './severity';
	import { buildTreeRows, collectTreeDirPaths, type FileCount } from './tree';
	import { plural } from './labels';

	let {
		collapsed,
		mode,
		onsetmode,
		groupsNav,
		fileNav,
		findings,
		activeFindingId,
		onselectfinding,
		onselectfile,
		/** Archivo visible en Explore (tema + path), para resaltar en el acordeón. */
		activeExploreFile = null
	}: {
		collapsed: boolean;
		mode: 'explore' | 'findings';
		onsetmode: (mode: 'explore' | 'findings') => void;
		groupsNav: GroupNavItem[];
		fileNav: FileNavItem[];
		findings: DecoratedFinding[];
		activeFindingId: string | null;
		onselectfinding: (id: string) => void;
		onselectfile: (path: string, groupId?: string) => void;
		activeExploreFile?: { groupId: string; path: string } | null;
	} = $props();

	const reviewedCount = $derived(findings.filter((f) => f.decided).length);
	const reviewedPct = $derived(findings.length ? Math.round((reviewedCount / findings.length) * 100) : 0);

	/** Índice de Explorar: los mismos archivos, indexados por tema o por carpeta. */
	let exploreIndex = $state<'temas' | 'archivos'>('temas');
	let collapsedDirs = $state<string[]>([]);
	/** Árbol con carpetas, o lista plana de paths. */
	let filesLayout = $state<'tree' | 'list'>('tree');
	/** Acordeón de temas: un solo tema abierto a la vez. */
	let expandedGroupId = $state<string | null>(null);

	/** Al scrollear el panel, abrir el tema del archivo visible. */
	$effect(() => {
		const g = activeExploreFile?.groupId;
		if (g && exploreIndex === 'temas') expandedGroupId = g;
	});

	$effect(() => {
		if (!activeExploreFile) return;
		queueMicrotask(() => {
			document.querySelector('.group-files .tree-row.file.active')?.scrollIntoView({
				block: 'nearest',
				behavior: 'smooth'
			});
		});
	});

	const fileCounts = $derived.by(() => {
		const counts = new Map<string, FileCount>();
		for (const f of findings) {
			const rank = findingSeverityRank(f);
			const entry = counts.get(f.file) ?? {
				total: 0,
				done: 0,
				accent: f.accentColor,
				rank
			};
			entry.total += 1;
			if (f.decided) entry.done += 1;
			if (rank < entry.rank) {
				entry.rank = rank;
				entry.accent = f.accentColor;
			}
			counts.set(f.file, entry);
		}
		return counts;
	});

	const allDirPaths = $derived(collectTreeDirPaths(fileNav));
	const treeRows = $derived(buildTreeRows(fileNav, fileCounts, new Set(collapsedDirs)));
	const allExpanded = $derived(collapsedDirs.length === 0);

	const listRows = $derived.by(() =>
		[...fileNav]
			.sort((a, b) => a.path.localeCompare(b.path))
			.map((file) => {
				const count = fileCounts.get(file.path);
				const slash = file.path.lastIndexOf('/');
				return {
					path: file.path,
					name: slash >= 0 ? file.path.slice(slash + 1) : file.path,
					dir: slash >= 0 ? file.path.slice(0, slash) : '',
					changeMark: file.changeMark,
					navigable: file.navigable,
					findings: count?.total ?? 0,
					done: !!count?.total && count.done === count.total,
					accent: count?.accent ?? 'var(--text-faint)',
					skipReasonLabel: file.skipReasonLabel
				};
			})
	);

	const groupCounts = $derived.by(() => {
		const byId = new Map(findings.map((f) => [f.id, f]));
		return new Map(
			groupsNav.map((g) => {
				const groupFindings = g.findingIds.map((id) => byId.get(id)).filter(Boolean) as DecoratedFinding[];
				const total = groupFindings.length;
				const done = groupFindings.filter((f) => f.decided).length;
				return [g.id, { total, done, accent: maxFindingAccent(groupFindings) }] as const;
			})
		);
	});

	const findingsMaxAccent = $derived(maxFindingAccent(findings));

	function toggleDir(key: string) {
		collapsedDirs = collapsedDirs.includes(key)
			? collapsedDirs.filter((k) => k !== key)
			: [...collapsedDirs, key];
	}

	function toggleExpandAll() {
		collapsedDirs = allExpanded ? allDirPaths : [];
	}

	function toggleGroup(id: string) {
		expandedGroupId = expandedGroupId === id ? null : id;
	}

	function openGroup(id: string) {
		expandedGroupId = id;
	}

	function fileName(path: string) {
		const slash = path.lastIndexOf('/');
		return slash >= 0 ? path.slice(slash + 1) : path;
	}

	function fileDir(path: string) {
		const slash = path.lastIndexOf('/');
		return slash >= 0 ? path.slice(0, slash) : '';
	}

	/** Indent por nivel y slot compartido chevron/ícono (estilo explorer de Cursor/VS Code). */
	const TREE_INDENT = 8;
	const TREE_SLOT = 16;
	const TREE_PAD = 4;

	function treePad(depth: number) {
		return TREE_PAD + depth * TREE_INDENT;
	}

	function guideLeft(level: number) {
		return TREE_PAD + level * TREE_INDENT + TREE_SLOT / 2;
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
						<span class="count-badge" style:--finding-sev={findingsMaxAccent}>{findings.length}</span>
					{/if}
				</span>
			</button>
		</div>

		{#if mode === 'explore'}
			<div class="panel explore-panel">
				<div class="panel-chrome">
					<div class="index-tabs">
						<button type="button" class:on={exploreIndex === 'temas'} onclick={() => (exploreIndex = 'temas')}
							>Temas · {groupsNav.length}</button
						>
						<button type="button" class:on={exploreIndex === 'archivos'} onclick={() => (exploreIndex = 'archivos')}
							>Archivos · {fileNav.length}</button
						>
					</div>

					{#if exploreIndex === 'archivos'}
						<div class="files-toolbar">
							<div class="seg" role="group" aria-label="Vista de archivos">
								<button
									type="button"
									class="tool"
									class:on={filesLayout === 'tree'}
									title="Vista en árbol"
									aria-label="Vista en árbol"
									aria-pressed={filesLayout === 'tree'}
									onclick={() => (filesLayout = 'tree')}
								>
									<svg class="tool-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
										<path
											d="M3 2.5h3.2v3.2H3V2.5Zm0 4.4h3.2v3.2H3V6.9Zm0 4.4h3.2v3.2H3v-3.2ZM7.6 4.1H13M7.6 8.5H13M7.6 12.9H13M6.2 4.1v8.8"
											stroke="currentColor"
											stroke-width="1.5"
											stroke-linecap="round"
											stroke-linejoin="round"
										/>
									</svg>
								</button>
								<button
									type="button"
									class="tool"
									class:on={filesLayout === 'list'}
									title="Vista en lista"
									aria-label="Vista en lista"
									aria-pressed={filesLayout === 'list'}
									onclick={() => (filesLayout = 'list')}
								>
									<svg class="tool-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
										<path
											d="M3 4h10M3 8h10M3 12h10"
											stroke="currentColor"
											stroke-width="1.5"
											stroke-linecap="round"
										/>
									</svg>
								</button>
							</div>
							{#if filesLayout === 'tree'}
								<button
									type="button"
									class="tool"
									disabled={allDirPaths.length === 0}
									title={allExpanded ? 'Colapsar todo el árbol' : 'Expandir todo el árbol'}
									aria-label={allExpanded ? 'Colapsar todo el árbol' : 'Expandir todo el árbol'}
									onclick={toggleExpandAll}
								>
									{#if allExpanded}
										<svg class="tool-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
											<path
												d="M4.5 7.2 8 3.8l3.5 3.4M4.5 12.2 8 8.8l3.5 3.4"
												stroke="currentColor"
												stroke-width="1.5"
												stroke-linecap="round"
												stroke-linejoin="round"
											/>
										</svg>
									{:else}
										<svg class="tool-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
											<path
												d="M4.5 3.8 8 7.2l3.5-3.4M4.5 8.8 8 12.2l3.5-3.4"
												stroke="currentColor"
												stroke-width="1.5"
												stroke-linecap="round"
												stroke-linejoin="round"
											/>
										</svg>
									{/if}
								</button>
							{/if}
						</div>
					{/if}
				</div>

				<div class="panel-scroll">
					{#if exploreIndex === 'temas'}
						<div class="nav-list">
							{#each groupsNav as g (g.id)}
								{@const count = groupCounts.get(g.id)}
								{@const open = expandedGroupId === g.id}
								<div class="group-item" class:open>
									<div class="group-head-row">
										<button
											type="button"
											class="group-caret"
											aria-expanded={open}
											aria-label={open ? 'Ocultar archivos del tema' : 'Mostrar archivos del tema'}
											onclick={() => toggleGroup(g.id)}
										>
											<span class="caret">{open ? '▾' : '▸'}</span>
										</button>
										<a
											href={`#${groupAnchor(g.id)}`}
											class="group-link"
											onclick={() => openGroup(g.id)}
										>
											<span class="row">
												<span class="number">#{g.number}</span>
												<span class="kind-chip" style:color={g.kindColor}>{g.kindLabel}</span>
												{#if count?.total}
													<span
														class="count"
														class:done={count.done === count.total}
														style:--finding-sev={count.accent}
														title="{plural(count.total, 'hallazgo', 'hallazgos')} en este tema{count.done ===
														count.total
															? ' · todos revisados'
															: ''}">{count.done === count.total ? '✓' : count.total}</span
													>
												{/if}
											</span>
											<span class="title">{g.title}</span>
											<span class="meta">{g.meta}</span>
										</a>
									</div>
									{#if open}
										<div class="group-files">
											{#each g.files as file (file.path)}
												{@const fcount = fileCounts.get(file.path)}
												{@const dir = fileDir(file.path)}
												{@const active =
													activeExploreFile?.groupId === g.id && activeExploreFile?.path === file.path}
												<button
													type="button"
													class="tree-row file"
													class:active
													data-active-explore={active ? '1' : undefined}
													onclick={() => onselectfile(file.path, g.id)}
												>
													<span class="tree-slot">
														<FileIcon path={file.path} />
													</span>
													<span class="name-line">
														<span class="name" title={file.path}>{fileName(file.path)}</span>
														{#if dir}
															<span class="dir" title={dir}>{dir}</span>
														{/if}
													</span>
													{#if fcount?.total}
														<span
															class="count"
															class:done={fcount.done === fcount.total}
															style:--finding-sev={fcount.accent}
															title={plural(fcount.total, 'hallazgo', 'hallazgos')}
															>{fcount.done === fcount.total ? '✓' : fcount.total}</span
														>
													{/if}
													<span
														class="mark"
														class:add={file.changeMark === 'A'}
														class:del={file.changeMark === 'D'}>{file.changeMark}</span
													>
												</button>
											{/each}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{:else if filesLayout === 'tree'}
						<div class="tree">
							{#each treeRows as row (row.key)}
								{#if row.kind === 'dir'}
									<button
										type="button"
										class="tree-row dir"
										style:padding-left="{treePad(row.depth)}px"
										onclick={() => toggleDir(row.key)}
									>
										{#if row.depth > 0}
											<span class="tree-guides" aria-hidden="true">
												{#each Array(row.depth) as _, i (i)}
													<span class="tree-guide" style:left="{guideLeft(i)}px"></span>
												{/each}
											</span>
										{/if}
										<span class="tree-slot">
											<span class="caret">{row.open ? '▾' : '▸'}</span>
										</span>
										<span class="name">{row.label}</span>
										{#if row.findings}
											<span
												class="count"
												class:done={row.done}
												style:--finding-sev={row.accent}
												title="{plural(row.findings, 'hallazgo', 'hallazgos')} en esta carpeta{row.done
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
										style:padding-left="{treePad(row.depth)}px"
										disabled={!row.navigable}
										title={row.skipReasonLabel ? `${row.path} · omitido (${row.skipReasonLabel})` : row.path}
										onclick={() => onselectfile(row.path)}
									>
										{#if row.depth > 0}
											<span class="tree-guides" aria-hidden="true">
												{#each Array(row.depth) as _, i (i)}
													<span class="tree-guide" style:left="{guideLeft(i)}px"></span>
												{/each}
											</span>
										{/if}
										<span class="tree-slot">
											<FileIcon path={row.path} size={TREE_SLOT} />
										</span>
										<span class="name">{row.label}</span>
										{#if row.findings}
											<span
												class="count"
												class:done={row.done}
												style:--finding-sev={row.accent}
												title="{plural(row.findings, 'hallazgo', 'hallazgos')}{row.done
													? ' · todos revisados'
													: ''}">{row.done ? '✓' : row.findings}</span
											>
										{/if}
										<span class="mark" class:add={row.changeMark === 'A'} class:del={row.changeMark === 'D'}
											>{row.changeMark}</span
										>
									</button>
								{/if}
							{/each}
						</div>
					{:else}
						<div class="tree list">
							{#each listRows as row (row.path)}
								<button
									type="button"
									class="tree-row file"
									class:skipped={!!row.skipReasonLabel}
									class:muted={!row.navigable}
									style:padding-left="{TREE_PAD}px"
									disabled={!row.navigable}
									title={row.skipReasonLabel ? `${row.path} · omitido (${row.skipReasonLabel})` : row.path}
									onclick={() => onselectfile(row.path)}
								>
									<span class="tree-slot">
										<FileIcon path={row.path} size={TREE_SLOT} />
									</span>
									<span class="name-line">
										<span class="name">{row.name}</span>
										{#if row.dir}
											<span class="dir">{row.dir}</span>
										{/if}
									</span>
									{#if row.findings}
										<span
											class="count"
											class:done={row.done}
											style:--finding-sev={row.accent}
											title="{plural(row.findings, 'hallazgo', 'hallazgos')}{row.done
												? ' · todos revisados'
												: ''}">{row.done ? '✓' : row.findings}</span
										>
									{/if}
									<span class="mark" class:add={row.changeMark === 'A'} class:del={row.changeMark === 'D'}
										>{row.changeMark}</span
									>
								</button>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		{:else}
			<div class="panel findings-panel">
				<div class="findings-head">
					<h3>Hallazgos · {findings.length}</h3>
					<span class="reviewed"
						>{reviewedCount} de {findings.length} {findings.length === 1 ? 'revisado' : 'revisados'}</span
					>
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
							<span class="file-line" title={f.fileLine}
								>{fileName(f.file)}{f.line != null ? `:${f.line}` : ''}</span
							>
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
		overflow: hidden;
		min-height: 0;
		height: 100%;
		padding: 14px 0;
		display: flex;
		flex-direction: column;
	}

	.sidebar.collapsed {
		border-right: 0;
	}

	.mode-toggle {
		display: flex;
		border: 1px solid var(--border);
		margin: 0 14px 12px;
		overflow: hidden;
		flex-shrink: 0;
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
		border: 1px solid color-mix(in srgb, var(--finding-sev, var(--border)) 45%, transparent);
		background: color-mix(in srgb, var(--finding-sev, var(--bg-card)) 18%, transparent);
		color: var(--finding-sev, var(--text-dim));
	}

	.panel {
		padding: 0 14px 10px;
	}

	.explore-panel {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 0 0 10px;
		overflow: hidden;
	}

	.panel-chrome {
		flex-shrink: 0;
		padding: 0 14px;
	}

	.panel-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		padding: 0 14px;
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

	.files-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		margin: -2px 0 8px;
	}

	.files-toolbar .tool {
		width: 26px;
		height: 26px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--border);
		background: var(--bg-card);
		color: var(--text-dim);
	}

	.files-toolbar .tool:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--text-faint);
	}

	.files-toolbar .tool.on {
		background: var(--accent-soft);
		border-color: var(--border);
		color: var(--text);
	}

	.files-toolbar .tool:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.files-toolbar .tool-icon {
		width: 14px;
		height: 14px;
		display: block;
	}

	/* Árbol | Lista: siempre se ven las dos opciones; la activa queda marcada. */
	.files-toolbar .seg {
		display: flex;
		overflow: hidden;
		border: 1px solid var(--border);
	}

	.files-toolbar .seg .tool {
		border: 0;
		border-radius: 0;
		background: transparent;
	}

	.files-toolbar .seg .tool + .tool {
		border-left: 1px solid var(--border);
	}

	.files-toolbar .seg .tool.on {
		background: var(--accent-soft);
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
		position: relative;
		display: flex;
		align-items: center;
		gap: 4px;
		width: 100%;
		padding: 2px 6px 2px 0;
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

	.tree-guides {
		position: absolute;
		inset: 0 auto 0 0;
		width: 0;
		pointer-events: none;
	}

	.tree-guide {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 1px;
		background: var(--border-soft);
		opacity: 0.9;
	}

	/* Misma columna para ▸/▾ e ícono Seti: el texto arranca alineado. */
	.tree-slot {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.caret {
		font-size: 10px;
		line-height: 1;
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

	.tree-row .name-line {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 6px;
		overflow: hidden;
	}

	.tree-row .name-line .name {
		flex: 0 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tree-row .name-line .dir {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--text-faint);
	}

	/* Único contador del índice: hallazgos del archivo, de la carpeta o del tema. */
	.tree-row .count,
	.group-link .count {
		flex-shrink: 0;
		font-size: 9.5px;
		font-weight: 700;
		line-height: 1;
		padding: 2px 5px;
		color: var(--finding-sev, var(--danger));
		border: 1px solid color-mix(in srgb, var(--finding-sev, var(--danger-border)) 55%, transparent);
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
		flex: 1;
		min-width: 0;
		padding: 6px 8px 6px 0;
		font-size: 12.5px;
		color: var(--text);
		text-decoration: none;
	}

	.group-link:hover {
		background: transparent;
	}

	.group-item {
		border-radius: 0;
	}

	.group-item.open > .group-head-row {
		background: var(--bg-card);
	}

	.group-head-row {
		display: flex;
		align-items: flex-start;
		gap: 0;
	}

	.group-head-row:hover {
		background: var(--bg-card);
	}

	.group-caret {
		flex-shrink: 0;
		width: 20px;
		padding: 8px 0 0;
		border: 0;
		background: transparent;
		color: var(--text-faint);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}

	.group-caret:hover {
		color: var(--text);
	}

	.group-files {
		display: flex;
		flex-direction: column;
		padding: 0 0 4px 8px;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}

	.group-link .number {
		font-size: 10px;
		color: var(--text-faint);
		font-weight: 700;
		flex-shrink: 0;
	}

	.kind-chip {
		font-size: 10px;
		font-weight: 700;
		padding: 1px 5px;
		border: 1px solid var(--border);
		background: var(--bg-card);
		flex-shrink: 0;
	}

	.group-link .title {
		display: block;
		line-height: 1.35;
		white-space: normal;
		overflow-wrap: anywhere;
	}

	.group-link .row > .count {
		margin-left: auto;
	}

	.meta {
		font-size: 11px;
		color: var(--text-faint);
		padding-left: 0;
	}

	.group-files .tree-row.file.active {
		background: var(--accent-soft);
	}

	.findings-panel {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
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
