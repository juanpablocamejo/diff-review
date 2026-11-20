import { error } from '@sveltejs/kit';
import { basename } from 'node:path';
import { command, query } from '$app/server';
import { decodePayload } from '$review/lib/json-payload.mjs';
import { makeOutputFilename } from '$review/lib/output-name.mjs';
import {
	describeGitError,
	detectReviewOutput,
	hydrateReviewPayload,
	isExpectedGitUserError,
	loadFileLines,
	loadLaunchRepoInfo,
	loadRepoInfo,
	pickLocalFolder as pickLocalFolderSync,
	pickReviewJsonFile,
	adoptLocalReviews,
	ensureLocalReviewViewerId,
	findLocalReview,
	listLocalReviewCatalog,
	readReviewOutput,
	prepareLocalReview,
	readBranchFreshness,
	removeLocalReviewJson,
	resolveOutputName,
	takePendingImport,
	updateLocalBranch,
	writeReviewOutput as writeReviewOutputFile,
	type DetectedOutput,
	type OutputNameInfo,
	type PendingImport
} from '$lib/server/git-review';
import type { RepoSource, ReviewDocument, SavedReportSummary } from './types';

export type { DetectedOutput, OutputNameInfo, PendingImport };

export type RepoInfo = {
	repo: string;
	source: RepoSource;
	branches: string[];
	current: string;
	defaultBase: string;
	remoteUrl?: string;
};

export type PickedReviewFile = { filename: string; payload: unknown };

function fail(err: unknown): never {
	const message = describeGitError(err) || 'No se pudo hablar con git.';
	// Repo inválido / sin commits: la UI ya muestra el mensaje; no spamear stacks.
	if (!isExpectedGitUserError(err)) {
		console.error('[diff-review git]', message, err);
	}
	error(400, message);
}

export const loadRepo = query(
	'unchecked',
	async (input: { source?: RepoSource; repo: string }): Promise<RepoInfo> => {
		try {
			return loadRepoInfo(input?.source, String(input?.repo || '').trim());
		} catch (err) {
			fail(err);
		}
	}
);

/** Repo del CWD de lanzamiento, o null si no hay git. */
export const launchContext = query(async (): Promise<RepoInfo | null> => {
	try {
		return loadLaunchRepoInfo();
	} catch (err) {
		if (!isExpectedGitUserError(err)) {
			console.error('[diff-review git] launch context', describeGitError(err), err);
		}
		return null;
	}
});

/** JSON pendiente del CLI (DIFF_REVIEW_IMPORT_FILE); se consume al leer. */
export const pendingImport = query(async (): Promise<PendingImport | null> => {
	try {
		return takePendingImport();
	} catch (err) {
		console.error('[diff-review git] pending import', describeGitError(err), err);
		return null;
	}
});

/** ¿Hay un JSON de review en la raíz del repo local? */
export const detectOutput = query(
	'unchecked',
	async (input: { repo: string; preferredName?: string }): Promise<DetectedOutput | null> => {
		try {
			return detectReviewOutput(String(input?.repo || '').trim(), input?.preferredName);
		} catch (err) {
			console.error('[diff-review git] detect output', describeGitError(err), err);
			return null;
		}
	}
);

/** Nombre sugerido con tips cortos (branch/base). */
export const outputName = query(
	'unchecked',
	async (input: {
		repo: string;
		branch: string;
		base?: string;
	}): Promise<OutputNameInfo> => {
		try {
			return resolveOutputName(
				String(input?.repo || '').trim(),
				String(input?.branch || '').trim(),
				String(input?.base || 'develop').trim()
			);
		} catch (err) {
			console.error('[diff-review git] output name', describeGitError(err), err);
			return { filename: makeOutputFilename({}), fingerprint: null };
		}
	}
);

/** Lee un JSON detectado en el repo (sin diálogo). */
export const loadDetectedOutput = command(
	'unchecked',
	async (input: { repo: string; filename: string }): Promise<PendingImport | null> => {
		try {
			return readReviewOutput(String(input?.repo || '').trim(), String(input?.filename || '').trim());
		} catch (err) {
			fail(err);
		}
	}
);

/** Guarda un JSON de review en `.diff-review/` (p. ej. drag-and-drop → puntero en localStorage). */
export const writeReviewOutput = command(
	'unchecked',
	async (input: {
		repo: string;
		filename: string;
		payload: unknown;
	}): Promise<PendingImport> => {
		try {
			return writeReviewOutputFile(
				String(input?.repo || '').trim(),
				String(input?.filename || '').trim(),
				input?.payload
			);
		} catch (err) {
			fail(err);
		}
	}
);

export type ReviewCatalogHint = { filename: string; viewerId: string };

/** Lista los JSON del repo abierto. Estampa `meta.viewerId` en los que no tienen. */
export const listReviewCatalog = command(
	'unchecked',
	async (input: { repo: string; hints?: ReviewCatalogHint[] }): Promise<SavedReportSummary[]> => {
		try {
			return listLocalReviewCatalog(String(input?.repo || '').trim(), input?.hints || []);
		} catch (err) {
			console.error('[diff-review git] catalog', describeGitError(err), err);
			return [];
		}
	}
);

export type FoundReviewFile = {
	repo: string;
	filename: string;
	payload: unknown;
	viewerId: string;
	location: 'dir' | 'root';
};

/** Busca en esos repos un JSON con ese `viewerId` o ese nombre de archivo. */
export const findReviewOutput = command(
	'unchecked',
	async (input: { repos: string[]; viewerId?: string; filename?: string }): Promise<FoundReviewFile | null> => {
		try {
			return findLocalReview(input?.repos || [], {
				viewerId: String(input?.viewerId || '').trim(),
				filename: String(input?.filename || '').trim()
			});
		} catch (err) {
			fail(err);
		}
	}
);

/** Borra el JSON del reporte (allowlist). No toca otros archivos. */
export const deleteReviewOutput = command(
	'unchecked',
	async (input: { repo: string; filename: string; viewerId?: string }): Promise<{ deleted: boolean }> => {
		try {
			return {
				deleted: removeLocalReviewJson(
					String(input?.repo || '').trim(),
					String(input?.filename || '').trim(),
					String(input?.viewerId || '').trim()
				)
			};
		} catch (err) {
			fail(err);
		}
	}
);

export type AdoptReviewResult = {
	filename: string;
	viewerId: string;
	status: 'stamped' | 'kept' | 'written' | 'missing';
};

/** Una pasada del índice viejo: estampar el UUID o reescribir el JSON que solo estaba en el navegador. */
export const adoptReviewFiles = command(
	'unchecked',
	async (input: {
		repo: string;
		items: { filename: string; viewerId: string; payload?: unknown }[];
	}): Promise<AdoptReviewResult[]> => {
		try {
			return adoptLocalReviews(String(input?.repo || '').trim(), input?.items || []);
		} catch (err) {
			fail(err);
		}
	}
);

/** Si el JSON existe y no tiene `meta.viewerId`, escribe el que se pasa (o uno nuevo). */
export const ensureReviewViewerId = command(
	'unchecked',
	async (input: {
		repo: string;
		filename: string;
		viewerId?: string;
	}): Promise<{ filename: string; viewerId: string } | null> => {
		try {
			return ensureLocalReviewViewerId(
				String(input?.repo || '').trim(),
				String(input?.filename || '').trim(),
				String(input?.viewerId || '').trim()
			);
		} catch (err) {
			fail(err);
		}
	}
);

export const pickLocalFolder = command('unchecked', async (_input: null): Promise<string | null> => {
	try {
		return await pickLocalFolderSync();
	} catch (err) {
		fail(err);
	}
});

/** Diálogo nativo de JSON; `directory` = raíz del repo local. */
export const pickReviewFile = command(
	'unchecked',
	async (input: { directory?: string }): Promise<PickedReviewFile | null> => {
		try {
			const picked = await pickReviewJsonFile(input?.directory);
			if (!picked) return null;
			return {
				filename: basename(picked.path),
				payload: decodePayload(picked.text)
			};
		} catch (err) {
			fail(err);
		}
	}
);

/** Líneas del archivo en el branch revisado, para expandir el contexto oculto de un diff. */
export const fileLines = query(
	'unchecked',
	async (input: {
		repo: string;
		branch: string;
		base?: string;
		source?: RepoSource;
		path: string;
	}): Promise<string[] | null> =>
		loadFileLines({
			repo: String(input?.repo || '').trim(),
			branch: String(input?.branch || '').trim(),
			base: String(input?.base || 'develop').trim(),
			source: input?.source,
			path: String(input?.path || '').trim()
		})
);

export type BranchFreshness = {
	branch: string;
	upstream: string | null;
	behind: number;
	local: boolean;
};

/** ¿El branch o la base están detrás de su upstream? Usa los remote-tracking que ya hay (sin fetch). */
export const branchFreshness = query(
	'unchecked',
	async (input: { repo: string; branches: string[] }): Promise<BranchFreshness[]> => {
		try {
			return readBranchFreshness(String(input?.repo || '').trim(), input?.branches || []);
		} catch (err) {
			console.error('[diff-review git] freshness', describeGitError(err), err);
			return [];
		}
	}
);

/** Fetch + fast-forward de un branch. No descarta cambios. */
export const updateBranch = command(
	'unchecked',
	async (input: { repo: string; branch: string }) => {
		try {
			return updateLocalBranch(String(input?.repo || '').trim(), String(input?.branch || '').trim());
		} catch (err) {
			fail(err);
		}
	}
);

/** Escribe el diff de review en `.diff-review/` y devuelve el nombre y la huella. */
export const prepareReview = command(
	'unchecked',
	async (input: {
		repo: string;
		branch: string;
		base?: string;
		outputFilename?: string;
		stamp?: boolean;
		acp?: boolean;
	}) => {
		try {
			return prepareLocalReview({
				repo: String(input?.repo || '').trim(),
				branch: String(input?.branch || '').trim(),
				base: String(input?.base || 'develop').trim(),
				outputFilename: String(input?.outputFilename || '').trim() || undefined,
				stamp: Boolean(input?.stamp),
				acp: Boolean(input?.acp)
			});
		} catch (err) {
			fail(err);
		}
	}
);

export const hydrateFromGit = command(
	'unchecked',
	async (input: {
		repo: string;
		branch: string;
		base: string;
		source?: RepoSource;
		payload: unknown;
		outputFilename?: string;
	}): Promise<ReviewDocument> => {
		try {
			return hydrateReviewPayload({
				repo: String(input?.repo || '').trim(),
				branch: String(input?.branch || '').trim(),
				base: String(input?.base || 'develop').trim(),
				source: input?.source,
				payload: input?.payload,
				outputFilename: String(input?.outputFilename || '').trim() || undefined
			});
		} catch (err) {
			fail(err);
		}
	}
);
