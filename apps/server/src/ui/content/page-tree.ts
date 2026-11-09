/** A Page as the tree helpers read it: its id, and the title, slug and parent its Draft gives it. */
export type TreePage = { id: string; title: string; slug: string; parentId: string | null };

/**
 * Pages as a tree in reading order, siblings by title, each with how deep it is. A Page whose parent
 * isn't in the list sits at the top. `skip` leaves out one Page and every Page under it (the Pages
 * that can't be its parent); `maxDepth` leaves out Pages deeper than that.
 */
export function pageTree<Page extends TreePage>(
	pages: readonly Page[],
	options: { skip?: string; maxDepth?: number } = {},
): { page: Page; depth: number }[] {
	const known = new Set(pages.map((page) => page.id));
	const children = new Map<string | null, Page[]>();
	for (const page of pages) {
		const parent = page.parentId && known.has(page.parentId) ? page.parentId : null;
		children.set(parent, [...(children.get(parent) ?? []), page]);
	}
	const ordered: { page: Page; depth: number }[] = [];
	const seen = new Set<string>();
	const visit = (parent: string | null, depth: number) => {
		if (options.maxDepth !== undefined && depth > options.maxDepth) return;
		const list = [...(children.get(parent) ?? [])].sort((a, b) => a.title.localeCompare(b.title));
		for (const page of list) {
			if (page.id === options.skip || seen.has(page.id)) continue;
			seen.add(page.id);
			ordered.push({ page, depth });
			visit(page.id, depth + 1);
		}
	};
	visit(null, 0);
	return ordered;
}

/** The slugs of the Pages above `parentId` and of it, from the top: `["about", "team"]`. */
export function parentSlugs(pages: readonly TreePage[], parentId: string | null): string[] {
	const byId = new Map(pages.map((page) => [page.id, page]));
	const slugs: string[] = [];
	let current = parentId ? byId.get(parentId) : undefined;
	for (let depth = 0; current && depth < 12; depth++) {
		slugs.unshift(current.slug);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return slugs;
}
