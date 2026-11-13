/** Rendered Loop counts, including zero, from the renderer's editor-only comments. */
export function loopCounts(root: Node): Record<string, number> {
	const counts: Record<string, number> = {};
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const match = /^wc-code-loop ([^ ]+) (\d+)$/.exec(node.textContent ?? "");
		if (match?.[1]) counts[match[1]] = (counts[match[1]] ?? 0) + Number(match[2]);
	}
	return counts;
}
