// The web image's health check (HEALTHCHECK in apps/server/Dockerfile): the web process in this
// container answers `/readyz` with 200, asked on the admin host as the web process requires.
// Exits 0 when it does, 1 otherwise.

// Like the web process, never through an outgoing proxy (Bun's fetch would use HTTP_PROXY).
for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
	if (process.env[name]) process.env[name] = "";
}

const port = process.env.PORT?.trim() || "3000";
const adminHost = process.env.WEBCRAFT_ADMIN_HOST?.trim() ?? "";

try {
	const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
		headers: { host: adminHost },
		signal: AbortSignal.timeout(4000),
	});
	process.exit(response.status === 200 ? 0 : 1);
} catch {
	process.exit(1);
}

export {};
