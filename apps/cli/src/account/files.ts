import { readFile } from "node:fs/promises";

import { CliError, EXIT } from "../exit-codes.ts";

/**
 * Reads one of the JSON files the CLI keeps in its config folder (profiles, sign-ins): an object. A
 * file that isn't there yet answers `undefined`: nothing was kept so far. Any other failure stops
 * the command: a file that can't be read, or that isn't the object webcraft wrote (cut short by a
 * full disk or a crash, edited by hand), must never be taken for an empty one, since the next
 * sign-in would write that back and drop every other profile and sign-in it held.
 */
export async function readKeptObject(path: string): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw unreadable(path, error);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw unreadable(path, error);
	}
	if (!isRecord(parsed)) throw unreadable(path, new Error("it doesn't hold what webcraft keeps there"));
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unreadable(path: string, error: unknown): CliError {
	const why = error instanceof Error ? error.message : String(error);
	return new CliError(
		EXIT.failed,
		`${path} can't be read: it is damaged (${why}). Nothing was changed. Mend it, or move it away to start again (what it held is then gone: run webcraft login for each Install).`,
	);
}
