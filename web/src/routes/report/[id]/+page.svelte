<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { acpAgents } from '$lib/report/agent.remote';
	import AgentIcon from '$lib/report/AgentIcon.svelte';
	import { agentShortName, reportAgentId } from '$lib/report/agent-icons';
	import ChatPanel from '$lib/report/ChatPanel.svelte';
	import ExportDialog from '$lib/report/ExportDialog.svelte';
	import ReportView from '$lib/report/ReportView.svelte';
	import { resolveSavedReport } from '$lib/report/resolve-report';
	import { deleteReport } from '$lib/report/storage';
	import type { SavedReport } from '$lib/report/types';
	import BrandMark from '$lib/BrandMark.svelte';
	import Icon from '$lib/Icon.svelte';
	import ThemeToggle from '$lib/ThemeToggle.svelte';
	import { untrack } from 'svelte';

	/** Short repo label: basename of a local path or last URL segment, without `.git`. */
	function repoDisplayName(repo: string): string {
		const raw = String(repo || '').trim();
		if (!raw) return '—';
		const cleaned = raw.replace(/[\\/]+$/, '').replace(/\.git$/i, '');
		const parts = cleaned.split(/[\\/]/).filter(Boolean);
		return parts.at(-1) || cleaned || '—';
	}

	/** Branches largos: conservar prefijo (`feat/`) y final, que es lo que los distingue. */
	function middleEllipsis(text: string, max: number): string {
		if (text.length <= max) return text;
		const keep = max - 1;
		const head = Math.ceil(keep * 0.4);
		return `${text.slice(0, head)}…${text.slice(-(keep - head))}`;
	}

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
	/** Borrador para el compositor del ChatPanel (referencia a tema/bloque/hallazgo); no se envía solo. */
	let pendingAsk = $state<string | null>(null);
	/** Prompt de corrección para auto-enviar en modo fix. */
	let pendingFix = $state<{ text: string; autoSend?: boolean; findingIds?: string[] } | null>(null);
	/** Resumen del agente tras un turno fix exitoso → ReportView marca Corregido. */
	let pendingFixApplied = $state<{ findingIds: string[]; summary: string } | null>(null);

	$effect(() => {
		const id = params.id;
		// Solo trackea `params.id`. Si ya mostramos ese reporte (p. ej. tras onreportupdated), no reiniciar.
		if (untrack(() => report)?.id === id) return;
		let cancelled = false;
		report = undefined;
		loadError = '';
		downloadOpen = false;
		kebabOpen = false;
		// CRITICAL: resolveSavedReport → loadDetectedOutput/hydrateFromGit are SvelteKit
		// `command()`s. Invoking a command sync does `pending_count++` ($state read+write).
		// Without untrack, this effect subscribes to that counter → effect_update_depth_exceeded.
		untrack(() => {
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

	function openExportDialog() {
		if (!report) return;
		downloadOpen = true;
		kebabOpen = false;
		viewMenuOpen = false;
	}

	function remove() {
		if (!report) return;
		const label = report.meta.branch || 'este reporte';
		if (!confirm(`¿Eliminar “${label}”? No se puede deshacer.`)) return;
		deleteReport(report.id);
		void goto(resolve('/'));
	}

	function openAgentDrawer() {
		chatOpen = true;
	}

	function closeAgentDrawer() {
		chatOpen = false;
	}

	function askAbout(draft: string) {
		pendingFix = null;
		pendingAsk = draft;
		openAgentDrawer();
	}

	/**
	 * Abre el chat en Corregir código sin auto-enviar: el usuario puede cambiar de agente
	 * en el panel y después enviar. Se llama desde el PromptDrawer («Corregir con agente»).
	 */
	async function fixWithAgent(text: string, findingIds: string[] = []): Promise<boolean> {
		if (!report || !text.trim()) return false;
		try {
			const agents = await acpAgents();
			if (!agents.length && !report.meta.agentSession?.agentId) {
				console.warn('No hay agente ACP disponible; usá Copiar en el panel de corrección');
				return false;
			}
		} catch (err) {
			console.warn('Error al verificar agente ACP:', err);
			if (!report.meta.agentSession?.agentId) return false;
		}
		pendingAsk = null;
		pendingFix = { text, autoSend: false, findingIds };
		openAgentDrawer();
		return true;
	}

</script>

<svelte:window
	onclick={() => {
		if (downloadOpen || kebabOpen || viewMenuOpen) closeMenus();
	}}
	onkeydown={(e) => {
		// ExportDialog maneja Escape propio; no cerrar el diálogo desde acá al mismo tiempo.
		if (e.key === 'Escape' && !downloadOpen) closeMenus();
		else if (e.key === 'Escape' && downloadOpen) downloadOpen = false;
	}}
/>

<div class="page">
	<header class="app-header chrome">
		<div class="chrome-left">
			{#if report}
				<button
					type="button"
					class="icon-btn"
					class:on={!sidebarCollapsed}
					title={sidebarCollapsed ? 'Mostrar menú' : 'Ocultar menú'}
					aria-label={sidebarCollapsed ? 'Mostrar menú' : 'Ocultar menú'}
					aria-pressed={!sidebarCollapsed}
					onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
				>
					<Icon name="sidebar-left" />
				</button>
			{/if}
			<a href={resolve('/')} class="app-brand chrome-brand" title="Inicio">
				<BrandMark size={16} />
				<span class="brand-text">diff-review</span>
				<span class="brand-text app-version">v{__APP_VERSION__}</span>
			</a>
			{#if report}
				<span class="chrome-divider" aria-hidden="true"></span>
				{@const branch = report.meta.branch || '—'}
				{@const base = report.meta.base || 'develop'}
				{@const agentId = reportAgentId(report.meta)}
				{@const agentLabel = agentShortName(agentId, report.meta.agent || '')}
				{@const modelShown = report.meta.modelLabel || report.meta.model || ''}
				{@const modelRaw =
					report.meta.modelLabel && report.meta.model ? `${report.meta.modelLabel} (${report.meta.model})` : modelShown}
				{@const agentTitle = [report.meta.agent, modelRaw].filter(Boolean).join(' · ')}
				<div class="group ctx-group" role="group" aria-label="Contexto del reporte">
					<div class="chrome-meta">
						<div class="meta-block meta-repo" title={report.meta.repo || undefined}>
							<span class="meta-primary meta-line">
								<span class="meta-icon"><Icon name="repo" size={12} /></span>
								<span class="meta-text">{repoDisplayName(report.meta.repo)}</span>
							</span>
							<span class="breadcrumb meta-secondary" title={`${branch} → ${base}`}>
								<span class="meta-icon"><Icon name="branch" size={11} /></span>
								<span class="crumb-branch">{middleEllipsis(branch, 26)}</span>
								<span class="crumb-sep"><Icon name="arrow-right" size={10} /></span>
								<span class="crumb-base">{base}</span>
							</span>
						</div>
						{#if report.meta.agent || report.meta.model}
							<span class="meta-divider" aria-hidden="true"></span>
							<div class="meta-block meta-agent" title={agentTitle || undefined}>
								<span class="meta-primary meta-line">
									<span class="meta-icon"><AgentIcon id={agentId} size={12} /></span>
									<span class="meta-text">{agentId || report.meta.agent ? agentLabel : '—'}</span>
								</span>
								{#if modelShown}
									<span class="meta-secondary meta-line meta-model">
										<span class="meta-icon"><Icon name="brain" size={11} /></span>
										<span class="meta-text">{modelShown}</span>
									</span>
								{/if}
							</div>
						{/if}
					</div>
					<div class="menu-wrap">
						<button
							type="button"
							class="icon-btn inner"
							class:on={kebabOpen}
							title="Más acciones"
							aria-label="Más acciones"
							aria-expanded={kebabOpen}
							aria-haspopup="menu"
							onclick={(e) => {
								e.stopPropagation();
								toggleKebab();
							}}
						>
							<Icon name="more" />
						</button>
						{#if kebabOpen}
							<div class="menu" role="menu" tabindex="-1">
								<button type="button" class="menu-item danger" role="menuitem" onclick={remove}>
									Eliminar reporte…
								</button>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>

		<div class="chrome-right">
			{#if report}
				<div class="group diff-group chrome-center-inline" role="group" aria-label="Vista del diff">
					<button
						type="button"
						class="icon-btn inner"
						class:on={diffMode === 'unified'}
						title="Unificado"
						aria-label="Unificado"
						aria-pressed={diffMode === 'unified'}
						onclick={() => (diffMode = 'unified')}
					>
						<Icon name="unified" />
					</button>
					<button
						type="button"
						class="icon-btn inner"
						class:on={diffMode === 'split'}
						title="Lado a lado"
						aria-label="Lado a lado"
						aria-pressed={diffMode === 'split'}
						onclick={() => (diffMode = 'split')}
					>
						<Icon name="split" />
					</button>
					<span class="group-gap" aria-hidden="true"></span>
					<button
						type="button"
						class="icon-btn inner"
						title="Achicar letra del diff"
						aria-label="Achicar letra del diff"
						onclick={() => (diffFontSize = clamp(diffFontSize - 1, 9, 20))}
					>
						<Icon name="minus" size={14} />
					</button>
					<span class="zoom-label" title="Tamaño de letra del diff">{Math.round(diffFontSize)}</span>
					<button
						type="button"
						class="icon-btn inner"
						title="Agrandar letra del diff"
						aria-label="Agrandar letra del diff"
						onclick={() => (diffFontSize = clamp(diffFontSize + 1, 9, 20))}
					>
						<Icon name="plus" size={14} />
					</button>
					<span class="group-gap" aria-hidden="true"></span>
					<button
						type="button"
						class="icon-btn inner"
						class:on={wrapLines && diffMode !== 'split'}
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
						<Icon name="wrap" />
					</button>
				</div>
				<div class="menu-wrap chrome-view-menu">
					<button
						type="button"
						class="icon-btn"
						class:on={viewMenuOpen}
						title="Controles de vista"
						aria-label="Controles de vista"
						aria-expanded={viewMenuOpen}
						aria-haspopup="menu"
						onclick={(e) => {
							e.stopPropagation();
							toggleViewMenu();
						}}
					>
						<Icon name="sliders" />
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
									class="icon-btn inner"
									title="Achicar letra del diff"
									aria-label="Achicar letra del diff"
									onclick={() => (diffFontSize = clamp(diffFontSize - 1, 9, 20))}
								>
									<Icon name="minus" size={14} />
								</button>
								<span class="zoom-label">{Math.round(diffFontSize)}px</span>
								<button
									type="button"
									class="icon-btn inner"
									title="Agrandar letra del diff"
									aria-label="Agrandar letra del diff"
									onclick={() => (diffFontSize = clamp(diffFontSize + 1, 9, 20))}
								>
									<Icon name="plus" size={14} />
								</button>
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
								class:on={showExplanations}
								role="menuitem"
								onclick={() => (showExplanations = !showExplanations)}
							>
								{showExplanations ? 'Ocultar explicaciones' : 'Mostrar explicaciones'}
							</button>
						</div>
					{/if}
				</div>
				<button
					type="button"
					class="icon-btn"
					title="Exportar reporte"
					aria-label="Exportar reporte"
					onclick={(e) => {
						e.stopPropagation();
						openExportDialog();
					}}
				>
					<Icon name="download" />
				</button>
			{/if}
			<ThemeToggle />
			{#if report}
				<span class="chrome-divider" aria-hidden="true"></span>
				<button
					type="button"
					class="icon-btn chrome-layout-btn"
					class:on={showExplanations}
					title={showExplanations ? 'Ocultar explicaciones' : 'Mostrar explicaciones'}
					aria-label={showExplanations ? 'Ocultar explicaciones' : 'Mostrar explicaciones'}
					aria-pressed={showExplanations}
					onclick={() => (showExplanations = !showExplanations)}
				>
					<Icon name="sidebar-right" />
				</button>
				<button
					type="button"
					class="icon-btn"
					class:on={chatOpen}
					title="Chat con el agente"
					aria-label="Chat con el agente"
					aria-pressed={chatOpen}
					onclick={() => {
						if (chatOpen) closeAgentDrawer();
						else openAgentDrawer();
					}}
				>
					<Icon name="chat" />
				</button>
			{/if}
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
				onopendrawer={closeAgentDrawer}
				agentDrawerOpen={chatOpen}
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
					onclose={closeAgentDrawer}
					onreportupdated={(updated) => (report = updated)}
				/>
			{/if}
		</div>
		<ExportDialog {report} open={downloadOpen} onclose={() => (downloadOpen = false)} />
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

	.chrome {
		/* 32px: altura única de botones y grupos del header. */
		--ctl: 32px;
		--ctl-inner: 28px;
		--hover-bg: color-mix(in srgb, var(--text) 7%, transparent);
		--on-bg: color-mix(in srgb, var(--text) 11%, transparent);
		position: relative;
		flex-wrap: nowrap;
	}

	.chrome-left {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		flex: 1 1 auto;
		/* visible: el kebab dropdown no puede quedar clippeado por el header */
		overflow: visible;
		z-index: 2;
	}

	.chrome-right {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		flex: 0 1 auto;
		min-width: 0;
		z-index: 2;
	}

	.chrome-view-menu {
		display: none;
	}

	.chrome-divider {
		width: 1px;
		height: 18px;
		margin-inline: 2px;
		background: var(--border);
		flex-shrink: 0;
	}

	/* Grupos (contexto, diff): una superficie sutil, sin bordes internos. */
	.group {
		display: flex;
		align-items: center;
		gap: 2px;
		height: var(--ctl);
		box-sizing: border-box;
		padding: 1px;
		border: 1px solid var(--border-soft);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--text) 3.5%, transparent);
		flex-shrink: 0;
	}

	.group-gap {
		width: 6px;
		flex-shrink: 0;
	}

	/* Dos líneas de texto: más alto que los botones (38 vs 32), sin pasar el alto del header. */
	.ctx-group {
		flex-shrink: 1;
		min-width: 0;
		height: 38px;
		padding: 0 3px 0 11px;
		gap: 10px;
	}

	/* El kebab va separado del texto por una línea, como un segmento aparte. */
	.ctx-group > .menu-wrap {
		display: flex;
		align-items: center;
		align-self: stretch;
		padding-left: 4px;
		border-left: 1px solid var(--border-soft);
	}

	.chrome-meta {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 14px;
		min-width: 0;
		max-width: min(440px, 48vw);
		overflow: hidden;
	}

	.meta-block {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 3px;
		min-width: 0;
		overflow: hidden;
	}

	.meta-repo {
		flex: 1 1 auto;
		max-width: min(240px, 28vw);
	}

	.meta-agent {
		flex: 0 1 auto;
		max-width: min(180px, 22vw);
	}

	.meta-divider {
		width: 1px;
		height: 22px;
		background: var(--border);
		flex-shrink: 0;
		align-self: center;
	}

	.meta-line {
		display: flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		max-width: 100%;
	}

	.meta-icon {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.meta-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.meta-primary {
		max-width: 100%;
		overflow: hidden;
		font-size: 12px;
		font-weight: 600;
		line-height: 14px;
		color: var(--text);
	}

	.meta-secondary {
		max-width: 100%;
		overflow: hidden;
		font-size: 10.5px;
		line-height: 13px;
		color: var(--text-faint);
	}

	.meta-model {
		font-family: var(--mono);
		gap: 4px;
	}

	.breadcrumb {
		display: flex;
		align-items: center;
		gap: 4px;
		font-family: var(--mono);
		min-width: 0;
	}

	.crumb-branch {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		color: var(--text-dim);
	}

	.crumb-sep {
		display: inline-flex;
		flex-shrink: 0;
		opacity: 0.7;
	}

	.crumb-base {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex-shrink: 1;
		min-width: 0;
	}

	.menu-wrap {
		position: relative;
		flex-shrink: 0;
		z-index: 50;
	}

	.menu {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 60;
		min-width: 180px;
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-card);
		box-shadow: 0 8px 24px color-mix(in srgb, #000 18%, transparent);
	}

	.ctx-group .menu {
		left: auto;
		right: -2px;
	}

	.menu-item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0;
		width: 100%;
		padding: 6px 8px;
		border: 0;
		border-radius: 2px;
		background: transparent;
		color: var(--text);
		font-size: 12px;
		line-height: 1.25;
		text-align: left;
		cursor: pointer;
	}

	.menu-item:hover {
		background: var(--hover-bg);
	}

	.menu-item.danger {
		color: var(--danger);
	}

	/* Botones de ícono: sin marco; el fondo aparece en hover/activo. */
	.icon-btn {
		width: var(--ctl);
		height: var(--ctl);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		padding: 0;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-dim);
		cursor: pointer;
	}

	.icon-btn.inner {
		width: var(--ctl-inner);
		height: var(--ctl-inner);
		border-radius: 2px;
	}

	.icon-btn:hover:not(:disabled) {
		background: var(--hover-bg);
		color: var(--text);
	}

	.icon-btn.on {
		background: var(--on-bg);
		color: var(--text);
	}

	.icon-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.icon-btn:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.zoom-label {
		min-width: 22px;
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--text-faint);
		text-align: center;
		font-variant-numeric: tabular-nums;
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
		background: var(--on-bg);
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
		padding: 4px;
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

		.chrome-layout-btn {
			display: none;
		}

		.chrome-meta {
			max-width: min(320px, 40vw);
		}

		.meta-repo {
			max-width: min(160px, 24vw);
		}

		.meta-agent {
			max-width: min(140px, 18vw);
		}
	}

	@media (max-width: 900px) {
		.brand-text {
			display: none;
		}
	}

	@media (max-width: 768px) {
		.chrome {
			flex-wrap: wrap;
			padding: 10px 12px 10px 8px;
			gap: 8px 10px;
		}

		.chrome-left {
			flex: 1 1 100%;
		}

		.chrome-right {
			flex: 1 1 100%;
			justify-content: flex-end;
			flex-wrap: wrap;
		}

		.meta-agent,
		.meta-divider {
			display: none;
		}

		.chrome-meta {
			max-width: min(200px, 45vw);
		}

		.meta-repo {
			max-width: 100%;
		}

		.body.chat-open > :global(.report-shell) {
			/* El chat pasa a overlay a pantalla completa (ver ChatPanel). */
			visibility: hidden;
			pointer-events: none;
		}
	}
</style>
