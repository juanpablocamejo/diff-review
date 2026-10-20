<script lang="ts">
	import { buildReportModel } from './build';
	import { decorateFinding } from './decorate';
	import ExploreContent from './ExploreContent.svelte';
	import FindingsContent from './FindingsContent.svelte';
	import FindingsDrawer from './FindingsDrawer.svelte';
	import ReportFooter from './ReportFooter.svelte';
	import ResizeHandle from './ResizeHandle.svelte';
	import Sidebar from './Sidebar.svelte';
	import { tick } from 'svelte';
	import { fileAnchor, groupFileAnchor, scrollToAnchor } from './anchors';
	import { fileLines } from './git.remote';
	import { askDraftFinding } from './labels';
	import { buildFixPromptText, buildPublishText, type PublishPlatform } from './prompts';
	import { loadTriage, replaceReportDocument, saveTriage } from './storage';
	import type { SavedReport } from './types';

	let {
		report,
		diffMode,
		diffFontSize,
		wrapLines,
		sidebarCollapsed = false,
		showExplanations = true,
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
		/** Abre el chat con un borrador (referencia); el usuario completa y envía. */
		onask?: (draft: string) => void;
		/** Abre el chat en modo fix y auto-envía el prompt. `false` = sin agente ACP → panel de copiar. */
		onfixwithagent?: (text: string) => boolean | Promise<boolean>;
		onreportupdated?: (report: SavedReport) => void;
	} = $props();

	const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

	const model = $derived(buildReportModel(report.document));
	const agentId = $derived(report.meta.agentSession?.agentId ?? '');

	let reportMode = $state<'explore' | 'findings'>('explore');
	let activeFindingId = $state<string | null>(null);
	let decided = $state<Record<string, boolean>>({});
	let fixSelected = $state<Record<string, boolean>>({});
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

	$effect(() => {
		const triage = loadTriage(report.id);
		decided = triage.decided;
		fixSelected = triage.fixSelected;
		reportMode = 'explore';
		activeFindingId = null;
		drawerFilePath = null;
		drawerExpandedFindingId = null;
		showFixPrompt = false;
		showPublishPrompt = false;
		fileOpen = {};
		activeExploreFile = null;
	});

	function persistTriage() {
		saveTriage(report.id, { decided, fixSelected });
	}

	const decoratedFindingsNav = $derived(model.findingsNav.map((f) => decorateFinding(f, decided, fixSelected)));
	const decoratedOrphans = $derived(model.orphanFindings.map((f) => decorateFinding(f, decided, fixSelected)));

	function fileFindings(path: string) {
		return decoratedFindingsNav.filter((f) => f.file === path);
	}

	const activeFinding = $derived(
		decoratedFindingsNav.find((f) => f.id === activeFindingId) ?? decoratedFindingsNav[0] ?? null
	);
	const activeFile = $derived(activeFinding ? (model.fileSectionsByPath.get(activeFinding.file) ?? null) : null);
	const drawerFindings = $derived(drawerFilePath ? fileFindings(drawerFilePath) : []);

	const fixSelectionFindings = $derived(decoratedFindingsNav.filter((f) => fixSelected[f.id]));
	const fixSelectionCount = $derived(fixSelectionFindings.length);
	const ignoredFindings = $derived(decoratedFindingsNav.filter((f) => f.decided && !f.fixSelected));
	const ignoredCount = $derived(ignoredFindings.length);
	const reviewedCount = $derived(decoratedFindingsNav.filter((f) => f.decided).length);
	const reviewedLabel = $derived(`${reviewedCount} de ${decoratedFindingsNav.length} revisados`);

	const fixPromptText = $derived(
		showFixPrompt ? buildFixPromptText(fixSelectionFindings, report.document, report.meta) : ''
	);
	const publishText = $derived(showPublishPrompt ? buildPublishText(fixSelectionFindings, publishPlatform, report.meta) : '');
	const publishTargetLabel = $derived(publishPlatform === 'gitlab' ? 'merge request de GitLab' : 'pull request de GitHub');

	function setFindingDecision(id: string, fix: boolean) {
		decided = { ...decided, [id]: true };
		fixSelected = { ...fixSelected, [id]: fix };
		persistTriage();
		// Con varios hallazgos, pasar al siguiente; si es el único (o el último), dejarlo abierto.
		if (drawerFilePath && drawerExpandedFindingId === id) {
			const list = fileFindings(drawerFilePath);
			const idx = list.findIndex((f) => f.id === id);
			const next = list[idx + 1];
			if (next) drawerExpandedFindingId = next.id;
		}
	}

	function clearDecision(id: string) {
		decided = { ...decided, [id]: false };
		fixSelected = { ...fixSelected, [id]: false };
		persistTriage();
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
		const text = buildFixPromptText(fixSelectionFindings, report.document, report.meta);
		if (!text.trim()) return;
		if (!onfixwithagent) {
			openCopyFixPrompt();
			return;
		}
		const ok = await onfixwithagent(text);
		if (!ok) openCopyFixPrompt();
	}

	function purgeIgnored() {
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
		const document = {
			...report.document,
			findings: report.document.findings.filter((f) => !ids.has(f.id))
		};
		const updated = replaceReportDocument(report.id, document, report.meta);
		if (!updated) return;
		const triage = loadTriage(report.id);
		decided = triage.decided;
		fixSelected = triage.fixSelected;
		if (activeFindingId && ids.has(activeFindingId)) activeFindingId = null;
		onreportupdated?.(updated);
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
