import type { FindingCard } from './build';

export type DecoratedFinding = FindingCard & {
	decided: boolean;
	fixSelected: boolean;
	corrected: boolean;
	/** Marcado A ignorar. No es un corregido. */
	ignored: boolean;
	fixedDetail: string;
	opacity: number;
	strike: 'line-through' | 'none';
	statusMark: '✓' | '';
	statusColor: string;
	decisionLabel: '' | 'A ignorar' | 'A corregir' | 'Corregido';
	decisionColor: string;
	ignoreBg: string;
	fixBg: string;
	ignoreColor: string;
	fixColor: string;
};

/** Corregido o marcado A ignorar: no es trabajo abierto. "A corregir" sigue abierto. */
export function isSettledFinding(f: { corrected: boolean; ignored: boolean }): boolean {
	return f.corrected || f.ignored;
}

/** Deriva el estilo de un finding a partir de su estado de triage. */
export function decorateFinding(
	card: FindingCard,
	decided: Record<string, boolean>,
	fixSelected: Record<string, boolean>,
	corrected: Record<string, boolean> = {},
	fixedDetail: Record<string, string> = {}
): DecoratedFinding {
	const isCorrected = !!corrected[card.id];
	const isDecided = !!decided[card.id] || isCorrected;
	const isFix = !!fixSelected[card.id] && !isCorrected;
	const detail = (fixedDetail[card.id] || '').trim();

	if (isCorrected) {
		return {
			...card,
			decided: true,
			fixSelected: false,
			corrected: true,
			ignored: false,
			fixedDetail: detail,
			opacity: 0.62,
			strike: 'none',
			statusMark: '✓',
			statusColor: 'var(--ok)',
			decisionLabel: 'Corregido',
			decisionColor: 'var(--ok)',
			ignoreBg: 'transparent',
			fixBg: 'var(--ok-bg)',
			ignoreColor: 'var(--text-dim)',
			fixColor: 'var(--ok)'
		};
	}

	return {
		...card,
		decided: isDecided,
		fixSelected: isFix,
		corrected: false,
		ignored: isDecided && !isFix,
		fixedDetail: '',
		opacity: isDecided ? 0.55 : 1,
		strike: isDecided ? 'line-through' : 'none',
		statusMark: isDecided ? '✓' : '',
		statusColor: isDecided ? (isFix ? 'var(--ok)' : 'var(--danger)') : 'transparent',
		decisionLabel: isDecided ? (isFix ? 'A corregir' : 'A ignorar') : '',
		decisionColor: isDecided ? (isFix ? 'var(--ok)' : 'var(--danger)') : 'var(--text-faint)',
		ignoreBg: isDecided && !isFix ? 'var(--danger-bg)' : 'transparent',
		fixBg: isDecided && isFix ? 'var(--fix-bg)' : 'transparent',
		ignoreColor: isDecided && !isFix ? 'var(--danger)' : 'var(--text-dim)',
		fixColor: isDecided && isFix ? 'var(--ok)' : 'var(--text-dim)'
	};
}
