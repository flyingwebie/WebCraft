import { ModuleRefusedError } from "@webcraft/module-sdk";
import { type GuardedFetch, GuardedFetchError } from "../guarded-fetch.ts";

const refused = (): never => {
	throw new ModuleRefusedError("host", "Only REST routes of this Import's source may be called.");
};

/** A Module supplies a route, never the transport's query-string routing or method override. */
export function importRoute(address: string, path: string): { path: string; query: URLSearchParams } {
	const base = new URL(`${address}wp-json/`);
	const target = new URL(path, base);
	if (
		!path ||
		target.origin !== base.origin ||
		!target.pathname.startsWith(base.pathname) ||
		target.username ||
		target.password ||
		target.hash ||
		target.pathname.includes("%") ||
		/\{\{|%7b/i.test(path) ||
		path.includes("\\")
	)
		return refused();
	for (const key of target.searchParams.keys()) {
		// PHP normalizes dots/spaces in parameter names and accepts array suffixes.
		const name = key.trimStart().replace(/[ .]/g, "_").split("[")[0];
		if (key.includes("\0") || name === "rest_route" || name === "_method") return refused();
	}
	return { path: target.pathname.slice(base.pathname.length), query: target.searchParams };
}

/** WordPress advertises its root in the frontend's Link header. Discovery never carries a login. */
export async function discoverImportRoot(address: string, fetch: GuardedFetch): Promise<URL> {
	const site = new URL(address);
	const fallback = new URL("wp-json/", site);
	let response: Response;
	try {
		response = await fetch(new Request(site.toString(), { method: "HEAD" }), {
			allowedHosts: [site.hostname],
			maxBytes: 64 * 1024,
			maxRedirects: 0,
			timeoutMs: 10_000,
		});
	} catch (error) {
		// Some frontends block HEAD. The conventional root stays within the authorized Site path;
		// it is still guarded and the Module must successfully test its WordPress REST endpoints.
		if (error instanceof GuardedFetchError && error.problem === "unreachable") return fallback;
		throw error;
	}
	if (response.status >= 300 && response.status < 400) return refused();
	if (!response.ok && ![404, 405, 501].includes(response.status)) return refused();
	const header = response.headers.get("link") ?? "";
	if (header.length > 16 * 1024) return refused();
	const roots = new Set<string>();
	for (const link of header.matchAll(/<([^>]+)>((?:\s*;\s*[\w*-]+\s*=\s*(?:"[^"]*"|[^,;\s]+))*)/g)) {
		const relation = /;\s*rel\s*=\s*(?:"([^"]*)"|([^,;\s]+))/i.exec(link[2] ?? "");
		if ((relation?.[1] ?? relation?.[2] ?? "").split(/\s+/).includes("https://api.w.org/")) roots.add(link[1] ?? "");
	}
	if (!roots.size) return fallback;
	if (roots.size !== 1) return refused();
	const raw = [...roots][0] ?? "";
	if (raw.includes("\\")) return refused();
	let root: URL;
	try {
		root = new URL(raw, site);
	} catch {
		return refused();
	}
	if (root.origin !== site.origin || root.username || root.password || root.hash || root.pathname.includes("%"))
		return refused();
	if (root.search) {
		if (
			![site.pathname, `${site.pathname}index.php`].includes(root.pathname) ||
			[...root.searchParams].length !== 1 ||
			root.searchParams.get("rest_route") !== "/"
		)
			return refused();
	} else if (![`${site.pathname}wp-json/`, `${site.pathname}index.php/wp-json/`].includes(root.pathname)) {
		return refused();
	}
	return root;
}

/** Keep the discovered transport path fixed while appending the Module's checked route and query. */
export function importRouteUrl(root: URL, route: ReturnType<typeof importRoute>): URL {
	const target = new URL(root);
	if (target.searchParams.has("rest_route")) target.searchParams.set("rest_route", `/${route.path}`);
	else target.pathname += route.path;
	for (const [key, value] of route.query) target.searchParams.append(key, value);
	return target;
}
