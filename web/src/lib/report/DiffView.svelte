<script lang="ts">
	import {
		buildDiffSegments,
		buildHunkSplit,
		CONTEXT_STEP,
		hunkCovers,
		hunkLineCount,
		languageFor,
		parseUnifiedDiff,
		renderLine,
		type DiffGap,
		type DiffHunk,
		type RevealState,
		type SplitCell
	} from './diff';
	import type { BlockSide } from './types';
	import { plural } from './labels';

	type BlockExplain = { lines: string; opLabel: string; what: string; why: string };
	type Accent = {
		id: string;
		side: BlockSide;
		start: number;
		end: number;
		accentColor: string;
		explain?: BlockExplain;
	};

	let {
		path,
		diff,
		blocks = [],
		highlightBlockId = null,
		showBlockNotes = false,
		mode = 'unified',
		expanded = false,
		onToggleExpand,
		splitRatio = 0.5,
		onSplitRatioChange,
		fontSize = 11.5,
		wrapLines = true,
		onRequestLines
	}: {
		path: string;
		diff: string;
		blocks?: Accent[];
		highlightBlockId?: string | null;
		/** Sin columna de explicaciones: nota al inicio de cada bloque con popover del qué/por qué. */
		showBlockNotes?: boolean;
		mode?: 'unified' | 'split';
		expanded?: boolean;
		onToggleExpand?: () => void;
		splitRatio?: number;
		onSplitRatioChange?: (ratio: number) => void;
		fontSize?: number;
		/** Solo aplica en modo unificado: en split el código siempre ajusta, así no hay scroll horizontal. */
		wrapLines?: boolean;
		/** Trae el archivo entero del repo para rellenar las líneas que el diff no muestra. */
		onRequestLines?: (path: string) => Promise<string[] | null>;
	} = $props();

	/** Arriba de esto el diff arranca plegado: leerlo entero no aporta. */
	const BIG_DIFF_LINES = 400;

	const hunks = $derived(parseUnifiedDiff(diff));
	const lang = $derived(languageFor(path));
	const totalLines = $derived(hunkLineCount(hunks));
	const big = $derived(totalLines > BIG_DIFF_LINES);

	const visible = $derived(
		big && !expanded
			? hunks.filter((hunk) => blocks.some((b) => hunkCovers(hunk, { side: b.side, start: b.start, end: b.end })))
			: hunks
	);
	const hiddenCount = $derived(hunks.length - visible.length);

	/** Archivo completo del repo: se pide recién cuando el usuario toca un botón de expandir. */
	let fileLines = $state<string[] | null>(null);
	let linesState = $state<'idle' | 'loading' | 'error'>('idle');
	let reveal = $state<RevealState>({});

	// Cambió el archivo que muestra este componente: lo cargado ya no aplica.
	// Guard: assigning `reveal = {}` every run dirties dependents forever (effect_update_depth).
	let resetKey = '';
	$effect(() => {
		const key = `${path}\0${diff}`;
		if (key === resetKey) return;
		resetKey = key;
		fileLines = null;
		linesState = 'idle';
		reveal = {};
	});

	const canExpand = $derived(!!onRequestLines && linesState !== 'error');
	/**
	 * Con el diff grande plegado hay hunks escondidos: lo que falta entre los visibles no es
	 * contexto sin cambios, así que ahí no se ofrecen huecos (está el botón de mostrar todo).
	 */
	const segments = $derived(
		visible.length === hunks.length
			? buildDiffSegments(visible, fileLines, reveal)
			: visible.map((hunk) => ({ kind: 'hunk' as const, hunk }))
	);

	async function ensureLines(): Promise<string[] | null> {
		if (fileLines) return fileLines;
		if (!onRequestLines) return null;
		linesState = 'loading';
		try {
			const lines = await onRequestLines(path);
			if (!lines?.length) {
				linesState = 'error';
				return null;
			}
			fileLines = lines;
			linesState = 'idle';
			return lines;
		} catch {
			linesState = 'error';
			return null;
		}
	}

	async function expandGap(gap: DiffGap, dir: 'up' | 'down' | 'all') {
		if (!(await ensureLines())) return;
		const current = reveal[gap.key] ?? { up: 0, down: 0 };
		const step = dir === 'all' ? gap.hidden : Math.min(CONTEXT_STEP, gap.hidden);
		// El tramo final del archivo no tiene hunk debajo: ahí "todas" revela hacia abajo.
		const side = dir === 'all' ? (gap.canUp ? 'up' : 'down') : dir;
		reveal = { ...reveal, [gap.key]: { ...current, [side]: current[side] + step } };
	}

	function blockFor(side: BlockSide, no: number | null) {
		if (no == null) return null;
		return blocks.find((b) => b.side === side && no >= b.start && no <= b.end) ?? null;
	}
	function accentFor(side: BlockSide, no: number | null) {
		return blockFor(side, no)?.accentColor ?? 'transparent';
	}
	function isHighlighted(side: BlockSide, no: number | null) {
		if (!highlightBlockId) return false;
		return blockFor(side, no)?.id === highlightBlockId;
	}

	/** Fondo de las celdas de una fila: el hueco de un lado desparejo va rayado. */
	function cellBg(cell: SplitCell, side: BlockSide, no: number | null) {
		if (cell.blank) return 'var(--diff-blank-bg)';
		if (isHighlighted(side, no)) return 'var(--diff-mark)';
		if (cell.kind === 'del') return 'var(--diff-del-bg)';
		if (cell.kind === 'add') return 'var(--diff-add-bg)';
		return 'transparent';
	}

	type ViewSeg =
		| { kind: 'gap'; key: string; gap: DiffGap }
		| {
				kind: 'hunk';
				key: string;
				hunk: DiffHunk;
				headerText: string;
				built: ReturnType<typeof buildHunkSplit> | null;
		  };

	/** Hunks y huecos en un solo listado; el modo split le suma las filas lado a lado. */
	const viewSegments = $derived<ViewSeg[]>(
		segments.map((seg) =>
			seg.kind === 'gap'
				? { kind: 'gap' as const, key: seg.gap.key, gap: seg.gap }
				: {
						kind: 'hunk' as const,
						key: `h${seg.hunk.index}`,
						hunk: seg.hunk,
						headerText: `@@ -${seg.hunk.oldStart},${seg.hunk.oldCount} +${seg.hunk.newStart},${seg.hunk.newCount} @@${seg.hunk.header ? ' ' + seg.hunk.header : ''}`,
						built: mode === 'split' ? buildHunkSplit(seg.hunk) : null
					}
		)
	);

	/** `${segKey}:${fila}` → bloque que arranca ahí (primera fila visible de cada bloque). */
	const noteAt = $derived.by(() => {
		const at = new Map<string, Accent>();
		if (!showBlockNotes) return at;
		const seen = new Set<string>();
		const mark = (key: string, b: Accent | null) => {
			if (!b?.explain || seen.has(b.id)) return;
			seen.add(b.id);
			at.set(key, b);
		};
		for (const seg of viewSegments) {
			if (seg.kind !== 'hunk') continue;
			if (seg.built) {
				seg.built.rows.forEach((row, i) => {
					const oldNo = row.left.blank ? null : Number(row.left.no);
					const newNo = row.right.blank ? null : Number(row.right.no);
					mark(`${seg.key}:${i}`, blockFor('old', oldNo) ?? blockFor('new', newNo));
				});
			} else {
				seg.hunk.lines.forEach((line, i) => {
					const side = line.kind === 'del' ? 'old' : 'new';
					mark(`${seg.key}:${i}`, blockFor(side, side === 'old' ? line.oldNo : line.newNo));
				});
			}
		}
		return at;
	});

	let tip = $state<{ block: Accent; x: number; y: number; above: boolean } | null>(null);

	function showTip(e: Event, block: Accent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const above = r.bottom + 240 > window.innerHeight;
		tip = { block, x: Math.min(r.left, window.innerWidth - 400), y: above ? r.top - 6 : r.bottom + 6, above };
	}

	function hideTip() {
		tip = null;
	}

	// El popover es `fixed`: si cualquier contenedor scrollea, deja de estar pegado a su nota.
	$effect(() => {
		if (!tip) return;
		window.addEventListener('scroll', hideTip, true);
		return () => window.removeEventListener('scroll', hideTip, true);
	});

	const leftFr = $derived(Math.round(splitRatio * 1000) / 1000);
	const rightFr = $derived(Math.round((1 - splitRatio) * 1000) / 1000);

	let gridEls = $state<(HTMLDivElement | null)[]>([]);
	let wrapEl = $state<HTMLDivElement | null>(null);

	/**
	 * Al abrir un hallazgo, lleva la vista a la línea inicial de su bloque (si tiene uno).
	 * También depende de `mode`: unificado/split son árboles DOM distintos, así que cambiar
	 * de uno a otro pierde el scroll y hay que reubicar el bloque de nuevo.
	 */
	$effect(() => {
		const id = highlightBlockId;
		const root = wrapEl;
		void mode;
		if (!id || !root) return;
		const target = root.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
		target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	});

	/** Arrastre del separador entre las dos columnas del modo split. */
	function onDividerPointerDown(e: PointerEvent, si: number) {
		if (e.button !== 0 || !onSplitRatioChange) return;
		const divider = e.currentTarget as HTMLElement;
		divider.setPointerCapture(e.pointerId);
		const prevCursor = document.body.style.cursor;
		const prevUserSelect = document.body.style.userSelect;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		const containerWidth = gridEls[si]?.clientWidth || 800;
		let lastX = e.clientX;
		let ratio = splitRatio;
		// `splitRatio` es global: aplicar cada pointermove crudo re-renderiza el grid de
		// TODOS los diffs abiertos por evento. Se acumula y se aplica una vez por rAF.
		let pendingDx = 0;
		let rafId: number | null = null;

		function flush() {
			rafId = null;
			if (!pendingDx) return;
			ratio = Math.min(0.8, Math.max(0.2, ratio + pendingDx / containerWidth));
			pendingDx = 0;
			onSplitRatioChange?.(ratio);
		}
		function onMove(ev: PointerEvent) {
			const dx = ev.clientX - lastX;
			lastX = ev.clientX;
			pendingDx += dx;
			if (rafId == null) rafId = requestAnimationFrame(flush);
		}
		function onUp(ev: PointerEvent) {
			if (rafId != null) {
				cancelAnimationFrame(rafId);
				flush();
			}
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevUserSelect;
			divider.releasePointerCapture(ev.pointerId);
			divider.removeEventListener('pointermove', onMove);
			divider.removeEventListener('pointerup', onUp);
		}
		divider.addEventListener('pointermove', onMove);
		divider.addEventListener('pointerup', onUp);
	}
</script>

{#snippet gapBar(gap: DiffGap)}
	{@const revealStep = Math.min(CONTEXT_STEP, gap.hidden)}
	<div class="gap-bar">
		<div class="gap-actions">
			{#if gap.canUp}
				<button
					type="button"
					title="Mostrar {plural(revealStep, 'línea', 'líneas')} hacia arriba"
					disabled={!canExpand || linesState === 'loading'}
					onclick={() => expandGap(gap, 'up')}>↑</button
				>
			{/if}
			{#if gap.canDown}
				<button
					type="button"
					title="Mostrar {plural(revealStep, 'línea', 'líneas')} hacia abajo"
					disabled={!canExpand || linesState === 'loading'}
					onclick={() => expandGap(gap, 'down')}>↓</button
				>
			{/if}
			{#if gap.hidden > CONTEXT_STEP}
				<button
					type="button"
					class="all"
					title="Mostrar {plural(gap.hidden, 'línea', 'líneas')} del tramo"
					disabled={!canExpand || linesState === 'loading'}
					onclick={() => expandGap(gap, 'all')}>todas</button
				>
			{/if}
		</div>
		<span class="gap-info">
			{#if linesState === 'error'}
				no se pudo leer el archivo del repo
			{:else if linesState === 'loading'}
				leyendo archivo…
			{:else}
				{plural(gap.hidden, 'línea', 'líneas')} sin mostrar · L{gap.start}–{gap.end}
			{/if}
		</span>
	</div>
{/snippet}

{#snippet blockNote(block: Accent)}
	{@const ex = block.explain}
	{#if ex}
		<button
			type="button"
			class="block-note"
			style:--note-accent={block.accentColor}
			aria-label="Explicación del bloque {ex.lines}: {ex.what}"
			onmouseenter={(e) => showTip(e, block)}
			onmouseleave={hideTip}
			onfocus={(e) => showTip(e, block)}
			onblur={hideTip}
		>
			<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
				<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.4" />
				<path d="M8 7.25v3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
				<circle cx="8" cy="5" r="0.9" fill="currentColor" />
			</svg>
		</button>
	{/if}
{/snippet}

<div class="diff-wrap" bind:this={wrapEl} style="--diff-font-size: {fontSize}px">
	{#if big}
		<div class="collapse-bar">
			<span>
				{plural(totalLines, 'línea', 'líneas')}
				{#if !expanded && hiddenCount > 0}
					· {plural(hiddenCount, 'tramo sin bloques oculto', 'tramos sin bloques ocultos')}
				{/if}
			</span>
			<button type="button" class="link" onclick={() => onToggleExpand?.()}>
				{expanded ? 'plegar' : 'mostrar diff completo'}
			</button>
		</div>
	{/if}

	<div class="body">
	{#if !hunks.length}
		<p class="empty">Este archivo no trae diff.</p>
	{:else if !visible.length}
		<p class="empty">Los tramos de este archivo no tienen bloques explicados.</p>
	{:else if mode === 'split'}
		<div class="diff">
			{#each viewSegments as seg, si (seg.key)}
				{#if seg.kind === 'gap'}
					{@render gapBar(seg.gap)}
				{:else if seg.built}
					<div class="hunk-header">{seg.headerText}</div>
					<div
						class="split-grid"
						bind:this={gridEls[si]}
						style:grid-template-columns="var(--ln-w) var(--sign-w) minmax(0, {leftFr}fr) var(--divider-w) var(--ln-w) var(--sign-w) minmax(0, {rightFr}fr)"
					>
						{#each seg.built.rows as row, i (i)}
							{@const oldNo = row.left.blank ? null : Number(row.left.no)}
							{@const newNo = row.right.blank ? null : Number(row.right.no)}
							{@const leftBg = cellBg(row.left, 'old', oldNo)}
							{@const rightBg = cellBg(row.right, 'new', newNo)}
							{@const note = noteAt.get(`${seg.key}:${i}`)}
							<div class="srow">
								<span class="ln" style:background={leftBg} style:border-left-color={accentFor('old', oldNo)}
									>{row.left.no}</span
								>
								<span class="sign" class:del={row.left.kind === 'del'} style:background={leftBg}
									>{row.left.kind === 'del' ? '-' : ''}</span
								>
								<span class={['code', row.left.kind]} style:background={leftBg} data-block-id={blockFor('old', oldNo)?.id}
									>{#if !row.left.blank}{@html renderLine(row.left.text, lang, row.left.marks)}{/if}</span
								>
								<span
									class="divider"
									role="separator"
									aria-orientation="vertical"
									tabindex="-1"
									onpointerdown={(e) => onDividerPointerDown(e, si)}
								></span>
								<span class="ln" style:background={rightBg} style:border-left-color={accentFor('new', newNo)}
									>{row.right.no}</span
								>
								<span class="sign" class:add={row.right.kind === 'add'} style:background={rightBg}
									>{row.right.kind === 'add' ? '+' : ''}</span
								>
								<span
									class={['code', row.right.kind, { 'with-note': !!note }]}
									style:background={rightBg}
									data-block-id={blockFor('new', newNo)?.id}
									>{#if !row.right.blank}{@html renderLine(row.right.text, lang, row.right.marks)}{/if}{#if note}{@render blockNote(note)}{/if}</span
								>
							</div>
						{/each}
					</div>
				{/if}
			{/each}
		</div>
	{:else}
		<div class="diff" class:wrap={wrapLines}>
			{#each viewSegments as seg (seg.key)}
				{#if seg.kind === 'gap'}
					{@render gapBar(seg.gap)}
				{:else}
					{@const hunk = seg.hunk}
					<div class="hunk-header">{seg.headerText}</div>
					{#each hunk.lines as line, i (i)}
						{@const side = line.kind === 'del' ? 'old' : 'new'}
						{@const no = side === 'old' ? line.oldNo : line.newNo}
						{@const hl = isHighlighted(side, no)}
						{@const note = noteAt.get(`${seg.key}:${i}`)}
						<div
							class={['row', line.kind]}
							data-block-id={blockFor(side, no)?.id}
							style:background={hl ? 'var(--diff-mark)' : undefined}
							style:border-left-color={accentFor(side, no)}
						>
							<span class="ln">{line.oldNo ?? ''}</span>
							<span class="ln">{line.newNo ?? ''}</span>
							<span class="sign">{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}</span>
							<span class={['code', line.kind]}>{@html renderLine(line.text, lang, line.marks)}</span>
							{#if note}
								<span class="note-slot">{@render blockNote(note)}</span>
							{/if}
						</div>
					{/each}
				{/if}
			{/each}
		</div>
	{/if}
	</div>
</div>

{#if tip?.block.explain}
	{@const ex = tip.block.explain}
	<div
		class={['note-tip', { above: tip.above }]}
		role="tooltip"
		style:left="{tip.x}px"
		style:top="{tip.y}px"
		style:--note-accent={tip.block.accentColor}
	>
		<div class="tip-head">
			<span class="tip-lines">{ex.lines}</span>
			<span class="tip-op">{ex.opLabel}</span>
		</div>
		<p class="tip-what">{ex.what}</p>
		{#if ex.why}
			<p class="tip-why">{ex.why}</p>
		{/if}
	</div>
{/if}

<style>
	/* Columna al final de la fila: sticky para quedar en el borde visible sin sumar alto. */
	.note-slot {
		position: sticky;
		right: 0;
		display: flex;
		align-items: center;
		padding-left: 8px;
		background: var(--bg);
	}

	.row.add .note-slot {
		background: var(--diff-add-bg);
	}

	.row.del .note-slot {
		background: var(--diff-del-bg);
	}

	.block-note {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		padding: 0;
		border: 0;
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--bg) 72%, transparent);
		color: var(--note-accent, var(--accent));
		cursor: help;
	}

	.block-note:hover,
	.block-note:focus-visible {
		color: var(--text);
		background: var(--bg-card);
	}

	.block-note:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	/* En split la grilla no admite una columna extra: el ícono flota sobre el código. */
	.split-grid .code {
		position: relative;
	}

	.split-grid .code.with-note {
		padding-right: 24px;
	}

	.split-grid .block-note {
		position: absolute;
		top: 0;
		right: 4px;
		bottom: 0;
		margin: auto 0;
	}

	.note-tip {
		position: fixed;
		z-index: 200;
		width: max-content;
		max-width: min(380px, calc(100vw - 24px));
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-left: 3px solid var(--note-accent, var(--accent));
		border-radius: var(--radius);
		background: var(--bg-card);
		box-shadow: 0 10px 28px color-mix(in srgb, #000 24%, transparent);
		pointer-events: none;
	}

	.note-tip.above {
		transform: translateY(-100%);
	}

	.tip-head {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 4px;
		font-size: 10.5px;
		color: var(--text-faint);
	}

	.tip-lines {
		font-family: var(--mono);
	}

	.tip-what {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--text);
	}

	.tip-why {
		margin: 6px 0 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--text-dim);
	}

	.diff-wrap {
		background: var(--bg);
		/* Columnas de numeración y signo: lo mínimo para 5 dígitos, pegadas al borde. */
		--ln-w: calc(var(--diff-font-size, 11.5px) * 3.1);
		--sign-w: calc(var(--diff-font-size, 11.5px) * 1.05);
		--divider-w: 5px;
	}

	.collapse-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
		padding: 5px 10px;
		background: var(--diff-hunk-bg);
		border-bottom: 1px solid var(--border-soft);
		font-size: 10.5px;
		color: var(--text-faint);
	}

	.link {
		background: transparent;
		border: 0;
		padding: 0;
		color: var(--accent);
		font-size: 10.5px;
		text-decoration: underline;
	}

	.gap-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 3px 10px;
		background: var(--diff-hunk-bg);
		border-top: 1px solid var(--border-soft);
		border-bottom: 1px solid var(--border-soft);
	}

	.gap-actions {
		display: flex;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
		flex-shrink: 0;
	}

	.gap-actions button {
		background: var(--bg-card);
		border: 0;
		padding: 1px 8px;
		font-family: var(--mono);
		font-size: calc(var(--diff-font-size, 11.5px) * 0.87);
		line-height: 1.5;
		color: var(--text-dim);
	}

	.gap-actions button + button {
		border-left: 1px solid var(--border);
	}

	.gap-actions button:hover:not(:disabled) {
		background: var(--accent-soft);
		color: var(--text);
	}

	.gap-actions button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.gap-info {
		font-family: var(--mono);
		font-size: calc(var(--diff-font-size, 11.5px) * 0.87);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Horizontal siempre: si la columna se achica, no apilar letra a letra. */
	.empty {
		margin: 0;
		padding: 20px 16px;
		font-size: 13px;
		line-height: 1.45;
		color: var(--text-dim);
		text-align: center;
		writing-mode: horizontal-tb;
		white-space: normal;
		word-break: normal;
		overflow-wrap: break-word;
		min-width: min(100%, 14rem);
		box-sizing: border-box;
	}

	.diff,
	.hunk-header {
		font-family: var(--mono);
	}

	/*
	 * El scrollbar horizontal nativo queda pegado al borde inferior de ESTA caja, no al
	 * final del contenido. Sin `max-height`, la caja crece con el contenido y el scrollbar
	 * termina fuera de la pantalla hasta scrollear la página entera. Con el tope, la caja
	 * nunca crece más que eso: si el contenido entra, no pasa nada; si no entra, scrollea
	 * adentro y el scrollbar horizontal queda siempre a la vista en el borde de la caja.
	 */
	.diff {
		overflow-x: auto;
		overflow-y: auto;
		max-height: 55vh;
		font-size: var(--diff-font-size, 11.5px);
	}

	/* Ajuste de línea (solo unificado): las filas dejan de forzar su ancho al contenido y el código pasa a cortar. */
	.diff.wrap {
		overflow-x: hidden;
	}

	.diff.wrap .row {
		width: auto;
		min-width: 0;
	}

	.diff.wrap .code {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.hunk-header {
		padding: 3px 10px;
		background: var(--diff-hunk-bg);
		border-top: 1px solid var(--border-soft);
		border-bottom: 1px solid var(--border-soft);
		font-size: calc(var(--diff-font-size, 11.5px) * 0.913);
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.row {
		display: grid;
		grid-template-columns: var(--ln-w) var(--ln-w) var(--sign-w) auto auto;
		border-left: 2px solid transparent;
		width: max-content;
		min-width: 100%;
	}

	/*
	 * Las dos mitades del split viven en la MISMA grilla: cada fila ocupa una sola fila de
	 * grilla, así que los dos lados quedan alineados solos aunque el código ajuste en varias
	 * líneas visuales. Sin alto fijo ni scroll que sincronizar.
	 */
	.split-grid {
		display: grid;
		align-items: stretch;
	}

	.srow {
		display: contents;
	}

	.divider {
		background: var(--border-soft);
		cursor: col-resize;
		touch-action: none;
	}

	.divider:hover,
	.divider:active {
		background: var(--accent);
	}

	.split-grid .code {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.ln {
		text-align: right;
		padding-right: 6px;
		border-left: 2px solid transparent;
		color: var(--diff-gutter);
		font-size: calc(var(--diff-font-size, 11.5px) * 0.87);
		user-select: none;
		font-variant-numeric: tabular-nums;
		overflow: hidden;
	}

	.row .ln {
		border-left: 0;
	}

	.sign {
		text-align: center;
		user-select: none;
		color: var(--text-faint);
	}

	.sign.add {
		color: var(--diff-add-fg);
	}

	.sign.del {
		color: var(--diff-del-fg);
	}

	.code {
		white-space: pre;
		padding-right: 10px;
	}

	.row.add {
		background: var(--diff-add-bg);
	}

	.row.add .sign {
		color: var(--diff-add-fg);
	}

	.row.del {
		background: var(--diff-del-bg);
	}

	.row.del .sign {
		color: var(--diff-del-fg);
	}
</style>
