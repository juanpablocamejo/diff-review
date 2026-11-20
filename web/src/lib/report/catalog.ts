import { serializeReviewPayload } from './document';
import { adoptReviewFiles, listReviewCatalog } from './git.remote';
import {
	deleteReport,
	isLocalRepoPath,
	loadReportById,
	loadStoredReport,
	readLegacyReportIndex,
	replaceLegacyReportIndex,
	reportOutputFilename,
	viewerIdHints
} from './storage';
import type { ReportMeta, SavedReportSummary } from './types';

function localRepoFor(item: SavedReportSummary, openRepo: string): string {
	const stored = loadStoredReport(item.id);
	const candidates = [item.repo, stored?.meta.repo, openRepo];
	for (const candidate of candidates) {
		if (isLocalRepoPath(String(candidate || ''))) return String(candidate).trim();
	}
	return '';
}

/**
 * Una vez: el índice de localStorage deja de ser la lista.
 * Si el JSON existe, se estampa con el UUID viejo. Si no existe pero el documento sigue
 * en el navegador, se escribe `.diff-review/<nombre>.json`. Si no hay ninguno, se olvida.
 */
export async function migrateLegacyCatalog(openRepo: string): Promise<void> {
	const index = readLegacyReportIndex();
	if (!index.length) {
		replaceLegacyReportIndex([]);
		return;
	}

	const failed: SavedReportSummary[] = [];
	const drop = new Set<string>();
	const groups = new Map<string, { item: SavedReportSummary; filename: string; payload?: unknown }[]>();

	for (const item of index) {
		const stored = loadStoredReport(item.id);
		const mem = loadReportById(item.id);
		const meta: ReportMeta | undefined = mem?.meta || stored?.meta;
		const document = mem?.document || stored?.document;
		const filename = String(item.outputFilename || (meta ? reportOutputFilename(meta) : '')).trim();
		const repo = localRepoFor(item, openRepo);
		if (!filename) {
			if (!document) drop.add(item.id);
			continue;
		}
		if (!repo) {
			if (document) failed.push(item);
			else drop.add(item.id);
			continue;
		}
		let payload: unknown;
		if (document && meta) {
			payload = JSON.parse(
				serializeReviewPayload(document, {
					...meta,
					repo,
					viewerId: meta.viewerId || item.id,
					outputFilename: filename
				})
			);
		}
		const list = groups.get(repo) || [];
		list.push({ item, filename, ...(payload ? { payload } : {}) });
		groups.set(repo, list);
	}

	for (const [repo, entries] of groups) {
		try {
			const results = await adoptReviewFiles({
				repo,
				items: entries.map((entry) => ({
					filename: entry.filename,
					viewerId: entry.item.id,
					...(entry.payload ? { payload: entry.payload } : {})
				}))
			});
			const byName = new Map(results.map((result) => [result.filename, result]));
			for (const entry of entries) {
				const result = byName.get(entry.filename);
				if (result && result.status !== 'missing') continue;
				const still = loadStoredReport(entry.item.id)?.document || loadReportById(entry.item.id)?.document;
				if (!still) drop.add(entry.item.id);
			}
		} catch {
			failed.push(...entries.map((entry) => entry.item));
		}
	}

	replaceLegacyReportIndex(failed);
	for (const id of drop) deleteReport(id);
}

/** Tarjetas del repo que está en el formulario. Vacío si no es una carpeta local. */
export async function loadRepoCatalog(repo: string): Promise<SavedReportSummary[]> {
	const path = String(repo || '').trim();
	if (!isLocalRepoPath(path)) return [];
	await migrateLegacyCatalog(path);
	return listReviewCatalog({ repo: path, hints: viewerIdHints() });
}
