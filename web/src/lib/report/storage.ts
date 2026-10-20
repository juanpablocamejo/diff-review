import type { SeqEvent } from './agent-events';
import type { ReportMeta, ReviewDocument, SavedReport, SavedReportSummary, StoredReport } from './types';

const LAST_META_KEY = 'diff-review:last-meta';
const REPORTS_INDEX_KEY = 'diff-review:reports-index';
const REPORT_KEY = (id: string) => `diff-review:report:${id}`;
const TRIAGE_KEY = (id: string) => `diff-review:triage:${id}`;
const CHAT_KEY = (id: string) => `diff-review:chat:${id}`;

const MAX_REPORTS = 50;

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

/** Persiste un blob grande (import sin disco); evacúa reportes viejos si hace falta. */
function persistHeavy(id: string, json: string): boolean {
	if (persistJson(REPORT_KEY(id), json)) return true;
	const index = readIndex().filter((r) => r.id !== id);
	for (let i = index.length - 1; i >= 0; i--) {
		purgeStoredReport(index[i].id);
		index.splice(i, 1);
		if (persistJson(REPORT_KEY(id), json)) {
			saveReportsIndex(index);
			return true;
		}
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

export function loadReportsIndex(): SavedReportSummary[] {
	const index = readIndex();
	let changed = false;
	const enriched = index.map((item) => {
		if (item.agent || item.model) return item;
		const full = loadReportById(item.id) || loadStoredReport(item.id);
		const agent = full?.meta?.agent?.trim();
		const model = full?.meta?.model?.trim();
		if (!agent && !model) return item;
		changed = true;
		return { ...item, ...(agent ? { agent } : {}), ...(model ? { model } : {}) };
	});
	if (changed) saveReportsIndex(enriched);
	return enriched;
}

function saveReportsIndex(index: SavedReportSummary[]) {
	persistJson(REPORTS_INDEX_KEY, JSON.stringify(index));
}

function trimIndex(next: SavedReportSummary[]): SavedReportSummary[] {
	const trimmed = next.slice(0, MAX_REPORTS);
	const keep = new Set(trimmed.map((r) => r.id));
	for (const old of next) {
		if (keep.has(old.id)) continue;
		purgeStoredReport(old.id);
	}
	return trimmed;
}

export function rememberReport(full: SavedReport): void {
	memoryReports.set(full.id, full);
}

export function saveReport(document: ReviewDocument, meta: ReportMeta): SavedReport {
	const outputFilename = reportOutputFilename(meta);
	const normalized: ReportMeta = {
		...meta,
		...(outputFilename ? { outputFilename } : {})
	};
	const id = crypto.randomUUID();
	const savedAt = new Date().toISOString();
	const full: SavedReport = { id, meta: normalized, document, savedAt };
	memoryReports.set(id, full);

	const disk = canLoadFromDisk(normalized);
	writeStored(toStored(full, !disk));

	const blockerCount = document.findings.filter((f) => f.blocking).length;
	const qualityCount = document.findings.filter((f) => f.class === 'quality').length;
	const agent = normalized.agent?.trim();
	const model = normalized.model?.trim();
	const summary: SavedReportSummary = {
		id,
		repo: normalized.repo,
		branch: normalized.branch,
		base: normalized.base,
		savedAt,
		groupCount: document.groups.length,
		blockerCount,
		qualityCount,
		intent: document.intent,
		...(agent ? { agent } : {}),
		...(model ? { model } : {})
	};

	saveReportsIndex(trimIndex([summary, ...readIndex().filter((r) => r.id !== id)]));
	return full;
}

/** Actualiza solo el meta del reporte (p. ej. al guardar `agentSession` después de abrir el chat). */
export function updateReportMeta(id: string, patch: Partial<ReportMeta>): SavedReport | null {
	const mem = memoryReports.get(id);
	const stored = loadStoredReport(id);
	if (!mem && !stored) return null;

	const baseMeta = mem?.meta || stored!.meta;
	const filename = reportOutputFilename({ ...baseMeta, ...patch });
	const nextMeta: ReportMeta = {
		...baseMeta,
		...patch,
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
	const nextMeta: ReportMeta = {
		...(mem?.meta || stored!.meta),
		...meta,
		...(filename ? { outputFilename: filename } : {})
	};
	const full: SavedReport = { id, meta: nextMeta, document, savedAt };
	memoryReports.set(id, full);
	writeStored(toStored(full, !canLoadFromDisk(nextMeta)));

	const index = readIndex().map((item) =>
		item.id === id
			? {
					...item,
					groupCount: document.groups.length,
					blockerCount: document.findings.filter((f) => f.blocking).length,
					qualityCount: document.findings.filter((f) => f.class === 'quality').length,
					intent: document.intent,
					...(nextMeta.agent?.trim() ? { agent: nextMeta.agent.trim() } : {}),
					...(nextMeta.model?.trim() ? { model: nextMeta.model.trim() } : {})
				}
			: item
	);
	saveReportsIndex(index);

	const ids = new Set(document.findings.map((f) => f.id));
	const keepBool = (record: Record<string, boolean>) =>
		Object.fromEntries(Object.entries(record).filter(([fid]) => ids.has(fid)));
	const keepStr = (record: Record<string, string>) =>
		Object.fromEntries(Object.entries(record).filter(([fid]) => ids.has(fid)));
	const triage = loadTriage(id);
	saveTriage(id, {
		decided: keepBool(triage.decided),
		fixSelected: keepBool(triage.fixSelected),
		corrected: keepBool(triage.corrected),
		fixedDetail: keepStr(triage.fixedDetail)
	});

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
	saveReportsIndex(readIndex().filter((r) => r.id !== id));
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
