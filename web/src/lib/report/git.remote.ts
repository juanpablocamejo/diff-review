import { error } from '@sveltejs/kit';
import { command, query } from '$app/server';
import {
	describeGitError,
	hydrateReviewPayload,
	loadFileLines,
	loadRepoInfo,
	pickLocalFolder as pickLocalFolderSync
} from '$lib/server/git-review';
import type { RepoSource, ReviewDocument } from './types';

export type RepoInfo = {
	repo: string;
	source: RepoSource;
	branches: string[];
	current: string;
	defaultBase: string;
	remoteUrl?: string;
};

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

export const pickLocalFolder = command('unchecked', async (_input: null): Promise<string | null> => {
	try {
		return await pickLocalFolderSync();
	} catch (err) {
		fail(err);
	}
});

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
