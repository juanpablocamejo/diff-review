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
}

declare module '$review/lib/prompt.mjs' {
	export const OUTPUT_SCHEMA_BLOCK: string;
	export const OUTPUT_FILENAME_LEGACY: string;
	export function makeOutputFilename(input?: {
		branchSha?: string;
		baseSha?: string;
	}): string;
	export function isOutputFilename(name: string): boolean;
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
		opts?: { outputFilename?: string }
	): string;
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
	export const OTHER_MODEL: string;
	export function detectAgents(): DetectedAgent[];
	export function modelChoices(def: AgentDef): { options: ModelOption[]; initialValue: string };
	export function resolvedRunModel(def: AgentDef, model?: string): string;
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
		opts: { cwd: string }
	): Promise<{ models: { value: string; name: string }[]; currentModel: string }>;
	export function startAcpSession(
		agent: DetectedAgent,
		opts: {
			cwd: string;
			model?: string;
			resumeSessionId?: string;
			decide: (toolCall: ToolCallUpdate) => Decision;
			onUpdate?: (update: SessionUpdate) => void;
			onPermission?: (toolCall: ToolCallUpdate, decision: Decision) => void;
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
		opts?: { repo?: string; branch?: string; base?: string; cwd?: string }
	): CheckResult;
	export function formatCheckReport(file: string, command: string, result: CheckResult): string;
}
