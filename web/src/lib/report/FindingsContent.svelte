<script lang="ts">
	import type { FileSection } from './build';
	import type { DecoratedFinding } from './decorate';
	import DiffView from './DiffView.svelte';
	import FileIcon from './FileIcon.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import AskAgentButton from './AskAgentButton.svelte';
	import CopyPathButton from './CopyPathButton.svelte';
	import { findingRef } from './labels';

	let {
		activeFinding,
		activeFile,
		diffMode,
		showExplanations,
		explanationWidth,
		splitRatio,
		diffFontSize,
		wrapLines,
		reviewedLabel,
		agentId = '',
		onignore,
		onfix,
		onclear,
		onaskfinding,
		onresizeexplanation,
		onresizesplit,
		onrequestlines,
		onmarkallfix,
		onmarkallignore,
		onmarkallclear
	}: {
		activeFinding: DecoratedFinding | null;
		activeFile: FileSection | null;
		diffMode: 'unified' | 'split';
		showExplanations: boolean;
		explanationWidth: number;
		splitRatio: number;
		diffFontSize: number;
		wrapLines: boolean;
		reviewedLabel: string;
		agentId?: string;
		onignore: () => void;
		onfix: () => void;
		onclear: () => void;
		onaskfinding?: () => void;
		onresizeexplanation: (dx: number) => void;
		onresizesplit: (ratio: number) => void;
		onrequestlines?: (path: string) => Promise<string[] | null>;
		onmarkallfix?: () => void;
		onmarkallignore?: () => void;
		onmarkallclear?: () => void;
	} = $props();

	function fileName(path: string) {
		const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		return slash >= 0 ? path.slice(slash + 1) : path;
	}

	function fileDir(path: string) {
		const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		return slash >= 0 ? path.slice(0, slash) : '';
	}

	const findingDir = $derived(activeFinding ? fileDir(activeFinding.file) : '');
	const findingBase = $derived(
		activeFinding
			? `${fileName(activeFinding.file)}${activeFinding.line != null ? `:${activeFinding.line}` : ''}`
			: ''
	);
</script>

<div class="detail-panel">
	{#if onmarkallfix || onmarkallignore || onmarkallclear}
		<div class="bulk-bar">
			<span class="bulk-label">Marcar todos</span>
			{#if onmarkallfix}
				<button type="button" class="bulk fix" onclick={onmarkallfix}>A corregir</button>
			{/if}
			{#if onmarkallignore}
				<button type="button" class="bulk ignore" onclick={onmarkallignore}>A ignorar</button>
			{/if}
			{#if onmarkallclear}
				<button type="button" class="bulk clear" onclick={onmarkallclear}>Limpiar</button>
			{/if}
		</div>
	{/if}
	{#if activeFinding}
		<div class="detail-head">
			<div class="detail-head-row">
				<div class="detail-head-left">
					<span class="number">{findingRef(activeFinding.id, activeFinding.number)}</span>
					<span class="badge" style:color={activeFinding.badgeColor}>{activeFinding.badge}</span>
					<span class="file-name" title={activeFinding.fileLine}>{findingBase}</span>
					<CopyPathButton path={activeFinding.file} />
				</div>
				<div class="head-actions">
					{#if onaskfinding}
						<AskAgentButton {agentId} onclick={onaskfinding} />
					{/if}
					{#if activeFinding.corrected}
						<div class="decision-group corrected">
							<span class="corrected-label">Corregido</span>
							<button type="button" class="clear" title="Limpiar decisión" onclick={onclear}>✕</button>
						</div>
					{:else}
						<div class="decision-group">
							<button
								type="button"
								class={['ignore', { on: activeFinding.decided && !activeFinding.fixSelected }]}
								onclick={onignore}>A ignorar</button
							>
							<button
								type="button"
								class={['fix', { on: activeFinding.decided && activeFinding.fixSelected }]}
								onclick={onfix}>A corregir</button
							>
							{#if activeFinding.decided}
								<button type="button" class="clear" title="Limpiar decisión" onclick={onclear}>✕</button>
							{/if}
						</div>
					{/if}
				</div>
			</div>
			{#if findingDir}
				<span class="file-dir" title={findingDir}>{findingDir}</span>
			{/if}
		</div>
	{/if}

	<div
		class={['detail-grid', { 'no-explanations': !showExplanations }]}
		style:grid-template-columns={showExplanations
			? `minmax(min(100%, 200px), 1fr) 6px minmax(0, ${explanationWidth}px)`
			: 'minmax(0,1fr)'}
	>
		<div class="diff-col">
			{#if activeFile}
				<div class="file-path-bar">
					<FileIcon path={activeFile.path} />
					<span class="file-path-text">{activeFile.path}</span>
					<CopyPathButton path={activeFile.path} />
				</div>
				<DiffView
					path={activeFile.path}
					diff={activeFile.diff}
					blocks={activeFile.blocksForFile.map((b) => ({
						...b,
						accentColor: activeFile.blockAccent[b.id] ?? 'transparent'
					}))}
					mode={diffMode}
					highlightBlockId={activeFinding?.block || null}
					{splitRatio}
					onSplitRatioChange={onresizesplit}
					fontSize={diffFontSize}
					{wrapLines}
					onRequestLines={onrequestlines}
				/>
			{/if}
		</div>
		{#if activeFinding && showExplanations}
			<ResizeHandle ondrag={onresizeexplanation} />
			<div class="explain-col">
				<span class="explain-counter">{reviewedLabel}</span>
				<div>
					<h3>Qué pasa</h3>
					<p class="what">{activeFinding.what}</p>
				</div>
				<div>
					<h3>Sugerencia de corrección</h3>
					<p class="fix">{activeFinding.fix}</p>
				</div>
				{#if activeFinding.corrected && activeFinding.fixedDetail}
					<details class="fix-detail">
						<summary>Detalle</summary>
						<p>{activeFinding.fixedDetail}</p>
					</details>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.detail-panel {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-card);
		overflow: hidden;
		min-width: 0;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.detail-head {
		padding: 10px 16px;
		border-bottom: 1px solid var(--border-soft);
		background: var(--bg-elev);
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.detail-head-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-width: 0;
	}

	.detail-head-left {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		overflow: hidden;
	}

	.number {
		font-size: 12px;
		color: var(--text);
		font-weight: 700;
		flex-shrink: 0;
	}

	.badge {
		font-size: 10px;
		font-weight: 700;
		flex-shrink: 0;
	}

	.bulk-bar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px 8px;
		padding: 0 0 10px;
		margin-bottom: 4px;
		border-bottom: 1px solid var(--border-soft, var(--border));
	}

	.bulk-label {
		font-size: 11px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
		margin-right: 4px;
	}

	.bulk {
		padding: 4px 10px;
		font-size: 11.5px;
		font-weight: 600;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-dim);
		cursor: pointer;
	}

	.bulk.fix:hover {
		border-color: var(--fix-border);
		background: var(--fix-bg);
		color: var(--fix-text, var(--ok));
	}

	.bulk.ignore:hover {
		border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
		background: var(--danger-bg);
		color: var(--danger);
	}

	.bulk.clear:hover {
		border-color: var(--accent);
		color: var(--text);
	}

	.file-name {
		font-size: 12px;
		color: var(--text);
		font-weight: 600;
		font-family: var(--mono);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-dir {
		font-size: 11px;
		color: var(--text-faint);
		font-family: var(--mono);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.head-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.decision-group {
		display: flex;
		align-items: stretch;
		gap: 6px;
		flex-shrink: 0;
	}

	.decision-group.corrected {
		border: 1px solid color-mix(in srgb, var(--ok) 45%, var(--border));
		border-radius: var(--radius);
		background: var(--ok-bg);
		gap: 0;
	}

	.corrected-label {
		padding: 6px 14px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ok);
	}

	.decision-group button {
		padding: 6px 14px;
		font-size: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-dim);
		font-weight: 600;
	}

	.decision-group button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* Ignorar: ghost / danger-subtle */
	.decision-group button.ignore {
		background: transparent;
		border-color: var(--border);
		color: var(--text-dim);
	}

	.decision-group button.ignore:hover,
	.decision-group button.ignore.on {
		border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
		background: var(--danger-bg);
		color: var(--danger);
	}

	/* Corregir: filled con tokens --fix-* */
	.decision-group button.fix {
		background: var(--fix-bg);
		border-color: var(--fix-border);
		color: var(--fix-text);
	}

	.decision-group button.fix:hover,
	.decision-group button.fix.on {
		filter: brightness(1.05);
		box-shadow: inset 0 0 0 1px var(--fix-border);
	}

	.decision-group .clear {
		padding: 6px 10px;
		color: var(--text-dim);
		border-color: var(--border);
		background: transparent;
	}

	.decision-group.corrected .clear {
		border: 0;
		border-left: 1px solid color-mix(in srgb, var(--ok) 35%, var(--border));
	}

	.fix-detail {
		margin-top: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--ok-bg);
		padding: 8px 10px;
	}

	.fix-detail summary {
		cursor: pointer;
		font-size: 11px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ok);
		user-select: none;
	}

	.fix-detail p {
		margin: 8px 0 0;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--text);
		white-space: pre-wrap;
	}

	.detail-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
		flex: 1;
		min-height: 0;
	}

	.detail-grid.no-explanations {
		grid-template-columns: minmax(0, 1fr);
	}

	.diff-col {
		min-width: 0;
		overflow-y: auto;
		overflow-x: hidden;
		display: flex;
		flex-direction: column;
	}

	.file-path-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--border-soft);
		background: var(--bg-elev);
		flex-shrink: 0;
		min-width: 0;
	}

	.file-path-text {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.explain-col {
		border-left: 1px solid var(--border-soft);
		background: var(--bg-elev);
		overflow: auto;
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.explain-counter {
		align-self: flex-start;
		font-size: 10.5px;
		font-weight: 650;
		color: var(--text-dim);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-card);
		padding: 3px 8px;
	}

	.explain-col h3 {
		margin: 0 0 4px;
		font-size: 10.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		font-weight: 650;
	}

	.explain-col .what {
		margin: 0;
		font-size: 13px;
		color: var(--text);
		line-height: 1.45;
	}

	.explain-col .fix {
		margin: 0;
		font-size: 13px;
		color: var(--text-dim);
		line-height: 1.45;
	}
</style>
