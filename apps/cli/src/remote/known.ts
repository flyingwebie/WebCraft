import { readFile } from "node:fs/promises";

import { type Catalogue, catalogueOf } from "./catalogue.ts";

let known: Promise<Catalogue> | null = null;

/**
 * The commands this `webcraft` was built with: the OpenAPI document of its own WebCraft version,
 * with the first-party Modules (`docs/api/openapi.json`, embedded in the compiled `webcraft`). Help
 * falls back to it when no Install answers, and it tells a command an Install no longer (or doesn't
 * yet) offer from a mistyped one. Without it (a copy that left it out), it knows no command.
 */
export function knownCatalogue(): Promise<Catalogue> {
	known ??= (async () => {
		try {
			// Embedded as a file (never parsed at build time), and read only when needed.
			const { default: path } = (await import("../../../../docs/api/openapi.json", { with: { type: "file" } })) as {
				default: unknown;
			};
			return catalogueOf(JSON.parse(await readFile(path as string, "utf8")));
		} catch {
			return catalogueOf({ paths: {} });
		}
	})();
	return known;
}
