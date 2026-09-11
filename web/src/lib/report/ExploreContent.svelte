<script lang="ts">
	import type { FileSection, GroupSectionModel } from './build';
	import type { DecoratedFinding } from './decorate';
	import { fileAnchor, groupAnchor } from './anchors';
	import DiffView from './DiffView.svelte';
	import FileIcon from './FileIcon.svelte';
	import ResizeHandle from './ResizeHandle.svelte';

	let {
		intentText,
		notes,
		hasBlockers,
		blockerBannerText,
		groupSections,
		looseFileSections,
		looseOpen,
		ontoggleloose,
		orphanFindings,
		hasSkipped,
		skippedList,
		diffMode,
		showExplanations,
		expandedDiffs,
		decided,
		explanationWidth,
		splitRatio,
		diffFontSize,
		wrapLines,
		ontoggleexpand,
		onopenfindings,
		onresizeexplanation,
		onresizesplit,
		onrequestlines
	}: {
		intentText: string;
		notes: string[];
		hasBlockers: boolean;
		blockerBannerText: string;
		groupSections: GroupSectionModel[];
		looseFileSections: FileSection[];
		/** Plegado de los archivos sin tema, por path; sin entrada manda si tiene hallazgos. */
		looseOpen: Record<string, boolean>;
		ontoggleloose: (path: string) => void;
		orphanFindings: DecoratedFinding[];
		hasSkipped: boolean;
		skippedList: { path: string; reasonLabel: string }[];
		diffMode: 'unified' | 'split';
		showExplanations: boolean;
		expandedDiffs: Record<string, boolean>;
		decided: Record<string, boolean>;
		explanationWidth: number;
		splitRatio: number;
		diffFontSize: number;
		wrapLines: boolean;
		ontoggleexpand: (path: string) => void;
		onopenfindings: (path: string) => void;
		onresizeexplanation: (dx: number) => void;
		onresizesplit: (ratio: number) => void;
		onrequestlines?: (path: string) => Promise<string[] | null>;
	} = $props();
</script>

{#if hasBlockers}
	<p class="blocker-bar">{blockerBannerText}</p>
{/if}

<section class="intent">
	<h2>Intención</h2>
	<p class="intent-text">{intentText}</p>
	{#each notes as note (note)}
		<p class="note">{note}</p>
	{/each}
</section>

{#snippet fileBlock(file: FileSection)}
		{@const total = file.allFindings.length}
		{@const doneCount = file.allFindings.filter((f) => decided[f.id]).length}
		{@const allDone = total > 0 && doneCount === total}
		<div id={fileAnchor(file.path)} class="file-section">
			<div
				class="file-head"
				style:grid-template-columns={showExplanations ? `minmax(0,1fr) 6px ${explanationWidth}px` : 'minmax(0,1fr)'}
			>
				<div class="file-head-main">
					<FileIcon path={file.path} />
					<span class="path">{file.path}</span>
					<span class="change-label">{file.changeLabel}</span>
					{#if total > 0 && !showExplanations}
						<button type="button" class="findings-control" onclick={() => onopenfindings(file.path)}>
							{#if allDone}
								<span class="count-badge done">✓</span>
								<span class="count-label">{total} hallazgo{total === 1 ? '' : 's'}</span>
							{:else}
								<span class="count-badge open">{total}</span>
								<span class="count-label open">hallazgo{total === 1 ? '' : 's'}</span>
							{/if}
							<span class="arrow">→</span>
						</button>
					{/if}
				</div>
				{#if showExplanations}
					<div class="file-head-gutter"></div>
					<div class="file-head-explain">
						{#if total > 0}
							<button type="button" class="findings-control" onclick={() => onopenfindings(file.path)}>
								{#if allDone}
									<span class="count-badge done">✓</span>
									<span class="count-label">{total} hallazgo{total === 1 ? '' : 's'}</span>
								{:else}
									<span class="count-badge open">{total}</span>
									<span class="count-label open">hallazgo{total === 1 ? '' : 's'}</span>
								{/if}
								<span class="arrow">→</span>
							</button>
						{/if}
					</div>
				{/if}
			</div>
			<div
				class="file-grid"
				class:no-explanations={!showExplanations}
				style:grid-template-columns={showExplanations ? `minmax(0,1fr) 6px ${explanationWidth}px` : 'minmax(0,1fr)'}
			>
				<div class="diff-col">
					<DiffView
						path={file.path}
						diff={file.diff}
						blocks={file.blocksForFile.map((b) => ({ ...b, accentColor: file.blockAccent[b.id] ?? 'transparent' }))}
						mode={diffMode}
						expanded={!!expandedDiffs[file.path]}
						onToggleExpand={() => ontoggleexpand(file.path)}
						{splitRatio}
						onSplitRatioChange={onresizesplit}
						fontSize={diffFontSize}
					{wrapLines}
						onRequestLines={onrequestlines}
					/>
				</div>
				{#if showExplanations}
					<ResizeHandle ondrag={onresizeexplanation} />
					<div class="explain-col">
						{#each file.rows as row (row.id)}
							<div class="explain-row" style:border-left-color={row.accentColor}>
								<div class="explain-top">
									<span class="lines">{row.lines}</span>
									<span class="op">{row.opLabel}</span>
								</div>
								<p class="what">{row.what}</p>
								{#if row.why}
									<p class="why">{row.why}</p>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
{/snippet}

{#each groupSections as g, gi (g.id)}
	<section id={groupAnchor(g.id)} class="group" style:border-top={gi > 0 ? '1px solid var(--border-soft)' : 'none'}>
		<header class="group-head">
			<span class="kind-chip" style:color={g.kindColor}>{g.kindLabel}</span>
			<h2>{g.title}</h2>
		</header>
		<p class="group-intent">{g.intentText}</p>

		{#each g.fileSections as file (file.path)}
			{@render fileBlock(file)}
		{/each}
	</section>
{/each}

{#if looseFileSections.length}
	<section class="group loose">
		<header class="group-head">
			<span class="kind-chip">sin tema</span>
			<h2>Archivos que ningún bloque explica · {looseFileSections.length}</h2>
		</header>
		{#each looseFileSections as file (file.path)}
			{#if looseOpen[file.path] ?? file.allFindings.length > 0}
				{@render fileBlock(file)}
			{:else}
				<!-- Sin hallazgos y sin bloques: el diff arranca plegado para no colgar la página con cientos. -->
				<button
					type="button"
					id={fileAnchor(file.path)}
					class="loose-row"
					onclick={() => ontoggleloose(file.path)}
				>
					<span class="loose-caret">▸</span>
					<FileIcon path={file.path} />
					<span class="loose-path">{file.path}</span>
					<span class="loose-change">{file.changeLabel}</span>
				</button>
			{/if}
		{/each}
	</section>
{/if}

{#if orphanFindings.length}
	<section class="orphans">
		<h2>Hallazgos sin archivo asociado</h2>
		<div class="orphan-list">
			{#each orphanFindings as f (f.id)}
				<div class="orphan-row" style:border-left-color={f.accentColor} style:opacity={f.opacity}>
					<span class="badge" style:color={f.badgeColor}>{f.badge}</span>
					<span class="what" style:text-decoration={f.strike}>{f.what}</span>
					<span class="where">{f.fileLine}</span>
				</div>
			{/each}
		</div>
	</section>
{/if}

{#if hasSkipped}
	<section class="skipped">
		<h2>Archivos omitidos</h2>
		<div class="skipped-list">
			{#each skippedList as s (s.path)}
				<span class="skipped-chip">{s.path} · {s.reasonLabel}</span>
			{/each}
		</div>
	</section>
{/if}

<style>
	.blocker-bar {
		margin: 0;
		padding: 10px 14px;
		background: var(--danger-bg);
		border: 1px solid var(--danger-border);
		color: var(--danger);
		font-size: 13px;
		font-weight: 600;
	}

	h2 {
		margin: 0 0 8px;
		font-size: 12px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-faint);
		font-weight: 650;
	}

	.intent {
		padding: 0 0 16px;
		border-bottom: 1px solid var(--border);
	}

	.intent-text {
		margin: 0;
		font-size: 14px;
		line-height: 1.6;
		color: var(--text);
		max-width: 80ch;
	}

	.note {
		margin: 8px 0 0;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--text-faint);
		max-width: 80ch;
	}

	.loose-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 10px;
		border: 0;
		border-bottom: 1px solid var(--border-soft);
		background: transparent;
		text-align: left;
	}

	.loose-row:hover {
		background: var(--bg-card);
	}

	.loose-caret {
		font-size: 9px;
		color: var(--text-faint);
	}

	.loose-path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--mono);
		font-size: 11.5px;
		color: var(--text-dim);
	}

	.loose-change {
		font-size: 10.5px;
		color: var(--text-faint);
	}

	.loose .kind-chip {
		color: var(--text-faint);
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 18px 0 6px;
	}

	.group-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	.group-head h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 650;
		color: var(--text);
		text-transform: none;
		letter-spacing: normal;
	}

	.kind-chip {
		font-size: 11px;
		font-weight: 700;
		padding: 2px 8px;
		border: 1px solid var(--border);
		background: var(--bg-card);
		flex-shrink: 0;
	}

	.group-intent {
		margin: 0;
		font-size: 13px;
		color: var(--text-dim);
		line-height: 1.5;
	}

	.file-section {
		border-top: 1px solid var(--border);
	}

	.file-head {
		display: grid;
		align-items: center;
		border-bottom: 1px solid var(--border-soft);
	}

	.file-head-main {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 0;
		min-width: 0;
	}

	.file-head-gutter {
		flex-shrink: 0;
	}

	.file-head-explain {
		display: flex;
		align-items: center;
		padding: 10px 0 10px 14px;
	}

	.path {
		font-family: var(--mono);
		font-size: 12.5px;
		color: var(--text);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.change-label {
		font-size: 11px;
		color: var(--text-faint);
		flex: 1;
	}

	.findings-control {
		display: flex;
		align-items: center;
		gap: 6px;
		background: transparent;
		border: 0;
		padding: 0;
		flex-shrink: 0;
		color: var(--text);
	}

	.count-badge {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 18px;
		height: 18px;
		padding: 0 4px;
		font-size: 10.5px;
		font-weight: 700;
	}

	.count-badge.done {
		border: 1px solid var(--fix-border);
		color: var(--ok);
	}

	.count-badge.open {
		background: var(--accent-soft);
		color: var(--publish-text);
	}

	.count-label {
		font-size: 11.5px;
		color: var(--text-faint);
	}

	.count-label.open {
		color: var(--text-dim);
	}

	.arrow {
		font-size: 14px;
		color: var(--accent);
	}

	.file-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
	}

	.file-grid.no-explanations {
		grid-template-columns: minmax(0, 1fr);
	}

	.diff-col {
		min-width: 0;
	}

	.explain-col {
		border-left: 1px solid var(--border-soft);
		background: var(--bg-elev);
		display: flex;
		flex-direction: column;
		overflow: auto;
	}

	.explain-row {
		padding: 10px 14px;
		border-bottom: 1px solid var(--border-soft);
		border-left: 3px solid transparent;
	}

	.explain-top {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-bottom: 4px;
	}

	.lines {
		font-size: 10.5px;
		color: var(--text-faint);
		font-family: var(--mono);
	}

	.op {
		font-size: 10px;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.what {
		margin: 0 0 3px;
		font-size: 13px;
		color: var(--text);
		line-height: 1.4;
		max-width: 80ch;
	}

	.why {
		margin: 0;
		font-size: 11.5px;
		color: var(--text-dim);
		line-height: 1.4;
		max-width: 80ch;
	}

	.orphans,
	.skipped {
		padding-top: 12px;
		border-top: 1px solid var(--border-soft);
	}

	.orphan-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.orphan-row {
		display: flex;
		gap: 10px;
		align-items: baseline;
		padding: 6px 10px;
		border-left: 2px solid transparent;
		background: var(--bg-elev);
	}

	.orphan-row .badge {
		font-size: 10px;
		font-weight: 700;
		flex-shrink: 0;
	}

	.orphan-row .what {
		flex: 1;
		margin: 0;
		font-size: 12.5px;
	}

	.orphan-row .where {
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--text-faint);
	}

	.skipped-list {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.skipped-chip {
		font-size: 11px;
		font-family: var(--mono);
		color: var(--text-faint);
		padding: 4px 8px;
		border: 1px solid var(--border);
	}
</style>
