/** The external REST fixture used by both browser web and worker processes. */
export function liveWordpressReply(url: URL) {
	if (url.pathname.endsWith("/users/me")) return { body: '{"roles":["editor"]}' };
	if (url.pathname.endsWith("/types")) return { body: '{"post":{"name":"Posts","rest_base":"posts"}}' };
	if (url.pathname.endsWith("/taxonomies")) return { body: "{}" };
	return {
		body: '[{"id":1,"status":"publish","slug":"hello","title":{"rendered":"Hello"},"content":{"rendered":"<p>Welcome</p>"}}]',
		headers: { "x-wp-total": "1", "x-wp-totalpages": "1" },
	};
}
