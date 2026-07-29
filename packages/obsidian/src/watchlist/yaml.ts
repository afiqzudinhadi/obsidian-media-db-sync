const NEEDS_QUOTE = /[:,#\[\]{}"&*!|>%@`]/;
const KEYWORDS = new Set(['null', 'true', 'false', 'yes', 'no']);

export function yamlScalar(v: unknown): string {
	if (v === null || v === undefined || v === '') return '';
	const s = String(v);
	if (NEEDS_QUOTE.test(s) || s.trim() !== s || KEYWORDS.has(s.toLowerCase())) {
		return '"' + s.replace(/"/g, '\\"') + '"';
	}
	return s;
}

export function yamlList(items: string[]): string {
	const parts: string[] = [];
	for (const raw of items) {
		const g = String(raw).trim();
		if (!g) continue;
		parts.push(/^[A-Za-z0-9 ]+$/.test(g) ? g : '"' + g.replace(/"/g, '\\"') + '"');
	}
	return '[' + parts.join(', ') + ']';
}

export function quotedOrNull(v: string | null | undefined): string {
	return v ? '"' + v + '"' : 'null';
}
