import type { FindingCard } from './build';

export type DecoratedFinding = FindingCard & {
	decided: boolean;
	fixSelected: boolean;
	opacity: number;
	strike: 'line-through' | 'none';
	statusMark: '✓' | '';
	statusColor: string;
	decisionLabel: '' | 'Ignorar' | 'Corregir';
	decisionColor: string;
	ignoreBg: string;
	fixBg: string;
	ignoreColor: string;
	fixColor: string;
};

/** Deriva el estilo de un finding a partir de su estado de triage (decided/fixSelected). */
export function decorateFinding(
	card: FindingCard,
	decided: Record<string, boolean>,
	fixSelected: Record<string, boolean>
): DecoratedFinding {
	const isDecided = !!decided[card.id];
	const isFix = !!fixSelected[card.id];
	return {
		...card,
		decided: isDecided,
		fixSelected: isFix,
		opacity: isDecided ? 0.55 : 1,
		strike: isDecided ? 'line-through' : 'none',
		statusMark: isDecided ? '✓' : '',
		statusColor: isDecided ? (isFix ? 'var(--ok)' : 'var(--danger)') : 'transparent',
		decisionLabel: isDecided ? (isFix ? 'Corregir' : 'Ignorar') : '',
		decisionColor: isDecided ? (isFix ? 'var(--ok)' : 'var(--danger)') : 'var(--text-faint)',
		ignoreBg: isDecided && !isFix ? 'var(--danger-bg)' : 'transparent',
		fixBg: isDecided && isFix ? 'var(--fix-bg)' : 'transparent',
		ignoreColor: isDecided && !isFix ? 'var(--danger)' : 'var(--text-dim)',
		fixColor: isDecided && isFix ? 'var(--ok)' : 'var(--text-dim)'
	};
}
