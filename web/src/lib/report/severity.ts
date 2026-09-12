import type { FindingSeverity } from './types';

export const SEV_RANK: Record<FindingSeverity, number> = { high: 0, med: 1, low: 2, nit: 3 };

/** Menor = más grave. Bloqueante gana a cualquier severidad. */
export function findingSeverityRank(f: { blocking: boolean; severity: FindingSeverity }): number {
	return f.blocking ? -1 : SEV_RANK[f.severity];
}

/** Color del hallazgo más grave del conjunto. */
export function maxFindingAccent<
	T extends { blocking: boolean; severity: FindingSeverity; accentColor: string }
>(findings: T[]): string {
	if (!findings.length) return 'var(--text-faint)';
	let best = findings[0];
	for (let i = 1; i < findings.length; i++) {
		if (findingSeverityRank(findings[i]) < findingSeverityRank(best)) best = findings[i];
	}
	return best.accentColor;
}
