import { coerceDocument, hasUsableDiffs } from './document';
import { hydrateFromGit, loadDetectedOutput } from './git.remote';
import {
	canLoadFromDisk,
	loadReportById,
	loadReportsIndex,
	loadStoredReport,
	rememberReport,
	reportOutputFilename
} from './storage';
import type { ReportMeta, SavedReport, StoredReport } from './types';

function metaFromIndex(id: string): ReportMeta | null {
	const item = loadReportsIndex().find((r) => r.id === id);
	if (!item) return null;
	const filename = String(item.outputFilename || '').trim();
	const repo = String(item.repo || '').trim();
	if (!filename || !repo) return null;
	return {
		source: 'local',
		repo,
		branch: item.branch || '',
		base: item.base || 'develop',
		outputFilename: filename,
		...(item.agent ? { agent: item.agent } : {}),
		...(item.model ? { model: item.model } : {})
	};
}

async function hydrateDiskReport(
	stored: Pick<StoredReport, 'id' | 'meta' | 'savedAt'>
): Promise<SavedReport | null> {
	if (!canLoadFromDisk(stored.meta)) return null;

	const filename = reportOutputFilename(stored.meta);
	const loaded = await loadDetectedOutput({ repo: stored.meta.repo, filename });
	if (!loaded?.payload) return null;

	let document;
	try {
		document = await hydrateFromGit({
			repo: stored.meta.repo,
			branch: stored.meta.branch,
			base: stored.meta.base || 'develop',
			source: stored.meta.source,
			payload: loaded.payload,
			outputFilename: filename
		});
	} catch {
		// Sin git usable: el JSON en disco ya trae el documento (p. ej. files + diffs).
		const fallback = coerceDocument(loaded.payload);
		if (!fallback.groups.length && !fallback.findings.length && !hasUsableDiffs(fallback)) {
			return null;
		}
		document = fallback;
	}

	const full: SavedReport = {
		id: stored.id,
		meta: { ...stored.meta, outputFilename: filename },
		document,
		savedAt: stored.savedAt
	};
	rememberReport(full);
	return full;
}

/** Abre un reporte: memoria / documento embebido, o rehidrata desde `.diff-review/` en disco. */
export async function resolveSavedReport(id: string): Promise<SavedReport | null> {
	const key = String(id || '');
	if (!key) return null;

	const cached = loadReportById(key);
	if (cached) return cached;

	const stored = loadStoredReport(key);
	if (stored?.document) {
		const full: SavedReport = {
			id: stored.id,
			meta: stored.meta,
			document: stored.document,
			savedAt: stored.savedAt
		};
		rememberReport(full);
		return full;
	}

	if (stored) {
		const fromDisk = await hydrateDiskReport(stored);
		if (fromDisk) return fromDisk;
	}

	// Índice con puntero a disco (entrada LS del reporte ausente o meta incompleta).
	const indexMeta = metaFromIndex(key);
	if (!indexMeta) return null;
	const mergedMeta: ReportMeta = stored?.meta
		? {
				...indexMeta,
				...stored.meta,
				outputFilename:
					reportOutputFilename(stored.meta) || reportOutputFilename(indexMeta) || indexMeta.outputFilename
			}
		: indexMeta;

	return hydrateDiskReport({
		id: key,
		meta: mergedMeta,
		savedAt: stored?.savedAt || new Date().toISOString()
	});
}
