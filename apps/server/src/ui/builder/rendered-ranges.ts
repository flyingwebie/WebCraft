/** Shared rendered structural addresses; self-contained for the Site-host asset. */
export function renderedRanges(doc: Document): { ref: string; range: Range }[] {
	const ranges: { ref: string; range: Range }[] = [];
	const starts = new Map<string, Comment[]>();
	const walker = doc.createTreeWalker(doc.body, 128);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const match = /^wc-code-(start|end) (\S+)$/.exec(node.nodeValue ?? "");
		if (!match) continue;
		const ref = decodeURIComponent(match[2] ?? "");
		const stack = starts.get(ref) ?? [];
		if (match[1] === "start") {
			stack.push(node as Comment);
			starts.set(ref, stack);
		} else {
			const start = stack.pop();
			if (!start) continue;
			const range = doc.createRange();
			range.setStartAfter(start);
			range.setEndBefore(node);
			ranges.push({ ref, range });
		}
	}
	return ranges;
}
