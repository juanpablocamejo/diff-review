import type { TriageState } from './storage';
import type { FindingResolution, ReviewFinding } from './types';

/** Deriva el mapa de triage desde `findings[].resolution` del documento. */
export function triageFromFindings(findings: ReviewFinding[]): TriageState {
	const decided: Record<string, boolean> = {};
	const fixSelected: Record<string, boolean> = {};
	const corrected: Record<string, boolean> = {};
	const fixedDetail: Record<string, string> = {};

	for (const f of findings) {
		const kind = f.resolution?.kind;
		if (!kind) continue;
		const id = f.id;
		if (!id) continue;
		decided[id] = true;
		if (kind === 'corrected') {
			corrected[id] = true;
			fixSelected[id] = false;
			const detail = String(f.resolution?.detail || '').trim();
			if (detail) fixedDetail[id] = detail;
		} else if (kind === 'fix') {
			fixSelected[id] = true;
			corrected[id] = false;
		} else {
			fixSelected[id] = false;
			corrected[id] = false;
		}
	}

	return { decided, fixSelected, corrected, fixedDetail };
}

/**
 * JSON gana donde hay `resolution`; localStorage completa el resto (compat / migración).
 */
export function mergeTriage(doc: TriageState, ls: TriageState): TriageState {
	const decided = { ...ls.decided, ...doc.decided };
	const fixSelected = { ...ls.fixSelected };
	const corrected = { ...ls.corrected };
	const fixedDetail = { ...ls.fixedDetail };

	for (const id of Object.keys(doc.decided)) {
		if (doc.corrected[id]) {
			corrected[id] = true;
			fixSelected[id] = false;
			fixedDetail[id] = doc.fixedDetail[id] || '';
		} else {
			corrected[id] = false;
			fixedDetail[id] = '';
			fixSelected[id] = !!doc.fixSelected[id];
		}
	}

	return { decided, fixSelected, corrected, fixedDetail };
}

/** ¿Hay decisiones en LS que aún no están en el JSON? */
export function triageNeedsDocumentWrite(doc: TriageState, merged: TriageState): boolean {
	for (const id of Object.keys(merged.decided)) {
		if (!merged.decided[id]) continue;
		if (merged.corrected[id]) {
			if (!doc.corrected[id]) return true;
			if ((merged.fixedDetail[id] || '').trim() !== (doc.fixedDetail[id] || '').trim()) return true;
			continue;
		}
		if (!doc.decided[id] || doc.corrected[id]) return true;
		if (!!merged.fixSelected[id] !== !!doc.fixSelected[id]) return true;
	}
	return false;
}

export function resolutionForFinding(id: string, triage: TriageState): FindingResolution | undefined {
	if (triage.corrected[id]) {
		const detail = (triage.fixedDetail[id] || '').trim();
		return detail ? { kind: 'corrected', detail } : { kind: 'corrected' };
	}
	if (!triage.decided[id]) return undefined;
	return triage.fixSelected[id] ? { kind: 'fix' } : { kind: 'ignored' };
}

/** Escribe (o quita) `resolution` en cada finding según el triage actual. */
export function applyTriageToFindings(findings: ReviewFinding[], triage: TriageState): ReviewFinding[] {
	return findings.map((f) => {
		const resolution = resolutionForFinding(f.id, triage);
		if (!resolution) {
			if (!f.resolution) return f;
			const { resolution: _drop, ...rest } = f;
			return rest;
		}
		return { ...f, resolution };
	});
}
