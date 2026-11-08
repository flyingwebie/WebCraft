import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Handler } from "../responses.ts";

/**
 * Serves the admin's built browser files (`dist/client`) in production and hands every other
 * request to `next`. Only admin-host requests reach it, so Sites never expose admin files.
 * In development Vite serves these files itself.
 */
export function serveStaticFiles(directory: URL, next: (request: Request) => Response | Promise<Response>): Handler {
	const root = fileURLToPath(directory);
	return async (request) => {
		if (request.method === "GET" || request.method === "HEAD") {
			const path = fileFor(root, new URL(request.url).pathname);
			if (path && (await isFile(path))) {
				const file = Bun.file(path);
				return new Response(request.method === "HEAD" ? null : file, {
					headers: {
						"content-type": file.type,
						// Vite puts a content hash in every name under /assets/, so those never change.
						"cache-control": path.startsWith(`${root}assets${sep}`)
							? "public, max-age=31536000, immutable"
							: "no-cache",
					},
				});
			}
		}
		return next(request);
	};
}

/** The file a URL path names inside `root`, or null when it would leave `root`. */
function fileFor(root: string, pathname: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	const path = resolve(root, `.${decoded}`);
	return path.startsWith(root) && path !== root ? path : null;
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}
