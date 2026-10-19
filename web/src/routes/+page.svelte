<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		buildCoveragePromptText,
		buildPrompt,
		isOutputFilename,
		makeOutputFilename
	} from '$lib/report/prompts';
	import { uncoveredFiles } from '$lib/report/coverage';
	import { coerceDocument, hasUsableDiffs, parseReportMeta } from '$lib/report/document';
	import {
		detectOutput,
		hydrateFromGit,
		launchContext,
		loadDetectedOutput,
		writeReviewOutput,
		loadRepo,
		outputName,
		pendingImport,
		pickLocalFolder,
		pickReviewFile
	} from '$lib/report/git.remote';
	import type { DetectedOutput } from '$lib/report/git.remote';
	import {
		acpAgentModels,
		acpAgents,
		agentSession,
		cancelAgent,
		respondPermission,
		retryReview,
		setPermissionTrust,
		startReview
	} from '$lib/report/agent.remote';
	import type { AcpAgentOption, AcpModels, AgentSessionInfo, SeqEvent } from '$lib/report/agent-events';
	import { AgentStream } from '$lib/report/agent-stream.svelte';
	import AgentSelect from '$lib/report/AgentSelect.svelte';
	import LiveReviewView from '$lib/report/LiveReviewView.svelte';
	import ModelSelect from '$lib/report/ModelSelect.svelte';
	import { buildAcpModelSelectOptions, sortModelSelectOptions } from '$lib/report/model-label';
	import {
		deleteReport,
		loadLastLocalRepo,
		loadLastMeta,
		loadReportsIndex,
		reportOutputFilename,
		saveLastMeta,
		saveReport
	} from '$lib/report/storage';
	import type { ReportMeta, RepoSource, ReviewDocument, SavedReportSummary } from '$lib/report/types';
	import { validateDocument } from '$lib/report/validate';
	import { plural } from '$lib/report/labels';
	import ThemeToggle from '$lib/ThemeToggle.svelte';

	function queryFlag(name: string) {
		if (typeof window === 'undefined') return false;
		return new URL(window.location.href).searchParams.get(name) === '1';
	}

	/** Flags del CLI en la URL de entrada (antes de limpiarlos en onMount). */
	function cliLaunchFrom(url: URL) {
		return {
			agentId: url.searchParams.get('agent')?.trim() || '',
			import: url.searchParams.get('import') === '1',
			watch: url.searchParams.get('watch') === '1',
			out: url.searchParams.get('out')?.trim() || ''
		};
	}

	const bootCli = cliLaunchFrom(page.url);
	/**
	 * Flujo CLI (`?agent=` / `?import=` / `?watch=`): no mostrar el form de setup ni un frame.
	 * Sobrevive a `clearLaunchQuery()`.
	 */
	let cliShell = $state(Boolean(bootCli.agentId || bootCli.import || bootCli.watch));
	/** Sesión ACP lanzada por la CLI; mientras no haya `agentInfo`, mostramos LiveReviewView vacío. */
	let cliAgentPending = $state(bootCli.agentId);

	let meta = $state<ReportMeta>({ source: 'local', repo: '', branch: '', base: 'develop' });
	let outputFilename = $state(
		bootCli.out && isOutputFilename(bootCli.out) ? bootCli.out : makeOutputFilename({})
	);
	let promptText = $state('');
	let promptEdited = $state(false);
	let copied = $state(false);
	let promptNotify = $state(false);
	/** Preferencia de UI: 'agent' cuando hay agentes ACP; 'full' para copiar el prompt. */
	let promptViewMode = $state<'full' | 'agent'>('full');
	/** Si el usuario eligió una pestaña a mano, no pisamos al cargar agentes. */
	let promptModeTouched = $state(false);

	let dragOver = $state(false);
	let dropErrors = $state<string[]>([]);
	// Documento válido pero incompleto: espera decisión del usuario antes de abrirse.
	let pendingDoc = $state<ReviewDocument | null>(null);
	let pendingRaw = $state<unknown>(null);
	let uncovered = $state<string[]>([]);
	let coverageCopied = $state(false);
	let reports = $state<SavedReportSummary[]>([]);
	let reportMenuId = $state<string | null>(null);
	let reportMenuPos = $state<{ top: number; left: number } | null>(null);

	let branches = $state<string[]>([]);
	let folderError = $state('');
	let loadingRepo = $state(false);
	let pickingFolder = $state(false);
	let pickingFile = $state(false);
	let hydrating = $state(false);
	/** Modal al abrir un JSON (CLI `?import=1`, detectado o soltado): hidrata el viewer. */
	let diffBusy = $state(bootCli.import);
	/**
	 * Solo la pestaña que abrió el CLI con `?watch=1` importa solo el JSON cuando aparece.
	 * Volver a `/` no trae ese parámetro, así que no reabre el reporte.
	 */
	let autoWatch = $state(bootCli.watch);
	/** `openNewReport` ya navegó: el modal sigue hasta que esta página se desmonte. */
	let openingReport = false;
	/** Ruta local recordada al pasar a URL, para no perderla al volver. */
	let lastLocalRepo = $state('');

	let fileInput = $state<HTMLInputElement | null>(null);
	let detectedOutput = $state<DetectedOutput | null>(null);
	let autoImporting = $state(false);
	/** Evita re-importar el mismo archivo (path+mtime). */
	let consumedDetectionKey = $state('');
	let nameRefreshSeq = 0;

	/** Agentes con modo ACP: se lanzan desde acá y el progreso se ve en vivo. */
	let agentOptions = $state<AcpAgentOption[]>([]);
	let agentChoice = $state('');
	let modelChoice = $state('');
	let launchingAgent = $state(false);
	let agentError = $state('');
	let agentInfo = $state<AgentSessionInfo | null>(null);
	let agentStream = $state<AgentStream | null>(null);
	const chosenAgent = $derived(agentOptions.find((a) => a.id === agentChoice) ?? null);
	/** Flujo CLI: live shell o espera fullscreen (sin form de setup). */
	const showLiveShell = $derived(
		Boolean((agentStream && agentInfo) || (launchingAgent && chosenAgent) || cliAgentPending)
	);
	const showCliWait = $derived(cliShell && !showLiveShell);
	/** Modelos por ACP; mientras cargan o si fallan, se usa la lista fija de `lib/agents.mjs`. */
	let agentModels = $state<Record<string, AcpModels | 'loading'>>({});
	/** Reintento: forzar probe sin caché del server. */
	let modelsForce = $state<Record<string, boolean>>({});
	const modelOptions = $derived.by(() => {
		const live = agentModels[agentChoice];
		const fixed = {
			options: chosenAgent?.models ?? [],
			initialValue: ''
		};
		const fallback = fixed.options.filter((m) => m.value !== '');
		if (live && live !== 'loading' && live.models.length) {
			return buildAcpModelSelectOptions(
				{ models: live.models, currentModel: live.currentModel },
				fixed
			).options;
		}
		if (live === 'loading' && !fallback.length) {
			return [{ value: '', label: 'Cargando modelos…', title: 'Cargando modelos…', badges: [] }];
		}
		return sortModelSelectOptions(
			fixed.options.map((m) => ({
				value: m.value,
				label: m.label,
				title: m.label,
				badges: [] as string[],
				...(m.hint ? { hint: m.hint } : {})
			}))
		);
	});
	const modelsStatus = $derived(agentModels[agentChoice]);
	const modelsError = $derived(
		modelsStatus && modelsStatus !== 'loading' ? modelsStatus.error : undefined
	);
	const modelsEmpty = $derived(
		Boolean(
			modelsStatus &&
				modelsStatus !== 'loading' &&
				!modelsStatus.error &&
				!modelsStatus.models.length
		)
	);

	$effect(() => {
		const id = agentChoice;
		if (promptViewMode !== 'agent' || !id || id in untrack(() => agentModels)) return;
		const force = Boolean(untrack(() => modelsForce[id]));
		agentModels = { ...untrack(() => agentModels), [id]: 'loading' };
		void acpAgentModels({ agentId: id, repo: untrack(() => meta.repo), force }).then((res) => {
			agentModels = { ...agentModels, [id]: res };
			if (force) modelsForce = { ...modelsForce, [id]: false };
		});
	});

	function retryAgentModels() {
		const id = agentChoice;
		if (!id || agentModels[id] === 'loading') return;
		modelsForce = { ...modelsForce, [id]: true };
		const next = { ...agentModels };
		delete next[id];
		agentModels = next;
	}
	const canLaunchAgent = $derived(
		meta.source === 'local' && looksLikePath(meta.repo) && Boolean(meta.branch.trim()) && meta.branch !== meta.base
	);

	const canWatchRepo = $derived(meta.source === 'local' && looksLikePath(meta.repo));

	function setPromptViewMode(mode: 'full' | 'agent') {
		promptModeTouched = true;
		promptViewMode = mode;
	}

	onMount(() => {
		const last = loadLastMeta();
		meta = last;
		lastLocalRepo =
			loadLastLocalRepo() ||
			(last.source === 'local' && looksLikePath(last.repo) ? last.repo.trim() : '');
		const params = new URL(window.location.href).searchParams;
		const wantImport = params.get('import') === '1';
		const wantWatch = params.get('watch') === '1';
		const wantNotify = params.get('notify') === 'prompt';
		const outParam = params.get('out')?.trim();
		const agentParam = params.get('agent')?.trim();
		autoWatch = wantWatch;
		if (wantImport) diffBusy = true;
		if (outParam && isOutputFilename(outParam)) {
			outputFilename = outParam;
		}
		promptText = buildPrompt(meta, { outputFilename });
		reports = loadReportsIndex();
		// Los flags ya quedaron en estado. Sacarlos de la URL evita que un back/refresh vuelva a importar.
		if (wantImport || wantWatch || wantNotify || outParam || agentParam) clearLaunchQuery();
		void loadAgentOptions();
		if (agentParam) void followAgentSession(agentParam);
		void bootstrapFromLaunch(last, {
			wantImport,
			wantWatch,
			wantNotify,
			keepOutName: Boolean(outParam && isOutputFilename(outParam))
		});

		const timer = setInterval(() => {
			void pollDetectedOutput({ auto: true });
		}, 1500);
		return () => {
			clearInterval(timer);
			agentStream?.close();
		};
	});

	async function loadAgentOptions() {
		try {
			agentOptions = await acpAgents();
			if (!agentOptions.some((a) => a.id === agentChoice)) agentChoice = agentOptions[0]?.id ?? '';
			// Default a agente cuando hay opciones ACP y el usuario no eligió otra pestaña.
			if (!promptModeTouched && agentOptions.length > 0 && promptViewMode !== 'agent') {
				promptViewMode = 'agent';
			}
		} catch {
			agentOptions = [];
		}
	}

	/** Sigue una sesión ya lanzada (desde el CLI o desde acá) y abre el reporte cuando hay un resultado válido. */
	async function followAgentSession(id: string, known?: AgentSessionInfo) {
		promptViewMode = 'agent';
		agentError = '';
		let info = known ?? null;
		// La CLI abre el browser apenas el server escucha; a veces la sesión aún no está en el Map.
		if (!info) {
			for (let i = 0; i < 30; i++) {
				info = await agentSession({ id }).catch(() => null);
				if (info) break;
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		if (!info) {
			agentError = 'La sesión del agente ya no existe (¿se reinició diff-review?).';
			cliAgentPending = '';
			return;
		}
		// Si ya frenó (p. ej. auth) antes de conectar el SSE, mostrar el mismo mensaje que la CLI.
		if (info.status === 'error' && info.statusMessage) agentError = info.statusMessage;
		agentInfo = info;
		cliAgentPending = '';
		agentStream?.close();
		const stream = new AgentStream(id, (event) => void onAgentEvent(event));
		agentStream = stream;
		stream.connect();
	}

	async function onAgentEvent(event: SeqEvent) {
		if (event.type === 'status' && event.status === 'error') {
			agentError = event.message || agentError || 'Error del agente.';
			if (agentInfo) agentInfo = { ...agentInfo, status: 'error', statusMessage: agentError };
			return;
		}
		if (
			event.type === 'status' &&
			event.status === 'idle' &&
			/Cancelado/i.test(event.message || '')
		) {
			if (agentInfo) {
				agentInfo = {
					...agentInfo,
					status: 'idle',
					statusMessage: event.message || 'Cancelado.',
					busy: false
				};
			}
			return;
		}
		if (event.type !== 'review' || !event.ok || !agentInfo) return;
		try {
			const loaded = await loadDetectedOutput({ repo: agentInfo.repo, filename: event.filename });
			if (!loaded?.payload) return;
			outputFilename = event.filename;
			await ingestPayload(loaded.payload);
		} catch (err) {
			dropErrors = [`No se pudo abrir el JSON del agente: ${errMessage(err)}`];
		}
	}

	async function launchAgent() {
		if (!chosenAgent || !canLaunchAgent || launchingAgent) return;
		const model = modelChoice;
		launchingAgent = true;
		agentError = '';
		try {
			const started = await startReview({
				repo: meta.repo.trim(),
				branch: meta.branch.trim(),
				base: meta.base.trim() || 'develop',
				agentId: chosenAgent.id,
				model
			});
			outputFilename = started.outputFilename;
			await followAgentSession(started.id, started);
		} catch (err) {
			agentError = errMessage(err);
		} finally {
			launchingAgent = false;
		}
	}

	function resetAgentSession() {
		if (agentInfo) {
			const repo = agentInfo.repo?.trim();
			if (repo) {
				updateMeta({
					source: 'local',
					repo,
					branch: agentInfo.branch || meta.branch,
					base: agentInfo.base || meta.base
				});
				void loadRepoBranches(repo, 'local');
			}
			if (agentInfo.agentId) agentChoice = agentInfo.agentId;
			if (agentInfo.model) modelChoice = agentInfo.model;
		}
		agentStream?.close();
		agentStream = null;
		agentInfo = null;
		agentError = '';
		cliShell = false;
		cliAgentPending = '';
	}

	function clearLaunchQuery() {
		const url = new URL(window.location.href);
		if (!url.search) return;
		url.search = '';
		replaceState(url, {});
	}

	/** Si se lanzó desde un repo git, precarga esa ruta y el branch actual. */
	async function bootstrapFromLaunch(
		last: ReportMeta,
		opts: { wantImport: boolean; wantWatch: boolean; wantNotify: boolean; keepOutName: boolean }
	) {
		try {
			const launch = await launchContext();
			if (launch?.repo) {
				const nextBranch =
					launch.current && launch.current !== 'HEAD'
						? launch.current
						: launch.branches[0] || '';
				const nextBase = launch.branches.includes(last.base) ? last.base : launch.defaultBase;
				branches = launch.branches;
				lastLocalRepo = launch.repo;
				updateMeta({
					source: 'local',
					repo: launch.repo,
					branch: nextBranch,
					base: nextBase,
					remoteUrl: launch.remoteUrl || undefined
				});
				if (!opts.keepOutName) await refreshOutputFilename();
			} else if (last.repo.trim()) {
				void loadRepoBranches(last.repo, last.source);
				if (!opts.keepOutName && last.source === 'local') await refreshOutputFilename();
			}
		} catch {
			if (last.repo.trim()) void loadRepoBranches(last.repo, last.source);
		}

		if (opts.wantNotify) {
			copyToClipboard(promptText, (v) => {
				copied = v;
				promptNotify = true;
				setTimeout(() => (promptNotify = false), 2800);
			});
		}

		if (opts.wantImport) {
			try {
				const pending = await pendingImport();
				if (pending?.payload) {
					if (pending.filename) outputFilename = pending.filename;
					await ingestPayload(pending.payload);
				} else if (!openingReport) {
					diffBusy = false;
				}
			} catch {
				dropErrors = ['No se pudo importar el JSON pendiente del CLI.'];
				diffBusy = false;
			}
		}

		if (opts.wantWatch) void pollDetectedOutput({ auto: true });
	}

	async function refreshOutputFilename() {
		if (meta.source !== 'local' || !looksLikePath(meta.repo) || !meta.branch.trim()) {
			outputFilename = makeOutputFilename({});
			if (!promptEdited) promptText = buildPrompt(meta, { outputFilename });
			return;
		}
		const seq = ++nameRefreshSeq;
		try {
			const info = await outputName({
				repo: meta.repo.trim(),
				branch: meta.branch.trim(),
				base: meta.base.trim() || 'develop'
			});
			if (seq !== nameRefreshSeq) return;
			outputFilename = info.filename;
			if (!promptEdited) promptText = buildPrompt(meta, { outputFilename });
		} catch {
			if (seq !== nameRefreshSeq) return;
			outputFilename = makeOutputFilename({});
			if (!promptEdited) promptText = buildPrompt(meta, { outputFilename });
		}
	}

	function updateMeta(patch: Partial<ReportMeta>) {
		const prev = meta;
		meta = { ...meta, ...patch };
		if (meta.source === 'local' && looksLikePath(meta.repo)) {
			lastLocalRepo = meta.repo.trim();
		}
		saveLastMeta(meta, lastLocalRepo);
		if (!promptEdited) promptText = buildPrompt(meta, { outputFilename });
		const tipsChanged =
			prev.repo !== meta.repo ||
			prev.branch !== meta.branch ||
			prev.base !== meta.base ||
			prev.source !== meta.source;
		if (tipsChanged && meta.source === 'local') void refreshOutputFilename();
	}

	function setSource(source: RepoSource) {
		if (source === meta.source) return;
		branches = [];
		folderError = '';
		if (source === 'url') {
			if (looksLikePath(meta.repo)) lastLocalRepo = meta.repo.trim();
			const url =
				(meta.remoteUrl || '').trim() ||
				(looksLikeGitUrl(meta.repo) ? meta.repo.trim() : '');
			updateMeta({
				source,
				repo: url,
				...(url ? { remoteUrl: url } : {})
			});
			return;
		}
		const path = lastLocalRepo || (looksLikePath(meta.repo) ? meta.repo.trim() : '');
		const remote =
			(looksLikeGitUrl(meta.repo) ? meta.repo.trim() : '') || (meta.remoteUrl || '').trim();
		updateMeta({
			source,
			repo: path,
			...(remote ? { remoteUrl: remote } : {})
		});
	}

	function onPromptInput(e: Event) {
		promptText = (e.currentTarget as HTMLTextAreaElement).value;
		promptEdited = true;
	}

	function copyToClipboard(text: string, setDone: (v: boolean) => void) {
		const done = () => {
			setDone(true);
			setTimeout(() => setDone(false), 1600);
		};
		if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
		else done();
	}

	function copyPrompt() {
		copyToClipboard(promptText, (v) => (copied = v));
	}

	function copyCoveragePrompt() {
		copyToClipboard(buildCoveragePromptText(meta, uncovered, { outputFilename }), (v) => (coverageCopied = v));
	}

	function looksLikePath(value: string) {
		const v = value.trim();
		// URLs llevan `/` pero no son carpetas locales.
		if (!v || /^(https?:\/\/|git@|ssh:\/\/)/i.test(v)) return false;
		return /[\\/]/.test(v) || /^[A-Za-z]:/.test(v);
	}

	function looksLikeGitUrl(value: string) {
		const v = value.trim();
		if (!v) return false;
		if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(v)) return true;
		if (/\.git$/i.test(v) && !looksLikePath(v)) return true;
		return false;
	}

	function errMessage(err: unknown) {
		if (!err) return 'Error desconocido';
		if (typeof err === 'string') {
			try {
				const parsed = JSON.parse(err) as { message?: unknown };
				if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message;
			} catch {
				/* texto plano */
			}
			return err;
		}
		if (typeof err === 'object') {
			const rec = err as { message?: unknown; body?: { message?: unknown } };
			if (typeof rec.body?.message === 'string' && rec.body.message.trim()) return rec.body.message;
			if (typeof rec.message === 'string' && rec.message.trim()) {
				const msg = rec.message.trim();
				if (msg.startsWith('{')) {
					try {
						const parsed = JSON.parse(msg) as { message?: unknown };
						if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message;
					} catch {
						/* seguir con msg */
					}
				}
				return msg;
			}
		}
		return String(err);
	}

	async function browseLocalFolder() {
		if (pickingFolder || loadingRepo) return;
		pickingFolder = true;
		folderError = '';
		try {
			const path = await pickLocalFolder(null);
			if (!path) return;
			updateMeta({ source: 'local', repo: path });
			await loadRepoBranches(path, 'local');
		} catch (err) {
			folderError = 'No se pudo elegir la carpeta: ' + errMessage(err);
		} finally {
			pickingFolder = false;
		}
	}

	async function loadRepoBranches(path = meta.repo, source = meta.source) {
		const repo = path.trim();
		if (!repo) {
			folderError =
				source === 'url' ? 'Indicá la URL del repo.' : 'Indicá la ruta absoluta del repo.';
			return;
		}
		if (loadingRepo) return;
		loadingRepo = true;
		folderError = '';
		try {
			const result = await loadRepo({ source, repo });
			const nextBranch = result.branches.includes(meta.branch)
				? meta.branch
				: result.current || result.branches[0] || '';
			const nextBase = result.branches.includes(meta.base) ? meta.base : result.defaultBase;
			branches = result.branches;
			updateMeta({
				source: result.source,
				repo: result.repo,
				branch: nextBranch,
				base: nextBase,
				remoteUrl: result.remoteUrl || (result.source === 'url' ? result.repo : meta.remoteUrl)
			});
		} catch (err) {
			branches = [];
			folderError = 'No se pudo leer el repo: ' + errMessage(err);
		} finally {
			loadingRepo = false;
		}
	}

	function onDragOver(e: DragEvent) {
		e.preventDefault();
		if (!dragOver) dragOver = true;
	}
	function onDragLeave(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
	}
	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (hydrating || pickingFile || autoImporting) return;
		const file = e.dataTransfer?.files?.[0];
		if (file) handleFile(file);
	}

	async function triggerFileInput() {
		if (hydrating || pickingFile || autoImporting) return;
		if (canWatchRepo) {
			pickingFile = true;
			folderError = '';
			try {
				const picked = await pickReviewFile({ directory: meta.repo.trim() });
				if (!picked?.payload) return;
				if (picked.filename) outputFilename = picked.filename;
				await ingestPayload(picked.payload);
			} catch (err) {
				dropErrors = ['No se pudo abrir el archivo: ' + errMessage(err)];
				fileInput?.click();
			} finally {
				pickingFile = false;
			}
			return;
		}
		fileInput?.click();
	}

	function onFileInputChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) handleFile(file);
		input.value = '';
	}

	function detectionKey(hit: DetectedOutput) {
		return `${hit.path}::${hit.mtimeMs}`;
	}

	async function pollDetectedOutput(opts: { auto: boolean }) {
		if (!canWatchRepo || hydrating || pickingFile) return;
		try {
			const hit = await detectOutput({
				repo: meta.repo.trim(),
				preferredName: outputFilename
			});
			detectedOutput = hit;
			// `autoWatch` solo está activo en la carga que abrió el CLI (`?watch=1`).
			if (!opts.auto || !autoWatch || !hit || autoImporting) return;
			// Solo auto-avanza el archivo que pedimos en el prompt de esta sesión.
			if (hit.filename !== outputFilename) return;
			const key = detectionKey(hit);
			if (key === consumedDetectionKey) return;
			await openDetectedOutput(hit, { auto: true });
		} catch {
			/* silencioso: el poll sigue */
		}
	}

	async function openDetectedOutput(hit: DetectedOutput, opts?: { auto?: boolean }) {
		if (hydrating || autoImporting || pickingFile) return;
		autoImporting = true;
		diffBusy = true;
		dropErrors = [];
		try {
			const loaded = await loadDetectedOutput({
				repo: meta.repo.trim(),
				filename: hit.filename
			});
			if (!loaded?.payload) {
				if (!opts?.auto) dropErrors = ['No se pudo leer ' + hit.filename];
				diffBusy = false;
				return;
			}
			outputFilename = hit.filename;
			const ok = await ingestPayload(loaded.payload);
			if (ok) {
				consumedDetectionKey = detectionKey(hit);
				if (opts?.auto) autoWatch = false;
			}
		} catch (err) {
			dropErrors = ['No se pudo abrir ' + hit.filename + ': ' + errMessage(err)];
			diffBusy = false;
		} finally {
			autoImporting = false;
		}
	}

	function handleFile(file: File) {
		diffBusy = true;
		dropErrors = [];
		const reader = new FileReader();
		reader.onload = () => {
			let raw: unknown;
			try {
				raw = JSON.parse(String(reader.result));
			} catch (err) {
				dropErrors = ['El archivo no es JSON válido: ' + errMessage(err)];
				diffBusy = false;
				return;
			}
			void ingestPayload(raw);
		};
		reader.onerror = () => {
			dropErrors = ['No se pudo leer el archivo.'];
			diffBusy = false;
		};
		reader.readAsText(file);
	}

	function payloadMeta(raw: unknown): ReportMeta {
		return parseReportMeta(raw, meta);
	}

	async function ingestPayload(raw: unknown): Promise<boolean> {
		diffBusy = true;
		openingReport = false;
		try {
			const ok = await ingestPayloadNow(raw);
			// Si ya estamos yendo al reporte, el modal queda hasta que esta página se va.
			if (!openingReport) diffBusy = false;
			return ok;
		} catch (err) {
			diffBusy = false;
			throw err;
		}
	}

	async function ingestPayloadNow(raw: unknown): Promise<boolean> {
		const errors = validateDocument(raw);
		if (errors.length) {
			dropErrors = errors;
			return false;
		}

		let doc = coerceDocument(raw);
		const ctx = payloadMeta(raw);

		// Autocompletar el formulario con lo que vino en el JSON.
		if (ctx.repo || ctx.branch || ctx.base || ctx.remoteUrl) {
			updateMeta({
				source: ctx.source,
				repo: ctx.repo || meta.repo,
				branch: ctx.branch || meta.branch,
				base: ctx.base || meta.base,
				remoteUrl: ctx.remoteUrl || meta.remoteUrl
			});
		}

		const payload = {
			intent: doc.intent,
			groups: doc.groups,
			blocks: doc.blocks,
			findings: doc.findings,
			skipped: doc.skipped,
			notes: doc.notes
		};

		type Attempt = { source: RepoSource; repo: string };
		const attempts: Attempt[] = [];
		const pushAttempt = (source: RepoSource, repo: string) => {
			const r = repo.trim();
			if (!r) return;
			if (attempts.some((a) => a.source === source && a.repo === r)) return;
			attempts.push({ source, repo: r });
		};

		if (ctx.branch) {
			if (ctx.source === 'local' && looksLikePath(ctx.repo)) pushAttempt('local', ctx.repo);
			else if (ctx.source === 'url' && looksLikeGitUrl(ctx.repo)) pushAttempt('url', ctx.repo);
			else if (looksLikeGitUrl(ctx.repo)) pushAttempt('url', ctx.repo);
			else if (looksLikePath(ctx.repo)) pushAttempt('local', ctx.repo);

			const remote = (ctx.remoteUrl || '').trim();
			if (remote && looksLikeGitUrl(remote)) pushAttempt('url', remote);
		}

		if (attempts.length && ctx.branch) {
			hydrating = true;
			dropErrors = [];
			const errors: string[] = [];
			let hydrated = false;
			let discoveredRemote = ctx.remoteUrl;
			try {
				for (const attempt of attempts) {
					try {
						doc = await hydrateFromGit({
							repo: attempt.repo,
							branch: ctx.branch,
							base: ctx.base || 'develop',
							source: attempt.source,
							payload,
							outputFilename
						});
						hydrated = true;
						if (attempt.source === 'url') {
							discoveredRemote = discoveredRemote || attempt.repo;
						} else if (!discoveredRemote) {
							try {
								const info = await loadRepo({ source: 'local', repo: attempt.repo });
								if (info.remoteUrl) discoveredRemote = info.remoteUrl;
							} catch {
								/* sin remote */
							}
						}
						break;
					} catch (err) {
						errors.push(`${attempt.source === 'url' ? 'URL' : 'local'}: ${errMessage(err)}`);
					}
				}
				if (!hydrated) {
					if (!hasUsableDiffs(doc)) {
						dropErrors = [
							'No se pudo calcular el diff con git.',
							...errors.map((e) => `· ${e}`)
						];
						return false;
					}
					doc = {
						...doc,
						notes: [...doc.notes, 'No se pudo refrescar el diff con git: ' + errors.join(' | ')]
					};
				}
			} finally {
				hydrating = false;
			}

			if (discoveredRemote) {
				updateMeta({ remoteUrl: discoveredRemote });
			}

			let reportMeta = await ensureReviewOnDisk(raw, savedMeta(ctx, discoveredRemote));

			const missing = uncoveredFiles(doc);
			if (missing.length) {
				pendingDoc = doc;
				pendingRaw = raw;
				uncovered = missing;
				dropErrors = [];
				updateMeta(reportMeta);
				return true;
			}
			openNewReport(doc, reportMeta);
			return true;
		} else if (!hasUsableDiffs(doc)) {
			dropErrors = [
				'Indicá repo (ruta o URL) y branch, o incluí meta.remoteUrl en el JSON, para calcular el diff con git.'
			];
			return false;
		}

		let reportMeta = await ensureReviewOnDisk(raw, savedMeta(ctx));

		const missing = uncoveredFiles(doc);
		if (missing.length) {
			pendingDoc = doc;
			pendingRaw = raw;
			uncovered = missing;
			dropErrors = [];
			updateMeta(reportMeta);
			return true;
		}
		openNewReport(doc, reportMeta);
		return true;
	}

	function savedMeta(ctx: ReportMeta, remoteUrl?: string): ReportMeta {
		const filename =
			reportOutputFilename(ctx) ||
			(isOutputFilename(outputFilename) ? outputFilename : '') ||
			reportOutputFilename(meta);
		return {
			source: ctx.source,
			repo: ctx.repo || meta.repo,
			branch: ctx.branch || meta.branch,
			base: ctx.base || meta.base,
			remoteUrl: remoteUrl || ctx.remoteUrl || meta.remoteUrl,
			...(ctx.generatedAt ? { generatedAt: ctx.generatedAt } : {}),
			...(ctx.agent ? { agent: ctx.agent } : {}),
			...(ctx.model ? { model: ctx.model } : {}),
			...(ctx.agentSession ? { agentSession: ctx.agentSession } : {}),
			...(filename ? { outputFilename: filename } : {})
		};
	}

	async function ensureReviewOnDisk(raw: unknown, reportMeta: ReportMeta): Promise<ReportMeta> {
		const filename = reportOutputFilename(reportMeta);
		if (!filename || reportMeta.source !== 'local' || !looksLikePath(reportMeta.repo)) {
			return reportMeta;
		}
		const withName = { ...reportMeta, outputFilename: filename };
		try {
			const existing = await loadDetectedOutput({ repo: withName.repo, filename });
			if (existing?.payload) return withName;
			await writeReviewOutput({ repo: withName.repo, filename, payload: raw });
			return withName;
		} catch {
			// Sin archivo en disco, saveReport embebe el documento en localStorage.
			const { outputFilename: _drop, ...rest } = reportMeta;
			return rest;
		}
	}

	function openNewReport(doc: ReviewDocument, reportMeta = meta) {
		dropErrors = [];
		pendingDoc = null;
		pendingRaw = null;
		uncovered = [];
		openingReport = true;
		const saved = saveReport(doc, reportMeta);
		void goto(resolve(`/report/${saved.id}`));
	}

	async function openPendingAnyway() {
		if (!pendingDoc) return;
		const reportMeta = await ensureReviewOnDisk(pendingRaw ?? pendingDoc, savedMeta(meta));
		openNewReport(pendingDoc, reportMeta);
	}

	function fmtWhen(iso: string) {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
	}

	function closeReportMenu() {
		reportMenuId = null;
		reportMenuPos = null;
	}

	function placeReportMenu(button: HTMLButtonElement) {
		const rect = button.getBoundingClientRect();
		const width = 148;
		const height = 42;
		const gap = 4;
		const margin = 8;
		let top = rect.bottom + gap;
		if (top + height > window.innerHeight - margin) top = rect.top - gap - height;
		if (top < margin) top = margin;
		let left = rect.right - width;
		if (left < margin) left = margin;
		if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
		reportMenuPos = { top, left };
	}

	function toggleReportMenu(id: string, button: HTMLButtonElement) {
		if (reportMenuId === id) {
			closeReportMenu();
			return;
		}
		reportMenuId = id;
		placeReportMenu(button);
	}

	function removeReport(item: SavedReportSummary) {
		const label = item.branch || 'este reporte';
		if (!confirm(`¿Eliminar “${label}”? No se puede deshacer.`)) return;
		deleteReport(item.id);
		reports = loadReportsIndex();
		closeReportMenu();
	}
</script>

<svelte:window
	onclick={() => {
		if (reportMenuId) closeReportMenu();
	}}
	onkeydown={(e) => {
		if (e.key === 'Escape') closeReportMenu();
	}}
/>

<div
	class="page"
	class:live={showLiveShell || showCliWait}
>
	{#if promptNotify}
		<div class="toast" role="status">Prompt copiado al portapapeles.</div>
	{/if}

	{#if agentStream && agentInfo}
		<LiveReviewView
			info={agentInfo}
			events={agentStream.events}
			busy={agentStream.busy}
			gone={agentStream.gone}
			error={agentError ||
				agentStream.errorMessage ||
				(agentInfo.status === 'error' ? agentInfo.statusMessage || '' : '')}
			oncancel={() => void cancelAgent({ id: agentInfo!.id })}
			onreset={resetAgentSession}
			onrespondpermission={(detail) =>
				void respondPermission({
					id: agentInfo!.id,
					requestId: detail.requestId,
					allow: detail.allow,
					allowAll: detail.allowAll,
					scope: detail.scope
				})
					.then((next) => {
						agentInfo = next;
					})
					.catch((err) => {
						agentError = err instanceof Error ? err.message : String(err);
					})}
			onsessiontrust={(enabled) =>
				void setPermissionTrust({ id: agentInfo!.id, enabled })
					.then((next) => {
						agentInfo = next;
					})
					.catch((err) => {
						agentError = err instanceof Error ? err.message : String(err);
					})}
			onretry={() => {
				agentError = '';
				void retryReview({ id: agentInfo!.id })
					.then((next) => {
						agentInfo = next;
					})
					.catch((err) => {
						agentError = err instanceof Error ? err.message : String(err);
					});
			}}
		/>
	{:else if launchingAgent && chosenAgent}
		<LiveReviewView
			info={{
				id: '',
				agentId: chosenAgent.id,
				agentLabel: chosenAgent.label,
				model: modelChoice || '',
				repo: meta.repo.trim(),
				branch: meta.branch.trim(),
				base: meta.base.trim() || 'develop',
				outputFilename,
				acpSessionId: '',
				status: 'starting',
				busy: true
			}}
			events={[]}
			busy={true}
			oncancel={() => {}}
			onreset={resetAgentSession}
		/>
	{:else if cliAgentPending}
		<LiveReviewView
			info={{
				id: '',
				agentId: '',
				agentLabel: 'Agente',
				model: '',
				repo: meta.repo.trim(),
				branch: meta.branch.trim(),
				base: meta.base.trim() || 'develop',
				outputFilename,
				acpSessionId: '',
				status: 'starting',
				busy: true
			}}
			events={[]}
			busy={true}
			error={agentError}
			oncancel={() => {}}
			onreset={resetAgentSession}
		/>
	{:else if showCliWait}
		<div class="cli-wait" role="status" aria-live="polite" aria-busy="true">
			<div class="diff-spinner" aria-hidden="true"></div>
			<p class="cli-wait-title">
				{diffBusy || openingReport ? 'Abriendo el reporte…' : 'Esperando el JSON de la review…'}
			</p>
			{#if outputFilename}
				<p class="cli-wait-detail"><code>{outputFilename}</code></p>
			{/if}
			<button type="button" class="ghost" onclick={resetAgentSession}>Volver al inicio</button>
		</div>
	{:else}
	<header class="topbar">
		<a href={resolve('/')} class="brand">
			<span class="brand-dot"></span>
			<span class="title-block">
				<span>diff-review</span>
				<small>lanzá el agente, abrí el reporte, triager hallazgos</small>
			</span>
		</a>
		<ThemeToggle />
	</header>

	<div class="workspace">
		<section class="setup">
			<h2>1. Contexto</h2>
			<div class="mode-toggle source-toggle">
				<button type="button" class:on={meta.source === 'local'} onclick={() => setSource('local')}
					>Carpeta local</button
				>
				<button type="button" class:on={meta.source === 'url'} onclick={() => setSource('url')}
					>URL remota</button
				>
			</div>
			<p class="hint-text">
				{#if meta.source === 'url'}
					URL del remote (https / SSH). Al cargar se listan branches con <code>ls-remote</code>; al soltar el
					JSON se hace un clone shallow temporal para armar el diff. Requiere que el branch esté en el remote.
				{:else}
					Carpeta local del repo. Podés pegar la ruta o elegirla con el diálogo del sistema. Git corre ahí
					mismo (sirve para branches no pusheados).
				{/if}
			</p>
			{#if folderError}
				<p class="error-line">{folderError}</p>
			{/if}
			{#if branches.length}
				<p class="ok-line">{plural(branches.length, 'branch encontrado', 'branches encontrados')}.</p>
			{/if}
			<div class="repo-setup">
				<label class="field repo-field">
					<span>{meta.source === 'url' ? 'URL del repo' : 'Repo'}</span>
					<div class="repo-row">
						<input
							type="text"
							placeholder={meta.source === 'url'
								? 'https://github.com/org/repo.git'
								: 'C:\\path\\to\\repo'}
							value={meta.repo}
							oninput={(e) => updateMeta({ repo: (e.currentTarget as HTMLInputElement).value })}
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									void loadRepoBranches();
								}
							}}
						/>
						{#if meta.source === 'local'}
							<button type="button" onclick={() => void browseLocalFolder()} disabled={pickingFolder || loadingRepo}>
								{pickingFolder ? 'Eligiendo…' : 'Elegir…'}
							</button>
						{/if}
						<button type="button" onclick={() => void loadRepoBranches()} disabled={loadingRepo || pickingFolder}>
							{loadingRepo ? 'Cargando…' : 'Cargar'}
						</button>
					</div>
				</label>
				<div class="row branches-row">
					<label class="field">
						<span>Branch a revisar</span>
						{#if branches.length}
							<select
								value={meta.branch}
								onchange={(e) => updateMeta({ branch: (e.currentTarget as HTMLSelectElement).value })}
							>
								{#each branches as b (b)}
									<option value={b}>{b}</option>
								{/each}
							</select>
						{:else}
							<input
								type="text"
								placeholder="feature/PCM-14839"
								value={meta.branch}
								oninput={(e) => updateMeta({ branch: (e.currentTarget as HTMLInputElement).value })}
							/>
						{/if}
					</label>
					<label class="field">
						<span>Base</span>
						{#if branches.length}
							<select
								value={meta.base}
								onchange={(e) => updateMeta({ base: (e.currentTarget as HTMLSelectElement).value })}
							>
								{#each branches as b (b)}
									<option value={b}>{b}</option>
								{/each}
							</select>
						{:else}
							<input
								type="text"
								placeholder="develop"
								value={meta.base}
								oninput={(e) => updateMeta({ base: (e.currentTarget as HTMLInputElement).value })}
							/>
						{/if}
					</label>
				</div>
			</div>

			<div class="section-head">
				<h2>2. Generar review</h2>
			</div>
			<div class="mode-toggle">
				{#if agentOptions.length || agentStream}
					<button type="button" class:on={promptViewMode === 'agent'} onclick={() => setPromptViewMode('agent')}
						>Lanzar agente</button
					>
				{/if}
				<button type="button" class:on={promptViewMode === 'full'} onclick={() => setPromptViewMode('full')}
					>Copiar prompt</button
				>
			</div>

			{#if promptViewMode === 'agent' && (agentOptions.length || agentStream)}
				<p class="hint-text">
					diff-review lanza el agente en el repo, muestra lo que va haciendo y abre el reporte cuando llega a
					un resultado válido. Solo puede leer el repo, correr comandos de solo lectura (git, grep, cat…) y
					escribir <code>{outputFilename}</code>.
				</p>
				<div class="row">
					<label class="field">
						<span>Agente</span>
						<AgentSelect
							bind:value={agentChoice}
							options={agentOptions}
							onchange={() => (modelChoice = '')}
						/>
					</label>
					<label class="field">
						<span
							>Modelo{#if modelsStatus === 'loading'}
								<small class="loading-models"> · consultando modelos (puede tardar)…</small>{/if}</span
						>
						<ModelSelect
							bind:value={modelChoice}
							options={modelOptions}
							disabled={modelsStatus === 'loading' && !chosenAgent?.models.length}
						/>
					</label>
				</div>
				{#if modelsError}
					<p class="error-line models-error">
						{modelsError}
						<button type="button" class="linkish" onclick={retryAgentModels}>Reintentar</button>
					</p>
				{:else if modelsEmpty}
					<p class="hint-text models-error">
						El agente no listó modelos por ACP; usá el default o la lista fija.
						<button type="button" class="linkish" onclick={retryAgentModels}>Reintentar</button>
					</p>
				{/if}
				<div class="actions">
					<button
						type="button"
						class="primary"
						onclick={() => void launchAgent()}
						disabled={!canLaunchAgent || launchingAgent || !chosenAgent}
					>
						{launchingAgent ? 'Lanzando…' : 'Lanzar review'}
					</button>
				</div>
				{#if !canLaunchAgent}
					<p class="hint-text">Elegí un repo local y un branch distinto de la base.</p>
				{/if}
				{#if agentError}
					<p class="error-line">{agentError}</p>
				{/if}
			{:else}
				<p class="hint-text">
					Copiá y pegalo en Claude, Cursor, Copilot u otro agente. El schema de salida va incluido.
				</p>
				<textarea value={promptText} oninput={onPromptInput}></textarea>
				<div class="actions">
					<button type="button" class="primary" onclick={copyPrompt}>{copied ? 'Copiado ✓' : 'Copiar prompt'}</button>
				</div>
			{/if}

			<h2 class="result-head">3. Resultado</h2>
			<p class="hint-text"
				>Si lanzaste el agente desde acá o desde la CLI, el reporte se abre solo cuando hay un resultado válido.
				También podés soltar o elegir el <code>{outputFilename}</code> a mano. Si trae <code>meta</code>, se
				autocompletan repo y branches.
				{#if canWatchRepo && autoWatch}
					Con repo local, si el archivo aparece en <code>.diff-review/</code> (o en la raíz, formato viejo) lo
					abrimos solos.
				{:else if canWatchRepo}
					Con repo local, si el archivo está en <code>.diff-review/</code> (o en la raíz) podés abrirlo desde
					acá.
				{/if}
			</p>
			{#if canWatchRepo && detectedOutput && detectedOutput.filename === outputFilename && !hydrating && !autoImporting}
				<p class="detect-banner">
					Listo: <button type="button" class="file-link" onclick={() => void openDetectedOutput(detectedOutput!)}
						>{detectedOutput.filename}</button
					>
					{#if autoImporting}
						<span>abriendo…</span>
					{:else if autoWatch}
						<span>(se abre solo; podés hacer click si no)</span>
					{:else}
						<span>(hacé click para abrirlo)</span>
					{/if}
				</p>
			{:else if canWatchRepo && detectedOutput && detectedOutput.filename !== outputFilename && !hydrating}
				<p class="detect-banner">
					Encontré otro reporte:
					<button type="button" class="file-link" onclick={() => void openDetectedOutput(detectedOutput!)}
						>{detectedOutput.filename}</button
					>
				</p>
			{:else if canWatchRepo && !detectedOutput && !hydrating && !autoImporting}
				<p class="detect-wait">Esperando <code>{outputFilename}</code> en <code>.diff-review/</code>…</p>
			{/if}
			{#if autoImporting}
				<p class="detect-wait">Detecté el JSON — abriendo reporte…</p>
			{/if}
			<div
				class="dropzone"
				class:drag={dragOver}
				class:busy={hydrating || pickingFile || autoImporting}
				ondragover={onDragOver}
				ondragleave={onDragLeave}
				ondrop={onDrop}
				role="presentation"
			>
				<p>
					{#if hydrating}
						Abriendo el reporte…
					{:else if pickingFile}
						Eligiendo archivo…
					{:else if autoImporting}
						Importando JSON…
					{:else}
						Arrastrá el archivo .json acá
					{/if}
				</p>
				<button
					type="button"
					onclick={() => void triggerFileInput()}
					disabled={hydrating || pickingFile || autoImporting}
				>
					{pickingFile ? 'Abriendo…' : 'Elegir archivo'}
				</button>
				<input
					type="file"
					accept="application/json,.json"
					bind:this={fileInput}
					onchange={onFileInputChange}
					class="visually-hidden"
				/>
			</div>
			{#if pendingDoc}
				<div class="coverage-box">
					<div class="coverage-head">
						<strong>El modelo dejó {plural(uncovered.length, 'archivo', 'archivos')} sin explicar</strong>
						<span>no aparecen ni en "blocks" ni en "skipped"</span>
					</div>
					<details>
						<summary>Ver los archivos</summary>
						<ul class="coverage-list">
							{#each uncovered as path (path)}
								<li>{path}</li>
							{/each}
						</ul>
					</details>
					<p class="hint-text">
						Pedile al agente (chat del reporte, o este prompt pegado) que complete lo que falta: ya tiene el
						diff en contexto. Después el JSON se reabre solo, o soltalo de nuevo.
					</p>
					<textarea readonly rows="7" value={buildCoveragePromptText(meta, uncovered, { outputFilename })}></textarea>
					<div class="coverage-actions">
						<button type="button" class="primary" onclick={copyCoveragePrompt}>
							{coverageCopied ? 'Copiado ✓' : 'Copiar prompt de corrección'}
						</button>
						<button type="button" onclick={() => void openPendingAnyway()}>Abrir igual</button>
					</div>
				</div>
			{/if}

			{#if dropErrors.length}
				<div class="drop-errors">
					<strong>No se pudo abrir el reporte:</strong>
					<ul>
						{#each dropErrors as err (err)}
							<li>{err}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>

		<aside class="reports-col" onscroll={() => reportMenuId && closeReportMenu()}>
			<h2>Reportes recientes</h2>
			{#if reports.length}
				<ul class="report-list">
					{#each reports as item (item.id)}
						<li class="report-item">
							<a class="report-card" href={resolve(`/report/${item.id}`)}>
								<span class="report-top">
									<strong>{item.branch || '—'}</strong>
									<span class="when">{fmtWhen(item.savedAt)}</span>
								</span>
								<span class="report-meta">
									<span class="report-base"><span class="base-arrow" aria-hidden="true">→</span> {item.base || 'develop'}</span>
									<span class="report-counts">
										<span class="pill">{plural(item.groupCount, 'tema', 'temas')}</span>
										{#if item.blockerCount}
											<span class="pill bad">{plural(item.blockerCount, 'blocker', 'blockers')}</span>
										{/if}
										{#if item.qualityCount}
											<span class="pill">{plural(item.qualityCount, 'calidad', 'calidad')}</span>
										{/if}
									</span>
								</span>
								{#if item.agent || item.model}
									<span
										class="report-prov"
										title={[item.agent, item.model].filter(Boolean).join(' · ')}
									>
										{#if item.agent}<span class="prov-agent">{item.agent}</span>{/if}
										{#if item.agent && item.model}<span class="prov-sep">·</span>{/if}
										{#if item.model}<span class="prov-model">{item.model}</span>{/if}
									</span>
								{/if}
								{#if item.intent}
									<p class="report-intent">{item.intent}</p>
								{/if}
							</a>
							<div class="report-actions">
								<button
									type="button"
									class="kebab"
									title="Más acciones"
									aria-label="Más acciones para {item.branch || 'reporte'}"
									aria-expanded={reportMenuId === item.id}
									aria-haspopup="menu"
									onclick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										toggleReportMenu(item.id, e.currentTarget as HTMLButtonElement);
									}}
								>
									<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
										<circle cx="8" cy="3.5" r="1.25" fill="currentColor" />
										<circle cx="8" cy="8" r="1.25" fill="currentColor" />
										<circle cx="8" cy="12.5" r="1.25" fill="currentColor" />
									</svg>
								</button>
								{#if reportMenuId === item.id && reportMenuPos}
									<div
										class="report-menu"
										role="menu"
										tabindex="-1"
										style:top="{reportMenuPos.top}px"
										style:left="{reportMenuPos.left}px"
									>
										<button
											type="button"
											class="menu-item danger"
											role="menuitem"
											onclick={(e) => {
												e.stopPropagation();
												removeReport(item);
											}}
										>
											Eliminar…
										</button>
									</div>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="hint-text">Todavía no hay reportes. Lanzá el agente o copiá el prompt y abrí el JSON acá.</p>
			{/if}
		</aside>
	</div>
	{/if}
</div>

<style>
	.page {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.page.live {
		min-height: 100vh;
		height: 100vh;
		overflow: hidden;
	}

	.diff-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: grid;
		place-items: center;
		padding: 24px;
		background: color-mix(in srgb, var(--bg) 88%, transparent);
		backdrop-filter: blur(28px);
		-webkit-backdrop-filter: blur(28px);
	}

	.diff-modal {
		width: min(380px, 100%);
		padding: 28px 24px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		box-shadow: 0 16px 48px color-mix(in srgb, #000 28%, transparent);
		text-align: center;
	}

	.diff-modal p {
		margin: 14px 0 0;
		font-size: 15px;
		color: var(--text);
	}

	.diff-spinner {
		width: 28px;
		height: 28px;
		margin: 0 auto;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: diff-spin 0.7s linear infinite;
	}

	.cli-wait {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 32px 24px;
		text-align: center;
		background: var(--bg);
	}
	.cli-wait-title {
		margin: 0;
		font-size: 15px;
		color: var(--text);
	}
	.cli-wait-detail {
		margin: 0;
		font-size: 13px;
		color: var(--text-faint);
	}
	.cli-wait .ghost {
		margin-top: 8px;
		padding: 6px 12px;
		font-size: 13px;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-dim);
		cursor: pointer;
	}

	@keyframes diff-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.toast {
		position: fixed;
		top: 16px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 50;
		padding: 10px 16px;
		border: 1px solid var(--border);
		background: var(--bg-card);
		color: var(--text);
		font-size: 13px;
		box-shadow: 0 8px 24px color-mix(in srgb, #000 16%, transparent);
	}

	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 16px 28px;
		border-bottom: 1px solid var(--border);
		background: var(--header-bg);
		position: sticky;
		top: 0;
		z-index: 5;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		text-decoration: none;
		color: var(--text);
	}

	.brand-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: linear-gradient(135deg, #6ea8fe, #c9a5ff);
		box-shadow: 0 0 12px #6ea8fe88;
		flex-shrink: 0;
	}

	.title-block {
		display: flex;
		flex-direction: column;
		line-height: 1.25;
		text-align: left;
	}

	.title-block span:first-child {
		font-weight: 700;
		font-size: 15px;
	}

	.title-block small {
		color: var(--text-faint);
		font-weight: 400;
		font-size: 11.5px;
	}

	.workspace {
		flex: 1;
		overflow: auto;
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(300px, 380px);
		gap: 28px;
		padding: 22px 28px 40px;
		max-width: 1280px;
		align-items: start;
		margin: 0 auto;
		width: 100%;
	}

	.setup {
		min-width: 0;
	}

	h2 {
		margin: 0 0 4px;
		font-size: 13px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		font-weight: 600;
	}

	.result-head {
		margin-top: 24px;
	}

	.section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-top: 22px;
	}

	.hint-text {
		margin: 0 0 12px;
		font-size: 12.5px;
		color: var(--text-dim);
		line-height: 1.5;
	}

	.hint-text code {
		font-family: var(--mono);
		font-size: 12px;
		color: var(--text);
	}

	.detect-banner,
	.detect-wait {
		margin: 0 0 10px;
		font-size: 13px;
		color: var(--text-dim);
	}

	button.file-link {
		border: 0;
		padding: 0;
		background: transparent;
		color: var(--accent);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.error-line {
		margin: 0 0 10px;
		font-size: 12px;
		color: var(--danger);
	}

	.ok-line {
		margin: 0 0 10px;
		font-size: 12px;
		color: var(--ok);
	}

	.row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.repo-setup {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
		min-width: 180px;
	}

	.repo-field {
		flex: none;
		width: 100%;
		min-width: 0;
	}

	.branches-row .field {
		flex: 1;
		min-width: 160px;
	}

	.field span {
		font-size: 11px;
		color: var(--text-faint);
	}

	.repo-row {
		display: flex;
		gap: 6px;
		min-width: 0;
	}

	.repo-row input[type='text'] {
		flex: 1;
		min-width: 0;
	}

	.repo-row button {
		flex-shrink: 0;
	}

	.source-toggle {
		margin-bottom: 10px;
	}

	input[type='text'],
	select {
		flex: 1;
		min-width: 0;
		background: var(--bg-card);
		border: 1px solid var(--border);
		padding: 9px 12px;
	}

	button {
		background: var(--bg-card);
		border: 1px solid var(--border);
		padding: 9px 12px;
		font-size: 12.5px;
		color: var(--text);
	}

	button:hover:not(:disabled) {
		border-color: var(--accent);
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.mode-toggle {
		display: flex;
		border: 1px solid var(--border);
		overflow: hidden;
		width: fit-content;
		margin-bottom: 10px;
	}

	.mode-toggle button {
		padding: 6px 12px;
		font-size: 12px;
		border: 0;
		background: transparent;
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

	.loading-models {
		color: var(--text-faint);
		font-weight: 400;
	}
	.models-error {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px;
	}
	button.linkish {
		background: none;
		border: none;
		padding: 0;
		color: var(--accent, #3b82f6);
		cursor: pointer;
		text-decoration: underline;
		font: inherit;
	}

	.actions {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}

	button.primary {
		background: var(--btn-primary-bg);
		border-color: var(--btn-primary-border);
		color: var(--btn-primary-text);
		font-weight: 600;
	}

	.coverage-box {
		margin-top: 12px;
		border: 1px solid var(--border);
		border-left: 3px solid var(--sev-med);
		background: var(--bg-card);
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.coverage-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px;
	}

	.coverage-head strong {
		font-size: 13px;
		color: var(--sev-med);
	}

	.coverage-head span {
		font-size: 11.5px;
		color: var(--text-faint);
	}

	.coverage-box summary {
		font-size: 12px;
		color: var(--text-dim);
		cursor: pointer;
	}

	.coverage-list {
		margin: 8px 0 0;
		padding-left: 18px;
		max-height: 180px;
		overflow: auto;
		font-family: var(--mono);
		font-size: 11px;
		color: var(--text-faint);
	}

	.coverage-box textarea {
		width: 100%;
		resize: vertical;
		background: var(--bg);
		border: 1px solid var(--border);
		padding: 10px;
		font-family: var(--mono);
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--text);
	}

	.coverage-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.dropzone {
		padding: 26px;
		border: 1.5px dashed var(--border);
		text-align: center;
		background: var(--bg-elev);
		transition:
			background 0.15s,
			border-color 0.15s;
	}

	.dropzone.drag {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.dropzone.busy {
		opacity: 0.7;
	}

	.dropzone p {
		margin: 0 0 6px;
		font-size: 14px;
		color: var(--text-dim);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.drop-errors {
		margin-top: 10px;
		padding: 10px 12px;
		background: var(--danger-bg);
		color: var(--danger);
		font-size: 12.5px;
	}

	.drop-errors strong {
		display: block;
		margin-bottom: 4px;
	}

	.drop-errors ul {
		margin: 0;
		padding-left: 18px;
		line-height: 1.6;
	}

	.reports-col {
		position: sticky;
		top: 88px;
		max-height: calc(100vh - 110px);
		overflow: auto;
		min-width: 0;
	}

	.report-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.report-item {
		position: relative;
		display: flex;
		align-items: stretch;
		border: 1px solid var(--border);
		background: var(--bg-card);
		overflow: visible;
	}

	.report-item:hover {
		border-color: #33507a;
		background: var(--bg-card-hover);
	}

	.report-card {
		display: block;
		flex: 1;
		min-width: 0;
		padding: 12px 8px 12px 14px;
		text-decoration: none;
		color: var(--text);
	}

	.report-actions {
		position: relative;
		flex-shrink: 0;
		padding: 8px 8px 0 0;
	}

	.kebab {
		width: 26px;
		height: 26px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-faint);
		padding: 0;
		cursor: pointer;
	}

	.kebab:hover {
		border-color: var(--border);
		color: var(--text);
		background: var(--bg);
	}

	.report-menu {
		position: fixed;
		z-index: 40;
		width: 148px;
		padding: 4px;
		border: 1px solid var(--border);
		background: var(--bg-card);
		box-shadow: 0 8px 24px color-mix(in srgb, #000 18%, transparent);
	}

	.report-menu .menu-item {
		display: block;
		width: 100%;
		padding: 8px 10px;
		border: 0;
		background: transparent;
		color: var(--text);
		font-size: 12.5px;
		text-align: left;
		cursor: pointer;
	}

	.report-menu .menu-item:hover {
		background: var(--accent-soft);
	}

	.report-menu .menu-item.danger {
		color: var(--danger);
	}

	.report-top {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: baseline;
	}

	.report-top strong {
		font-size: 14px;
	}

	.report-prov {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		margin-top: 4px;
		font-size: 12px;
		color: var(--text-dim);
	}

	.report-prov .prov-agent {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.report-prov .prov-sep {
		flex-shrink: 0;
		color: var(--text-faint);
	}

	.report-prov .prov-model {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		font-family: var(--mono);
		font-size: 11.5px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.when {
		font-size: 12px;
		color: var(--text-dim);
	}

	.report-meta {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		margin-top: 6px;
		font-size: 12px;
		color: var(--text-dim);
	}

	.report-base {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.base-arrow {
		color: var(--text-faint);
	}

	.report-counts {
		display: flex;
		flex-shrink: 0;
		gap: 8px;
		align-items: baseline;
	}

	.pill {
		font-family: var(--mono);
		font-size: 11px;
	}

	.pill.bad {
		color: var(--danger);
	}

	.report-intent {
		margin: 8px 0 0;
		font-size: 12.5px;
		color: var(--text-dim);
		line-height: 1.45;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	@media (max-width: 960px) {
		.workspace {
			grid-template-columns: 1fr;
		}

		.reports-col {
			position: static;
			max-height: none;
		}
	}
</style>
