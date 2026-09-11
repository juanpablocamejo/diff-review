<script lang="ts">
	import type { FileSection } from './build';
	import type { DecoratedFinding } from './decorate';
	import DiffView from './DiffView.svelte';
	import FileIcon from './FileIcon.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import type { PublishPlatform } from './prompts';

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
		onignore,
		onfix,
		onclear,
		onresizeexplanation,
		onresizesplit,
		onrequestlines,
		fixSelectionCount,
		showFixPrompt,
		fixPromptMode,
		fixPromptText,
		fixCommandText,
		fixCopyLabel,
		onclosefixprompt,
		onsetfixmode,
		oncopyfix,
		showPublishPrompt,
		publishPlatform,
		publishText,
		publishTargetLabel,
		publishCopyLabel,
		onclosepublishprompt,
		onsetpublishplatform,
		oncopypublish
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
		onignore: () => void;
		onfix: () => void;
		onclear: () => void;
		onresizeexplanation: (dx: number) => void;
		onresizesplit: (ratio: number) => void;
		onrequestlines?: (path: string) => Promise<string[] | null>;
		fixSelectionCount: number;
		showFixPrompt: boolean;
		fixPromptMode: 'full' | 'command';
		fixPromptText: string;
		fixCommandText: string;
		fixCopyLabel: string;
		onclosefixprompt: () => void;
		onsetfixmode: (mode: 'full' | 'command') => void;
		oncopyfix: () => void;
		showPublishPrompt: boolean;
		publishPlatform: PublishPlatform;
		publishText: string;
		publishTargetLabel: string;
		publishCopyLabel: string;
		onclosepublishprompt: () => void;
		onsetpublishplatform: (platform: PublishPlatform) => void;
		oncopypublish: () => void;
	} = $props();
</script>

{#if showFixPrompt}
	<section class="prompt-box fix">
		<div class="prompt-head">
			<h2 class="fix-title">Prompt de corrección · {fixSelectionCount} hallazgos</h2>
			<button type="button" class="close" onclick={onclosefixprompt}>Cerrar ✕</button>
		</div>
		<div class="mode-toggle">
			<button type="button" class:on={fixPromptMode === 'full'} onclick={() => onsetfixmode('full')}
				>Prompt completo</button
			>
			<button type="button" class:on={fixPromptMode === 'command'} onclick={() => onsetfixmode('command')}
				>Comando (skill)</button
			>
		</div>
		{#if fixPromptMode === 'full'}
			<textarea readonly value={fixPromptText}></textarea>
		{:else}
			<div class="command-box"><code>{fixCommandText}</code></div>
			<p class="hint">Requiere /diff-review-fix instalado (mismo archivo de skill que /diff-review). El agente ubica cada hallazgo por archivo:línea.</p>
		{/if}
		<div>
			<button type="button" class="copy" onclick={oncopyfix}>{fixCopyLabel}</button>
		</div>
	</section>
{/if}

{#if showPublishPrompt}
	<section class="prompt-box publish">
		<div class="prompt-head">
			<h2 class="publish-title">Publicar hallazgos · {fixSelectionCount}</h2>
			<button type="button" class="close" onclick={onclosepublishprompt}>Cerrar ✕</button>
		</div>
		<div class="mode-toggle">
			<button type="button" class:on={publishPlatform === 'github'} onclick={() => onsetpublishplatform('github')}
				>GitHub</button
			>
			<button type="button" class:on={publishPlatform === 'gitlab'} onclick={() => onsetpublishplatform('gitlab')}
				>GitLab</button
			>
		</div>
		<textarea readonly value={publishText}></textarea>
		<p class="hint">Copiá y pegá como comentario en el {publishTargetLabel}. Markdown listo, un bloque por hallazgo marcado.</p>
		<div>
			<button type="button" class="copy" onclick={oncopypublish}>{publishCopyLabel}</button>
		</div>
	</section>
{/if}

<div class="detail-panel">
	{#if activeFinding}
		<div class="detail-head">
			<div class="detail-head-left">
				<span class="number">#{activeFinding.number}</span>
				<span class="badge" style:color={activeFinding.badgeColor}>{activeFinding.badge}</span>
				<span class="file-line">{activeFinding.fileLine}</span>
			</div>
			<div class="decision-group">
				<button type="button" class:on={activeFinding.decided && !activeFinding.fixSelected} onclick={onignore}
					>Ignorar</button
				>
				<button type="button" class:on={activeFinding.decided && activeFinding.fixSelected} onclick={onfix}
					>Corregir</button
				>
				{#if activeFinding.decided}
					<button type="button" class="clear" title="Limpiar decisión" onclick={onclear}>✕</button>
				{/if}
			</div>
		</div>
	{/if}

	<div
		class="detail-grid"
		class:no-explanations={!showExplanations}
		style:grid-template-columns={showExplanations ? `minmax(0,1fr) 6px ${explanationWidth}px` : 'minmax(0,1fr)'}
	>
		<div class="diff-col">
			{#if activeFile}
				<div class="file-path-bar">
					<FileIcon path={activeFile.path} />
					<span class="file-path-text">{activeFile.path}</span>
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
			</div>
		{/if}
	</div>
</div>

<style>
	.prompt-box {
		border: 1px solid var(--fix-border);
		background: var(--fix-bg);
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.prompt-box.publish {
		border-color: var(--publish-border);
		background: var(--publish-bg);
	}

	.prompt-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.fix-title {
		margin: 0;
		font-size: 12px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--fix-text);
		font-weight: 650;
	}

	.publish-title {
		margin: 0;
		font-size: 12px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--publish-text);
		font-weight: 650;
	}

	.close {
		background: transparent;
		border: 0;
		color: var(--text-faint);
		font-size: 12px;
		padding: 0;
	}

	.mode-toggle {
		display: flex;
		border: 1px solid var(--border);
		overflow: hidden;
		width: fit-content;
	}

	.mode-toggle button {
		padding: 6px 12px;
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

	textarea {
		width: 100%;
		height: 220px;
		resize: vertical;
		background: var(--bg);
		border: 1px solid var(--border);
		padding: 12px;
		font-family: var(--mono);
		font-size: 12px;
		line-height: 1.5;
		color: var(--text);
	}

	.command-box {
		background: var(--bg);
		border: 1px solid var(--border);
		padding: 10px 12px;
		overflow: auto;
	}

	.command-box code {
		font-family: var(--mono);
		font-size: 12.5px;
		color: var(--text);
		white-space: nowrap;
	}

	.hint {
		margin: 0;
		font-size: 11.5px;
		color: var(--text-faint);
	}

	.copy {
		background: var(--btn-primary-bg);
		border: 1px solid var(--btn-primary-border);
		padding: 9px 14px;
		color: var(--btn-primary-text);
		font-weight: 600;
		font-size: 13px;
	}

	.detail-panel {
		border: 1px solid var(--border);
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
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.detail-head-left {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.number {
		font-size: 12px;
		color: var(--text);
		font-weight: 700;
	}

	.badge {
		font-size: 10px;
		font-weight: 700;
	}

	.file-line {
		font-size: 11px;
		color: var(--text-faint);
		font-family: var(--mono);
	}

	.decision-group {
		display: flex;
		border: 1px solid var(--border);
		overflow: hidden;
		flex-shrink: 0;
	}

	.decision-group button {
		padding: 6px 14px;
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
		padding: 6px 10px;
		color: var(--text-faint);
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
