/**
 * Insert frontmatter key: value patches into note content, right after the `type:` line
 * when frontmatter exists (or prepended before the rest of the frontmatter when there's
 * no `type:` line). When the note has no frontmatter block at all, a new one is created,
 * optionally seeded with `defaultType`.
 *
 * Shared by watchlist's resolveMissingIds and the library resolve engine.
 */
export function patchFrontmatter(content: string, patches: Record<string, string>, opts: { defaultType?: string } = {}): string {
	const insert = Object.entries(patches)
		.map(([k, v]) => `${k}: ${v}`)
		.join('\n');
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
	if (fmMatch) {
		const inner = fmMatch[1];
		const typeLine = /^type:.*$/m.exec(inner);
		const newInner = typeLine
			? inner.slice(0, typeLine.index + typeLine[0].length) + '\n' + insert + inner.slice(typeLine.index + typeLine[0].length)
			: insert + '\n' + inner;
		return content.slice(0, fmMatch.index) + '---\n' + newInner + '\n---' + content.slice(fmMatch.index + fmMatch[0].length);
	}
	const typeLine = opts.defaultType ? `type: ${opts.defaultType}\n` : '';
	return `---\n${typeLine}${insert}\n---\n\n` + content;
}
