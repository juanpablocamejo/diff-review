/** Valida el JSON soltado por el usuario contra la forma mínima que necesita el viewer. */
export function validateDocument(doc: unknown): string[] {
	const errors: string[] = [];
	if (!doc || typeof doc !== 'object') return ['El archivo no contiene un objeto JSON.'];
	const d = doc as Record<string, unknown>;

	if (typeof d.intent !== 'string' || !d.intent.trim()) errors.push('Falta "intent" (string).');

	if (!Array.isArray(d.groups)) {
		errors.push('Falta "groups" (array).');
	} else {
		d.groups.forEach((g, i) => {
			if (!g || typeof g !== 'object') {
				errors.push(`groups[${i}]: no es un objeto.`);
				return;
			}
			for (const k of ['id', 'kind', 'title', 'intent']) {
				if (typeof (g as Record<string, unknown>)[k] !== 'string' || !(g as Record<string, unknown>)[k]) {
					errors.push(`groups[${i}]: falta "${k}".`);
				}
			}
		});
	}

	if (!Array.isArray(d.blocks)) {
		errors.push('Falta "blocks" (array).');
	} else {
		d.blocks.forEach((b, i) => {
			if (!b || typeof b !== 'object') {
				errors.push(`blocks[${i}]: no es un objeto.`);
				return;
			}
			for (const k of ['id', 'group', 'file', 'op', 'what', 'why']) {
				if (typeof (b as Record<string, unknown>)[k] !== 'string' || !(b as Record<string, unknown>)[k]) {
					errors.push(`blocks[${i}]: falta "${k}".`);
				}
			}
		});
	}

	if (!Array.isArray(d.findings)) {
		errors.push('Falta "findings" (array).');
	} else {
		d.findings.forEach((f, i) => {
			if (!f || typeof f !== 'object') {
				errors.push(`findings[${i}]: no es un objeto.`);
				return;
			}
			const rec = f as Record<string, unknown>;
			for (const k of ['id', 'class', 'severity', 'kind', 'file', 'what', 'fix']) {
				if (typeof rec[k] !== 'string' || !rec[k]) errors.push(`findings[${i}]: falta "${k}".`);
			}
			if (typeof rec.blocking !== 'boolean') errors.push(`findings[${i}]: "blocking" debe ser booleano.`);
		});
	}

	if (d.files != null && !Array.isArray(d.files)) errors.push('"files" debe ser un array.');
	if (d.skipped != null && !Array.isArray(d.skipped)) errors.push('"skipped" debe ser un array.');
	if (d.notes != null && !Array.isArray(d.notes)) errors.push('"notes" debe ser un array.');

	return errors;
}
