declare module '$review/lib/git.mjs' {
	export function assertGitRepo(repo: string): string;
	export function tryResolveGitRoot(cwd: string): string | null;
	export function listBranches(repo: string): {
		branches: string[];
		current: string;
		defaultBase: string;
	};
	export function getRemoteUrl(repo: string, preferred?: string): string;
	export function showFileLines(repo: string, rev: string, path: string): string[] | null;
	export function resolveRev(repo: string, ref: string): string;
	export function branchTips(
		repo: string,
		branch: string,
		base: string
	): { branchSha: string; baseSha: string };
	export function fingerprint(branchSha: string, baseSha: string): string | null;
	export function reportId(branchSha: string, baseSha: string): string;
}

declare module '$review/lib/output-name.mjs' {
	export const OUTPUT_PREFIX: string;
	export const OUTPUT_PREFIX_LEGACY: string;
	export const OUTPUT_FILENAME_LEGACY: string;
	export const OUTPUT_FILENAME_RE: RegExp;
	export function makeOutputFilename(input?: {
		branchSha?: string;
		baseSha?: string;
	}): string;
	export function isOutputFilename(name: string): boolean;
	export const OUTPUT_DIR: string;
	export function outputRelPath(filename: string): string;
}

declare module '$review/lib/prompt.mjs' {
	export const OUTPUT_SCHEMA_BLOCK: string;
	export const OUTPUT_FILENAME_LEGACY: string;
	export function makeOutputFilename(input?: {
		branchSha?: string;
		baseSha?: string;
	}): string;
	export function isOutputFilename(name: string): boolean;
	export const OUTPUT_DIR: string;
	export function outputRelPath(filename: string): string;
	export function validateCliCommand(filename?: string): string;
	export function outputSchemaBlock(meta: {
		source?: string;
		repo?: string;
		branch?: string;
		base?: string;
		remoteUrl?: string;
	}): string;
	export function buildPrompt(
		meta: {
			source?: string;
			repo?: string;
			branch?: string;
			base?: string;
			remoteUrl?: string;
		},
		opts?: {
			outputFilename?: string;
			acp?: boolean;
			diffRelPath?: string | null;
			mergeBase?: string;
			branchSha?: string;
			baseSha?: string;
			files?: Array<{ path: string; changeType?: string }>;
			ignored?: string[];
			ignoreGlobs?: string[];
		}
	): string;
}

declare module '$review/lib/review-prep.mjs' {
	export function prepareReviewPromptOpts(input: {
		repo: string;
		branch: string;
		base?: string;
		outputFilename: string;
		acp?: boolean;
	}): {
		outputFilename: string;
		acp: boolean;
		diffRelPath: string | null;
		mergeBase?: string;
		branchSha?: string;
		baseSha?: string;
		files: Array<{ path: string; changeType?: string }>;
		ignored: string[];
		ignoreGlobs: string[];
	};
}

declare module '$review/lib/json-payload.mjs' {
	export function decodePayload(text: string): unknown;
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
	export function extractBranchDiff(opts: {
		repo: string;
		branch: string;
		base?: string;
		cachedDiff?: string | null;
	}): {
		files: Array<{
			path: string;
			oldPath?: string;
			changeType: string;
			diff: string;
			group?: string;
		}>;
		mergeBase?: string;
		branchSha?: string;
		baseSha?: string;
		context?: { ignored?: string[] };
		notes?: string[];
		[key: string]: unknown;
	};
	export function loadBranchDiff(opts: {
		repo: string;
		branch: string;
		base?: string;
		filename?: string;
	}): {
		files: Array<{
			path: string;
			oldPath?: string;
			changeType: string;
			diff: string;
			group?: string;
		}>;
		mergeBase?: string;
		branchSha?: string;
		baseSha?: string;
		context?: { ignored?: string[] };
		notes?: string[];
		[key: string]: unknown;
	};
	export function parseGitDiffFiles(text: string): Array<{
		path: string;
		oldPath?: string;
		changeType: string;
		hunkDiff: string;
	}>;
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

declare module '$review/lib/agents.mjs' {
	export type ModelOption = { value: string; label: string; hint?: string };
	export type AgentDef = {
		id: string;
		label: string;
		bins: string[];
		models: ModelOption[];
		acp?: (ctx: { path: string }) => {
			file: string;
			args: string[];
			sessionMeta?: Record<string, unknown>;
		};
	};
	export type DetectedAgent = { def: AgentDef; path: string };
	export const AGENTS: AgentDef[];
	export const AGENT_DEFAULT_MODEL: string;
	export function detectAgents(): DetectedAgent[];
	export function modelChoices(def: AgentDef): { options: ModelOption[]; initialValue: string };
	export function resolvedRunModel(def: AgentDef, model?: string): string;
}

declare module '$review/lib/model-label.mjs' {
	export type FormattedModelOption = {
		title: string;
		badges: string[];
		label: string;
		hint?: string;
	};
	export type ModelSelectOption = {
		value: string;
		label: string;
		hint?: string;
		title?: string;
		badges?: string[];
	};
	export function modelSlug(s: string): string;
	export function humanizeModelId(id: string): string;
	export function compactModelMeta(raw: string): string[];
	export function formatModelOption(name: string, value: string): FormattedModelOption;
	export function modelOptionLabel(name: string, value: string): string;
	export function defaultModelOptionLabel(
		current: { value: string; name: string } | undefined,
		configuredOptionLabel?: string
	): string;
	export function sortModelSelectOptions<T extends { value: string; label?: string; title?: string }>(
		options: T[]
	): T[];
	export function buildAcpModelSelectOptions(
		live: { models: { value: string; name: string }[]; currentModel: string },
		fixed: { options: { value: string; label: string; hint?: string }[]; initialValue?: string }
	): { options: ModelSelectOption[]; initialValue: string };
}

declare module '$review/lib/models-cache.mjs' {
	export const MODELS_CACHE_TTL_MS: number;
	export function modelsCachePath(home?: string): string;
	export function readModelsCache(
		agentId: string,
		opts?: { home?: string; now?: number; ttlMs?: number }
	): { models: { value: string; name: string }[]; currentModel: string; fetchedAt: string } | null;
	export function writeModelsCache(
		agentId: string,
		data: { models: { value: string; name: string }[]; currentModel?: string },
		opts?: { home?: string; now?: number }
	): void;
}

declare module '$review/lib/acp-policy.mjs' {
	export type PolicyMode = 'review' | 'ask' | 'edit';
	export type Decision = { allow: boolean; reason: string };
	export function decidePermission(
		toolCall: unknown,
		ctx: { repo: string; outputFilename: string; mode: PolicyMode }
	): Decision;
}

declare module '$review/lib/acp.mjs' {
	import type { SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk';
	import type { DetectedAgent } from '$review/lib/agents.mjs';
	import type { Decision } from '$review/lib/acp-policy.mjs';
	export type AcpSession = {
		sessionId: string;
		resumed: boolean;
		models: { value: string; name: string }[];
		currentModel: string;
		modelWarning?: string;
		prompt: (text: string) => Promise<{ stopReason: string }>;
		cancel: () => Promise<void>;
		close: () => void;
		closed: Promise<void>;
		stderrTail: () => string;
	};
	export function supportsAcp(agent: DetectedAgent): boolean;
	export function listAcpModels(
		agent: DetectedAgent,
		opts: { cwd: string; timeoutMs?: number }
	): Promise<{ models: { value: string; name: string }[]; currentModel: string }>;
	export function listAcpModelsCached(
		agent: DetectedAgent,
		opts: { cwd: string; timeoutMs?: number; force?: boolean }
	): Promise<{ models: { value: string; name: string }[]; currentModel: string; fromCache: boolean }>;
	export function startAcpSession(
		agent: DetectedAgent,
		opts: {
			cwd: string;
			model?: string;
			resumeSessionId?: string;
			decide: (toolCall: ToolCallUpdate) => Decision;
			onUpdate?: (update: SessionUpdate) => void;
			onPermission?: (toolCall: ToolCallUpdate, decision: Decision) => void;
			onDeniedPermission?: (toolCall: ToolCallUpdate, decision: Decision) => Promise<boolean>;
			onExit?: (info: { code: number | null; stderr: string }) => void;
		}
	): Promise<AcpSession>;
}

declare module '$review/lib/review-meta.mjs' {
	export function stampReviewProvenance(
		filePath: string,
		provenance: {
			agent?: string;
			model?: string;
			agentSession?: { agentId: string; sessionId: string; outputFilename: string };
		}
	): boolean;
}

declare module '$review/lib/check-report.mjs' {
	export type CheckResult = { ok: boolean; errors: string[]; notes: string[]; file: string };
	export function checkReportFile(
		filePath: string,
		opts?: { repo?: string; branch?: string; base?: string; cwd?: string; paths?: string[] }
	): CheckResult;
	export function formatCheckReport(file: string, command: string, result: CheckResult): string;
}

declare module '$review/lib/review-dir.mjs' {
	export type SessionRef = { agentId: string; sessionId: string; model?: string; updatedAt?: string };
	export const OUTPUT_DIR: string;
	export function reviewDir(repoRoot: string): string;
	export function ensureReviewDir(repoRoot: string): string;
	export function companionPaths(repoRoot: string, filename: string): { json: string; diff: string; session: string };
	export function locateReviewFile(repoRoot: string, filename: string): string | null;
	export function writeDiffCache(repoRoot: string, filename: string, refs: { branch: string; base: string }): string | null;
	export function writeDiffText(repoRoot: string, filename: string, text: string): string;
	export function readDiffCache(repoRoot: string, filename: string): string | null;
	export function readSessionRef(repoRoot: string, filename: string): SessionRef | null;
	export function writeSessionRef(repoRoot: string, filename: string, ref: SessionRef): SessionRef;
}
