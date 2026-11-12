import { readFile } from "node:fs/promises";

import { CliError, EXIT } from "../exit-codes.ts";

/**
 * Reads one of the JSON files the CLI keeps in its config folder (profiles, sign-ins). A file that
 * isn't there yet answers `undefined`: nothing was kept so far. Any other failure stops the command:
 * a file that can't be read, or that isn't JSON (cut short by a full disk, edited by hand), must
 * never be taken for an empty one, since the next sign-in would write that back and drop every
 * other profile and sign-in it held.
 */
export async function readKeptJson(path: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw unreadable(path, error);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw unreadable(path, error);
	}
}

function unreadable(path: string, error: unknown): CliError {
	const why = error instanceof Error ? error.message : String(error);
	return new CliError(
		EXIT.failed,
		`${path} can't be read (${why}). Nothing was changed. Repair the file, or move it away to start again: you then sign in again with webcraft login.`,
	);
}
