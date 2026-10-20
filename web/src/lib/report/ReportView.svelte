<script lang="ts">
	import { buildReportModel } from './build';
	import { decorateFinding } from './decorate';
	import ExploreContent from './ExploreContent.svelte';
	import FindingsContent from './FindingsContent.svelte';
	import FindingsDrawer from './FindingsDrawer.svelte';
	import ReportFooter from './ReportFooter.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import Sidebar from './Sidebar.svelte';
	import { tick, untrack } from 'svelte';
	import { agentShortName, reportAgentId } from './agent-icons';
	import { acpAgents } from './agent.remote';
	import type { AcpAgentOption } from './agent-events';
	import { fileAnchor, groupFileAnchor, scrollToAnchor } from './anchors';
	import { askDraftFinding } from './labels';
	import { reviewSeedPayload } from './document';
	import { fileLines, writeReviewOutput } from './git.remote';
	import { buildFixPromptText, buildPublishText, splitFixSummary, type PublishPlatform } from './prompts';
	import {
		canLoadFromDisk,
		loadTriage,
		replaceReportDocument,
		reportOutputFilename,
		saveTriage,
		type TriageState
	} from './storage';
	import {
		applyTriageToFindings,
		mergeTriage,
		triageFromFindings,
		triageNeedsDocumentWrite
	} from './triage';
	import type { SavedReport } from './types';

	let {
		report,
		diffMode,
		diffFontSize,
		wrapLines,
		sidebarCollapsed = false,
		showExplanations = true,
		pendingFixApplied = null,
		onpendingfixappliedconsumed,
		onask,
		onfixwithagent,
		onreportupdated
	}: {
		report: SavedReport;
		diffMode: 'unified' | 'split';
		diffFontSize: number;
		wrapLines: boolean;
		/** Los dos paneles laterales se prenden y apagan desde el header de la página. */
		sidebarCollapsed?: boolean;
		showExplanations?: boolean;
		/** Resultado de un turno Corregir código: marcar hallazgos como Corregido. */
		pendingFixApplied?: { findingIds: string[]; summary: string } | null;
		onpendingfixappliedconsumed?: () => void;
		/** Abre el chat con un borrador (referencia); el usuario completa y envía. */
		onask?: (draft: string) => void;
		/** Abre el chat en modo fix y auto-envía el prompt. `false` = sin agente ACP → panel de copiar. */
		onfixwithagent?: (text: string, findingIds: string[]) => boolean | Promise<boolean>;
		onreportupdated?: (report: SavedReport) => void;
	} = $props();

	const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

	const model = $derived(buildReportModel(report.document));

	let installedAgents = $state<AcpAgentOption[]>([]);
	/**
	 * Sesión ACP, o provenance de meta.agent si ese agente sigue instalado.
	 * Vacío → iconos genéricos + "Agente" (no inventar Cursor/Claude).
	 */
	const agentId = $derived.by(() => {
		const preferred = reportAgentId(report.meta);
		if (!preferred) return '';
		if (report.meta.agentSession?.agentId) return preferred;
		if (!installedAgents.length) return preferred;
		return installedAgents.some((a) => a.id === preferred) ? preferred : '';
	});
	/** Mismo nombre corto que el botón del header / chat (Claude, Cursor, … o "Agente"). */
	const agentName = $derived(agentShortName(agentId, report.meta.agent || ''));

	let reportMode = $state<'explore' | 'findings'>('explore');
	let activeFindingId = $state<string | null>(null);
	let decided = $state<Record<string, boolean>>({});
	let fixSelected = $state<Record<string, boolean>>({});
	let corrected = $state<Record<string, boolean>>({});
	let fixedDetail = $state<Record<string, string>>({});
	let sidebarWidth = $state(270);
	let explanationWidth = $state(360);
	let splitRatio = $state(0.5);
	let drawerFilePath = $state<string | null>(null);
	let drawerExpandedFindingId = $state<string | null>(null);
	let expandedDiffs = $state<Record<string, boolean>>({});
	/** Override de abierto/cerrado por path; si no hay entrada, manda el default del panel. */
	let fileOpen = $state<Record<string, boolean>>({});
	let showFixPrompt = $state(false);
	let showPublishPrompt = $state(false);
	let publishPlatform = $state<PublishPlatform>('github');
	let fixCopyLabel = $state('Copiar');
	let publishCopyLabel = $state('Copiar');
	/** Archivo más visible en Explore → resalte en el acordeón de temas. */
	let activeExploreFile = $state<{ groupId: string; path: string } | null>(null);
	/** Evita resetear Explorar/Hallazgos cuando `onreportupdated` reemplaza el mismo reporte. */
	let hydratedReportId: string | null = null;

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

	$effect(() => {
		// Solo al cambiar de reporte: persistir triage / meta reasigna `report` con el mismo id.
		const id = report.id;
		if (hydratedReportId === id) return;
		hydratedReportId = id;
		const findings = untrack(() => report.document.findings);
		const fromDoc = triageFromFindings(findings);
		const merged = mergeTriage(fromDoc, loadTriage(id));
		decided = merged.decided;
		fixSelected = merged.fixSelected;
		corrected = merged.corrected;
		fixedDetail = merged.fixedDetail;
		saveTriage(id, merged);
		reportMode = 'explore';
		activeFindingId = null;
		drawerFilePath = null;
		drawerExpandedFindingId = null;
		showFixPrompt = false;
		showPublishPrompt = false;
		fileOpen = {};
		activeExploreFile = null;
		if (triageNeedsDocumentWrite(fromDoc, merged)) {
			void persistTriageState(merged);
		}
	});

	$effect(() => {
		const payload = pendingFixApplied;
		if (!payload?.findingIds?.length) return;
		applyFixFromAgent(payload.findingIds, payload.summary || '');
		onpendingfixappliedconsumed?.();
	});

	function currentTriage(): TriageState {
		return { decided, fixSelected, corrected, fixedDetail };
	}

	function documentWithTriage(triage: TriageState = currentTriage()) {
		return {
			...report.document,
			findings: applyTriageToFindings(report.document.findings, triage)
		};
	}

	/** localStorage + documento (+ `.diff-review/*.json` si el reporte es file-backed). */
	async function persistTriageState(triage: TriageState = currentTriage()) {
		saveTriage(report.id, triage);
		const document = documentWithTriage(triage);
		const updated = replaceReportDocument(report.id, document, report.meta);
		if (!updated) {
			console.error('No se pudo guardar el triage en el reporte');
			return;
		}
		onreportupdated?.(updated);
		if (!canLoadFromDisk(updated.meta)) return;
		const filename = reportOutputFilename(updated.meta);
		if (!filename) return;
		try {
			await writeReviewOutput({
				repo: updated.meta.repo,
				filename,
				payload: reviewSeedPayload(updated.document, updated.meta)
			});
		} catch (err) {
			console.error('No se pudo escribir el JSON de review en disco:', err);
		}
	}

	const decoratedFindingsNav = $derived(
		model.findingsNav.map((f) => decorateFinding(f, decided, fixSelected, corrected, fixedDetail))
	);
	const decoratedOrphans = $derived(
		model.orphanFindings.map((f) => decorateFinding(f, decided, fixSelected, corrected, fixedDetail))
	);

	function fileFindings(path: string) {
		return decoratedFindingsNav.filter((f) => f.file === path);
	}

	const activeFinding = $derived(
		decoratedFindingsNav.find((f) => f.id === activeFindingId) ?? decoratedFindingsNav[0] ?? null
	);
	const activeFile = $derived(activeFinding ? (model.fileSectionsByPath.get(activeFinding.file) ?? null) : null);
	const drawerFindings = $derived(drawerFilePath ? fileFindings(drawerFilePath) : []);

	const fixSelectionFindings = $derived(
		decoratedFindingsNav.filter((f) => fixSelected[f.id] && !corrected[f.id])
	);
	const fixSelectionCount = $derived(fixSelectionFindings.length);
	const ignoredFindings = $derived(
		decoratedFindingsNav.filter((f) => f.decided && !f.fixSelected && !f.corrected)
	);
	const ignoredCount = $derived(ignoredFindings.length);
	const reviewedCount = $derived(decoratedFindingsNav.filter((f) => f.decided).length);
	const reviewedLabel = $derived(`${reviewedCount} de ${decoratedFindingsNav.length} revisados`);

	const fixPromptText = $derived(
		showFixPrompt
			? buildFixPromptText(
					fixSelectionFindings,
					documentWithTriage({ decided, fixSelected, corrected, fixedDetail }),
					report.meta
				)
			: ''
	);
	const publishText = $derived(showPublishPrompt ? buildPublishText(fixSelectionFindings, publishPlatform, report.meta) : '');
	const publishTargetLabel = $derived(publishPlatform === 'gitlab' ? 'merge request de GitLab' : 'pull request de GitHub');

	function setFindingDecision(id: string, fix: boolean) {
		const next: TriageState = {
			decided: { ...decided, [id]: true },
			fixSelected: { ...fixSelected, [id]: fix },
			corrected: { ...corrected },
			fixedDetail: { ...fixedDetail }
		};
		if (next.corrected[id] || next.fixedDetail[id]) {
			next.corrected[id] = false;
			next.fixedDetail[id] = '';
		}
		decided = next.decided;
		fixSelected = next.fixSelected;
		corrected = next.corrected;
		fixedDetail = next.fixedDetail;
		void persistTriageState(next);
		// Con varios hallazgos, pasar al siguiente; si es el único (o el último), dejarlo abierto.
		if (drawerFilePath && drawerExpandedFindingId === id) {
			const list = fileFindings(drawerFilePath);
			const idx = list.findIndex((f) => f.id === id);
			const nextFinding = list[idx + 1];
			if (nextFinding) drawerExpandedFindingId = nextFinding.id;
		}
	}

	function clearDecision(id: string) {
		const next: TriageState = {
			decided: { ...decided, [id]: false },
			fixSelected: { ...fixSelected, [id]: false },
			corrected: { ...corrected, [id]: false },
			fixedDetail: { ...fixedDetail, [id]: '' }
		};
		decided = next.decided;
		fixSelected = next.fixSelected;
		corrected = next.corrected;
		fixedDetail = next.fixedDetail;
		void persistTriageState(next);
	}

	function applyFixFromAgent(findingIds: string[], summary: string) {
		const details = splitFixSummary(summary, findingIds);
		const next: TriageState = {
			decided: { ...decided },
			fixSelected: { ...fixSelected },
			corrected: { ...corrected },
			fixedDetail: { ...fixedDetail }
		};
		for (const id of findingIds) {
			next.decided[id] = true;
			next.fixSelected[id] = false;
			next.corrected[id] = true;
			next.fixedDetail[id] = details[id] || summary.trim();
		}
		decided = next.decided;
		fixSelected = next.fixSelected;
		corrected = next.corrected;
		fixedDetail = next.fixedDetail;
		void persistTriageState(next);
	}

	function openDrawerFile(path: string) {
		const first = fileFindings(path)[0];
		drawerFilePath = path;
		drawerExpandedFindingId = first ? first.id : null;
	}
	function closeDrawer() {
		drawerFilePath = null;
		drawerExpandedFindingId = null;
	}
	function toggleDrawerExpanded(id: string) {
		if (drawerExpandedFindingId !== id) drawerExpandedFindingId = id;
	}

	/**
	 * Archivo completo desde git, para expandir el contexto que el diff no trae. Cachea por
	 * path: el mismo archivo se abre desde varios hallazgos y desde explorar.
	 */
	const linesCache = new Map<string, Promise<string[] | null>>();
	function requestLines(path: string): Promise<string[] | null> {
		const key = `${report.meta.repo}|${report.meta.branch}|${path}`;
		let hit = linesCache.get(key);
		if (!hit) {
			hit = Promise.resolve(
				fileLines({
					repo: report.meta.repo,
					branch: report.meta.branch,
					base: report.meta.base,
					source: report.meta.source,
					path
				})
			).catch(() => null);
			linesCache.set(key, hit);
		}
		return hit;
	}

	/**
	 * Salto desde el árbol / temas: si el archivo está plegado, lo abre antes de scrollear
	 * para no quedar mirando solo el encabezado. Con groupId apunta a la copia del tema.
	 */
	async function selectFile(path: string, groupId?: string) {
		const loose = model.looseFileSections.find((fs) => fs.path === path);
		const defaultOpen = loose ? loose.allFindings.length > 0 : true;
		if (!(fileOpen[path] ?? defaultOpen)) {
			fileOpen = { ...fileOpen, [path]: true };
			await tick();
		}
		if (groupId) {
			scrollToAnchor(groupFileAnchor(groupId, path));
			return;
		}
		const firstGroup = model.groupSections.find((g) => g.fileSections.some((fs) => fs.path === path));
		scrollToAnchor(firstGroup ? groupFileAnchor(firstGroup.id, path) : fileAnchor(path));
	}

	function toggleFileOpen(path: string, defaultOpen: boolean) {
		fileOpen = { ...fileOpen, [path]: !(fileOpen[path] ?? defaultOpen) };
	}

	function askFinding(id: string) {
		const f = decoratedFindingsNav.find((x) => x.id === id);
		if (!f || !onask) return;
		onask(askDraftFinding(f));
	}

	function copyToClipboard(text: string, onDone: () => void) {
		const done = () => {
			onDone();
			setTimeout(() => {
				fixCopyLabel = 'Copiar';
				publishCopyLabel = 'Copiar';
			}, 1600);
		};
		if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
		else done();
	}

	function openCopyFixPrompt() {
		showFixPrompt = true;
		showPublishPrompt = false;
		reportMode = 'findings';
	}

	async function fixWithAgent() {
		const ids = fixSelectionFindings.map((f) => f.id);
		const text = buildFixPromptText(fixSelectionFindings, documentWithTriage(), report.meta);
		if (!text.trim()) return;
		if (!onfixwithagent) {
			openCopyFixPrompt();
			return;
		}
		const ok = await onfixwithagent(text, ids);
		if (!ok) openCopyFixPrompt();
	}

	async function purgeIgnored() {
		const ids = new Set(ignoredFindings.map((f) => f.id));
		if (!ids.size) return;
		const n = ids.size;
		if (
			!confirm(
				`¿Eliminar ${n} hallazgo${n === 1 ? '' : 's'} ignorado${n === 1 ? '' : 's'} del reporte? No se puede deshacer.`
			)
		) {
			return;
		}
		const triage = currentTriage();
		const document = {
			...report.document,
			findings: applyTriageToFindings(
				report.document.findings.filter((f) => !ids.has(f.id)),
				triage
			)
		};
		const updated = replaceReportDocument(report.id, document, report.meta);
		if (!updated) {
			console.error('Error al eliminar hallazgos ignorados: no se pudo guardar el documento');
			alert('Error: No se pudo guardar los cambios. Intenta de nuevo.');
			return;
		}
		const next = loadTriage(report.id);
		decided = next.decided;
		fixSelected = next.fixSelected;
		corrected = next.corrected;
		fixedDetail = next.fixedDetail;
		if (activeFindingId && ids.has(activeFindingId)) activeFindingId = null;
		onreportupdated?.(updated);
		if (canLoadFromDisk(updated.meta)) {
			const filename = reportOutputFilename(updated.meta);
			if (filename) {
				try {
					await writeReviewOutput({
						repo: updated.meta.repo,
						filename,
						payload: reviewSeedPayload(updated.document, updated.meta)
					});
				} catch (err) {
					console.error('No se pudo escribir el JSON tras purgar ignorados:', err);
				}
			}
		}
	}
</script>

<div class="report-shell">
<div
	class="report"
	style:grid-template-columns={sidebarCollapsed ? '48px minmax(0,1fr)' : `${sidebarWidth}px 6px minmax(0,1fr)`}
>
	<Sidebar
		collapsed={sidebarCollapsed}
		mode={reportMode}
		onsetmode={(m) => (reportMode = m)}
		groupsNav={model.groupsNav}
		fileNav={model.fileNav}
		onselectfile={selectFile}
		findings={decoratedFindingsNav}
		{activeFindingId}
		onselectfinding={(id) => (activeFindingId = id)}
		{activeExploreFile}
	/>

	{#if !sidebarCollapsed}
		<ResizeHandle ondrag={(dx) => (sidebarWidth = clamp(sidebarWidth + dx, 200, 480))} />
	{/if}

	<div class="content">
		{#if reportMode === 'explore'}
			<ExploreContent
				intentText={model.intentText}
				notes={model.notes}
				hasBlockers={model.hasBlockers}
				blockerBannerText={model.blockerBannerText}
				groupSections={model.groupSections}
				looseFileSections={model.looseFileSections}
				{fileOpen}
				ontogglefile={toggleFileOpen}
				orphanFindings={decoratedOrphans}
				hasSkipped={model.hasSkipped}
				skippedList={model.skippedList}
				{diffMode}
				{showExplanations}
				{expandedDiffs}
				{decided}
				{explanationWidth}
				{splitRatio}
				{diffFontSize}
				{wrapLines}
				{agentId}
				ontoggleexpand={(path) => (expandedDiffs = { ...expandedDiffs, [path]: !expandedDiffs[path] })}
				onopenfindings={openDrawerFile}
				onresizeexplanation={(dx) => (explanationWidth = clamp(explanationWidth - dx, 220, 560))}
				onresizesplit={(r) => (splitRatio = clamp(r, 0.2, 0.8))}
				onrequestlines={requestLines}
				onactivefile={(file) => (activeExploreFile = file)}
				{onask}
			/>
		{:else}
			<FindingsContent
				{activeFinding}
				{activeFile}
				{diffMode}
				{showExplanations}
				{explanationWidth}
				{splitRatio}
				{diffFontSize}
				{wrapLines}
				{reviewedLabel}
				{agentId}
				onignore={() => activeFinding && setFindingDecision(activeFinding.id, false)}
				onfix={() => activeFinding && setFindingDecision(activeFinding.id, true)}
				onclear={() => activeFinding && clearDecision(activeFinding.id)}
				onaskfinding={onask && activeFinding ? () => askFinding(activeFinding.id) : undefined}
				onresizeexplanation={(dx) => (explanationWidth = clamp(explanationWidth - dx, 220, 560))}
				onresizesplit={(r) => (splitRatio = clamp(r, 0.2, 0.8))}
				onrequestlines={requestLines}
				{fixSelectionCount}
				{showFixPrompt}
				{fixPromptText}
				{fixCopyLabel}
				onclosefixprompt={() => (showFixPrompt = false)}
				oncopyfix={() => copyToClipboard(fixPromptText, () => (fixCopyLabel = 'Copiado ✓'))}
				{showPublishPrompt}
				{publishPlatform}
				{publishText}
				{publishTargetLabel}
				{publishCopyLabel}
				onclosepublishprompt={() => (showPublishPrompt = false)}
				onsetpublishplatform={(p) => (publishPlatform = p)}
				oncopypublish={() => copyToClipboard(publishText, () => (publishCopyLabel = 'Copiado ✓'))}
			/>
		{/if}
	</div>

	<FindingsDrawer
		filePath={drawerFilePath}
		findings={drawerFindings}
		expandedId={drawerExpandedFindingId}
		{agentId}
		onclose={closeDrawer}
		ontoggle={toggleDrawerExpanded}
		onignore={(id) => setFindingDecision(id, false)}
		onfix={(id) => setFindingDecision(id, true)}
		onclear={clearDecision}
		onaskfinding={onask ? askFinding : undefined}
	/>
</div>

<ReportFooter
	{reviewedLabel}
	hasFixSelection={fixSelectionCount > 0}
	{fixSelectionCount}
	{ignoredCount}
	{agentName}
	onfixwithagent={() => void fixWithAgent()}
	oncopyfixprompt={openCopyFixPrompt}
	onopenpublishprompt={() => {
		showPublishPrompt = true;
		showFixPrompt = false;
		reportMode = 'findings';
	}}
	onpurgeignored={purgeIgnored}
/>
</div>

<style>
	.report-shell {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.report {
		flex: 1;
		min-height: 0;
		display: grid;
	}

	.content {
		overflow: auto;
		min-height: 0;
		padding: 14px 20px 24px;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
</style>
