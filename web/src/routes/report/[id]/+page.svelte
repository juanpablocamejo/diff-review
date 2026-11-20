<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { acpAgentModels, acpAgents, startReview, startUpdateReview } from '$lib/report/agent.remote';
	import { deleteReviewOutput, prepareReview } from '$lib/report/git.remote';
	import { buildPrompt, buildUpdatePrompt, makeStampedOutputFilename } from '$lib/report/prompts';
	import type { AcpAgentOption, AcpModels } from '$lib/report/agent-events';
	import AgentIcon from '$lib/report/AgentIcon.svelte';
	import AgentSelect from '$lib/report/AgentSelect.svelte';
	import ModelSelect from '$lib/report/ModelSelect.svelte';
	import { buildAcpModelSelectOptions, sortModelSelectOptions } from '$lib/report/model-label';
	import { agentShortName, reportAgentId } from '$lib/report/agent-icons';
	import ChatPanel from '$lib/report/ChatPanel.svelte';
	import ExportDialog from '$lib/report/ExportDialog.svelte';
	import ReportView from '$lib/report/ReportView.svelte';
	import { resolveSavedReport } from '$lib/report/resolve-report';
	import { canLoadFromDisk, deleteReport, reportOutputFilename, updateReportMeta } from '$lib/report/storage';
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
	let updateOpen = $state(false);
	let updateBusy = $state(false);
	let updateError = $state('');
	let updateUnchanged = $state(false);
	let updateConfirmed = $state(false);
	let updatePrompt = $state('');
	let updateCopied = $state(false);
	let updateLaunchNote = $state('');
	let updateAgents = $state<AcpAgentOption[]>([]);
	let updateFingerprint = $state('');
	/** Actualizar el JSON abierto, o armar una review nueva desde los cambios actuales. */
	let reviewMode = $state<'update' | 'regenerate'>('update');
	let regenBusy = $state(false);
	let regenError = $state('');
	type PreparedDiff = {
		outputFilename: string;
		diffRelPath: string | null;
		diffFingerprint: string;
		includesWorktree: boolean;
		empty: boolean;
		mergeBase?: string;
		branchSha?: string;
		baseSha?: string;
		files?: Array<{ path: string; changeType?: string }>;
		ignored?: string[];
		ignoreGlobs?: string[];
	};

	let regenPrepared = $state.raw<PreparedDiff | null>(null);
	let regenAgentId = $state('');
	let regenModel = $state('');
	/** El usuario eligió un modelo a mano; no pisarlo con el de esta review. */
	let regenModelTouched = $state(false);
	let regenModels = $state<Record<string, AcpModels | 'loading'>>({});

	function hasLocalWorktree(current: SavedReport): boolean {
		const repo = current.meta.repo.trim();
		if (!repo || current.meta.source === 'url') return false;
		if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(repo)) return false;
		return /[\\/]/.test(repo) || /^[A-Za-z]:/.test(repo);
	}

	function reportFilename(current: SavedReport): string {
		return current.meta.outputFilename || current.meta.agentSession?.outputFilename || '';
	}

	/** El agente de esta review si sigue en el catálogo; si no, el default (el primero). */
	function pickRegenAgent(agents: AcpAgentOption[], currentId: string): string {
		const wanted = currentId.trim().toLowerCase();
		const saved = wanted ? agents.find((agent) => agent.id.toLowerCase() === wanted) : undefined;
		return saved?.id || agents[0]?.id || '';
	}

	function savedAgentId(): string {
		return report ? reportAgentId(report.meta) : '';
	}

	/** Vacío, `default` y `auto` son el ítem normal del select (valor ""). */
	function isDefaultModel(model: string): boolean {
		const value = model.trim().toLowerCase();
		return !value || value === 'default' || value.startsWith('default[') || value === 'auto' || value.startsWith('auto[');
	}

	/** Mismos values que el select (catálogo ACP, o aliases fijos si ACP no trajo modelos). */
	function modelOptionValues(agentId: string): string[] {
		const chosen = updateAgents.find((agent) => agent.id === agentId);
		const live = regenModels[agentId];
		if (!live || live === 'loading') return [];
		const fixed = { options: chosen?.models ?? [], initialValue: '' };
		if (live.models.length) {
			return buildAcpModelSelectOptions({ models: live.models, currentModel: live.currentModel }, fixed).options.map(
				(option) => option.value
			);
		}
		return fixed.options.map((model) => model.value);
	}

	function matchSavedModel(agentId: string, saved: string): string {
		if (isDefaultModel(saved)) return '';
		const values = modelOptionValues(agentId);
		if (values.includes(saved)) return saved;
		const folded = saved.toLowerCase();
		return values.find((value) => value.toLowerCase() === folded) || '';
	}

	/**
	 * Preselecciona `meta.model` solo si el agente elegido es el de la review y el id está en el catálogo.
	 * Si no está, deja el default del select y no bloquea el lanzamiento.
	 */
	function applySavedModel(agentId: string) {
		if (regenModelTouched || regenAgentId !== agentId || !report) return;
		const savedId = savedAgentId();
		if (!savedId || agentId.toLowerCase() !== savedId.toLowerCase()) return;
		const live = regenModels[agentId];
		if (!live || live === 'loading') return;
		regenModel = matchSavedModel(agentId, String(report.meta.model || '').trim());
	}

	function freshReviewPrompt(prepared: PreparedDiff, acp: boolean): string {
		if (!report) return '';
		return buildPrompt(report.meta, {
			outputFilename: prepared.outputFilename,
			acp,
			diffRelPath: prepared.diffRelPath,
			diffFingerprint: prepared.diffFingerprint,
			includesWorktree: prepared.includesWorktree,
			mergeBase: prepared.mergeBase,
			branchSha: prepared.branchSha,
			baseSha: prepared.baseSha,
			files: prepared.files,
			ignored: prepared.ignored,
			ignoreGlobs: prepared.ignoreGlobs
		});
	}

	const regenChosen = $derived(updateAgents.find((agent) => agent.id === regenAgentId) ?? null);
	const regenModelsStatus = $derived(regenModels[regenAgentId]);
	const regenModelOptions = $derived.by(() => {
		const live = regenModels[regenAgentId];
		const fixed = {
			options: regenChosen?.models ?? [],
			initialValue: ''
		};
		if (live === 'loading' || live === undefined) {
			return [{ value: '', label: 'Cargando modelos…', title: 'Cargando modelos…', badges: [] as string[] }];
		}
		if (live.models.length) {
			return buildAcpModelSelectOptions(
				{ models: live.models, currentModel: live.currentModel },
				fixed
			).options;
		}
		return sortModelSelectOptions(
			fixed.options.map((model) => ({
				value: model.value,
				label: model.label,
				title: model.label,
				badges: [] as string[],
				...(model.hint ? { hint: model.hint } : {})
			}))
		);
	});
	const regenModelsError = $derived(
		regenModelsStatus && regenModelsStatus !== 'loading' ? regenModelsStatus.error : undefined
	);
	/** Mostrar el select mientras carga o cuando el agente (fijo o ACP) tiene modelos. */
	const showRegenModels = $derived.by(() => {
		if (!regenChosen) return false;
		const live = regenModels[regenChosen.id];
		if (!live || live === 'loading') return true;
		return live.models.length > 0 || regenChosen.models.length > 0;
	});
	const regenPrompt = $derived.by(() => {
		if (!report || !regenPrepared || regenPrepared.empty) return '';
		return freshReviewPrompt(regenPrepared, updateAgents.length > 0);
	});
	const updatingReview = $derived(reviewMode === 'update');
	const promptReady = $derived(updatingReview ? Boolean(updatePrompt) : Boolean(regenPrompt));
	const modeBusy = $derived(updateBusy || (!updatingReview && regenBusy));
	const fingerprintGate = $derived(updatingReview && updateUnchanged && !updateConfirmed);

	function regenModeActive(): boolean {
		return reviewMode === 'regenerate';
	}

	function ensureRegenModels(id: string) {
		if (!id || id in regenModels) return;
		const repo = report?.meta.repo || '';
		regenModels = { ...regenModels, [id]: 'loading' };
		void acpAgentModels({ agentId: id, repo }).then((res) => {
			regenModels = { ...regenModels, [id]: res };
			applySavedModel(id);
		});
	}

	function retryRegenModels() {
		const id = regenAgentId;
		if (!id || regenModels[id] === 'loading') return;
		const repo = report?.meta.repo || '';
		regenModels = { ...regenModels, [id]: 'loading' };
		void acpAgentModels({ agentId: id, repo, force: true }).then((res) => {
			regenModels = { ...regenModels, [id]: res };
			applySavedModel(id);
		});
	}

	function onRegenModelChange() {
		regenModelTouched = true;
	}

	function onRegenAgentChange() {
		regenModel = '';
		regenModelTouched = false;
		ensureRegenModels(regenAgentId);
		applySavedModel(regenAgentId);
	}

	async function prepareFreshDiff(outputFilename?: string): Promise<PreparedDiff> {
		if (!report) throw new Error('No hay reporte.');
		return prepareReview({
			repo: report.meta.repo,
			branch: report.meta.branch,
			base: report.meta.base || 'develop',
			...(outputFilename ? { outputFilename } : {}),
			acp: updateAgents.length > 0
		});
	}

	async function prepareRegenerate() {
		if (!report || !hasLocalWorktree(report)) return;
		regenBusy = true;
		regenError = '';
		try {
			let prepared = await prepareFreshDiff();
			if (prepared.empty) {
				regenPrepared = null;
				regenError =
					'El diff está vacío (ni commits ni cambios sin commitear). No hay nada nuevo que analizar.';
				return;
			}
			const currentName = reportFilename(report);
			if (currentName && prepared.outputFilename === currentName) {
				prepared = await prepareFreshDiff(
					makeStampedOutputFilename({
						branchSha: prepared.branchSha,
						baseSha: prepared.baseSha
					})
				);
			}
			if (prepared.empty) {
				regenPrepared = null;
				regenError =
					'El diff está vacío (ni commits ni cambios sin commitear). No hay nada nuevo que analizar.';
				return;
			}
			regenPrepared = prepared;
		} catch (err) {
			regenPrepared = null;
			regenError = err instanceof Error ? err.message : String(err);
		} finally {
			regenBusy = false;
		}
	}

	function setReviewMode(mode: 'update' | 'regenerate') {
		if (reviewMode === mode) return;
		reviewMode = mode;
		updateCopied = false;
		if (mode !== 'regenerate') return;
		ensureRegenModels(regenAgentId);
		applySavedModel(regenAgentId);
		if (!regenPrepared && !regenBusy && report && hasLocalWorktree(report)) {
			void prepareRegenerate();
		}
	}

	async function openUpdateReview() {
		if (!report) return;
		closeMenus();
		updateOpen = true;
		reviewMode = 'update';
		updateBusy = true;
		updateError = '';
		updateUnchanged = false;
		updateConfirmed = false;
		updatePrompt = '';
		updateCopied = false;
		updateLaunchNote = '';
		updateFingerprint = '';
		updateAgents = [];
		regenBusy = false;
		regenError = '';
		regenPrepared = null;
		regenAgentId = '';
		regenModel = '';
		regenModelTouched = false;
		if (!hasLocalWorktree(report)) {
			updateBusy = false;
			updateError =
				'No hay un worktree local donde escribir el diff. No armé un prompt que apunte a un archivo inexistente.';
			regenError = updateError;
			updateLaunchNote = 'Lanzar está deshabilitado: hace falta el repo en esta máquina.';
			return;
		}
		try {
			const agents = await acpAgents().catch(() => [] as AcpAgentOption[]);
			updateAgents = agents;
			regenAgentId = pickRegenAgent(agents, reportAgentId(report.meta));
			// Durante el await el usuario puede haber pasado a Regenerar.
			if (regenModeActive()) {
				ensureRegenModels(regenAgentId);
				applySavedModel(regenAgentId);
			}
			if (!agents.length) {
				updateLaunchNote =
					'No hay un agente integrado en esta máquina. Podés copiar el prompt y pegarlo en el tuyo.';
			}
			const filename = reportFilename(report);
			if (!filename) {
				updateError =
					'Este reporte no tiene un JSON en .diff-review/. No puedo actualizarlo en el mismo archivo.';
				updateLaunchNote = 'Lanzar está deshabilitado sin ese archivo.';
				return;
			}
			const prepared = await prepareReview({
				repo: report.meta.repo,
				branch: report.meta.branch,
				base: report.meta.base || 'develop',
				outputFilename: filename
			});
			if (prepared.empty) {
				updateError = 'El diff está vacío (ni commits ni cambios sin commitear). No hay nada nuevo que analizar.';
				updateLaunchNote = 'Lanzar está deshabilitado porque el diff está vacío.';
				return;
			}
			updateFingerprint = prepared.diffFingerprint;
			const stored = report.meta.diffFingerprint || '';
			updateUnchanged = Boolean(stored && stored === prepared.diffFingerprint);
			updatePrompt = buildUpdatePrompt(report.meta, {
				outputFilename: filename,
				diffRelPath: prepared.diffRelPath,
				diffFingerprint: prepared.diffFingerprint,
				includesWorktree: prepared.includesWorktree,
				acp: agents.length > 0
			});
		} catch (err) {
			updateError = err instanceof Error ? err.message : String(err);
			updateLaunchNote = 'Lanzar está deshabilitado porque no pude preparar el diff.';
		} finally {
			updateBusy = false;
		}
	}

	function rememberFingerprint() {
		if (!report || !updateFingerprint) return;
		const updated = updateReportMeta(report.id, { diffFingerprint: updateFingerprint });
		if (updated) report = updated;
	}

	async function copyRegeneratePrompt() {
		if (!report || !regenPrepared || regenPrepared.empty) return;
		try {
			const prepared = await prepareReview({
				repo: report.meta.repo,
				branch: report.meta.branch,
				base: report.meta.base || 'develop',
				outputFilename: regenPrepared.outputFilename,
				stamp: true,
				acp: updateAgents.length > 0
			});
			if (prepared.empty) {
				regenError = 'El diff está vacío. No copié un prompt que apunte a un archivo sin cambios.';
				return;
			}
			regenPrepared = prepared;
			const prompt = freshReviewPrompt(prepared, updateAgents.length > 0);
			await navigator.clipboard.writeText(prompt);
			updateCopied = true;
		} catch (err) {
			regenError = err instanceof Error ? err.message : String(err);
		}
	}

	async function copyUpdatePrompt() {
		if (reviewMode === 'regenerate') {
			await copyRegeneratePrompt();
			return;
		}
		if (!report || !updatePrompt || (updateUnchanged && !updateConfirmed)) return;
		const filename = reportFilename(report);
		try {
			const prepared = await prepareReview({
				repo: report.meta.repo,
				branch: report.meta.branch,
				base: report.meta.base || 'develop',
				outputFilename: filename,
				stamp: true
			});
			if (prepared.empty) {
				updateError = 'El diff está vacío. No copié un prompt que apunte a un archivo sin cambios.';
				return;
			}
			updateFingerprint = prepared.diffFingerprint;
			const prompt = buildUpdatePrompt(report.meta, {
				outputFilename: filename,
				diffRelPath: prepared.diffRelPath,
				diffFingerprint: prepared.diffFingerprint,
				includesWorktree: prepared.includesWorktree,
				acp: updateAgents.length > 0
			});
			updatePrompt = prompt;
			rememberFingerprint();
			await navigator.clipboard.writeText(prompt);
			updateCopied = true;
		} catch (err) {
			updateError = err instanceof Error ? err.message : String(err);
		}
	}

	async function launchRegenerate() {
		if (!report || !regenPrepared || regenPrepared.empty || !updateAgents.length) return;
		const agentId = regenAgentId || updateAgents[0]?.id;
		if (!agentId) {
			regenError = 'No hay un agente para lanzar. Copiá el prompt.';
			return;
		}
		updateBusy = true;
		regenError = '';
		try {
			const started = await startReview({
				repo: report.meta.repo,
				branch: report.meta.branch,
				base: report.meta.base || 'develop',
				agentId,
				model: regenModel,
				outputFilename: regenPrepared.outputFilename
			});
			updateOpen = false;
			await goto(`${resolve('/')}?agent=${encodeURIComponent(started.id)}`);
		} catch (err) {
			regenError = err instanceof Error ? err.message : String(err);
		} finally {
			updateBusy = false;
		}
	}

	async function launchUpdate() {
		if (reviewMode === 'regenerate') {
			await launchRegenerate();
			return;
		}
		if (!report || !updateAgents.length || (updateUnchanged && !updateConfirmed)) return;
		const filename = reportFilename(report);
		const agentId = report.meta.agentSession?.agentId || updateAgents[0]?.id;
		if (!agentId) {
			updateLaunchNote = 'No hay un agente para lanzar. Copiá el prompt.';
			return;
		}
		updateBusy = true;
		try {
			const started = await startUpdateReview({
				repo: report.meta.repo,
				branch: report.meta.branch,
				base: report.meta.base || 'develop',
				outputFilename: filename,
				agentId,
				model: report.meta.model
			});
			rememberFingerprint();
			updateOpen = false;
			await goto(`${resolve('/')}?agent=${encodeURIComponent(started.id)}`);
		} catch (err) {
			updateError = err instanceof Error ? err.message : String(err);
		} finally {
			updateBusy = false;
		}
	}

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
					if (resolved && resolved.id !== id) {
						report = resolved;
						void goto(resolve(`/report/${resolved.id}`), { replaceState: true });
						return;
					}
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

	async function remove() {
		if (!report) return;
		const label = report.meta.branch || 'este reporte';
		if (!confirm(`¿Eliminar “${label}”? No se puede deshacer.`)) return;
		const current = report;
		try {
			if (canLoadFromDisk(current.meta)) {
				await deleteReviewOutput({
					repo: current.meta.repo,
					filename: reportOutputFilename(current.meta),
					viewerId: current.meta.viewerId || current.id
				});
			}
			deleteReport(current.id);
			void goto(resolve('/'));
		} catch (err) {
			alert(`No se pudo eliminar el reporte: ${err instanceof Error ? err.message : String(err)}`);
		}
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
		if (e.key === 'Escape' && updateOpen) updateOpen = false;
		else if (e.key === 'Escape' && !downloadOpen) closeMenus();
		else if (e.key === 'Escape' && downloadOpen) downloadOpen = false;
	}}
/>

<div class="page">
	<header class="app-header chrome">
		<div class="chrome-left">
			{#if report}
				<button
					type="button"
					class={['icon-btn', { on: !sidebarCollapsed }]}
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
							class={['icon-btn inner', { on: kebabOpen }]}
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
				<div class="menu-wrap chrome-view-menu">
					<button
						type="button"
						class={['icon-btn', { on: viewMenuOpen }]}
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
						<div
							class="menu view-menu"
							role="menu"
							tabindex="-1"
							onclick={(e) => e.stopPropagation()}
							onkeydown={(e) => e.stopPropagation()}
						>
							<div class="view-menu-heading" role="presentation">diff viewer</div>
							<button
								type="button"
								class={['menu-item', { on: diffMode === 'unified' }]}
								role="menuitem"
								onclick={() => (diffMode = 'unified')}
							>
								<Icon name="unified" size={16} /><span>Unificado</span>
							</button>
							<button
								type="button"
								class={['menu-item', { on: diffMode === 'split' }]}
								role="menuitem"
								onclick={() => (diffMode = 'split')}
							>
								<Icon name="split" size={16} /><span>Lado a lado</span>
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
									<Icon name="minus" size={16} />
								</button>
								<span class="zoom-label">{Math.round(diffFontSize)}px</span>
								<button
									type="button"
									class="icon-btn inner"
									title="Agrandar letra del diff"
									aria-label="Agrandar letra del diff"
									onclick={() => (diffFontSize = clamp(diffFontSize + 1, 9, 20))}
								>
									<Icon name="plus" size={16} />
								</button>
							</div>
							<button
								type="button"
								class={['menu-item', { on: wrapLines && diffMode !== 'split' }]}
								role="menuitem"
								disabled={diffMode === 'split'}
								title={diffMode === 'split' ? 'En lado a lado el código siempre ajusta' : undefined}
								onclick={() => (wrapLines = true)}
							>
								<Icon name="wrap" size={16} /><span>Ajustar líneas</span>
							</button>
							<button
								type="button"
								class={['menu-item', { on: !wrapLines }]}
								role="menuitem"
								disabled={diffMode === 'split'}
								title={diffMode === 'split' ? 'En lado a lado el código siempre ajusta' : undefined}
								onclick={() => (wrapLines = false)}
							>
								<Icon name="nowrap" size={16} /><span>Sin ajuste de línea</span>
							</button>
						</div>
					{/if}
				</div>
				<button type="button" class="text-btn" onclick={() => void openUpdateReview()}>Actualizar review</button>
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
					class={['icon-btn chrome-layout-btn', { on: showExplanations }]}
					title={showExplanations ? 'Ocultar explicaciones' : 'Mostrar explicaciones'}
					aria-label={showExplanations ? 'Ocultar explicaciones' : 'Mostrar explicaciones'}
					aria-pressed={showExplanations}
					onclick={() => (showExplanations = !showExplanations)}
				>
					<Icon name="sidebar-right" />
				</button>
				<button
					type="button"
					class={['icon-btn', { on: chatOpen }]}
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
		<div class={['body', { 'chat-open': chatOpen }]}>
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
		{#if updateOpen}
			<button
				type="button"
				class="update-backdrop"
				aria-label="Cerrar"
				onclick={() => (updateOpen = false)}
			></button>
			<div
				class="update-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="update-review-title"
			>
				<h2 id="update-review-title">Volver a analizar</h2>
				<div class="mode-choice" role="radiogroup" aria-label="Qué hacer con la review">
					<button
						type="button"
						role="radio"
						aria-checked={updatingReview}
						class={{ on: updatingReview }}
						onclick={() => setReviewMode('update')}
					>
						Actualizar
					</button>
					<button
						type="button"
						role="radio"
						aria-checked={!updatingReview}
						class={{ on: !updatingReview }}
						onclick={() => setReviewMode('regenerate')}
					>
						Regenerar
					</button>
				</div>
				{#if updatingReview}
					{#if updateBusy && !updatePrompt}
						<p>Preparando el diff del working tree…</p>
					{:else}
						<p>
							El agente lee esta review (json) y los nuevos cambios en los archivos para actualizarla, marcando como
							corregido o ignorado lo que corresponda.
						</p>
						{#if updateUnchanged}
							<p class="update-warn">
								Nada cambió desde la última vez que se creó o actualizó esta review (la huella del diff es la
								misma). No hay cambios nuevos para analizar.
							</p>
							<button
								type="button"
								class="dialog-btn"
								onclick={() => (updateConfirmed = true)}
								disabled={updateConfirmed}
							>
								{updateConfirmed ? 'Confirmado' : 'Continuar igual'}
							</button>
						{/if}
						{#if updateError}
							<p class="update-warn">{updateError}</p>
						{/if}
						{#if updateLaunchNote}
							<p class="update-note">{updateLaunchNote}</p>
						{/if}
					{/if}
				{:else if regenBusy && !regenPrompt}
					<p>Preparando el diff del working tree…</p>
				{:else}
					<p>
						El agente arma una review nueva a partir de los cambios actuales, sin partir de esta review.
					</p>
					{#if updateAgents.length}
						<div class="update-fields">
							<label class="field">
								<span>Agente</span>
								<AgentSelect
									bind:value={regenAgentId}
									options={updateAgents}
									onchange={onRegenAgentChange}
								/>
							</label>
							{#if showRegenModels}
								<label class="field">
									<span
										>Modelo{#if regenModelsStatus === 'loading'}
											<small> · consultando modelos (puede tardar)…</small>{/if}</span
									>
									<ModelSelect
										bind:value={regenModel}
										options={regenModelOptions}
										disabled={regenModelsStatus === 'loading' || regenModelsStatus === undefined}
										onchange={onRegenModelChange}
									/>
								</label>
							{/if}
						</div>
						{#if regenModelsError}
							<p class="update-warn">
								{regenModelsError}
								<button type="button" class="linkish" onclick={retryRegenModels}>Reintentar</button>
							</p>
						{/if}
					{/if}
					{#if regenError}
						<p class="update-warn">{regenError}</p>
					{/if}
				{/if}
				<div class="update-actions">
					<button type="button" class="dialog-btn" onclick={() => (updateOpen = false)}>Cerrar</button>
					<button
						type="button"
						class="dialog-btn"
						disabled={!promptReady || modeBusy || fingerprintGate}
						onclick={() => void copyUpdatePrompt()}
					>
						{updateCopied ? 'Copiado ✓' : 'Copiar prompt'}
					</button>
					<button
						type="button"
						class="dialog-btn primary"
						disabled={!promptReady || modeBusy || !updateAgents.length || fingerprintGate || (!updatingReview && !regenAgentId)}
						title={updatingReview
							? updateLaunchNote || 'Lanzar el agente con el prompt de actualización'
							: 'Lanzar una review nueva'}
						onclick={() => void launchUpdate()}
					>
						{updateBusy ? 'Lanzando…' : 'Lanzar agente'}
					</button>
				</div>
			</div>
		{/if}
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
		z-index: 20;
		flex-wrap: nowrap;
		overflow: visible;
	}

	.text-btn {
		height: var(--ctl);
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
		white-space: nowrap;
	}

	.text-btn:hover {
		background: var(--hover-bg);
	}

	.update-backdrop {
		position: fixed;
		inset: 0;
		padding: 0;
		border: 0;
		background: color-mix(in srgb, var(--bg) 35%, transparent);
		z-index: 40;
		cursor: default;
	}

	.update-dialog {
		position: fixed;
		z-index: 41;
		top: 72px;
		right: 16px;
		width: min(440px, calc(100vw - 32px));
		overflow: visible;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg-elev);
		box-shadow: 0 12px 40px color-mix(in srgb, #000 24%, transparent);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.update-dialog h2 {
		margin: 0;
		font-size: 16px;
	}

	.update-dialog p {
		margin: 0;
		font-size: 13px;
		line-height: 1.45;
	}

	.update-warn {
		color: var(--danger);
	}

	.update-note {
		color: var(--text-dim);
	}

	.mode-choice {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.mode-choice button {
		width: 100%;
		padding: 8px 10px;
		text-align: left;
		appearance: none;
		font: inherit;
		font-size: 13px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		cursor: pointer;
	}

	.mode-choice button.on {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 16%, var(--bg-card));
	}

	.mode-choice button:hover:not(.on) {
		border-color: var(--text-faint);
	}

	.update-fields {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.update-fields .field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
		font-size: 12px;
		color: var(--text-dim);
	}

	.update-dialog .linkish {
		margin-left: 6px;
		padding: 0;
		appearance: none;
		border: 0;
		background: transparent;
		color: var(--accent);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.update-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	/*
	 * Sin fondo propio el botón queda con el buttonface del navegador (claro) y
	 * hereda color: inherit → --text (claro en dark). Hay que pintar superficie y texto.
	 * Solo los botones de esta página: AgentSelect y ModelSelect traen los suyos.
	 */
	.dialog-btn {
		align-self: flex-start;
		padding: 7px 12px;
		appearance: none;
		font: inherit;
		font-size: 13px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		cursor: pointer;
	}

	.dialog-btn:hover:not(:disabled) {
		border-color: var(--accent);
	}

	.dialog-btn:disabled {
		background: var(--bg-card);
		border-color: var(--border);
		color: var(--text-dim);
		cursor: not-allowed;
	}

	.update-actions button.primary {
		background: var(--btn-primary-bg);
		border-color: var(--btn-primary-border);
		color: var(--btn-primary-text);
	}

	.update-actions button.primary:disabled {
		background: var(--btn-primary-bg);
		border-color: var(--btn-primary-border);
		color: color-mix(in srgb, var(--btn-primary-text) 72%, var(--btn-primary-bg));
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
		overflow: visible;
		z-index: 3;
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

	.view-menu-heading {
		padding: 6px 8px;
		font-size: 10.5px;
		line-height: 1.25;
		color: var(--text-faint);
		pointer-events: none;
	}

	.view-menu .menu-item {
		flex-direction: row;
		align-items: center;
		gap: 8px;
	}

	.view-menu .menu-item.on {
		background: var(--on-bg);
		color: var(--text);
	}

	.view-menu .menu-item:disabled,
	.view-menu .menu-item:disabled:hover {
		background: transparent;
		color: var(--text-faint);
		cursor: not-allowed;
	}

	.view-menu .menu-item.on:disabled,
	.view-menu .menu-item.on:disabled:hover {
		background: var(--on-bg);
		color: var(--text-faint);
	}

	.view-menu-sep {
		height: 1px;
		margin: 4px 0;
		background: var(--border-soft);
	}

	.view-menu-row {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		gap: 8px;
		padding: 6px 8px;
	}

	.view-menu-row .icon-btn.inner {
		width: 16px;
		height: 16px;
		color: var(--text);
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
