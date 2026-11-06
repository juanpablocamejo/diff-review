<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { downloadReport, type ExportFormat } from '$lib/report/export';
	import { agentShortName, reportAgentId } from '$lib/report/agent-icons';
	import { acpAgents } from '$lib/report/agent.remote';
	import type { AcpAgentOption } from '$lib/report/agent-events';
	import ChatPanel from '$lib/report/ChatPanel.svelte';
	import ReportView from '$lib/report/ReportView.svelte';
	import { resolveSavedReport } from '$lib/report/resolve-report';
	import { deleteReport } from '$lib/report/storage';
	import type { SavedReport } from '$lib/report/types';
	import ThemeToggle from '$lib/ThemeToggle.svelte';

	let { params }: { params: { id: string } } = $props();

	const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

	let report = $state<SavedReport | null | undefined>(undefined);
	let loadError = $state('');
	let diffMode = $state<'unified' | 'split'>('unified');
	let diffFontSize = $state(11.5);
	let wrapLines = $state(true);
	// Paneles laterales: viven acá con el resto de los controles de vista del header.
	let sidebarCollapsed = $state(false);
	let showExplanations = $state(true);
	let downloadOpen = $state(false);
	let kebabOpen = $state(false);
	let viewMenuOpen = $state(false);
	let chatOpen = $state(false);
	/** Agentes ACP instalados: para no mostrar Cursor/Claude en el header si no están. */
	let installedAgents = $state<AcpAgentOption[]>([]);
	/** Borrador para el compositor del ChatPanel (referencia a tema/bloque/hallazgo); no se envía solo. */
	let pendingAsk = $state<string | null>(null);
	/** Prompt de corrección para auto-enviar en modo fix. */
	let pendingFix = $state<{ text: string; autoSend?: boolean; findingIds?: string[] } | null>(null);
	/** Resumen del agente tras un turno fix exitoso → ReportView marca Corregido. */
	let pendingFixApplied = $state<{ findingIds: string[]; summary: string } | null>(null);

	$effect(() => {
		const id = params.id;
		let cancelled = false;
		report = undefined;
		loadError = '';
		downloadOpen = false;
		kebabOpen = false;
		void resolveSavedReport(id)
			.then((resolved) => {
				if (cancelled) return;
				report = resolved;
				if (!resolved) {
					loadError =
						'No se encontró el reporte en disco ni en este navegador. Revisá que el JSON siga en .diff-review/.';
				}
			})
			.catch((err) => {
				if (cancelled) return;
				report = null;
				loadError = err instanceof Error ? err.message : String(err);
			});
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		let cancelled = false;
		void acpAgents()
			.then((agents) => {
				if (!cancelled) installedAgents = agents;
			})
			.catch(() => {
				if (!cancelled) installedAgents = [];
			});
		return () => {
			cancelled = true;
		};
	});

	function closeMenus() {
		downloadOpen = false;
		kebabOpen = false;
		viewMenuOpen = false;
	}

	function toggleDownload() {
		downloadOpen = !downloadOpen;
		kebabOpen = false;
		viewMenuOpen = false;
	}

	function toggleKebab() {
		kebabOpen = !kebabOpen;
		downloadOpen = false;
		viewMenuOpen = false;
	}

	function toggleViewMenu() {
		viewMenuOpen = !viewMenuOpen;
		downloadOpen = false;
		kebabOpen = false;
	}

	function exportAs(format: ExportFormat) {
		if (!report) return;
		downloadOpen = false;
		downloadReport(report, format);
	}

	function remove() {
		if (!report) return;
		const label = report.meta.branch || 'este reporte';
		if (!confirm(`¿Eliminar “${label}”? No se puede deshacer.`)) return;
		deleteReport(report.id);
		void goto(resolve('/'));
	}

	function askAbout(draft: string) {
		pendingFix = null;
		pendingAsk = draft;
		chatOpen = true;
	}

	/** Abre el chat en Corregir código. `false` si no hay agente ACP → el footer muestra Copiar prompt. */
	async function fixWithAgent(text: string, findingIds: string[] = []): Promise<boolean> {
		if (!report || !text.trim()) return false;
		try {
			const agents = await acpAgents();
			if (!agents.length && !report.meta.agentSession?.agentId) {
				console.warn('No hay agente ACP disponible; fallback a copiar prompt');
				return false;
			}
		} catch (err) {
			console.warn('Error al verificar agente ACP:', err);
			if (!report.meta.agentSession?.agentId) return false;
		}
		pendingAsk = null;
		pendingFix = { text, autoSend: true, findingIds };
		chatOpen = true;
		return true;
	}

	/**
	 * Agente del botón del header: sesión ACP, o provenance de meta si ese agente
	 * sigue instalado. Si hay que elegir → id vacío y label "Agente".
	 */
	const chatAgentId = $derived.by(() => {
		if (!report) return '';
		const preferred = reportAgentId(report.meta);
		if (!preferred) return '';
		if (report.meta.agentSession?.agentId) return preferred;
		if (!installedAgents.length) return preferred;
		return installedAgents.some((a) => a.id === preferred) ? preferred : '';
	});
	const chatAgentName = $derived(agentShortName(chatAgentId, report?.meta.agent || ''));
</script>

<svelte:window
	onclick={() => {
		if (downloadOpen || kebabOpen || viewMenuOpen) closeMenus();
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
				<span
					class="breadcrumb"
					title={`${report.meta.branch || '—'} › ${report.meta.base || 'develop'}`}
				>
					<span class="crumb-branch">{report.meta.branch || '—'}</span>
					<span class="crumb-sep">›</span>
					<span class="crumb-base">{report.meta.base || 'develop'}</span>
				</span>
				{#if report.meta.agent || report.meta.model}
					<span class="chrome-divider chrome-divider-prov"></span>
					<span
						class="provenance"
						title={[report.meta.agent, report.meta.model].filter(Boolean).join(' · ')}
					>
						{#if report.meta.agent}<span class="prov-agent">{report.meta.agent}</span>{/if}
						{#if report.meta.agent && report.meta.model}<span class="prov-sep">·</span>{/if}
						{#if report.meta.model}<span class="prov-model">{report.meta.model}</span>{/if}
					</span>
				{/if}
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
			<div class="chrome-center chrome-center-inline">
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
						aria-label="Achicar letra del diff"
						onclick={() => (diffFontSize = clamp(diffFontSize - 1, 9, 20))}>－</button
					>
					<span class="zoom-label">{Math.round(diffFontSize)}px</span>
					<button
						type="button"
						class="icon-btn"
						title="Agrandar letra del diff"
						aria-label="Agrandar letra del diff"
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
					aria-label={diffMode === 'split'
						? 'En lado a lado el código siempre ajusta'
						: wrapLines
							? 'Desactivar ajuste de línea'
							: 'Ajustar líneas largas'}
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
					aria-label={sidebarCollapsed ? 'Mostrar menú' : 'Ocultar menú'}
					onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
				>
					◧
				</button>
				<button
					type="button"
					class="icon-btn panel"
					class:on={showExplanations}
					title={showExplanations ? 'Ocultar detalle' : 'Mostrar detalle'}
					aria-label={showExplanations ? 'Ocultar detalle' : 'Mostrar detalle'}
					onclick={() => (showExplanations = !showExplanations)}
				>
					◨
				</button>
			</div>
		{/if}

		<div class="chrome-right">
			{#if report}
				<div class="menu-wrap chrome-view-menu">
					<button
						type="button"
						class="ghost view-menu-btn"
						title="Controles de vista"
						aria-label="Controles de vista"
						aria-expanded={viewMenuOpen}
						aria-haspopup="menu"
						onclick={(e) => {
							e.stopPropagation();
							toggleViewMenu();
						}}
					>
						Vista
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
					{#if viewMenuOpen}
						<div class="menu view-menu" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()}>
							<button
								type="button"
								class="menu-item"
								class:on={diffMode === 'unified'}
								role="menuitem"
								onclick={() => (diffMode = 'unified')}
							>
								Unificado
							</button>
							<button
								type="button"
								class="menu-item"
								class:on={diffMode === 'split'}
								role="menuitem"
								onclick={() => (diffMode = 'split')}
							>
								Lado a lado
							</button>
							<div class="view-menu-sep" role="separator"></div>
							<div class="view-menu-row" role="group" aria-label="Tamaño de letra">
								<button
									type="button"
									class="icon-btn"
									title="Achicar letra del diff"
									aria-label="Achicar letra del diff"
									onclick={() => (diffFontSize = clamp(diffFontSize - 1, 9, 20))}>－</button
								>
								<span class="zoom-label">{Math.round(diffFontSize)}px</span>
								<button
									type="button"
									class="icon-btn"
									title="Agrandar letra del diff"
									aria-label="Agrandar letra del diff"
									onclick={() => (diffFontSize = clamp(diffFontSize + 1, 9, 20))}>＋</button
								>
							</div>
							<button
								type="button"
								class="menu-item"
								class:on={wrapLines}
								role="menuitem"
								disabled={diffMode === 'split'}
								onclick={() => (wrapLines = !wrapLines)}
							>
								{wrapLines ? 'Sin ajuste de línea' : 'Ajustar líneas'}
							</button>
							<div class="view-menu-sep" role="separator"></div>
							<button
								type="button"
								class="menu-item"
								class:on={!sidebarCollapsed}
								role="menuitem"
								onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
							>
								{sidebarCollapsed ? 'Mostrar menú' : 'Ocultar menú'}
							</button>
							<button
								type="button"
								class="menu-item"
								class:on={showExplanations}
								role="menuitem"
								onclick={() => (showExplanations = !showExplanations)}
							>
								{showExplanations ? 'Ocultar detalle' : 'Mostrar detalle'}
							</button>
						</div>
					{/if}
				</div>
				<button
					type="button"
					class="ghost chat-btn"
					class:on={chatOpen}
					title="Chat con el agente"
					aria-label="Chat con el agente"
					aria-pressed={chatOpen}
					onclick={() => (chatOpen = !chatOpen)}
				>
					<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
						<path
							d="M2.5 3.25h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.2L4 13.75V11.25H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"
							fill="none"
							stroke="currentColor"
							stroke-width="1.35"
							stroke-linejoin="round"
						/>
					</svg>
				</button>
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
		<div class="empty-state">
			<p class="hint">Cargando reporte…</p>
		</div>
	{:else if report === null}
		<div class="empty-state">
			<p class="hint">
				{loadError ||
					'No se encontró este reporte. Los locales se leen desde .diff-review/; sin ese archivo no hay viewer.'}
			</p>
			<p class="hint"><a href={resolve('/')}>Volver al inicio</a>.</p>
		</div>
	{:else}
		<div class="body" class:chat-open={chatOpen}>
			<ReportView
				{report}
				{diffMode}
				{diffFontSize}
				{wrapLines}
				{sidebarCollapsed}
				{showExplanations}
				{pendingFixApplied}
				onpendingfixappliedconsumed={() => (pendingFixApplied = null)}
				onask={askAbout}
				onfixwithagent={fixWithAgent}
				onreportupdated={(updated) => (report = updated)}
			/>
			{#if chatOpen}
				<ChatPanel
					{report}
					{pendingAsk}
					onpendingaskconsumed={() => (pendingAsk = null)}
					{pendingFix}
					onpendingfixconsumed={() => (pendingFix = null)}
					onfixapplied={(payload) => (pendingFixApplied = payload)}
					onclose={() => (chatOpen = false)}
					onreportupdated={(updated) => (report = updated)}
				/>
			{/if}
		</div>
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

	.body {
		flex: 1;
		min-height: 0;
		display: flex;
	}

	.body > :global(.report-shell) {
		flex: 1;
		min-width: 0;
	}

	.ghost.on {
		background: var(--accent-soft);
		border-color: var(--accent);
	}

	.chrome {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		gap: 12px 16px;
		padding: 12px 28px;
		border-bottom: 1px solid var(--border);
		background: var(--header-bg);
		flex-shrink: 0;
		min-width: 0;
	}

	.chrome-left {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		flex: 1 1 0;
		overflow: hidden;
	}

	.chrome-center {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 0 0 auto;
	}

	.chrome-right {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 0 0 auto;
		margin-left: auto;
	}

	.chrome-view-menu {
		display: none;
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
		max-width: min(220px, 28vw);
		overflow: hidden;
	}

	.crumb-branch {
		color: var(--text);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.crumb-sep {
		color: var(--text-dim);
		flex-shrink: 0;
	}

	.crumb-base {
		color: var(--text-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex-shrink: 1;
		min-width: 0;
	}

	.provenance {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: min(160px, 18vw);
		overflow: hidden;
		font-size: 12px;
		color: var(--text-dim);
		flex-shrink: 1;
	}

	.prov-agent {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.prov-sep {
		color: var(--text-dim);
		flex-shrink: 0;
	}

	.prov-model {
		font-family: var(--mono);
		font-size: 11.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
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
		padding: 4px;
		display: flex;
		flex-direction: column;
		gap: 0;
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

	/*
	 * Hit-box = caja visible: overflow hidden evita que el texto del ítem anterior
	 * capture el pointer sobre el siguiente (hover “atrasado”).
	 */
	.download-menu button.menu-item {
		box-sizing: border-box;
		position: relative;
		z-index: 0;
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin: 0;
		padding: 0 10px;
		min-height: 44px;
		height: 44px;
		border: 0;
		border-radius: 2px;
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
		overflow: hidden;
	}

	.download-menu button.menu-item:hover {
		z-index: 1;
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
		line-height: 1.2;
		flex-shrink: 0;
	}

	.menu-item .hint {
		font-size: 10.5px;
		line-height: 1.2;
		color: var(--text-faint);
	}

	.download-menu .menu-item .fmt,
	.download-menu .menu-item .hint {
		pointer-events: none;
	}

	.download-menu .menu-item .hint {
		font-size: 10px;
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
		width: 40px;
		height: 40px;
		min-width: 40px;
		min-height: 40px;
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
		color: var(--text-dim);
		width: 30px;
		text-align: center;
	}

	.view-menu-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.view-menu {
		left: auto;
		right: 0;
		min-width: 200px;
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.view-menu .menu-item.on {
		background: var(--accent-soft);
		color: var(--text);
	}

	.view-menu-sep {
		height: 1px;
		margin: 4px 0;
		background: var(--border-soft);
	}

	.view-menu-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 6px 4px;
	}

	.ghost {
		background: var(--bg-card);
		border: 1px solid var(--border);
		padding: 7px 12px;
		font-size: 12.5px;
		color: var(--text);
	}

	.chat-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		padding: 0;
	}

	.chat-btn.on {
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
		background: var(--accent-soft, color-mix(in srgb, var(--accent) 10%, transparent));
		color: var(--accent);
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
		padding: 0;
		margin: 0;
		color: var(--text-dim);
		font-size: 13px;
		line-height: 1.5;
		max-width: 36rem;
	}

	.empty-state {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 40px 28px;
		text-align: center;
	}

	.empty-state a {
		color: var(--accent);
	}

	@media (max-width: 1100px) {
		.chrome-center-inline {
			display: none;
		}

		.chrome-view-menu {
			display: block;
		}

		.provenance {
			max-width: min(120px, 22vw);
		}

		.breadcrumb {
			max-width: min(160px, 30vw);
		}
	}

	@media (max-width: 768px) {
		.chrome {
			flex-wrap: wrap;
			padding: 10px 14px;
			gap: 8px 10px;
		}

		.chrome-left {
			flex: 1 1 calc(100% - 80px);
			order: 1;
		}

		.chrome-right {
			flex: 1 1 100%;
			order: 2;
			margin-left: 0;
			justify-content: flex-end;
			flex-wrap: wrap;
		}

		.chrome-divider-prov,
		.provenance {
			display: none;
		}

		.breadcrumb {
			max-width: min(200px, 45vw);
		}

		.body.chat-open > :global(.report-shell) {
			/* El chat pasa a overlay a pantalla completa (ver ChatPanel). */
			visibility: hidden;
			pointer-events: none;
		}
	}
</style>
