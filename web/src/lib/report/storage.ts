import type { SeqEvent } from './agent-events';
import type { ReportMeta, ReviewDocument, SavedReport, SavedReportSummary } from './types';

const LAST_META_KEY = 'diff-review:last-meta';
const REPORTS_INDEX_KEY = 'diff-review:reports-index';
const REPORT_KEY = (id: string) => `diff-review:report:${id}`;
const TRIAGE_KEY = (id: string) => `diff-review:triage:${id}`;

const MAX_REPORTS = 50;

export type TriageState = {
	decided: Record<string, boolean>;
	fixSelected: Record<string, boolean>;
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

export function loadLastMeta(): ReportMeta {
	const fallback: ReportMeta = { source: 'local', repo: '', branch: '', base: 'develop' };
	const parsed = safeParse<Partial<ReportMeta> & { pr?: string }>(localStorage.getItem(LAST_META_KEY), fallback);
	const source = parsed.source === 'url' ? 'url' : 'local';
	return {
		source,
		repo: String(parsed.repo || ''),
		branch: String(parsed.branch || ''),
		base: String(parsed.base || 'develop'),
		remoteUrl: parsed.remoteUrl ? String(parsed.remoteUrl) : undefined
	};
}

export function saveLastMeta(meta: ReportMeta) {
	try {
		localStorage.setItem(
			LAST_META_KEY,
			JSON.stringify({
				source: meta.source === 'url' ? 'url' : 'local',
				repo: meta.repo,
				branch: meta.branch,
				base: meta.base,
				...(meta.remoteUrl ? { remoteUrl: meta.remoteUrl } : {})
			})
		);
	} catch {
		/* localStorage lleno o deshabilitado: no es fatal, el prompt sigue andando en memoria. */
	}
}

export function loadReportsIndex(): SavedReportSummary[] {
	const index = safeParse<SavedReportSummary[]>(localStorage.getItem(REPORTS_INDEX_KEY), []);
	let changed = false;
	const enriched = index.map((item) => {
		if (item.agent || item.model) return item;
		const full = loadReportById(item.id);
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
	try {
		localStorage.setItem(REPORTS_INDEX_KEY, JSON.stringify(index));
	} catch {
		/* idem */
	}
}

export function saveReport(document: ReviewDocument, meta: ReportMeta): SavedReport {
	const id = crypto.randomUUID();
	const savedAt = new Date().toISOString();
	const full: SavedReport = { id, meta, document, savedAt };

	const blockerCount = document.findings.filter((f) => f.blocking).length;
	const qualityCount = document.findings.filter((f) => f.class === 'quality').length;
	const agent = meta.agent?.trim();
	const model = meta.model?.trim();
	const summary: SavedReportSummary = {
		id,
		repo: meta.repo,
		branch: meta.branch,
		base: meta.base,
		savedAt,
		groupCount: document.groups.length,
		blockerCount,
		qualityCount,
		intent: document.intent,
		...(agent ? { agent } : {}),
		...(model ? { model } : {})
	};

	try {
		localStorage.setItem(REPORT_KEY(id), JSON.stringify(full));
	} catch {
		/* si el doc es enorme y no entra, igual devolvemos el reporte para esta sesión */
	}
	const index = [summary, ...loadReportsIndex().filter((r) => r.id !== id)].slice(0, MAX_REPORTS);
	saveReportsIndex(index);

	return full;
}

/**
 * Reemplaza el documento de un reporte existente (p. ej. después de que el agente corrigió el JSON). El triage de los
 * hallazgos que siguen existiendo se conserva; el de los que desaparecieron se descarta.
 */
export function replaceReportDocument(id: string, document: ReviewDocument, meta: ReportMeta): SavedReport | null {
	const current = loadReportById(id);
	if (!current) return null;
	const full: SavedReport = { ...current, meta, document };
	try {
		localStorage.setItem(REPORT_KEY(id), JSON.stringify(full));
	} catch {
		/* idem saveReport */
	}

	const index = loadReportsIndex().map((item) =>
		item.id === id
			? {
					...item,
					groupCount: document.groups.length,
					blockerCount: document.findings.filter((f) => f.blocking).length,
					qualityCount: document.findings.filter((f) => f.class === 'quality').length,
					intent: document.intent
				}
			: item
	);
	saveReportsIndex(index);

	const ids = new Set(document.findings.map((f) => f.id));
	const keep = (record: Record<string, boolean>) =>
		Object.fromEntries(Object.entries(record).filter(([fid]) => ids.has(fid)));
	const triage = loadTriage(id);
	saveTriage(id, { decided: keep(triage.decided), fixSelected: keep(triage.fixSelected) });

	return full;
}

const CHAT_KEY = (id: string) => `diff-review:chat:${id}`;

/** Historial del chat con el agente de un reporte. `sessionId` = sesión del server que produjo `events`. */
export type ChatHistory = { sessionId: string; events: SeqEvent[] };

export function loadChat(id: string): ChatHistory {
	return safeParse(localStorage.getItem(CHAT_KEY(id)), { sessionId: '', events: [] });
}

export function saveChat(id: string, chat: ChatHistory) {
	try {
		localStorage.setItem(CHAT_KEY(id), JSON.stringify(chat));
	} catch {
		/* idem */
	}
}

export function loadReportById(id: string): SavedReport | null {
	return safeParse<SavedReport | null>(localStorage.getItem(REPORT_KEY(id)), null);
}

export function deleteReport(id: string) {
	try {
		localStorage.removeItem(REPORT_KEY(id));
		localStorage.removeItem(TRIAGE_KEY(id));
		localStorage.removeItem(CHAT_KEY(id));
	} catch {
		/* idem */
	}
	saveReportsIndex(loadReportsIndex().filter((r) => r.id !== id));
}

export function loadTriage(id: string): TriageState {
	return safeParse(localStorage.getItem(TRIAGE_KEY(id)), { decided: {}, fixSelected: {} });
}

export function saveTriage(id: string, triage: TriageState) {
	try {
		localStorage.setItem(TRIAGE_KEY(id), JSON.stringify(triage));
	} catch {
		/* idem */
	}
}
