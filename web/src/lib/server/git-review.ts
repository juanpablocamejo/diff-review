import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { extractBranchDiff } from '$review/lib/extract.mjs';
import {
	assertGitRepo,
	branchTips,
	fingerprint,
	getRemoteUrl,
	listBranches,
	showFileLines,
	tryResolveGitRoot
} from '$review/lib/git.mjs';
import { decodePayload } from '$review/lib/json-payload.mjs';
import { formatOutputStamp, isOutputFilename, makeOutputFilename } from '$review/lib/output-name.mjs';
import {
	ensureRemoteWorktree,
	listRemoteBranches,
	looksLikeGitUrl,
	normalizeGitUrl
} from '$review/lib/remote-repo.mjs';
import { buildReview } from '$review/lib/review.mjs';
import type { ReviewDocument, ReviewFile, RepoSource } from '$lib/report/types';
import { pickJsonFile, type PickedFile } from './pick-file';
import { pickFolder } from './pick-folder';

export type RepoInfo = {
	repo: string;
	source: RepoSource;
	branches: string[];
	current: string;
	defaultBase: string;
	/** Presente en repos locales con remote configurado. */
	remoteUrl?: string;
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
		return { repo: url, source: 'url', remoteUrl: url, ...listed };
	}
	const resolved = assertGitRepo(repo);
	const listed = listBranches(resolved);
	const remoteUrl = getRemoteUrl(resolved) || undefined;
	return { repo: resolved, source: 'local', remoteUrl, ...listed };
}

/**
 * Repo + branch del directorio desde el que se lanzó `diff-review` (env DIFF_REVIEW_LAUNCH_CWD).
 * En `npm run dev` cae a process.cwd(). Null si no hay git.
 */
export function loadLaunchRepoInfo(): RepoInfo | null {
	const cwd = String(process.env.DIFF_REVIEW_LAUNCH_CWD || process.cwd() || '').trim();
	if (!cwd) return null;
	const root = tryResolveGitRoot(cwd);
	if (!root) return null;
	try {
		return loadRepoInfo('local', root);
	} catch {
		return null;
	}
}

export type PendingImport = { filename: string; payload: unknown };

/**
 * JSON dejado por el CLI (env DIFF_REVIEW_IMPORT_FILE). Se consume una sola vez.
 */
export function takePendingImport(): PendingImport | null {
	const raw = String(process.env.DIFF_REVIEW_IMPORT_FILE || '').trim();
	if (!raw) return null;
	delete process.env.DIFF_REVIEW_IMPORT_FILE;
	const filePath = resolve(raw);
	const name = basename(filePath);
	if (!isOutputFilename(name)) return null;
	if (!existsSync(filePath)) return null;
	try {
		const text = readFileSync(filePath, 'utf8');
		const payload = decodePayload(text);
		return { filename: name, payload };
	} catch {
		return null;
	}
}

export type DetectedOutput = { filename: string; path: string; mtimeMs: number };

/**
 * Busca un JSON de review en la raíz del repo local.
 * Prefiere `preferredName` si existe; si no, el más reciente que matchee el patrón.
 */
export function detectReviewOutput(repo: string, preferredName?: string): DetectedOutput | null {
	const raw = String(repo || '').trim();
	if (!raw || looksLikeGitUrl(raw)) return null;
	let root: string;
	try {
		root = assertGitRepo(raw);
	} catch {
		return null;
	}

	const preferred = String(preferredName || '').trim();
	if (preferred && isOutputFilename(preferred)) {
		const preferredPath = join(root, preferred);
		if (existsSync(preferredPath)) {
			try {
				const st = statSync(preferredPath);
				return { filename: preferred, path: preferredPath, mtimeMs: st.mtimeMs };
			} catch {
				/* seguir al listado */
			}
		}
	}

	let best: DetectedOutput | null = null;
	try {
		for (const name of readdirSync(root)) {
			if (!isOutputFilename(name)) continue;
			const full = join(root, name);
			try {
				const st = statSync(full);
				if (!st.isFile()) continue;
				if (!best || st.mtimeMs > best.mtimeMs) {
					best = { filename: name, path: full, mtimeMs: st.mtimeMs };
				}
			} catch {
				/* ignore */
			}
		}
	} catch {
		return null;
	}
	return best;
}

/** Lee y parsea un JSON de review en la raíz del repo (solo nombres válidos). */
export function readReviewOutput(repo: string, filename: string): PendingImport | null {
	const raw = String(repo || '').trim();
	const name = basename(String(filename || '').trim());
	if (!raw || !name || !isOutputFilename(name) || looksLikeGitUrl(raw)) return null;
	let root: string;
	try {
		root = assertGitRepo(raw);
	} catch {
		return null;
	}
	const filePath = join(root, name);
	if (!existsSync(filePath)) return null;
	try {
		const text = readFileSync(filePath, 'utf8');
		return { filename: name, payload: decodePayload(text) };
	} catch {
		return null;
	}
}

export async function pickLocalFolder(): Promise<string | null> {
	return pickFolder();
}

export type OutputNameInfo = {
	filename: string;
	stamp: string;
	fingerprint: string | null;
	branchSha?: string;
	baseSha?: string;
};

/** Nombre de salida con tips cortos del branch y la base (repo local). */
export function resolveOutputName(
	repo: string,
	branch: string,
	base: string,
	stamp?: string
): OutputNameInfo {
	const outStamp = String(stamp || '').trim() || formatOutputStamp();
	const raw = String(repo || '').trim();
	const b = String(branch || '').trim();
	const baseRef = String(base || '').trim() || 'develop';
	if (!raw || looksLikeGitUrl(raw) || !b) {
		return {
			filename: makeOutputFilename({ stamp: outStamp }),
			stamp: outStamp,
			fingerprint: null
		};
	}
	try {
		const root = assertGitRepo(raw);
		const tips = branchTips(root, b, baseRef);
		const fp = fingerprint(tips.branchSha, tips.baseSha);
		return {
			filename: makeOutputFilename({
				branchSha: tips.branchSha,
				baseSha: tips.baseSha,
				stamp: outStamp
			}),
			stamp: outStamp,
			fingerprint: fp,
			branchSha: tips.branchSha,
			baseSha: tips.baseSha
		};
	} catch {
		return {
			filename: makeOutputFilename({ stamp: outStamp }),
			stamp: outStamp,
			fingerprint: null
		};
	}
}

/** Diálogo nativo de JSON; abre en la raíz del repo si es local. */
export async function pickReviewJsonFile(defaultDir?: string): Promise<PickedFile | null> {
	const dir = String(defaultDir || '').trim();
	let start = dir;
	if (dir && !looksLikeGitUrl(dir)) {
		try {
			start = assertGitRepo(dir);
		} catch {
			start = dir;
		}
	} else {
		start = '';
	}
	return pickJsonFile(start || undefined);
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
