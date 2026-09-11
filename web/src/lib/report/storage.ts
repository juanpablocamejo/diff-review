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
		base: String(parsed.base || 'develop')
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
				base: meta.base
			})
		);
	} catch {
		/* localStorage lleno o deshabilitado: no es fatal, el prompt sigue andando en memoria. */
	}
}

export function loadReportsIndex(): SavedReportSummary[] {
	return safeParse(localStorage.getItem(REPORTS_INDEX_KEY), []);
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
	const summary: SavedReportSummary = {
		id,
		repo: meta.repo,
		branch: meta.branch,
		base: meta.base,
		savedAt,
		groupCount: document.groups.length,
		blockerCount,
		qualityCount,
		intent: document.intent
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

export function loadReportById(id: string): SavedReport | null {
	return safeParse<SavedReport | null>(localStorage.getItem(REPORT_KEY(id)), null);
}

export function deleteReport(id: string) {
	try {
		localStorage.removeItem(REPORT_KEY(id));
		localStorage.removeItem(TRIAGE_KEY(id));
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
