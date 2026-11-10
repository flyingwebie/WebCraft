import { readFileSync } from "node:fs";

// Embedded in the compiled `webcraft` as a file (not parsed at build time), read only when needed.
import knownDocumentPath from "../../../../docs/api/openapi.json" with { type: "file" };
import { type Catalogue, catalogueOf } from "./catalogue.ts";

let known: Catalogue | null = null;

/**
 * The commands this `webcraft` was built with: the OpenAPI document of its own WebCraft version,
 * with the first-party Modules (`docs/api/openapi.json`). Help falls back to it when no Install
 * answers, and it tells a command an Install no longer (or doesn't yet) offer from a mistyped one.
 */
export function knownCatalogue(): Catalogue {
	if (!known) {
		try {
			known = catalogueOf(JSON.parse(readFileSync(knownDocumentPath as unknown as string, "utf8")));
		} catch {
			known = catalogueOf({ paths: {} });
		}
	}
	return known;
}
