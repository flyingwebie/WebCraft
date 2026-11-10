/** The external REST fixture used by both browser web and worker processes. */
export function liveWordpressReply(
	url: URL,
	method = "GET",
): { body: string | null; headers?: Record<string, string>; status?: number } {
	const review = url.pathname.startsWith("/review/");
	if (method === "HEAD")
		return {
			body: null,
			headers: {
				link: `<${url.origin}${review ? "/review/index.php?rest_route=/" : "/wp-json/"}>; rel="https://api.w.org/"`,
				"content-length": "262144",
			},
		};
	const route = url.searchParams.get("rest_route") ?? url.pathname;
	if (review && (url.pathname !== "/review/index.php" || !url.searchParams.has("rest_route")))
		return { status: 404, body: "This source only has plain permalinks." };
	if (route.endsWith("/users/me")) return { body: '{"roles":["editor"]}' };
	if (route.endsWith("/types")) return { body: '{"post":{"name":"Posts","rest_base":"posts"}}' };
	if (route.endsWith("/taxonomies")) return { body: "{}" };
	if (review && route !== "/wp/v2/posts") return { status: 404, body: "This source only has plain permalinks." };
	return {
		body: JSON.stringify([
			{
				id: 1,
				status: "publish",
				slug: "hello",
				title: { rendered: review ? "Bread &amp; butter &#8211; today" : "Hello" },
				content: { rendered: "<p>Welcome</p>" },
			},
		]),
		headers: { "x-wp-total": "1", "x-wp-totalpages": "1" },
	};
}
