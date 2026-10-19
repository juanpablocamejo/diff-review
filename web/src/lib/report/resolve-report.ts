import { hydrateFromGit, loadDetectedOutput } from './git.remote';
import {
	canLoadFromDisk,
	loadReportById,
	loadStoredReport,
	rememberReport,
	reportOutputFilename
} from './storage';
import type { SavedReport } from './types';

/** Abre un reporte: memoria / documento embebido, o rehidrata desde `.diff-review/` en disco. */
export async function resolveSavedReport(id: string): Promise<SavedReport | null> {
	const key = String(id || '');
	if (!key) return null;

	const cached = loadReportById(key);
	if (cached) return cached;

	const stored = loadStoredReport(key);
	if (!stored) return null;

	if (stored.document) {
		const full: SavedReport = {
			id: stored.id,
			meta: stored.meta,
			document: stored.document,
			savedAt: stored.savedAt
		};
		rememberReport(full);
		return full;
	}

	if (!canLoadFromDisk(stored.meta)) return null;

	const filename = reportOutputFilename(stored.meta);
	const loaded = await loadDetectedOutput({ repo: stored.meta.repo, filename });
	if (!loaded?.payload) return null;

	const document = await hydrateFromGit({
		repo: stored.meta.repo,
		branch: stored.meta.branch,
		base: stored.meta.base || 'develop',
		source: stored.meta.source,
		payload: loaded.payload,
		outputFilename: filename
	});

	const full: SavedReport = {
		id: stored.id,
		meta: { ...stored.meta, outputFilename: filename },
		document,
		savedAt: stored.savedAt
	};
	rememberReport(full);
	return full;
}
