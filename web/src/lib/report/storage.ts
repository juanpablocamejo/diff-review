import type { SeqEvent } from './agent-events';
import { triageForSavedDocument } from './triage';
import type { ReportMeta, ReviewDocument, SavedReport, SavedReportSummary, StoredReport } from './types';

const LAST_META_KEY = 'diff-review:last-meta';
const REPORTS_INDEX_KEY = 'diff-review:reports-index';
const REPORT_KEY = (id: string) => `diff-review:report:${id}`;
const TRIAGE_KEY = (id: string) => `diff-review:triage:${id}`;
const CHAT_KEY = (id: string) => `diff-review:chat:${id}`;

/** Documento hidratado de la pestaña actual (no se serializa a localStorage si hay archivo en disco). */
const memoryReports = new Map<string, SavedReport>();

export type TriageState = {
	decided: Record<string, boolean>;
	fixSelected: Record<string, boolean>;
	/** Hallazgos ya corregidos por el agente (o marcados como tales). */
	corrected: Record<string, boolean>;
	/** Resumen corto de la corrección aplicada, por finding id. */
	fixedDetail: Record<string, string>;
};

function safeParse<T>(raw: string | null, fallback: T): T {
	if (!raw) return fallback;
	try {
		const parsed = JSON.parse(raw);
		return parsed ?? fallback;
	} catch {
		return fallback;
	}
}

type StoredLastMeta = Partial<ReportMeta> & { pr?: string; localRepo?: string };

function looksLikeStoredLocalPath(value: string) {
	const v = value.trim();
	if (!v || /^(https?:\/\/|git@|ssh:\/\/)/i.test(v)) return false;
	return /[\\/]/.test(v) || /^[A-Za-z]:/.test(v);
}

/** Ruta de carpeta local (no una URL git). */
export function isLocalRepoPath(value: string): boolean {
	return looksLikeStoredLocalPath(String(value || ''));
}

/** ¿Se puede volver a abrir el reporte leyendo `.diff-review/<outputFilename>`? */
export function canLoadFromDisk(meta: ReportMeta): boolean {
	const filename = String(meta.outputFilename || meta.agentSession?.outputFilename || '').trim();
	return meta.source === 'local' && looksLikeStoredLocalPath(meta.repo) && Boolean(filename);
}

export function reportOutputFilename(meta: ReportMeta): string {
	return String(meta.outputFilename || meta.agentSession?.outputFilename || '').trim();
}

function readIndex(): SavedReportSummary[] {
	return safeParse<SavedReportSummary[]>(localStorage.getItem(REPORTS_INDEX_KEY), []);
}

function purgeStoredReport(id: string) {
	try {
		localStorage.removeItem(REPORT_KEY(id));
		localStorage.removeItem(TRIAGE_KEY(id));
		localStorage.removeItem(CHAT_KEY(id));
	} catch {
		/* idem */
	}
	memoryReports.delete(id);
}

function persistJson(key: string, json: string): boolean {
	try {
		localStorage.setItem(key, json);
		return true;
	} catch {
		return false;
	}
}

function embeddedReportIds(): { id: string; savedAt: string }[] {
	const found: { id: string; savedAt: string }[] = [];
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key?.startsWith('diff-review:report:')) continue;
			const id = key.slice('diff-review:report:'.length);
			const parsed = safeParse<StoredReport | null>(localStorage.getItem(key), null);
			if (!parsed?.document) continue;
			found.push({ id, savedAt: String(parsed.savedAt || '') });
		}
	} catch {
		/* localStorage no disponible */
	}
	found.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
	return found;
}

/** Persiste un blob grande (import sin disco); suelta documentos embebidos viejos si hace falta. */
function persistHeavy(id: string, json: string): boolean {
	if (persistJson(REPORT_KEY(id), json)) return true;
	for (const victim of embeddedReportIds()) {
		if (victim.id === id) continue;
		try {
			localStorage.removeItem(REPORT_KEY(victim.id));
		} catch {
			/* ignore */
		}
		memoryReports.delete(victim.id);
		if (persistJson(REPORT_KEY(id), json)) return true;
	}
	return false;
}

function toStored(full: SavedReport, embedDocument: boolean): StoredReport {
	return {
		id: full.id,
		meta: full.meta,
		savedAt: full.savedAt,
		...(embedDocument ? { document: full.document } : {})
	};
}

function writeStored(stored: StoredReport): void {
	const embed = Boolean(stored.document);
	const json = JSON.stringify(stored);
	if (embed) persistHeavy(stored.id, json);
	else persistJson(REPORT_KEY(stored.id), json);
}

export function loadLastMeta(): ReportMeta {
	const fallback: ReportMeta = { source: 'local', repo: '', branch: '', base: 'develop' };
	const parsed = safeParse<StoredLastMeta>(localStorage.getItem(LAST_META_KEY), fallback);
	const source = parsed.source === 'url' ? 'url' : 'local';
	return {
		source,
		repo: String(parsed.repo || ''),
		branch: String(parsed.branch || ''),
		base: String(parsed.base || 'develop'),
		remoteUrl: parsed.remoteUrl ? String(parsed.remoteUrl) : undefined
	};
}

/** Ruta local recordada aunque el último source haya sido URL (toggle / reload). */
export function loadLastLocalRepo(): string {
	const parsed = safeParse<StoredLastMeta>(localStorage.getItem(LAST_META_KEY), {});
	const remembered = String(parsed.localRepo || '').trim();
	if (remembered && looksLikeStoredLocalPath(remembered)) return remembered;
	if (parsed.source !== 'url') {
		const repo = String(parsed.repo || '').trim();
		if (looksLikeStoredLocalPath(repo)) return repo;
	}
	return '';
}

export function saveLastMeta(meta: ReportMeta, localRepo?: string) {
	try {
		const prev = safeParse<StoredLastMeta>(localStorage.getItem(LAST_META_KEY), {});
		const fromArg = localRepo?.trim() || '';
		const fromMeta = meta.source === 'local' && looksLikeStoredLocalPath(meta.repo) ? meta.repo.trim() : '';
		const fromPrev = String(prev.localRepo || '').trim();
		const remembered =
			(fromArg && looksLikeStoredLocalPath(fromArg) && fromArg) ||
			fromMeta ||
			(fromPrev && looksLikeStoredLocalPath(fromPrev) ? fromPrev : '');
		localStorage.setItem(
			LAST_META_KEY,
			JSON.stringify({
				source: meta.source === 'url' ? 'url' : 'local',
				repo: meta.repo,
				branch: meta.branch,
				base: meta.base,
				...(meta.remoteUrl ? { remoteUrl: meta.remoteUrl } : {}),
				...(remembered ? { localRepo: remembered } : {})
			})
		);
	} catch {
		/* localStorage lleno o deshabilitado: no es fatal, el prompt sigue andando en memoria. */
	}
}

/** Índice viejo (`diff-review:reports-index`). Ya no es el catálogo: solo se lee para migrar. */
export function readLegacyReportIndex(): SavedReportSummary[] {
	return readIndex();
}

/** Deja el índice viejo en las entradas que todavía no se pudieron migrar, o lo borra. */
export function replaceLegacyReportIndex(index: SavedReportSummary[]) {
	if (!index.length) {
		try {
			localStorage.removeItem(REPORTS_INDEX_KEY);
		} catch {
			/* ignore */
		}
		return;
	}
	persistJson(REPORTS_INDEX_KEY, JSON.stringify(index));
}

/** filename → viewerId que el navegador ya conoce, para no inventar otro al estampar el JSON. */
export function viewerIdHints(): { filename: string; viewerId: string }[] {
	const hints: { filename: string; viewerId: string }[] = [];
	const seen = new Set<string>();
	const push = (filename: string, viewerId: string) => {
		const name = String(filename || '').trim();
		const id = String(viewerId || '').trim();
		if (!name || !id || seen.has(name)) return;
		seen.add(name);
		hints.push({ filename: name, viewerId: id });
	};
	for (const item of readIndex()) push(String(item.outputFilename || ''), item.id);
	for (const report of memoryReports.values()) push(reportOutputFilename(report.meta), report.id);
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key?.startsWith('diff-review:report:')) continue;
			const stored = loadStoredReport(key.slice('diff-review:report:'.length));
			if (!stored) continue;
			push(reportOutputFilename(stored.meta), stored.id);
		}
	} catch {
		/* ignore */
	}
	return hints;
}

export function viewerIdAssociatedWith(filename: string): string {
	const name = String(filename || '').trim();
	if (!name) return '';
	return viewerIdHints().find((hint) => hint.filename === name)?.viewerId || '';
}

export function rememberReport(full: SavedReport): void {
	memoryReports.set(full.id, full);
	const existing = loadStoredReport(full.id);
	if (existing?.document) return;
	if (!canLoadFromDisk(full.meta)) return;
	writeStored(toStored(full, false));
}

export function saveReport(document: ReviewDocument, meta: ReportMeta): SavedReport {
	const outputFilename = reportOutputFilename(meta);
	const id = String(meta.viewerId || '').trim() || crypto.randomUUID();
	const normalized: ReportMeta = {
		...meta,
		viewerId: id,
		...(outputFilename ? { outputFilename } : {})
	};
	const savedAt = new Date().toISOString();
	const full: SavedReport = { id, meta: normalized, document, savedAt };
	memoryReports.set(id, full);
	writeStored(toStored(full, !canLoadFromDisk(normalized)));
	return full;
}

/** Actualiza solo el meta del reporte (p. ej. al guardar `agentSession` después de abrir el chat). */
export function updateReportMeta(id: string, patch: Partial<ReportMeta>): SavedReport | null {
	const mem = memoryReports.get(id);
	const stored = loadStoredReport(id);
	if (!mem && !stored) return null;

	const baseMeta = mem?.meta || stored!.meta;
	const filename = reportOutputFilename({ ...baseMeta, ...patch });
	const viewerId = String(patch.viewerId || baseMeta.viewerId || id).trim() || id;
	const nextMeta: ReportMeta = {
		...baseMeta,
		...patch,
		viewerId,
		...(filename ? { outputFilename: filename } : {})
	};
	// Permitir borrar la sesión ACP (`{ agentSession: undefined }`) al cambiar de agente.
	if ('agentSession' in patch && patch.agentSession == null) {
		delete nextMeta.agentSession;
	}

	if (mem?.document || stored?.document) {
		return replaceReportDocument(id, (mem?.document || stored!.document)!, nextMeta);
	}

	const savedAt = mem?.savedAt || stored!.savedAt;
	writeStored({ id, meta: nextMeta, savedAt });
	if (mem) {
		const updated = { ...mem, meta: nextMeta };
		memoryReports.set(id, updated);
		return updated;
	}
	return null;
}

export function replaceReportDocument(id: string, document: ReviewDocument, meta: ReportMeta): SavedReport | null {
	const stored = loadStoredReport(id);
	const mem = memoryReports.get(id);
	if (!stored && !mem) return null;

	const savedAt = mem?.savedAt || stored!.savedAt;
	const filename = reportOutputFilename(meta) || reportOutputFilename(mem?.meta || stored!.meta);
	const viewerId = String(meta.viewerId || mem?.meta.viewerId || stored?.meta.viewerId || id).trim() || id;
	const nextMeta: ReportMeta = {
		...(mem?.meta || stored!.meta),
		...meta,
		viewerId,
		...(filename ? { outputFilename: filename } : {})
	};
	const full: SavedReport = { id, meta: nextMeta, document, savedAt };
	memoryReports.set(id, full);
	writeStored(toStored(full, !canLoadFromDisk(nextMeta)));
	saveTriage(id, triageForSavedDocument(document.findings, loadTriage(id)));
	return full;
}

/** Historial del chat con el agente de un reporte. `sessionId` = sesión del server que produjo `events`. */
export type ChatHistory = { sessionId: string; events: SeqEvent[] };

export function loadChat(id: string): ChatHistory {
	return safeParse(localStorage.getItem(CHAT_KEY(id)), { sessionId: '', events: [] });
}

export function saveChat(id: string, chat: ChatHistory) {
	persistJson(CHAT_KEY(id), JSON.stringify(chat));
}

/** Borra el historial de chat guardado con el reporte (p. ej. al cambiar de agente). */
export function clearChat(id: string) {
	try {
		localStorage.removeItem(CHAT_KEY(id));
	} catch {
		/* ignore */
	}
}

/** Entrada cruda de localStorage (sin hidratar). */
export function loadStoredReport(id: string): StoredReport | null {
	const key = String(id || '');
	if (!key) return null;
	const parsed = safeParse<StoredReport | SavedReport | null>(localStorage.getItem(REPORT_KEY(key)), null);
	if (!parsed?.id) return null;
	return {
		id: parsed.id,
		meta: parsed.meta,
		savedAt: parsed.savedAt,
		...(parsed.document ? { document: parsed.document } : {})
	};
}

/** Solo memoria o entradas viejas con documento embebido. Para disco, usar `resolveSavedReport`. */
export function loadReportById(id: string): SavedReport | null {
	const key = String(id || '');
	if (!key) return null;
	const cached = memoryReports.get(key);
	if (cached) return cached;
	const stored = loadStoredReport(key);
	if (stored?.document) {
		const full: SavedReport = {
			id: stored.id,
			meta: stored.meta,
			document: stored.document,
			savedAt: stored.savedAt
		};
		memoryReports.set(key, full);
		return full;
	}
	return null;
}

export function deleteReport(id: string) {
	purgeStoredReport(id);
	const index = readIndex();
	if (index.some((item) => item.id === id)) {
		replaceLegacyReportIndex(index.filter((item) => item.id !== id));
	}
}

export function loadTriage(id: string): TriageState {
	const raw = safeParse<Partial<TriageState> | null>(localStorage.getItem(TRIAGE_KEY(id)), null);
	return {
		decided: raw?.decided ?? {},
		fixSelected: raw?.fixSelected ?? {},
		corrected: raw?.corrected ?? {},
		fixedDetail: raw?.fixedDetail ?? {}
	};
}

export function saveTriage(id: string, triage: TriageState) {
	persistJson(TRIAGE_KEY(id), JSON.stringify(triage));
}
