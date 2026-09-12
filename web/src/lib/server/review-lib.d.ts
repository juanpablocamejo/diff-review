declare module '$review/lib/git.mjs' {
	export function assertGitRepo(repo: string): string;
	export function listBranches(repo: string): {
		branches: string[];
		current: string;
		defaultBase: string;
	};
	export function getRemoteUrl(repo: string, preferred?: string): string;
	export function showFileLines(repo: string, rev: string, path: string): string[] | null;
}

declare module '$review/lib/pick-folder.mjs' {
	export function pickFolder(): Promise<string | null>;
}

/* pickFolder de producción vive en $lib/server/pick-folder */

declare module '$review/lib/remote-repo.mjs' {
	export function looksLikeGitUrl(value: string): boolean;
	export function normalizeGitUrl(url: string): string;
	export function listRemoteBranches(url: string): {
		branches: string[];
		current: string;
		defaultBase: string;
	};
	export function ensureRemoteWorktree(url: string, branch: string, base?: string): string;
}

declare module '$review/lib/extract.mjs' {
	export function extractBranchDiff(opts: { repo: string; branch: string; base?: string }): {
		files: Array<{
			path: string;
			oldPath?: string;
			changeType: string;
			diff: string;
			group?: string;
		}>;
		context?: { ignored?: string[] };
		notes?: string[];
		[key: string]: unknown;
	};
}

declare module '$review/lib/review.mjs' {
	export function parseLineRange(value: unknown): { side: 'new' | 'old'; start: number; end: number } | null;
	export function buildReview(opts: { skeleton: unknown; payload: unknown; notes?: string[] }): {
		intent: string;
		groups: unknown[];
		blocks: unknown[];
		findings: unknown[];
		skipped: unknown[];
		files: Array<{
			path: string;
			oldPath?: string;
			changeType: string;
			diff: string;
			group?: string;
		}>;
		notes?: string[];
		[key: string]: unknown;
	};
}
