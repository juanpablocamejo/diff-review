<script lang="ts">
	import { untrack } from 'svelte';
	import AgentAccountMenu from './AgentAccountMenu.svelte';
	import AgentIcon from './AgentIcon.svelte';
	import AgentLog from './AgentLog.svelte';
	import AgentSelect from './AgentSelect.svelte';
	import { agentShortName, reportAgentId } from './agent-icons';
	import TrustSessionToggle from './TrustSessionToggle.svelte';
	import {
		acpAgentModels,
		acpAgents,
		cancelAgent,
		closeChat,
		openAgentLogin,
		openAgentLogout,
		openChat,
		respondPermission,
		sendMessage,
		setPermissionTrust
	} from './agent.remote';
	import type { AcpAgentOption, AcpModels, AgentSessionInfo, ChatMode, SeqEvent } from './agent-events';
	import { AgentStream } from './agent-stream.svelte';
	import { parseReportMeta, reviewSeedDiff, reviewSeedPayload } from './document';
	import { hydrateFromGit, loadDetectedOutput } from './git.remote';
	import { buildAcpModelSelectOptions, sortModelSelectOptions } from './model-label';
	import ModelSelect from './ModelSelect.svelte';
	import {
		AGENT_SWITCH_BOOTSTRAP,
		buildAgentSwitchHandoff,
		formatReadableChatMarkdown,
		handoffChatRelPath
	} from './prompts';
	import ResizeHandle from './ResizeHandle.svelte';
	import {
		canLoadFromDisk,
		clearChat,
		loadChat,
		replaceReportDocument,
		saveChat,
		updateReportMeta
	} from './storage';
	import type { SavedReport } from './types';

	const CHAT_WIDTH_DEFAULT = 480;
	const CHAT_WIDTH_MIN = 320;
	const CHAT_WIDTH_MAX = 720;

	let {
		report,
		onclose,
		onreportupdated,
		pendingAsk = null,
		onpendingaskconsumed,
		pendingFix = null,
		onpendingfixconsumed,
		onfixapplied
	}: {
		report: SavedReport;
		onclose: () => void;
		onreportupdated: (report: SavedReport) => void;
		/** Borrador para el compositor en modo ask (referencia a tema/bloque/hallazgo); no se envía solo. */
		pendingAsk?: string | null;
		onpendingaskconsumed?: () => void;
		/** Prompt de corrección: modo fix; con `autoSend` se envía cuando la sesión esté lista. */
		pendingFix?: { text: string; autoSend?: boolean; findingIds?: string[] } | null;
		onpendingfixconsumed?: () => void;
		/** Tras un turno fix exitoso (`end_turn`) lanzado con findingIds. */
		onfixapplied?: (payload: { findingIds: string[]; summary: string }) => void;
	} = $props();

	let info = $state<AgentSessionInfo | null>(null);
	let stream = $state<AgentStream | null>(null);
	/** Conversación de sesiones anteriores del server (antes de un reinicio), guardada con el reporte. */
	let history = $state<SeqEvent[]>([]);
	let text = $state('');
	let mode = $state<ChatMode>('ask');
	let error = $state('');
	let sending = $state(false);
	let updating = $state(false);
	let starting = $state(false);
	/** Reabriendo sesión ACP guardada (openChat / ensureAcp). */
	let connecting = $state(false);
	/** Hubo un pedido de cambio: el próximo JSON válido reemplaza el reporte. */
	let pendingEdit = false;
	/** Enviar el compositor apenas la sesión ACP esté lista (p. ej. Corregir con el agente). */
	let pendingAutoSend = $state(false);
	/** Ids de hallazgos del próximo envío fix (desde pendingFix). */
	let queuedFixIds: string[] | null = null;
	/** Ids en vuelo: marcar Corregido al terminar el turno con end_turn. */
	let awaitingFixIds: string[] | null = null;
	let composerEl = $state<HTMLTextAreaElement | null>(null);
	let chatWidth = $state(CHAT_WIDTH_DEFAULT);
	/** Bumps AgentLog scroll-to-bottom (Corregir / envío; ignora pin del usuario). */
	let logScrollSignal = $state(0);
	let loginBusy = $state(false);
	let copilotPickHost = $state(false);
	let copilotEnterpriseHost = $state('');
	let loginNote = $state('');
	/** Sesión real del agente (no alcanza con needs_auth para ofrecer "Cambiar cuenta"). */
	let accountLoggedIn = $state(false);
	let accountRefresh = $state(0);

	function bumpLogScroll() {
		logScrollSignal += 1;
	}

	let agentOptions = $state<AcpAgentOption[]>([]);
	let agentChoice = $state('');
	let modelChoice = $state('');
	let agentModels = $state<Record<string, AcpModels | 'loading'>>({});
	let modelsForce = $state<Record<string, boolean>>({});
	/** Cambio de agente en curso (cierra sesión + abre otra). */
	let switching = $state(false);
	/** Label del agente al que estamos cambiando (evita copy stale de meta.agent). */
	let switchingToLabel = $state('');
	/** Confirmación ES antes de perder el chat del agente actual. */
	let pendingSwitch = $state<{ nextId: string; nextLabel: string; currentLabel: string } | null>(
		null
	);

	const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

	const ref = $derived(report.meta.agentSession);
	const busy = $derived(sending || starting || connecting || switching || Boolean(stream?.busy));
	/** Reconectar solo si cambia el reporte o la sesión (no cuando el agente actualiza el documento). */
	const sessionKey = $derived(`${report.id}|${ref?.agentId ?? ''}|${ref?.sessionId ?? ''}`);
	/** Agente del que listamos modelos: sesión activa, ref guardada, o picker. */
	const modelsAgentId = $derived(info?.agentId || ref?.agentId || agentChoice);
	const sessionReady = $derived(Boolean(info));
	const showPicker = $derived(!ref && !info && !connecting && !switching);
	const displayModel = $derived(modelChoice || info?.model || report.meta.model || '');
	const headerAgentId = $derived(
		info?.agentId || (switching ? agentChoice : ref?.agentId) || agentChoice || ''
	);
	/** En el picker vacío no fingir un agente distinto al elegido (ni al de meta si aún no hay choice). */
	const headerAgentName = $derived(
		showPicker && !agentChoice
			? 'Agente'
			: switching && switchingToLabel
				? switchingToLabel
				: agentShortName(
						headerAgentId,
						info?.agentLabel ||
							(headerAgentId && matchAgentLabel(headerAgentId)) ||
							report.meta.agent ||
							''
					)
	);
	/** Nombre para “Lanzando …” / detalle: priorizar elección viva, no provenance vieja. */
	const connectingAgentName = $derived(
		switching && switchingToLabel
			? switchingToLabel
			: agentShortName(
					headerAgentId || agentChoice,
					info?.agentLabel ||
						(agentChoice && matchAgentLabel(agentChoice)) ||
						report.meta.agent ||
						''
				) || 'agente'
	);
	const launching = $derived(starting || connecting || switching);
	const headerSelectDisabled = $derived(
		busy || updating || connecting || starting || switching || Boolean(pendingSwitch)
	);

	const chosenAgent = $derived(agentOptions.find((a) => a.id === modelsAgentId) ?? null);
	const modelOptions = $derived.by(() => {
		const live = agentModels[modelsAgentId];
		const fixed = {
			options: chosenAgent?.models ?? [],
			initialValue: ''
		};
		if (live === 'loading' || live === undefined) {
			return [{ value: '', label: 'Cargando modelos…', title: 'Cargando modelos…', badges: [] }];
		}
		if (live.models.length) {
			return buildAcpModelSelectOptions(
				{ models: live.models, currentModel: live.currentModel || info?.model || report.meta.model || '' },
				fixed
			).options;
		}
		// Sin catálogo ACP (error / vacío): aliases fijos como último recurso.
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
	const modelsStatus = $derived(agentModels[modelsAgentId]);
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

	function resolvedModel(): string | undefined {
		const raw = String(modelChoice || '').trim();
		return raw || undefined;
	}

	/**
	 * Seed solo si el JSON/diff no están ya en `.diff-review/` (p. ej. import solo en memoria).
	 * Mandar el diff completo en el body del remote rompe el límite de 512K del adapter.
	 */
	const seed = $derived(
		canLoadFromDisk(report.meta)
			? null
			: {
					payload: reviewSeedPayload(report.document, report.meta),
					diff: reviewSeedDiff(report.document)
				}
	);

	$effect(() => {
		void sessionKey;
		const reportId = report.id;
		const agentSession = report.meta.agentSession;
		// Sin sesión guardada: el picker / startFresh se encargan (no desarmar un chat recién abierto).
		if (!agentSession) return;
		// No reconectar encima de un switchAgent en curso (carrera con openChat).
		if (untrack(() => switching)) return;
		// Ya conectados a esta sesión ACP (p. ej. tras persistir meta desde startFresh).
		if (
			untrack(
				() =>
					Boolean(
						info?.acpSessionId === agentSession.sessionId &&
							info?.outputFilename === agentSession.outputFilename &&
							info?.agentId === agentSession.agentId &&
							stream
					)
			)
		) {
			return;
		}
		untrack(() => void connect(reportId, agentSession));
		return () => untrack(() => stream?.close());
	});

	$effect(() => {
		void loadAgents();
	});

	$effect(() => {
		const id = modelsAgentId;
		if (!id) return;
		if (id in untrack(() => agentModels)) return;
		const force = Boolean(untrack(() => modelsForce[id]));
		agentModels = { ...untrack(() => agentModels), [id]: 'loading' };
		void acpAgentModels({ agentId: id, repo: report.meta.repo, force }).then((res) => {
			agentModels = { ...agentModels, [id]: res };
			if (force) modelsForce = { ...modelsForce, [id]: false };
		});
	});

	function retryAgentModels() {
		const id = modelsAgentId;
		if (!id || agentModels[id] === 'loading') return;
		modelsForce = { ...modelsForce, [id]: true };
		const next = { ...agentModels };
		delete next[id];
		agentModels = next;
	}

	// Guardar la conversación con el reporte (la del server se pierde si se reinicia).
	$effect(() => {
		const events = stream?.events;
		if (!info || !events) return;
		saveChat(report.id, { sessionId: info.id, events: [...history, ...events] });
	});

	// Persistí agentSession cuando llega el id ACP (sesión nueva o retomada).
	$effect(() => {
		const acpId = info?.acpSessionId;
		if (!info || !acpId) return;
		const current = report.meta.agentSession;
		if (
			current?.sessionId === acpId &&
			current.agentId === info.agentId &&
			current.outputFilename === info.outputFilename
		) {
			return;
		}
		const updated = updateReportMeta(report.id, {
			agentSession: {
				agentId: info.agentId,
				sessionId: acpId,
				outputFilename: info.outputFilename
			},
			...(info.model ? { model: info.model } : {}),
			...(info.agentLabel ? { agent: info.agentLabel } : {})
		});
		if (updated) onreportupdated(updated);
	});

	// Precargar borrador en el compositor (sin enviar): el usuario completa y manda.
	$effect(() => {
		const ask = pendingAsk;
		if (!ask) return;
		pendingAutoSend = false;
		text = ask;
		mode = 'ask';
		onpendingaskconsumed?.();
		queueMicrotask(() => {
			composerEl?.focus();
			const len = composerEl?.value.length ?? 0;
			composerEl?.setSelectionRange(len, len);
		});
	});

	// Corregir con el agente: modo fix + texto; auto-envío cuando la sesión esté lista.
	$effect(() => {
		const fix = pendingFix;
		if (!fix?.text) return;
		pendingAsk = null;
		text = fix.text;
		mode = 'fix';
		pendingAutoSend = Boolean(fix.autoSend);
		queuedFixIds = fix.findingIds?.length ? [...fix.findingIds] : null;
		onpendingfixconsumed?.();
		bumpLogScroll();
		queueMicrotask(() => {
			composerEl?.focus();
			const len = composerEl?.value.length ?? 0;
			composerEl?.setSelectionRange(len, len);
			bumpLogScroll();
		});
	});

	let autoSendTimeout: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (!pendingAutoSend || !sessionReady || busy || !text.trim()) {
			if (autoSendTimeout) clearTimeout(autoSendTimeout);
			return;
		}
		pendingAutoSend = false;
		void send();
	});

	$effect(() => {
		// Timeout si sessionReady demora: fallback a envío manual después de 10s
		if (!pendingAutoSend || sessionReady || !text.trim()) {
			if (autoSendTimeout) clearTimeout(autoSendTimeout);
			return;
		}
		if (autoSendTimeout) clearTimeout(autoSendTimeout);
		autoSendTimeout = setTimeout(() => {
			pendingAutoSend = false;
			autoSendTimeout = null;
		}, 10000);
	});

	async function loadAgents() {
		try {
			agentOptions = await acpAgents();
			if (agentOptions.some((a) => a.id === agentChoice)) return;
			// Preferí el agente de la review (sesión o meta.agent) si sigue instalado.
			const preferred = reportAgentId(report.meta);
			if (preferred && agentOptions.some((a) => a.id === preferred)) {
				agentChoice = preferred;
				return;
			}
			// No elegir Cursor/Claude al azar: el usuario elige en el picker.
			agentChoice = '';
		} catch {
			agentOptions = [];
		}
	}

	// Mantener el select del header alineado con la sesión viva / ref guardada.
	$effect(() => {
		const id = info?.agentId || ref?.agentId;
		if (!id || switching || pendingSwitch) return;
		if (agentChoice !== id) agentChoice = id;
	});

	function lastFixUserText(events: SeqEvent[]): string {
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i];
			if (e.type === 'user' && e.mode === 'fix') return e.text;
		}
		return '';
	}

	function captureFixRequeue(): { text: string; findingIds: string[] | null } | null {
		const ids = queuedFixIds?.length ? queuedFixIds : awaitingFixIds?.length ? awaitingFixIds : null;
		const fromComposer = mode === 'fix' && text.trim() ? text.trim() : '';
		const fromHistory = lastFixUserText([...(history || []), ...(stream?.events ?? [])]);
		const body = fromComposer || fromHistory;
		const inFlight =
			Boolean(ids) ||
			pendingAutoSend ||
			(mode === 'fix' && Boolean(fromComposer)) ||
			Boolean(awaitingFixIds?.length);
		if (!inFlight || !body) return null;
		return { text: body, findingIds: ids };
	}

	/** Sin sesión abierta: solo cambia choice + reset modelo (picker). */
	function onPickerAgentChange() {
		modelChoice = '';
	}

	/**
	 * Con sesión viva o `meta.agentSession`: pedir confirmación ES.
	 * Mismo agente → no-op (AgentSelect ya no llama si id === value).
	 */
	function onHeaderAgentBeforeChange(nextId: string): boolean {
		if (nextId === (info?.agentId || ref?.agentId || agentChoice)) return false;
		if (!info && !ref) {
			modelChoice = '';
			return true;
		}
		if (headerSelectDisabled) return false;
		const next = agentOptions.find((a) => a.id === nextId);
		pendingSwitch = {
			nextId,
			nextLabel: agentShortName(nextId, next?.label || ''),
			currentLabel: headerAgentName
		};
		return false;
	}

	function matchAgentLabel(id: string): string {
		const opt = agentOptions.find((a) => a.id === id);
		return opt ? agentShortName(id, opt.label) : '';
	}

	function cancelPendingSwitch() {
		pendingSwitch = null;
	}

	async function confirmPendingSwitch() {
		const pending = pendingSwitch;
		pendingSwitch = null;
		if (!pending) return;
		await switchAgent(pending.nextId, pending.nextLabel, pending.currentLabel);
	}

	function onSwitchDialogKeydown(e: KeyboardEvent) {
		if (!pendingSwitch) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			cancelPendingSwitch();
		}
	}

	async function switchAgent(nextAgentId: string, nextLabel: string, currentLabel: string) {
		const nextAgent = agentOptions.find((a) => a.id === nextAgentId);
		if (!nextAgent || switching) return;
		if (nextAgentId === (info?.agentId || ref?.agentId)) return;

		const toLabel = nextLabel || agentShortName(nextAgentId, nextAgent.label);
		switching = true;
		switchingToLabel = toLabel;
		error = '';
		// Actualizar choice + provenance YA: el header / “Lanzando …” no deben seguir en el agente viejo.
		agentChoice = nextAgentId;
		modelChoice = '';
		const outputFilename =
			report.meta.agentSession?.outputFilename || report.meta.outputFilename || '';
		const transcript = [...(history || []), ...(stream?.events ?? [])];
		const pendingUserText = text.trim();
		const fixRequeue = captureFixRequeue();
		const chatRel = outputFilename ? handoffChatRelPath(outputFilename) : '';
		const handoffChatMarkdown = formatReadableChatMarkdown(transcript);
		const handoffNote = buildAgentSwitchHandoff({
			document: report.document,
			fromAgentLabel: currentLabel || headerAgentName,
			toAgentLabel: toLabel,
			transcript,
			chatRelPath: handoffChatMarkdown && chatRel ? chatRel : null
		});

		try {
			if (info && (stream?.busy || sending || info.busy)) {
				await cancelAgent({ id: info.id });
			}
			if (info) {
				await closeChat({ id: info.id });
			}

			stream?.close();
			stream = null;
			info = null;
			history = [];
			pendingEdit = false;
			awaitingFixIds = null;
			queuedFixIds = null;
			pendingAutoSend = false;
			clearChat(report.id);

			const cleared = updateReportMeta(report.id, {
				agentSession: undefined,
				agent: toLabel,
				model: undefined
			});
			if (cleared) onreportupdated(cleared);

			const opened = await openChat({
				agentId: nextAgentId,
				sessionId: '',
				outputFilename,
				repo: report.meta.repo,
				branch: report.meta.branch,
				base: report.meta.base,
				model: undefined,
				seed,
				handoffNote,
				handoffChatMarkdown: handoffChatMarkdown || undefined
			});
			attachSession(report.id, opened);

			// Encolar el primer mensaje: autoSend corre cuando `switching` baja y la sesión está lista
			// (así el preamble + handoffNote viajan con needsContext).
			if (fixRequeue) {
				text = fixRequeue.text;
				mode = 'fix';
				pendingAutoSend = true;
				queuedFixIds = fixRequeue.findingIds;
			} else if (pendingUserText) {
				text = pendingUserText;
				pendingAutoSend = true;
			} else {
				text = AGENT_SWITCH_BOOTSTRAP;
				mode = 'ask';
				pendingAutoSend = true;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			switching = false;
			switchingToLabel = '';
		}
	}

	async function connect(reportId: string, agentSession: SavedReport['meta']['agentSession']) {
		if (!agentSession) return;
		connecting = true;
		stream?.close();
		stream = null;
		info = null;
		error = '';
		try {
			const opened = await openChat({
				agentId: agentSession.agentId,
				sessionId: agentSession.sessionId,
				outputFilename: agentSession.outputFilename,
				repo: report.meta.repo,
				branch: report.meta.branch,
				base: report.meta.base,
				model: resolvedModel() || report.meta.model,
				seed
			});
			attachSession(reportId, opened);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			connecting = false;
		}
	}

	function attachSession(reportId: string, opened: AgentSessionInfo) {
		const saved = loadChat(reportId);
		history = saved.sessionId === opened.id ? [] : saved.events;
		info = opened;
		if (!modelChoice && opened.model) modelChoice = opened.model;
		else if (!modelChoice && report.meta.model) modelChoice = report.meta.model;
		const next = new AgentStream(opened.id, (event) => void onEvent(event));
		stream = next;
		next.connect();
	}

	async function startFresh() {
		const agent = agentOptions.find((a) => a.id === agentChoice) ?? null;
		if (!agent || starting) return;
		starting = true;
		error = '';
		try {
			const opened = await openChat({
				agentId: agent.id,
				sessionId: '',
				outputFilename: report.meta.agentSession?.outputFilename || '',
				repo: report.meta.repo,
				branch: report.meta.branch,
				base: report.meta.base,
				model: resolvedModel(),
				seed
			});
			attachSession(report.id, opened);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			starting = false;
		}
	}

	const needsAuth = $derived(
		info?.status === 'needs_auth' ||
			stream?.status === 'needs_auth' ||
			/autenticad|authentication|login|iniciar sesi[oó]n|inicio de sesi[oó]n/i.test(
				error || stream?.errorMessage || ''
			)
	);

	const authAgentId = $derived(info?.agentId || ref?.agentId || agentChoice || '');
	const authAgentLabel = $derived(
		info?.agentLabel || report.meta.agent || agentShortName(authAgentId, '') || 'el agente'
	);

	/** Mensaje legible de errores remote/HttpError (evita dump `{"message":…}`). */
	function remoteErrorMessage(err: unknown): string {
		if (err && typeof err === 'object') {
			const body = (err as { body?: { message?: unknown } }).body;
			if (body && typeof body.message === 'string' && body.message.trim()) return body.message.trim();
		}
		const raw = err instanceof Error ? err.message : String(err ?? '');
		const trimmed = raw.trim();
		if (trimmed.startsWith('{')) {
			try {
				const parsed = JSON.parse(trimmed) as { message?: unknown };
				if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim();
			} catch {
				/* ignore */
			}
		}
		return trimmed;
	}

	const canSwitchAccount = $derived(
		accountLoggedIn && (authAgentId === 'copilot' || authAgentId === 'claude')
	);

	/** Envío diferido tras login iniciado desde Preguntar/Corregir. */
	let pendingSendAfterAuth = $state<{ body: string; mode: ChatMode } | null>(null);

	function onLoginClick() {
		loginNote = '';
		error = '';
		if (authAgentId === 'copilot') {
			copilotPickHost = true;
			return;
		}
		void onOpenLogin();
	}

	async function onSwitchAccount() {
		loginBusy = true;
		loginNote = '';
		error = '';
		try {
			const result = await openAgentLogout({
				agentId: authAgentId,
				...(info?.id ? { id: info.id } : {})
			});
			loginNote = result.hint;
			if (result.warnings?.length) error = result.warnings.join(' ');
			if (result.ok) accountLoggedIn = false;
			accountRefresh += 1;
			if (authAgentId === 'copilot') copilotPickHost = true;
			else void onOpenLogin();
		} catch (err) {
			error = remoteErrorMessage(err);
		} finally {
			loginBusy = false;
		}
	}

	async function onOpenLogin(host?: string | null) {
		copilotPickHost = false;
		loginBusy = true;
		loginNote = '';
		error = '';
		try {
			const result = await openAgentLogin({
				agentId: authAgentId,
				...(info?.id ? { id: info.id } : {}),
				...(authAgentId === 'copilot' ? { host: host ?? '' } : {})
			});
			loginNote = result.resumed
				? 'Inicio de sesión ok. Reconectando…'
				: result.hint || 'Esperando que completes el inicio de sesión…';
			if (!result.resumed && ref) {
				await connect(report.id, ref);
			}
		} catch (err) {
			error = remoteErrorMessage(err);
		} finally {
			loginBusy = false;
			accountRefresh += 1;
		}
	}

	async function onEvent(event: SeqEvent) {
		if (event.type === 'status' && (event.status === 'error' || event.status === 'needs_auth')) {
			pendingEdit = false;
			awaitingFixIds = null;
			if (event.status === 'needs_auth' && event.message) error = event.message;
		}
		if (event.type === 'turn' && awaitingFixIds?.length) {
			const ids = awaitingFixIds;
			awaitingFixIds = null;
			if (event.stopReason === 'end_turn') {
				const summary = lastAgentMessageText([...(history || []), ...(stream?.events ?? [])]);
				onfixapplied?.({ findingIds: ids, summary });
			}
		}
		if (event.type !== 'review' || !event.ok || !pendingEdit || !info) return;
		pendingEdit = false;
		await reloadReport(event.filename);
	}

	/** Texto del agente tras el último user en modo fix (chunks `text` kind message). */
	function lastAgentMessageText(events: SeqEvent[]): string {
		let lastFixUser = -1;
		for (let i = events.length - 1; i >= 0; i--) {
			const e = events[i];
			if (e.type === 'user' && e.mode === 'fix') {
				lastFixUser = i;
				break;
			}
		}
		if (lastFixUser < 0) return '';
		const parts: string[] = [];
		for (let i = lastFixUser + 1; i < events.length; i++) {
			const e = events[i];
			if (e.type === 'turn') break;
			if (e.type === 'text' && e.kind === 'message') parts.push(e.text);
		}
		return parts.join('').trim();
	}

	/** El agente dejó el JSON válido: hidratar el viewer (reusa el companion `.diff` si existe). */
	async function reloadReport(filename: string) {
		updating = true;
		try {
			const loaded = await loadDetectedOutput({ repo: report.meta.repo, filename });
			if (!loaded?.payload) throw new Error(`No pude leer ${filename}.`);
			const meta = { ...parseReportMeta(loaded.payload, report.meta), agentSession: report.meta.agentSession };
			const document = await hydrateFromGit({
				repo: meta.repo,
				branch: meta.branch,
				base: meta.base,
				source: meta.source,
				payload: loaded.payload,
				outputFilename: filename
			});
			const updated = replaceReportDocument(report.id, document, meta);
			if (updated) onreportupdated(updated);
		} catch (err) {
			error = `No se pudo actualizar el reporte: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			updating = false;
		}
	}

	async function sendText(body: string, sendMode: ChatMode) {
		if (!body || !info || busy) return;
		sending = true;
		error = '';
		const fixIds = sendMode === 'fix' && queuedFixIds?.length ? queuedFixIds : null;
		queuedFixIds = null;
		try {
			if (sendMode === 'edit') pendingEdit = true;
			if (fixIds) awaitingFixIds = fixIds;
			const next = await sendMessage({
				id: info.id,
				text: body,
				mode: sendMode,
				model: resolvedModel()
			});
			info = next;
			if (next.model) modelChoice = next.model;
		} catch (err) {
			pendingEdit = false;
			if (fixIds) awaitingFixIds = null;
			error = err instanceof Error ? err.message : String(err);
		} finally {
			sending = false;
		}
	}

	async function send() {
		const body = text.trim();
		if (!body || !info || busy || loginBusy) return;
		const sendMode = mode;
		if (needsAuth) {
			pendingSendAfterAuth = { body, mode: sendMode };
			onLoginClick();
			return;
		}
		pendingSendAfterAuth = null;
		text = '';
		bumpLogScroll();
		await sendText(body, sendMode);
	}

	/** Tras login ok: enviar el mensaje encolado desde Preguntar/Corregir. */
	$effect(() => {
		if (needsAuth || loginBusy || !pendingSendAfterAuth || !sessionReady || busy) return;
		const queued = pendingSendAfterAuth;
		pendingSendAfterAuth = null;
		text = '';
		bumpLogScroll();
		untrack(() => void sendText(queued.body, queued.mode));
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void send();
		}
	}

	function onRespondPermission(detail: {
		requestId?: string;
		allow: boolean;
		allowAll?: boolean;
		scope?: 'once' | 'session' | 'always';
	}) {
		if (!info) return;
		void respondPermission({
			id: info.id,
			requestId: detail.requestId,
			allow: detail.allow,
			allowAll: detail.allowAll,
			scope: detail.scope
		})
			.then((next) => {
				info = next;
			})
			.catch((err) => {
				error = err instanceof Error ? err.message : String(err);
			});
	}

	function onSessionTrust(enabled: boolean) {
		if (!info) return;
		void setPermissionTrust({ id: info.id, enabled })
			.then((next) => {
				info = next;
			})
			.catch((err) => {
				error = err instanceof Error ? err.message : String(err);
			});
	}
</script>

<svelte:window onkeydown={onSwitchDialogKeydown} />

<div class="chat-shell" style:width="{chatWidth}px" aria-label="Chat con el agente">
	<!-- Arrastrar a la izquierda ensancha (borde izquierdo del panel). -->
	<ResizeHandle ondrag={(dx) => (chatWidth = clamp(chatWidth - dx, CHAT_WIDTH_MIN, CHAT_WIDTH_MAX))} />
	<aside class="chat">
	<header>
		<div class="title">
			{#if !showPicker && agentOptions.length}
				<div class="header-agent">
					<AgentSelect
						bind:value={agentChoice}
						options={agentOptions}
						disabled={headerSelectDisabled}
						beforechange={onHeaderAgentBeforeChange}
					/>
				</div>
			{:else}
				<AgentIcon id={headerAgentId} size={16} />
				<strong>{headerAgentName}</strong>
			{/if}
			{#if headerAgentId}
				<div class="header-account">
					<AgentAccountMenu
						agentId={headerAgentId}
						agentLabel={headerAgentName}
						sessionId={info?.id ?? ''}
						refreshToken={accountRefresh}
						onaccount={(loggedIn) => (accountLoggedIn = loggedIn)}
						onafterauth={() => {
							if (ref) void connect(report.id, ref);
						}}
					/>
				</div>
			{/if}
		</div>
		<button type="button" class="close" title="Cerrar" aria-label="Cerrar chat" onclick={onclose}>✕</button>
	</header>

	{#if showPicker}
		<div class="picker">
			<p class="hint">
				Este reporte no tiene sesión de agente. Elegí uno para chatear (se abre una sesión nueva con el contexto de
				la review).
			</p>
			{#if agentOptions.length}
				<label class="field">
					<span>Agente</span>
					<AgentSelect
						bind:value={agentChoice}
						options={agentOptions}
						onchange={onPickerAgentChange}
					/>
				</label>
				<label class="field">
					<span
						>Modelo{#if modelsStatus === 'loading'}
							<small> · consultando modelos (puede tardar)…</small>{/if}</span
					>
					<ModelSelect
						bind:value={modelChoice}
						options={modelOptions}
						disabled={modelsStatus === 'loading' || modelsStatus === undefined}
					/>
				</label>
				{#if modelsError}
					<p class="err models-error">
						{modelsError}
						<button type="button" class="linkish" onclick={retryAgentModels}>Reintentar</button>
					</p>
				{:else if modelsEmpty}
					<p class="hint models-error">
						El agente no devolvió modelos; usá el default o la lista fija.
						<button type="button" class="linkish" onclick={retryAgentModels}>Reintentar</button>
					</p>
				{/if}
				<button
					type="button"
					class="primary start"
					onclick={() => void startFresh()}
					disabled={!agentChoice || starting || modelsStatus === 'loading' || modelsStatus === undefined}
					aria-busy={starting}
				>
					{#if starting}
						<span class="spinner sm" aria-hidden="true"></span>
						Abriendo…
					{:else}
						Iniciar chat
					{/if}
				</button>
			{:else}
				<p class="hint">No hay agentes instalados en este equipo.</p>
			{/if}
			{#if error}
				<p class="err">{error}</p>
			{/if}
		</div>
	{:else}
		<div class="log-area">
			{#if !sessionReady}
				<div class="connecting" role="status" aria-live="polite">
					{#if (error || needsAuth) && !connecting}
						<p class="connecting-title">
							{needsAuth ? 'Autenticación requerida' : 'No se pudo abrir la sesión'}
						</p>
						<p class="err" style="padding: 0; text-align: left">
							{error ||
								stream?.errorMessage ||
								(needsAuth
									? `Necesitás iniciar sesión en ${authAgentLabel}.`
									: '')}
						</p>
						{#if needsAuth && authAgentId && copilotPickHost && !loginBusy}
							<div class="copilot-host-pick">
								<p class="hint">¿Con qué cuenta de GitHub?</p>
								<div class="auth-actions">
									<button type="button" class="primary start" onclick={() => void onOpenLogin('')}>
										GitHub.com
									</button>
									<button type="button" class="ghost" onclick={() => (copilotPickHost = false)}>
										Volver
									</button>
								</div>
								<label class="copilot-host-field">
									<span>Enterprise (hostname)</span>
									<input
										type="text"
										bind:value={copilotEnterpriseHost}
										placeholder="empresa.ghe.com"
										autocomplete="off"
									/>
								</label>
								<div class="auth-actions">
									<button
										type="button"
										class="primary start"
										disabled={!copilotEnterpriseHost.trim()}
										onclick={() => void onOpenLogin(copilotEnterpriseHost.trim())}
									>
										Continuar con Enterprise
									</button>
								</div>
								<p class="hint">
									En github.com, si tenés varias cuentas, elegí la corporativa en el browser del OAuth.
								</p>
							</div>
						{:else}
							<div class="auth-actions">
								{#if needsAuth && authAgentId}
									<button
										type="button"
										class="primary start"
										onclick={() => onLoginClick()}
										disabled={loginBusy}
									>
										{loginBusy
											? 'Esperando que completes el inicio de sesión…'
											: `Iniciar sesión en ${authAgentLabel}`}
									</button>
									{#if canSwitchAccount}
										<button
											type="button"
											class="ghost"
											onclick={() => void onSwitchAccount()}
											disabled={loginBusy}
										>
											Cambiar cuenta
										</button>
									{/if}
								{/if}
								{#if ref}
									<button
										type="button"
										class="primary start"
										onclick={() => void connect(report.id, ref)}
										disabled={loginBusy}
									>
										Reintentar
									</button>
								{/if}
							</div>
						{/if}
						{#if loginNote}
							<p class="hint" style="margin-top: 8px">{loginNote}</p>
						{/if}
					{:else}
						<div class="connecting-progress" aria-hidden="true">
							<div class="spinner"></div>
						</div>
						<p class="connecting-title">
							{launching ? `Lanzando ${connectingAgentName}…` : 'Conectando con el agente…'}
						</p>
						<p class="connecting-detail">
							{connectingAgentName}
							{#if displayModel && !switching}
								· {displayModel}
							{/if}
						</p>
						<ol class="connecting-phases">
							<li class:done={launching || sessionReady}>Abriendo sesión</li>
							<li class:done={sessionReady} class:active={launching && !sessionReady}>
								Esperando al agente
							</li>
							<li>Listo para chatear</li>
						</ol>
						<p class="connecting-hint">Puede tardar unos segundos al lanzar o retomar la sesión del agente.</p>
					{/if}
				</div>
			{:else}
				<div class="log">
					<AgentLog
						events={[...history, ...(stream?.events ?? [])]}
						busy={busy || updating}
						sessionId={info?.id ?? null}
						scrollSignal={logScrollSignal}
						onrespondpermission={onRespondPermission}
					/>
				</div>
			{/if}
		</div>
		{#if updating}
			<p class="note">Actualizando el reporte…</p>
		{/if}
		{#if stream?.gone}
			<p class="err">La sesión del agente se cerró. Recargá la página para retomarla.</p>
		{/if}
		{#if (error || needsAuth) && sessionReady}
			<p class="err">{error || stream?.errorMessage}</p>
			{#if needsAuth && authAgentId}
				{#if copilotPickHost && !loginBusy}
					<div class="copilot-host-pick" style="padding: 0 12px 8px">
						<p class="hint">¿Con qué cuenta de GitHub?</p>
						<div class="auth-actions">
							<button type="button" class="primary start" onclick={() => void onOpenLogin('')}>
								GitHub.com
							</button>
							<button type="button" class="ghost" onclick={() => (copilotPickHost = false)}>Volver</button>
						</div>
						<label class="copilot-host-field">
							<span>Enterprise (hostname)</span>
							<input
								type="text"
								bind:value={copilotEnterpriseHost}
								placeholder="empresa.ghe.com"
								autocomplete="off"
							/>
						</label>
						<button
							type="button"
							class="primary start"
							disabled={!copilotEnterpriseHost.trim()}
							onclick={() => void onOpenLogin(copilotEnterpriseHost.trim())}
						>
							Continuar con Enterprise
						</button>
					</div>
				{:else}
					<div class="auth-actions" style="padding: 0 12px 8px">
						<button type="button" class="primary start" onclick={() => onLoginClick()} disabled={loginBusy}>
							{loginBusy
								? 'Esperando que completes el inicio de sesión…'
								: `Iniciar sesión en ${authAgentLabel}`}
						</button>
						{#if canSwitchAccount}
							<button
								type="button"
								class="ghost"
								onclick={() => void onSwitchAccount()}
								disabled={loginBusy}
							>
								Cambiar cuenta
							</button>
						{/if}
					</div>
				{/if}
				{#if loginNote}
					<p class="hint" style="padding: 0 12px 8px">{loginNote}</p>
				{/if}
			{/if}
		{/if}
		<div class="composer">
			<div class="composer-top">
				<label class="mode-field">
					<span class="sr-only">Modo</span>
					<select class="mode-select" bind:value={mode} disabled={busy}>
						<option value="ask">Preguntar</option>
						<option value="edit">Modificar reporte</option>
						<option value="fix">Corregir código</option>
					</select>
				</label>
				<div class="model-field">
					<ModelSelect
						compact
						bind:value={modelChoice}
						options={modelOptions}
						disabled={!sessionReady || (Boolean(stream?.busy) && sending)}
					/>
				</div>
			</div>
			{#if modelsError}
				<p class="err models-error">
					{modelsError}
					<button type="button" class="linkish" onclick={retryAgentModels}>Reintentar</button>
				</p>
			{/if}
			<textarea
				bind:this={composerEl}
				bind:value={text}
				rows="3"
				placeholder={connecting || !sessionReady
					? 'Podés ir escribiendo; se habilita el envío cuando la sesión esté lista…'
					: mode === 'ask'
						? '¿Por qué el hallazgo f2 es bloqueante?'
						: mode === 'edit'
							? 'Bajá la severidad de f3 a low: el caso no llega a producción.'
							: 'Aplicá los hallazgos marcados para corregir en el código del repo.'}
				onkeydown={onKeydown}
			></textarea>
			<div class="actions">
				{#if info?.id}
					<TrustSessionToggle
						inline
						enabled={Boolean(info.sessionTrust)}
						onchange={onSessionTrust}
					/>
				{/if}
				<span class="actions-spacer"></span>
				{#if stream?.busy && info}
					<button type="button" onclick={() => void cancelAgent({ id: info!.id })}>Cancelar</button>
				{/if}
				<button
					type="button"
					class="primary"
					title="Ctrl+Enter"
					onclick={() => void send()}
					disabled={!text.trim() || busy || !sessionReady || loginBusy}
				>
					{#if connecting || !sessionReady}
						Conectando…
					{:else if sending || stream?.busy}
						Enviando…
					{:else if mode === 'ask'}
						Preguntar
					{:else if mode === 'edit'}
						Pedir cambio
					{:else}
						Corregir
					{/if}
				</button>
			</div>
		</div>
	{/if}
	</aside>
</div>

{#if pendingSwitch}
	<div class="switch-backdrop" role="presentation" onclick={cancelPendingSwitch}></div>
	<div
		class="switch-dialog"
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="switch-agent-title"
		aria-describedby="switch-agent-desc"
	>
		<h2 id="switch-agent-title">¿Cambiar a {pendingSwitch.nextLabel}?</h2>
		<p id="switch-agent-desc">
			Vas a perder la sesión abierta con <strong>{pendingSwitch.currentLabel}</strong> (historial de chat de ese
			agente). El reporte y el triage se mantienen. Se abrirá una sesión nueva y se le pasará el contexto de la
			review.
		</p>
		<div class="switch-actions">
			<button type="button" onclick={cancelPendingSwitch}>Cancelar</button>
			<button type="button" class="primary" onclick={() => void confirmPendingSwitch()}>Cambiar agente</button>
		</div>
	</div>
{/if}

<style>
	.chat-shell {
		flex-shrink: 0;
		display: flex;
		min-width: 0;
		min-height: 0;
		align-self: stretch;
	}

	.chat {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-left: 1px solid var(--border);
		background: var(--bg-elev);
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
	}
	.title {
		display: flex;
		align-items: center;
		gap: 8px 12px;
		min-width: 0;
		flex: 1;
		flex-wrap: wrap;
	}
	.title strong {
		font-size: 13.5px;
		font-weight: 650;
	}
	.header-agent {
		flex: 0 1 auto;
		min-width: 0;
		max-width: min(200px, 55%);
	}
	.header-account {
		flex: 1 1 auto;
		min-width: 0;
	}
	.header-account :global(.account-label) {
		max-width: min(140px, 40vw);
	}
	.header-agent :global(.agent-select .trigger) {
		min-height: 28px;
		padding: 4px 8px;
		font-size: 13px;
		font-weight: 650;
		background: transparent;
		border-color: transparent;
	}
	.header-agent :global(.agent-select .trigger:hover:not(:disabled)) {
		border-color: var(--border);
		background: var(--bg-card);
	}
	.header-agent :global(.agent-select .menu) {
		min-width: 180px;
	}
	.close {
		background: transparent;
		border: 0;
		color: var(--text-dim);
		font-size: 13px;
		cursor: pointer;
	}
	.log-area {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
	}
	.log {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.log :global(.log) {
		flex: 1;
		min-height: 0;
	}
	.picker {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		flex: 1;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
		color: var(--text-dim);
	}
	.field :global(.agent-select .trigger) {
		font-size: 13px;
		padding: 6px 8px;
	}
	.field small {
		color: var(--text-faint);
	}
	.start {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		align-self: flex-start;
		padding: 8px 14px;
		font-size: 13px;
		background: var(--btn-primary-bg);
		border: 1px solid var(--btn-primary-border);
		border-radius: var(--radius);
		color: var(--btn-primary-text);
	}
	.start:disabled {
		opacity: 0.5;
	}
	.hint,
	.note,
	.err {
		margin: 0;
		padding: 8px 14px;
		font-size: 12.5px;
		color: var(--text-faint);
	}
	.picker .hint {
		padding: 0;
	}
	.err {
		color: var(--danger);
	}
	.models-error {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px;
		padding-inline: 0;
	}
	.auth-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: center;
		margin-top: 8px;
	}
	.copilot-host-pick {
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: min(100%, 28rem);
	}
	.copilot-host-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
		color: var(--text-dim);
		text-align: left;
	}
	.copilot-host-field input {
		padding: 7px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: 13px;
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
	.connecting {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		gap: 8px;
		padding: 18px 12px;
		text-align: center;
	}
	.connecting-progress {
		display: flex;
		justify-content: center;
		margin-bottom: 4px;
	}
	.spinner {
		width: 28px;
		height: 28px;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: chat-spin 0.8s linear infinite;
	}
	.spinner.sm {
		width: 14px;
		height: 14px;
		border-width: 2px;
	}
	@keyframes chat-spin {
		to {
			transform: rotate(360deg);
		}
	}
	.connecting-title {
		margin: 0;
		font-size: 13.5px;
		font-weight: 650;
		color: var(--text);
	}
	.connecting-detail {
		margin: 0;
		font-size: 12px;
		font-family: var(--mono);
		color: var(--text-dim);
		word-break: break-all;
	}
	.connecting-phases {
		margin: 8px 0 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 4px;
		align-items: stretch;
		width: min(100%, 220px);
		text-align: left;
	}
	.connecting-phases li {
		position: relative;
		padding: 4px 8px 4px 22px;
		font-size: 12px;
		color: var(--text-dim);
		border: 1px solid transparent;
		border-radius: var(--radius);
	}
	.connecting-phases li::before {
		content: '';
		position: absolute;
		left: 6px;
		top: 50%;
		width: 7px;
		height: 7px;
		margin-top: -3.5px;
		border-radius: 50%;
		border: 1.5px solid var(--border);
		background: transparent;
	}
	.connecting-phases li.done {
		color: var(--text);
	}
	.connecting-phases li.done::before {
		border-color: var(--accent);
		background: var(--accent);
	}
	.connecting-phases li.active {
		color: var(--text);
		background: var(--bg-card);
		border-color: var(--border);
	}
	.connecting-phases li.active::before {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
	}
	.connecting-hint {
		margin: 4px 0 0;
		font-size: 12px;
		color: var(--text-dim);
		max-width: 28rem;
	}
	.composer {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 14px 14px;
		border-top: 1px solid var(--border);
	}
	.composer-top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}
	.model-field {
		flex: 0 1 auto;
		min-width: 0;
		max-width: min(280px, 48%);
		margin-left: auto;
	}
	.mode-field {
		flex: 0 1 auto;
		min-width: 0;
	}
	.mode-select {
		display: block;
		width: 100%;
		max-width: 180px;
		padding: 5px 8px;
		font: inherit;
		font-size: 12px;
		color: var(--text);
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		cursor: pointer;
	}
	.mode-select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	textarea {
		resize: vertical;
		min-height: 60px;
		font: inherit;
		font-size: 13px;
		padding: 8px;
		background: var(--bg-card);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.actions-spacer {
		flex: 1;
		min-width: 0;
	}
	.actions button {
		padding: 6px 12px;
		font-size: 12.5px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
	}
	.actions button.primary {
		background: var(--btn-primary-bg);
		border-color: var(--btn-primary-border);
		color: var(--btn-primary-text);
	}
	.actions button:disabled {
		opacity: 0.5;
	}

	.switch-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: color-mix(in srgb, #000 40%, transparent);
	}
	.switch-dialog {
		position: fixed;
		z-index: 81;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: min(420px, calc(100vw - 32px));
		padding: 18px 20px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: 0 16px 40px color-mix(in srgb, #000 28%, transparent);
	}
	.switch-dialog h2 {
		margin: 0 0 10px;
		font-size: 15px;
		font-weight: 650;
	}
	.switch-dialog p {
		margin: 0;
		font-size: 13px;
		line-height: 1.45;
		color: var(--text-dim);
	}
	.switch-dialog strong {
		color: var(--text);
		font-weight: 650;
	}
	.switch-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}
	.switch-actions button {
		padding: 7px 12px;
		font-size: 13px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		cursor: pointer;
	}
	.switch-actions button.primary {
		background: var(--btn-primary-bg);
		border-color: var(--btn-primary-border);
		color: var(--btn-primary-text);
	}

	@media (max-width: 768px) {
		.chat-shell {
			position: fixed;
			inset: 0;
			z-index: 60;
			width: 100% !important;
			max-width: none;
			background: var(--bg);
		}
		.chat-shell :global(.resize-handle),
		.chat-shell :global([aria-orientation='vertical']) {
			display: none;
		}
		.chat {
			border-left: 0;
			width: 100%;
		}
	}
</style>
