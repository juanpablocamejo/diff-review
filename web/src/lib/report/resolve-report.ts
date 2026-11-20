import { migrateLegacyCatalog } from './catalog';
import { coerceDocument, parseReportMeta, serializeReviewPayload, viewerIdFromPayload } from './document';
import {
	ensureReviewViewerId,
	findReviewOutput,
	hydrateFromGit,
	launchContext,
	loadDetectedOutput,
	writeReviewOutput
} from './git.remote';
import {
	canLoadFromDisk,
	isLocalRepoPath,
	loadLastLocalRepo,
	loadReportById,
	loadStoredReport,
	rememberReport,
	reportOutputFilename
} from './storage';
import type { ReportMeta, SavedReport, StoredReport } from './types';

function pushRepo(repos: string[], value: string | undefined) {
	const repo = String(value || '').trim();
	if (!repo || !isLocalRepoPath(repo) || repos.includes(repo)) return;
	repos.push(repo);
}

async function candidateRepos(meta?: ReportMeta | null): Promise<string[]> {
	const repos: string[] = [];
	pushRepo(repos, meta?.repo);
	pushRepo(repos, loadLastLocalRepo());
	try {
		const launch = await launchContext();
		pushRepo(repos, launch?.repo);
	} catch {
		/* sin repo de lanzamiento */
	}
	return repos;
}

function materialize(stored: StoredReport): SavedReport {
	const id = String(stored.meta.viewerId || stored.id).trim() || stored.id;
	return {
		id: stored.id,
		meta: { ...stored.meta, viewerId: id },
		document: stored.document!,
		savedAt: stored.savedAt
	};
}

/** Si el JSON no está, lo reescribe. Si está y le falta viewerId, lo estampa con el id ya conocido. */
async function ensureDiskCopy(full: SavedReport): Promise<void> {
	if (!canLoadFromDisk(full.meta)) return;
	const filename = reportOutputFilename(full.meta);
	const repo = full.meta.repo;
	const viewerId = String(full.meta.viewerId || full.id).trim();
	try {
		const existing = await loadDetectedOutput({ repo, filename });
		if (existing?.payload) {
			if (!viewerIdFromPayload(existing.payload) && viewerId) {
				await ensureReviewViewerId({ repo, filename, viewerId });
			}
			return;
		}
	} catch {
		/* si no se pudo leer, igual intentamos escribir el documento que sí tenemos */
	}
	try {
		const payload = JSON.parse(
			serializeReviewPayload(full.document, { ...full.meta, viewerId, outputFilename: filename })
		);
		await writeReviewOutput({ repo, filename, payload });
	} catch {
		/* el documento en memoria alcanza para abrir */
	}
}

async function fromFoundFile(
	id: string,
	found: { repo: string; filename: string; payload: unknown; viewerId: string },
	fallback?: ReportMeta | null
): Promise<SavedReport | null> {
	const viewerId = String(found.viewerId || id).trim() || id;
	const meta = parseReportMeta(found.payload, {
		...(fallback || {}),
		source: 'local',
		repo: found.repo || fallback?.repo || '',
		outputFilename: found.filename,
		viewerId
	});
	meta.viewerId = viewerId;
	meta.outputFilename = found.filename;
	if (!meta.repo) meta.repo = found.repo;

	let document;
	try {
		document = await hydrateFromGit({
			repo: meta.repo,
			branch: meta.branch,
			base: meta.base || 'develop',
			source: meta.source,
			payload: found.payload,
			outputFilename: found.filename
		});
	} catch {
		document = coerceDocument(found.payload);
	}

	const full: SavedReport = {
		id: viewerId,
		meta,
		document,
		savedAt: meta.generatedAt || fallback?.generatedAt || new Date().toISOString()
	};
	rememberReport(full);
	return full;
}

/** Abre `/report/<id>`: memoria, documento embebido, o un JSON cuyo viewerId (o nombre) coincide. */
export async function resolveSavedReport(id: string): Promise<SavedReport | null> {
	const key = String(id || '').trim();
	if (!key) return null;

	const cached = loadReportById(key);
	const storedEarly = cached ? null : loadStoredReport(key);
	try {
		await migrateLegacyCatalog(cached?.meta.repo || storedEarly?.meta.repo || loadLastLocalRepo());
	} catch {
		/* la migración no bloquea abrir lo que sí está */
	}

	const fresh = loadReportById(key) || cached;
	if (fresh?.document) {
		await ensureDiskCopy(fresh);
		return fresh;
	}

	const stored = loadStoredReport(key) || storedEarly;
	if (stored?.document) {
		const full = materialize(stored);
		rememberReport(full);
		await ensureDiskCopy(full);
		return full;
	}

	const repos = await candidateRepos(stored?.meta || fresh?.meta);
	if (repos.length) {
		const filename = stored?.meta ? reportOutputFilename(stored.meta) : '';
		const found = await findReviewOutput({
			repos,
			viewerId: key,
			...(filename ? { filename } : {})
		});
		if (found?.payload) {
			const opened = await fromFoundFile(key, found, stored?.meta);
			if (opened) return opened;
		}
	}

	if (stored?.document) {
		const full = materialize(stored);
		rememberReport(full);
		await ensureDiskCopy(full);
		return full;
	}
	return null;
}
