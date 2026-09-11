import { extractBranchDiff } from '$review/lib/extract.mjs';
import { assertGitRepo, listBranches, showFileLines } from '$review/lib/git.mjs';
import { pickFolder } from '$review/lib/pick-folder.mjs';
import {
	ensureRemoteWorktree,
	listRemoteBranches,
	looksLikeGitUrl,
	normalizeGitUrl
} from '$review/lib/remote-repo.mjs';
import { buildReview } from '$review/lib/review.mjs';
import type { ReviewDocument, ReviewFile, RepoSource } from '$lib/report/types';

export type RepoInfo = {
	repo: string;
	source: RepoSource;
	branches: string[];
	current: string;
	defaultBase: string;
};

export function describeGitError(err: unknown): string {
	if (err && typeof err === 'object') {
		const rec = err as { stderr?: string; message?: string };
		const stderr = String(rec.stderr || '')
			.trim()
			.split('\n')
			.find(Boolean);
		if (stderr) return stderr;
		if (rec.message) return rec.message;
	}
	return err instanceof Error ? err.message : String(err);
}

export function resolveSource(source: RepoSource | undefined, repo: string): RepoSource {
	if (source === 'local' || source === 'url') return source;
	return looksLikeGitUrl(repo) ? 'url' : 'local';
}

export function loadRepoInfo(source: RepoSource | undefined, repo: string): RepoInfo {
	const resolvedSource = resolveSource(source, repo);
	if (resolvedSource === 'url') {
		const url = normalizeGitUrl(repo);
		const listed = listRemoteBranches(url);
		return { repo: url, source: 'url', ...listed };
	}
	const resolved = assertGitRepo(repo);
	const listed = listBranches(resolved);
	return { repo: resolved, source: 'local', ...listed };
}

export function pickLocalFolder(): string | null {
	return pickFolder();
}

function resolveWorktree(source: RepoSource, repo: string, branch: string, base: string): string {
	if (source === 'url') return ensureRemoteWorktree(repo, branch, base);
	return assertGitRepo(repo);
}

function toReviewFile(file: {
	path: string;
	oldPath?: string;
	changeType: string;
	diff: string;
	group?: string;
}): ReviewFile {
	const changeType = file.changeType;
	const typed =
		changeType === 'added' || changeType === 'deleted' || changeType === 'renamed' || changeType === 'modified'
			? changeType
			: 'modified';
	return {
		path: file.path,
		oldPath: file.oldPath || undefined,
		changeType: typed,
		diff: String(file.diff ?? '').replaceAll('\0', ''),
		group: file.group ?? ''
	};
}

/**
 * Contenido del archivo en la punta del branch, para rellenar en el viewer las líneas
 * que el diff no trae. Devuelve null (en vez de reventar) cuando el repo no está a mano
 * o el archivo es binario: ahí el viewer apaga los botones de expandir.
 */
export function loadFileLines(input: {
	repo: string;
	branch: string;
	base?: string;
	source?: RepoSource;
	path: string;
}): string[] | null {
	try {
		const source = resolveSource(input.source, input.repo);
		const repo = resolveWorktree(source, input.repo, input.branch, input.base || 'develop');
		return showFileLines(repo, input.branch, input.path);
	} catch (err) {
		console.error('[diff-review git] no se pudo leer', input.path, describeGitError(err));
		return null;
	}
}

export function hydrateReviewPayload(input: {
	repo: string;
	branch: string;
	base: string;
	source?: RepoSource;
	payload: unknown;
}): ReviewDocument {
	const source = resolveSource(input.source, input.repo);
	const repo = resolveWorktree(source, input.repo, input.branch, input.base || 'develop');
	const skeleton = extractBranchDiff({ repo, branch: input.branch, base: input.base || 'develop' });
	const extraNotes = Array.isArray((input.payload as { notes?: unknown })?.notes)
		? ((input.payload as { notes: unknown[] }).notes.filter((n) => typeof n === 'string') as string[])
		: [];
	const built = buildReview({ skeleton, payload: input.payload, notes: extraNotes });
	const doc: ReviewDocument = {
		intent: built.intent,
		groups: built.groups as ReviewDocument['groups'],
		blocks: built.blocks as ReviewDocument['blocks'],
		findings: built.findings as ReviewDocument['findings'],
		skipped: built.skipped as ReviewDocument['skipped'],
		files: (built.files || []).map(toReviewFile),
		notes: built.notes || []
	};
	// devalue (remote functions) falla con bytes nulos / valores raros; JSON es el contrato del viewer.
	return JSON.parse(JSON.stringify(doc)) as ReviewDocument;
}
