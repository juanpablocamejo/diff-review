import { error } from '@sveltejs/kit';
import { basename } from 'node:path';
import { command, query } from '$app/server';
import { decodePayload } from '$review/lib/json-payload.mjs';
import { makeOutputFilename } from '$review/lib/output-name.mjs';
import {
	describeGitError,
	detectReviewOutput,
	hydrateReviewPayload,
	loadFileLines,
	loadLaunchRepoInfo,
	loadRepoInfo,
	pickLocalFolder as pickLocalFolderSync,
	pickReviewJsonFile,
	readReviewOutput,
	resolveOutputName,
	takePendingImport,
	type DetectedOutput,
	type OutputNameInfo,
	type PendingImport
} from '$lib/server/git-review';
import type { RepoSource, ReviewDocument } from './types';

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
	console.error('[diff-review git]', message, err);
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
		console.error('[diff-review git] launch context', describeGitError(err), err);
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

export const hydrateFromGit = command(
	'unchecked',
	async (input: {
		repo: string;
		branch: string;
		base: string;
		source?: RepoSource;
		payload: unknown;
	}): Promise<ReviewDocument> => {
		try {
			return hydrateReviewPayload({
				repo: String(input?.repo || '').trim(),
				branch: String(input?.branch || '').trim(),
				base: String(input?.base || 'develop').trim(),
				source: input?.source,
				payload: input?.payload
			});
		} catch (err) {
			fail(err);
		}
	}
);
