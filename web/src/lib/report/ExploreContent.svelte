<script lang="ts">
	import type { FileSection, GroupSectionModel } from './build';
	import type { DecoratedFinding } from './decorate';
	import { fileAnchor, groupAnchor, groupFileAnchor } from './anchors';
	import AskAgentButton from './AskAgentButton.svelte';
	import CopyPathButton from './CopyPathButton.svelte';
	import DiffView from './DiffView.svelte';
	import FileIcon from './FileIcon.svelte';
	import Icon from '$lib/Icon.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import { maxFindingAccent } from './severity';

	/** Bloques del archivo con color y, si hay, el qué/por qué para las notas inline. */
	function diffBlocks(file: FileSection) {
		const rowById = new Map(file.rows.map((r) => [r.id, r]));
		return file.blocksForFile.map((b) => {
			const row = rowById.get(b.id);
			return {
				...b,
				accentColor: file.blockAccent[b.id] ?? 'transparent',
				explain: row ? { lines: row.lines, opLabel: row.opLabel, what: row.what, why: row.why } : undefined
			};
		});
	}
	import { askDraftBlock, askDraftTheme, plural, pluralWord, themeRef } from './labels';
	import type { Action } from 'svelte/action';

	let {
		reviewDate = '',
		intentText,
		notes,
		hasBlockers,
		blockerBannerText,
		groupSections,
		looseFileSections,
		fileOpen,
		ontogglefile,
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
		agentId = '',
		ontoggleexpand,
		onopenfindings,
		onresizeexplanation,
		onresizesplit,
		onrequestlines,
		onactivefile,
		onask
	}: {
		/** ISO de cuándo se generó la review (o, si el agente no lo puso, cuándo se guardó). */
		reviewDate?: string;
		intentText: string;
		notes: string[];
		hasBlockers: boolean;
		blockerBannerText: string;
		groupSections: GroupSectionModel[];
		looseFileSections: FileSection[];
		/** Override de abierto/cerrado; sin entrada usa el default del panel. */
		fileOpen: Record<string, boolean>;
		ontogglefile: (path: string, defaultOpen: boolean) => void;
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
		agentId?: string;
		ontoggleexpand: (path: string) => void;
		onopenfindings: (path: string) => void;
		onresizeexplanation: (dx: number) => void;
		onresizesplit: (ratio: number) => void;
		onrequestlines?: (path: string) => Promise<string[] | null>;
		/** Archivo más visible al scrollear Explore (para el sidebar). */
		onactivefile?: (file: { groupId: string; path: string } | null) => void;
		/** Abre el chat con un borrador (referencia a tema/bloque); no envía. */
		onask?: (draft: string) => void;
	} = $props();

	/** "19 oct 2026, 11:03" + "hace 3 días"; vacío si la fecha no es válida. */
	const reviewWhen = $derived.by(() => {
		const d = new Date(reviewDate);
		if (!reviewDate || Number.isNaN(d.getTime())) return null;
		const month = d.toLocaleString('es-AR', { month: 'short' }).replace('.', '');
		const year = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
		const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
		const abs = `${d.getDate()} ${month}${year}, ${time}`;
		const mins = Math.round((Date.now() - d.getTime()) / 60000);
		const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
		const rel =
			mins < 1
				? 'recién'
				: mins < 60
					? rtf.format(-mins, 'minute')
					: mins < 60 * 24
						? rtf.format(-Math.round(mins / 60), 'hour')
						: mins < 60 * 24 * 30
							? rtf.format(-Math.round(mins / 1440), 'day')
							: rtf.format(-Math.round(mins / 43200), 'month');
		return { abs, rel, iso: d.toISOString() };
	});

	function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
		let p = el?.parentElement ?? null;
		while (p) {
			const style = getComputedStyle(p);
			if (/(auto|scroll)/.test(style.overflowY) || /(auto|scroll)/.test(style.overflow)) return p;
			p = p.parentElement;
		}
		return null;
	}

	/**
	 * Popover con las explicaciones del archivo cuando el panel lateral está oculto. Es `fixed`
	 * para que no lo recorte el scroll del contenido; por eso se cierra al scrollear afuera.
	 */
	const INFO_W = 400; // igual al ancho máximo de .info-pop
	let info = $state<{
		file: FileSection;
		left: number;
		top?: number;
		bottom?: number;
		maxH: number;
	} | null>(null);
	let infoEl = $state<HTMLDivElement | null>(null);
	let infoAnchor: HTMLElement | null = null;

	/*
	 * Se abre al pasar el mouse (con una pausa corta para no disparar popovers al cruzar
	 * headers) y se cierra al salir, salvo que el puntero pase al popover. Foco y clic también
	 * lo abren, para teclado y pantallas táctiles.
	 */
	const OPEN_DELAY = 120;
	const CLOSE_DELAY = 180;
	let openTimer: ReturnType<typeof setTimeout> | null = null;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	function clearTimers() {
		if (openTimer) clearTimeout(openTimer);
		if (closeTimer) clearTimeout(closeTimer);
		openTimer = closeTimer = null;
	}

	function hoverInfo(e: Event, file: FileSection) {
		const btn = e.currentTarget as HTMLElement;
		clearTimers();
		if (info?.file.path === file.path) return;
		openTimer = setTimeout(() => openInfo(btn, file), info ? 0 : OPEN_DELAY);
	}

	function leaveInfo() {
		if (openTimer) clearTimeout(openTimer);
		openTimer = null;
		if (!info) return;
		if (closeTimer) clearTimeout(closeTimer);
		closeTimer = setTimeout(closeInfo, CLOSE_DELAY);
	}

	function keepInfo() {
		if (closeTimer) clearTimeout(closeTimer);
		closeTimer = null;
	}

	function clickInfo(e: MouseEvent, file: FileSection) {
		clearTimers();
		if (info?.file.path !== file.path) openInfo(e.currentTarget as HTMLElement, file);
	}

	function openInfo(btn: HTMLElement, file: FileSection) {
		const r = btn.getBoundingClientRect();
		const left = Math.max(8, Math.min(r.right - INFO_W, window.innerWidth - INFO_W - 8));
		const below = window.innerHeight - r.bottom - 18;
		infoAnchor = btn;
		info =
			below >= 220 || below >= r.top
				? { file, left, top: r.bottom + 6, maxH: below }
				: { file, left, bottom: window.innerHeight - r.top + 6, maxH: r.top - 18 };
	}

	function closeInfo() {
		clearTimers();
		info = null;
		infoAnchor = null;
	}

	// Al volver a mostrar el panel lateral, el popover sobra.
	$effect(() => {
		if (showExplanations) closeInfo();
	});

	$effect(() => {
		if (!info) return;
		const inside = (t: EventTarget | null) =>
			t instanceof Node && (!!infoEl?.contains(t) || !!infoAnchor?.contains(t));
		const onDown = (e: PointerEvent) => {
			if (!inside(e.target)) closeInfo();
		};
		const onScroll = (e: Event) => {
			if (!inside(e.target)) closeInfo();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') closeInfo();
		};
		window.addEventListener('pointerdown', onDown, true);
		window.addEventListener('scroll', onScroll, true);
		window.addEventListener('resize', closeInfo);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('pointerdown', onDown, true);
			window.removeEventListener('scroll', onScroll, true);
			window.removeEventListener('resize', closeInfo);
			window.removeEventListener('keydown', onKey);
		};
	});

	type ActiveFileFn =((file: { groupId: string; path: string } | null) => void) | undefined;

	/**
	 * Action (not $effect + bind:this): `display:contents` + bind:this re-assigns the node when
	 * the parent re-renders from onactivefile, which re-ran the effect → notify → depth exceeded.
	 * The action mounts once; `update` only refreshes the callback identity.
	 */
	const observeActiveFile: Action<HTMLElement, ActiveFileFn> = (node, initial) => {
		let notify = initial;
		const scrollRoot = scrollParentOf(node);
		const visible = new Map<Element, number>();
		let lastKey = '';
		let observer: IntersectionObserver | null = null;
		let mo: MutationObserver | null = null;

		const publish = () => {
			if (!notify) return;
			let best: { el: Element; ratio: number } | null = null;
			for (const [el, ratio] of visible) {
				if (!best || ratio > best.ratio) best = { el, ratio };
			}
			// Never notify(null): MutationObserver re-watch clears `visible` and would
			// oscillate null↔file → parent re-render → MO → depth exceeded.
			if (!best || best.ratio <= 0) return;
			const groupId = (best.el as HTMLElement).dataset.groupId;
			const path = (best.el as HTMLElement).dataset.path;
			if (!groupId || !path) return;
			const key = `${groupId}\0${path}`;
			if (key === lastKey) return;
			lastKey = key;
			notify({ groupId, path });
		};

		const stop = () => {
			mo?.disconnect();
			observer?.disconnect();
			mo = null;
			observer = null;
			visible.clear();
		};

		const start = () => {
			if (!notify) return;
			observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting && entry.intersectionRatio > 0) {
							visible.set(entry.target, entry.intersectionRatio);
						} else {
							visible.delete(entry.target);
						}
					}
					publish();
				},
				{
					root: scrollRoot,
					rootMargin: '-12% 0px -55% 0px',
					threshold: [0, 0.1, 0.25, 0.5, 0.75, 1]
				}
			);
			const watch = () => {
				observer?.disconnect();
				// Keep last intersection ratios; only drop nodes that left the tree.
				const nodes = [...node.querySelectorAll<HTMLElement>('[data-explore-file]')];
				const alive = new Set<Element>(nodes);
				for (const el of visible.keys()) {
					if (!alive.has(el)) visible.delete(el);
				}
				nodes.forEach((el) => observer?.observe(el));
			};
			watch();
			mo = new MutationObserver(watch);
			mo.observe(node, { childList: true, subtree: true });
		};

		start();

		return {
			update(next) {
				const was = Boolean(notify);
				notify = next;
				if (!was && next) start();
				else if (was && !next) stop();
			},
			destroy() {
				stop();
			}
		};
	};
</script>

<div class="explore" use:observeActiveFile={onactivefile}>
{#if hasBlockers}
	<p class="blocker-bar">{blockerBannerText}</p>
{/if}

<section class="intent">
	<div class="intent-head">
		<h2>Intención</h2>
		{#if reviewWhen}
			<time class="review-date" datetime={reviewWhen.iso} title="Fecha de la review">
				{reviewWhen.abs}<span class="review-sep" aria-hidden="true">·</span><span class="review-rel">{reviewWhen.rel}</span>
			</time>
		{/if}
	</div>
	<p class="intent-text">{intentText}</p>
	{#each notes as note (note)}
		<p class="note">{note}</p>
	{/each}
</section>

{#snippet findingsControl(total: number, allDone: boolean, maxAccent: string, path: string)}
	<button
		type="button"
		class="findings-control"
		style:--finding-sev={allDone ? null : maxAccent}
		onclick={() => onopenfindings(path)}
	>
		{#if allDone}
			<span class="count-badge done">✓</span>
			<span class="count-label">{plural(total, 'hallazgo', 'hallazgos')}</span>
		{:else}
			<span class="count-badge open">{total}</span>
			<span class="count-label open">{pluralWord(total, 'hallazgo', 'hallazgos')}</span>
		{/if}
		<span class="arrow">→</span>
	</button>
{/snippet}

{#snippet explainRows(file: FileSection)}
	{#each file.rows as row (row.id)}
		<div class="explain-row">
			<div class="explain-top">
				<span class="lines">{row.lines}</span>
				<span class="op">{row.opLabel}</span>
				{#if onask}
					<span class="explain-ask">
						<AskAgentButton
							{agentId}
							title="Preguntar al agente sobre este bloque"
							onclick={() => {
								closeInfo();
								onask(askDraftBlock({ id: row.id, file: file.path, lines: row.lines }));
							}}
						/>
					</span>
				{/if}
			</div>
			<p class="what">{row.what}</p>
			{#if row.why}
				<p class="why">{row.why}</p>
			{/if}
		</div>
	{/each}
{/snippet}

{#snippet fileBlock(file: FileSection, defaultOpen = true, groupId: string | null = null)}
		{@const open = fileOpen[file.path] ?? defaultOpen}
		{@const total = file.allFindings.length}
		{@const doneCount = file.allFindings.filter((f) => decided[f.id]).length}
		{@const allDone = total > 0 && doneCount === total}
		{@const maxAccent = maxFindingAccent(file.allFindings)}
		<div
			id={groupId ? groupFileAnchor(groupId, file.path) : fileAnchor(file.path)}
			class="file-section"
			class:collapsed={!open}
			data-explore-file={groupId ? '' : undefined}
			data-group-id={groupId ?? undefined}
			data-path={file.path}
		>
			<div
				class="file-head"
				style:grid-template-columns={showExplanations ? `minmax(0,1fr) 6px ${explanationWidth}px` : 'minmax(0,1fr)'}
			>
				<div class="file-head-main">
					<button
						type="button"
						class="file-toggle"
						onclick={() => ontogglefile(file.path, defaultOpen)}
					>
						<span class="caret" class:open><Icon name="chevron-right" size={16} /></span>
						<FileIcon path={file.path} />
						<span class="path">{file.path}</span>
						<span class="change-label">{file.changeLabel}</span>
					</button>
					<CopyPathButton path={file.path} />
					{#if !showExplanations && (total > 0 || file.rows.length > 0)}
						<div class="head-actions">
							{#if total > 0}
								{@render findingsControl(total, allDone, maxAccent, file.path)}
							{/if}
							{#if file.rows.length > 0}
								{@const infoOpen = info?.file.path === file.path}
								<button
									type="button"
									class="info-btn"
									class:on={infoOpen}
									aria-label="Explicación de los bloques de {file.path}"
									aria-expanded={infoOpen}
									aria-haspopup="dialog"
									onmouseenter={(e) => hoverInfo(e, file)}
									onmouseleave={leaveInfo}
									onfocus={(e) => hoverInfo(e, file)}
									onblur={leaveInfo}
									onclick={(e) => clickInfo(e, file)}
								>
									<Icon name="info" size={15} />
								</button>
							{/if}
						</div>
					{/if}
				</div>
				{#if showExplanations}
					<div class="file-head-gutter"></div>
					<div class="file-head-explain">
						{#if total > 0}
							{@render findingsControl(total, allDone, maxAccent, file.path)}
						{/if}
					</div>
				{/if}
			</div>
			{#if open}
				<div
					class="file-grid"
					class:no-explanations={!showExplanations}
					style:grid-template-columns={showExplanations ? `minmax(0,1fr) 6px ${explanationWidth}px` : 'minmax(0,1fr)'}
				>
					<div class="diff-col">
						<DiffView
							path={file.path}
							diff={file.diff}
							blocks={diffBlocks(file)}
							showBlockNotes={!showExplanations}
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
							{@render explainRows(file)}
						</div>
					{/if}
				</div>
			{/if}
		</div>
{/snippet}

{#each groupSections as g, gi (g.id)}
	<section id={groupAnchor(g.id)} class="group" style:border-top={gi > 0 ? '1px solid var(--border-soft)' : 'none'}>
		<div class="group-sticky">
			<header class="group-head">
				<span class="number">{themeRef(g.id, g.number)}</span>
				<span class="kind-chip" style:color={g.kindColor}>{g.kindLabel}</span>
				<h2>{g.title}</h2>
				{#if onask}
					<span class="group-ask">
						<AskAgentButton
							{agentId}
							title="Preguntar al agente sobre este tema"
							onclick={() => onask(askDraftTheme({ id: g.id, number: g.number, title: g.title }))}
						/>
					</span>
				{/if}
			</header>
			{#if g.intentText}
				<p class="group-intent">{g.intentText}</p>
			{/if}
		</div>

		{#each g.fileSections as file (file.path)}
			{@render fileBlock(file, true, g.id)}
		{/each}
	</section>
{/each}

{#if looseFileSections.length}
	<section class="group loose">
		<header class="group-head">
			<span class="kind-chip">sin tema</span>
			<h2>{plural(looseFileSections.length, 'Archivo que ningún bloque explica', 'Archivos que ningún bloque explica')}</h2>
		</header>
		{#each looseFileSections as file (file.path)}
			<!-- Sin hallazgos arranca plegado para no colgar la página con cientos de diffs. -->
			{@render fileBlock(file, file.allFindings.length > 0)}
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

{#if info}
	<div
		bind:this={infoEl}
		class="info-pop"
		role="dialog"
		tabindex="-1"
		aria-label="Explicación de los bloques de {info.file.path}"
		onmouseenter={keepInfo}
		onmouseleave={leaveInfo}
		onfocusin={keepInfo}
		onfocusout={leaveInfo}
		style:left="{info.left}px"
		style:top={info.top != null ? `${info.top}px` : undefined}
		style:bottom={info.bottom != null ? `${info.bottom}px` : undefined}
		style:max-height="{info.maxH}px"
	>
		<div class="info-head">
			<FileIcon path={info.file.path} />
			<span class="info-path" title={info.file.path}>{info.file.path}</span>
			<span class="info-count">{plural(info.file.rows.length, 'bloque', 'bloques')}</span>
		</div>
		<div class="info-body">
			{@render explainRows(info.file)}
		</div>
	</div>
{/if}
</div>

<style>
	/* Real box (not display:contents): contents + action/bind:this was recreated whenever
	   onactivefile updated the parent → remount observers → effect_update_depth_exceeded. */
	.explore {
		display: flex;
		flex-direction: column;
		gap: 18px;
		min-width: 0;
	}

	.blocker-bar {
		margin: 0;
		padding: 10px 14px;
		background: var(--danger-bg);
		border: 1px solid var(--danger-border);
		border-radius: var(--radius);
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

	.intent-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 8px;
	}

	.intent-head h2 {
		margin: 0;
	}

	.review-date {
		flex-shrink: 0;
		font-size: 11.5px;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}

	.review-sep {
		margin: 0 6px;
		opacity: 0.6;
	}

	.review-rel {
		opacity: 0.8;
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

	.group {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 18px 0 6px;
	}

	.group-sticky {
		position: sticky;
		/* Compensa el padding de .content para que no quede hueco arriba al scrollear. */
		top: -14px;
		z-index: 4;
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0 -20px;
		padding: 14px 20px 12px;
		background: var(--bg);
		border-bottom: 1px solid var(--border-soft);
	}

	.group-head {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.group-ask {
		margin-left: auto;
	}

	.group-head .number {
		font-size: 12px;
		font-weight: 700;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.group-head h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 650;
		color: var(--text);
		text-transform: none;
		letter-spacing: normal;
		line-height: 1.3;
	}

	.kind-chip {
		font-size: 11px;
		font-weight: 700;
		padding: 2px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-card);
		flex-shrink: 0;
	}

	.group-intent {
		margin: 0;
		font-size: 12.5px;
		color: var(--text-dim);
		line-height: 1.45;
		max-width: 80ch;
	}

	.loose .kind-chip {
		color: var(--text-faint);
	}

	.file-section {
		border-top: 1px solid var(--border);
	}

	.file-head {
		display: grid;
		align-items: center;
		border-bottom: 1px solid var(--border-soft);
	}

	.file-section.collapsed .file-head {
		border-bottom: 0;
	}

	.file-head-main {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 0;
		min-width: 0;
	}

	.file-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 0 1 auto;
		min-width: 0;
		padding: 4px 0;
		border: 0;
		background: transparent;
		text-align: left;
		color: inherit;
		cursor: pointer;
	}

	.file-toggle:hover .path {
		color: var(--accent);
	}

	.caret {
		display: inline-flex;
		flex-shrink: 0;
		margin-left: -3px;
		color: var(--text-faint);
		transition: transform 0.12s ease;
	}

	.caret.open {
		transform: rotate(90deg);
	}

	.file-toggle:hover .caret {
		color: var(--text);
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
		flex-shrink: 0;
	}

	.head-actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-left: auto;
		flex-shrink: 0;
	}

	.info-btn {
		width: 26px;
		height: 26px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
	}

	.info-btn:hover,
	.info-btn.on {
		background: color-mix(in srgb, var(--text) 8%, transparent);
		color: var(--text);
	}

	.info-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.info-pop {
		position: fixed;
		z-index: 200;
		width: min(400px, calc(100vw - 16px));
		display: flex;
		flex-direction: column;
		min-height: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		box-shadow: 0 12px 32px color-mix(in srgb, #000 28%, transparent);
		overflow: hidden;
	}

	.info-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 14px;
		border-bottom: 1px solid var(--border-soft);
		background: var(--bg-card);
		flex-shrink: 0;
	}

	.info-path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--mono);
		font-size: 11.5px;
		color: var(--text-dim);
	}

	.info-count {
		flex-shrink: 0;
		font-size: 10.5px;
		color: var(--text-faint);
	}

	.info-body {
		overflow-y: auto;
		min-height: 0;
	}

	.info-body .explain-row:last-child {
		border-bottom: 0;
	}

	.findings-control {
		display: flex;
		align-items: center;
		gap: 6px;
		background: transparent;
		border: 0;
		padding: 0;
		flex-shrink: 0;
		margin-left: auto;
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
		border-radius: var(--radius);
		color: var(--ok);
	}

	.count-badge.open {
		background: color-mix(in srgb, var(--finding-sev) 22%, transparent);
		color: var(--finding-sev);
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
		color: var(--finding-sev, var(--accent));
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
	}

	.explain-top {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 4px;
	}

	.explain-ask {
		margin-left: auto;
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
		border-radius: var(--radius);
	}
</style>
