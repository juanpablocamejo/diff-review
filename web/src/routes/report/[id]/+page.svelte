<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
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

	$effect(() => {
		report = loadReportById(params.id);
	});

	function download() {
		if (!report) return;
		const blob = new Blob([JSON.stringify(report.document, null, 2)], { type: 'application/json;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${(report.meta.branch || 'reporte').replace(/[^a-z0-9.-]+/gi, '-')}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}

	function remove() {
		if (!report) return;
		deleteReport(report.id);
		void goto(resolve('/'));
	}
</script>

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
				<button type="button" class="ghost" onclick={download}>Descargar JSON</button>
				<button type="button" class="ghost danger" onclick={remove}>Eliminar</button>
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

	.ghost.danger {
		color: var(--danger);
	}

	.hint {
		padding: 40px 28px;
		color: var(--text-faint);
		font-size: 13px;
	}
</style>
