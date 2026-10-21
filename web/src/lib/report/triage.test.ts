import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	applyTriageToFindings,
	triageForSavedDocument,
	triageFromFindings
} from './triage.ts';
import type { TriageState } from './storage.ts';
import type { ReviewFinding } from './types.ts';

function finding(id: string, kind?: 'ignored' | 'fix' | 'corrected'): ReviewFinding {
	return {
		id,
		class: 'risk',
		severity: 'med',
		blocking: false,
		kind: 'bug',
		file: 'a.ts',
		line: 1,
		block: '',
		what: id,
		fix: '',
		...(kind ? { resolution: { kind } } : {})
	};
}

test('triageForSavedDocument preserves fix marks when LS is missing fixSelected', () => {
	const findings = [finding('a', 'ignored'), finding('b', 'fix')];
	const staleLs: TriageState = {
		decided: { a: true, b: true },
		fixSelected: { a: false },
		corrected: {},
		fixedDetail: {}
	};

	const remaining = findings.filter((f) => f.id !== 'a');
	const next = triageForSavedDocument(remaining, staleLs);

	assert.equal(next.decided.b, true);
	assert.equal(next.fixSelected.b, true);
	assert.equal(next.decided.a, undefined);
	assert.equal(next.fixSelected.a, undefined);
});

test('purge-style apply + triageForSavedDocument keeps corregir after dropping ignored', () => {
	const triage: TriageState = {
		decided: { a: true, b: true, c: true },
		fixSelected: { a: false, b: true, c: false },
		corrected: { c: true },
		fixedDetail: { c: 'ya aplicado' }
	};
	const findings = [
		finding('a', 'ignored'),
		finding('b', 'fix'),
		finding('c', 'corrected')
	];
	const ignoredIds = new Set(['a']);
	const saved = applyTriageToFindings(
		findings.filter((f) => !ignoredIds.has(f.id)),
		triage
	);
	// Simulate replaceReportDocument reading a stale LS (decided without fixSelected for b).
	const staleLs: TriageState = {
		decided: { a: true, b: true, c: true },
		fixSelected: { a: false, c: false },
		corrected: { c: true },
		fixedDetail: { c: 'ya aplicado' }
	};
	const next = triageForSavedDocument(saved, staleLs);

	assert.deepEqual(
		saved.map((f) => [f.id, f.resolution?.kind]),
		[
			['b', 'fix'],
			['c', 'corrected']
		]
	);
	assert.equal(next.fixSelected.b, true);
	assert.equal(next.corrected.c, true);
	assert.equal(next.fixedDetail.c, 'ya aplicado');
	assert.equal(next.decided.a, undefined);
});

test('triageFromFindings round-trips fix and ignored', () => {
	const fromDoc = triageFromFindings([finding('x', 'fix'), finding('y', 'ignored')]);
	assert.equal(fromDoc.fixSelected.x, true);
	assert.equal(fromDoc.fixSelected.y, false);
	assert.equal(fromDoc.decided.x, true);
	assert.equal(fromDoc.decided.y, true);
});
