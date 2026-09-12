<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { downloadReport, type ExportFormat, type ExportMode } from '$lib/report/export';
	import ReportView from '$lib/report/ReportView.svelte';
	import { deleteReport, loadReportById } from '$lib/report/storage';
	import type { SavedReport } from '$lib/report/types';
	import ThemeToggle from '$lib/ThemeToggle.svelte';

	let { params }: { params: { id: string } } = $props();

	const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

	let report = $state<SavedReport | null | undefined>(undefined);
	let diffMode = $state<'unified' | 'split'>('unified');
	let diffFontSize = $state(11.5);
	let wrapLines = $state(true);
	// Paneles laterales: viven acá con el resto de los controles de vista del header.
	let sidebarCollapsed = $state(false);
	let showExplanations = $state(true);
	let downloadOpen = $state(false);
	let kebabOpen = $state(false);
	let exportMode = $state<ExportMode>('full');

	$effect(() => {
		report = loadReportById(params.id);
		downloadOpen = false;
		kebabOpen = false;
	});

	function closeMenus() {
		downloadOpen = false;
		kebabOpen = false;
	}

	function toggleDownload() {
		downloadOpen = !downloadOpen;
		kebabOpen = false;
	}

	function toggleKebab() {
		kebabOpen = !kebabOpen;
		downloadOpen = false;
	}

	function exportAs(format: ExportFormat) {
		if (!report) return;
		downloadOpen = false;
		downloadReport(report, format, { mode: exportMode });
	}

	function remove() {
		if (!report) return;
		const label = report.meta.branch || 'este reporte';
		if (!confirm(`¿Eliminar “${label}”? No se puede deshacer.`)) return;
		deleteReport(report.id);
		void goto(resolve('/'));
	}
</script>

<svelte:window
	onclick={() => {
		if (downloadOpen || kebabOpen) closeMenus();
	}}
	onkeydown={(e) => {
		if (e.key === 'Escape') closeMenus();
	}}
/>

<div class="page">
	<header class="chrome">
		<div class="chrome-left">
			<a href={resolve('/')} class="brand">
				<span class="brand-dot"></span>
				<span>diff-review</span>
			</a>
			{#if report}
				<span class="chrome-divider"></span>
				<span class="breadcrumb">
					<span class="crumb-branch">{report.meta.branch || '—'}</span>
					<span class="crumb-sep">›</span>
					<span class="crumb-base">{report.meta.base || 'develop'}</span>
				</span>
				<div class="menu-wrap">
					<button
						type="button"
						class="icon-btn kebab"
						title="Más acciones"
						aria-label="Más acciones"
						aria-expanded={kebabOpen}
						aria-haspopup="menu"
						onclick={(e) => {
							e.stopPropagation();
							toggleKebab();
						}}
					>
						<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
							<circle cx="8" cy="3.5" r="1.25" fill="currentColor" />
							<circle cx="8" cy="8" r="1.25" fill="currentColor" />
							<circle cx="8" cy="12.5" r="1.25" fill="currentColor" />
						</svg>
					</button>
					{#if kebabOpen}
						<div class="menu" role="menu" tabindex="-1">
							<button type="button" class="menu-item danger" role="menuitem" onclick={remove}>
								Eliminar reporte…
							</button>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		{#if report}
			<div class="chrome-center">
				<div class="mode-toggle">
					<button type="button" class:on={diffMode === 'unified'} onclick={() => (diffMode = 'unified')}
						>Unificado</button
					>
					<button type="button" class:on={diffMode === 'split'} onclick={() => (diffMode = 'split')}
						>Lado a lado</button
					>
				</div>
				<div class="zoom">
					<button
						type="button"
						class="icon-btn"
						title="Achicar letra del diff"
						onclick={() => (diffFontSize = clamp(diffFontSize - 1, 9, 20))}>－</button
					>
					<span class="zoom-label">{Math.round(diffFontSize)}px</span>
					<button
						type="button"
						class="icon-btn"
						title="Agrandar letra del diff"
						onclick={() => (diffFontSize = clamp(diffFontSize + 1, 9, 20))}>＋</button
					>
				</div>
				<button
					type="button"
					class="icon-btn"
					class:on={wrapLines}
					disabled={diffMode === 'split'}
					title={diffMode === 'split'
						? 'En lado a lado el código siempre ajusta'
						: wrapLines
							? 'Desactivar ajuste de línea (volver a scroll horizontal)'
							: 'Ajustar líneas largas en vez de scrollear horizontalmente'}
					onclick={() => (wrapLines = !wrapLines)}
				>
					↵
				</button>
				<span class="chrome-divider"></span>
				<button
					type="button"
					class="icon-btn panel"
					class:on={!sidebarCollapsed}
					title={sidebarCollapsed ? 'Mostrar menú' : 'Ocultar menú'}
					onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
				>
					◧
				</button>
				<button
					type="button"
					class="icon-btn panel"
					class:on={showExplanations}
					title={showExplanations ? 'Ocultar detalle' : 'Mostrar detalle'}
					onclick={() => (showExplanations = !showExplanations)}
				>
					◨
				</button>
			</div>
		{/if}

		<div class="chrome-right">
			{#if report}
				<div class="menu-wrap">
					<button
						type="button"
						class="ghost download-btn"
						aria-expanded={downloadOpen}
						aria-haspopup="menu"
						onclick={(e) => {
							e.stopPropagation();
							toggleDownload();
						}}
					>
						<svg class="dl-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
							<path
								d="M8 2.5v7.2M5.2 7.2 8 10l2.8-2.8M3.5 12.5h9"
								fill="none"
								stroke="currentColor"
								stroke-width="1.5"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
						Descargar
						<svg class="caret" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
							<path
								d="M2.5 4.5 6 8l3.5-3.5"
								fill="none"
								stroke="currentColor"
								stroke-width="1.5"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
					{#if downloadOpen}
						<div class="menu download-menu" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()}>
							<div class="menu-mode" role="group" aria-label="Modo de exportación">
								<button
									type="button"
									class:on={exportMode === 'summary'}
									onclick={() => (exportMode = 'summary')}>Resumen</button
								>
								<button
									type="button"
									class:on={exportMode === 'full'}
									onclick={() => (exportMode = 'full')}>Completo</button
								>
							</div>
							<p class="menu-mode-hint">
								{exportMode === 'full'
									? 'Incluye snippets de diff por hallazgo (MD / HTML / PDF).'
									: 'Solo texto e intención, sin diffs.'}
							</p>
							<button type="button" class="menu-item" role="menuitem" onclick={() => exportAs('json')}>
								<span class="fmt">JSON</span>
								<span class="hint">para volver a importar</span>
							</button>
							<button type="button" class="menu-item" role="menuitem" onclick={() => exportAs('md')}>
								<span class="fmt">Markdown</span>
								<span class="hint">para leer / pegar</span>
							</button>
							<button type="button" class="menu-item" role="menuitem" onclick={() => exportAs('html')}>
								<span class="fmt">HTML</span>
								<span class="hint">página autocontenida</span>
							</button>
							<button type="button" class="menu-item" role="menuitem" onclick={() => exportAs('pdf')}>
								<span class="fmt">PDF</span>
								<span class="hint">imprimir / guardar</span>
							</button>
						</div>
					{/if}
				</div>
			{/if}
			<ThemeToggle />
		</div>
	</header>

	{#if report === undefined}
		<p class="hint">Cargando…</p>
	{:else if report === null}
		<p class="hint">No se encontró este reporte en este navegador. Los reportes viven en localStorage, así que no se comparten entre dispositivos.</p>
	{:else}
		<ReportView {report} {diffMode} {diffFontSize} {wrapLines} {sidebarCollapsed} {showExplanations} />
	{/if}
</div>

<style>
	.page {
		height: 100vh;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--bg);
	}

	.chrome {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		gap: 16px;
		padding: 12px 28px;
		border-bottom: 1px solid var(--border);
		background: var(--header-bg);
		flex-shrink: 0;
	}

	.chrome-left {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
		justify-self: start;
	}

	.chrome-center {
		display: flex;
		align-items: center;
		gap: 10px;
		justify-self: center;
	}

	.chrome-right {
		display: flex;
		align-items: center;
		gap: 10px;
		justify-self: end;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		font-weight: 700;
		font-size: 15px;
		text-decoration: none;
		color: var(--text);
		flex-shrink: 0;
	}

	.brand-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: linear-gradient(135deg, #6ea8fe, #c9a5ff);
		box-shadow: 0 0 12px #6ea8fe88;
		flex-shrink: 0;
	}

	.chrome-divider {
		width: 1px;
		height: 18px;
		background: var(--border);
		flex-shrink: 0;
	}

	.breadcrumb {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--mono);
		font-size: 12.5px;
		min-width: 0;
	}

	.crumb-branch {
		color: var(--text);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.crumb-sep {
		color: var(--text-faint);
	}

	.crumb-base {
		color: var(--text-faint);
		white-space: nowrap;
	}

	.menu-wrap {
		position: relative;
		flex-shrink: 0;
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 40;
		min-width: 180px;
		padding: 4px;
		border: 1px solid var(--border);
		background: var(--bg-card);
		box-shadow: 0 8px 24px color-mix(in srgb, #000 18%, transparent);
	}

	.download-menu {
		left: auto;
		right: 0;
		min-width: 220px;
		padding: 2px;
	}

	.menu-mode {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0;
		margin: 1px 1px 2px;
		border: 1px solid var(--border);
	}

	.menu-mode button {
		border: 0;
		background: transparent;
		color: var(--text-dim);
		font-size: 11px;
		font-weight: 600;
		padding: 3px 8px;
		line-height: 1.15;
		min-height: 0;
		appearance: none;
	}

	.menu-mode button + button {
		border-left: 1px solid var(--border);
	}

	.menu-mode button.on {
		background: var(--accent-soft);
		color: var(--text);
	}

	.menu-mode-hint {
		margin: 0 6px 2px;
		font-size: 10px;
		color: var(--text-faint);
		line-height: 1.25;
	}

	.menu-item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0;
		width: 100%;
		padding: 4px 8px;
		border: 0;
		background: transparent;
		color: var(--text);
		font-size: 12px;
		line-height: 1.25;
		text-align: left;
		cursor: pointer;
	}

	/* Altura fija + hover con la misma especificidad que el fondo base. */
	.download-menu button.menu-item {
		box-sizing: border-box;
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin: 0;
		padding: 0 10px;
		min-height: 0;
		height: 44px;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 12px;
		font-weight: 400;
		line-height: 1.2;
		letter-spacing: normal;
		text-align: left;
		cursor: pointer;
		appearance: none;
		-webkit-appearance: none;
	}

	.download-menu button.menu-item:hover {
		background: var(--accent-soft);
	}

	.menu-item:hover {
		background: var(--accent-soft);
	}

	.menu-item.danger {
		color: var(--danger);
	}

	.menu-item .fmt {
		font-weight: 600;
		line-height: 1;
		flex-shrink: 0;
	}

	.menu-item .hint {
		font-size: 10.5px;
		line-height: 1;
		color: var(--text-faint);
	}

	.download-menu .menu-item .hint {
		font-size: 10px;
		line-height: 1;
		text-align: right;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.mode-toggle {
		display: flex;
		border: 1px solid var(--border);
		overflow: hidden;
	}

	.mode-toggle button {
		padding: 6px 12px;
		font-size: 12px;
		border: 0;
		white-space: nowrap;
		background: transparent;
		color: var(--text);
	}

	.mode-toggle button + button {
		border-left: 1px solid var(--border);
	}

	.mode-toggle button.on {
		background: var(--accent-soft);
	}

	.zoom {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.icon-btn {
		background: var(--bg-card);
		border: 1px solid var(--border);
		width: 26px;
		height: 26px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		font-size: 13px;
		color: var(--text-dim);
	}

	.icon-btn:hover {
		border-color: var(--accent);
		color: var(--text);
	}

	.icon-btn.on {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--text);
	}

	.icon-btn.kebab {
		width: 24px;
		height: 24px;
		border-color: transparent;
		background: transparent;
	}

	.icon-btn.kebab:hover {
		border-color: var(--border);
		background: var(--bg-card);
	}

	/* Los glifos de panel dibujan medio cuadrado: a 13px no se distinguen entre sí. */
	.icon-btn.panel {
		font-size: 15px;
	}

	.icon-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.zoom-label {
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--text-faint);
		width: 30px;
		text-align: center;
	}

	.ghost {
		background: var(--bg-card);
		border: 1px solid var(--border);
		padding: 7px 12px;
		font-size: 12.5px;
		color: var(--text);
	}

	.download-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.download-btn .caret {
		opacity: 0.7;
	}

	.hint {
		padding: 40px 28px;
		color: var(--text-faint);
		font-size: 13px;
	}
</style>
