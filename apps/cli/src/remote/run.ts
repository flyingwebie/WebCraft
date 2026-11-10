import { CliError, EXIT } from "../exit-codes.ts";
import type { RemoteCommand } from "./catalogue.ts";
import type { Connection, RunContext } from "./connection.ts";
import { inputOf } from "./input.ts";
import { renderHuman } from "./render.ts";

/** A procedure's refusal, as `/api/v1` answers it. */
export type Refusal = { code: string; status: number; message: string; data?: unknown };

/** What one call came to. */
export type CallOutcome = { ok: true; answer: unknown } | { ok: false; refusal: Refusal };

/** Calls a public procedure with an input: JSON, or multipart form data when it holds a file. */
export async function callProcedure(
	connection: Connection,
	command: Pick<RemoteCommand, "path" | "files">,
	input: Record<string, unknown>,
): Promise<CallOutcome> {
	const response = await connection.send(`/api/v1/${command.path}`, bodyOf(input, command.files));
	const text = await response.text();
	let body: unknown = null;
	try {
		body = text === "" ? null : JSON.parse(text);
	} catch {
		body = text;
	}
	if (response.ok) return { ok: true, answer: body };
	const { code, message, data } = (body ?? {}) as { code?: string; message?: string; data?: unknown };
	return {
		ok: false,
		refusal: {
			code: code ?? `HTTP_${response.status}`,
			status: response.status,
			message: message ?? (response.statusText || `The Install answered ${response.status}.`),
			...(data === undefined ? {} : { data }),
		},
	};
}

/** Calls a procedure and answers its answer, or throws its refusal as the CLI's error. */
export async function call(
	connection: Connection,
	command: Pick<RemoteCommand, "path" | "files">,
	input: Record<string, unknown>,
): Promise<unknown> {
	const outcome = await callProcedure(connection, command, input);
	if (!outcome.ok) throw refusalError(outcome.refusal, connection);
	return outcome.answer;
}

function bodyOf(input: Record<string, unknown>, files: readonly string[]): RequestInit {
	if (!files.some((name) => input[name] instanceof Blob)) {
		return { body: JSON.stringify(input), headers: { "content-type": "application/json", accept: "application/json" } };
	}
	const form = new FormData();
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null) continue;
		if (value instanceof Blob) form.append(key, value, value instanceof File ? value.name : "file");
		else form.append(key, typeof value === "string" ? value : JSON.stringify(value));
	}
	return { body: form, headers: { accept: "application/json" } };
}

/** The CLI's error for a refusal: its exit code by what went wrong, its words the Install's. */
export function refusalError(refusal: Refusal, connection: Pick<Connection, "kind" | "profile">): CliError {
	const exit =
		refusal.status === 401
			? EXIT.signIn
			: refusal.code === "CHANGED_MEANWHILE"
				? EXIT.changedMeanwhile
				: refusal.status === 404 && refusal.code === "NOT_FOUND" && refusal.message.includes("public procedure")
					? EXIT.notOffered
					: EXIT.failed;
	let message = `${refusal.message} (${refusal.code})`;
	if (refusal.status === 401) {
		message +=
			connection.kind === "apiToken"
				? "\nWEBCRAFT_TOKEN doesn't work any more: make a new API token in the admin (Your account › API tokens)."
				: `\nRun: webcraft login --install ${connection.profile?.name ?? "<the Install's address>"}`;
	}
	const details = detailsOf(refusal);
	if (details) message += `\n${details}`;
	return new CliError(exit, message, refusal);
}

/** A refusal's details worth showing: validation issues and listed problems, one per line. */
function detailsOf(refusal: Refusal): string | null {
	const data = refusal.data as { issues?: unknown; problems?: unknown; retryAfterSeconds?: unknown } | undefined;
	const list = Array.isArray(data?.issues) ? data.issues : Array.isArray(data?.problems) ? data.problems : null;
	const lines: string[] = [];
	if (list) {
		for (const each of list.slice(0, 20)) {
			const item = each as { path?: unknown; at?: unknown; message?: unknown; line?: unknown; column?: unknown };
			const where = Array.isArray(item.path) ? item.path.join(".") : typeof item.at === "string" ? item.at : "";
			const position =
				typeof item.line === "number"
					? ` (line ${item.line}${typeof item.column === "number" ? `, column ${item.column}` : ""})`
					: "";
			lines.push(`  ${where ? `${where}: ` : ""}${String(item.message ?? JSON.stringify(each))}${position}`);
		}
	}
	if (typeof data?.retryAfterSeconds === "number") lines.push(`  Try again in ${data.retryAfterSeconds} seconds.`);
	return lines.length > 0 ? lines.join("\n") : null;
}

/** The answer of a two-step procedure's first call: a preview to confirm. */
function previewOf(answer: unknown): { id: string; expiresAt: unknown; preview: unknown } | null {
	if (typeof answer !== "object" || answer === null) return null;
	const { confirmation, preview } = answer as {
		confirmation?: { id?: unknown; expiresAt?: unknown };
		preview?: unknown;
	};
	if (!confirmation || typeof confirmation.id !== "string" || preview === undefined) return null;
	return { id: confirmation.id, expiresAt: confirmation.expiresAt, preview };
}

/**
 * Runs a remote command: reads its options, calls its procedure and prints the answer. A procedure
 * that takes two steps answers a preview first: it is shown, and the change goes ahead only once
 * confirmed (asked on a terminal, or `--yes`); otherwise nothing changes and the command exits 4.
 */
export async function runRemote(
	context: RunContext,
	connection: Connection,
	command: RemoteCommand,
	args: readonly string[],
): Promise<number> {
	const { io, options } = context;
	const input = await inputOf(command, args, io);
	let answer = await call(connection, command, input);

	const asked = command.confirmation && input.confirmation === undefined ? previewOf(answer) : null;
	if (asked) {
		const preview = options.json ? `${JSON.stringify(asked.preview, null, 2)}\n` : renderHuman(asked.preview);
		io.stderr(`webcraft ${command.words.join(" ")} asks you to confirm first:\n${preview}`);
		let confirmed = options.yes;
		if (!confirmed && io.interactive) {
			const reply = (await io.ask("Go ahead? [y/N] ")).trim().toLowerCase();
			confirmed = reply === "y" || reply === "yes";
			if (!confirmed) {
				io.stderr("Nothing changed.\n");
				return EXIT.notConfirmed;
			}
		}
		if (!confirmed) {
			if (options.json) io.stdout(`${JSON.stringify(answer, null, 2)}\n`);
			io.stderr(
				`Nothing changed. Pass --yes to go ahead, or call again with --confirmation ${asked.id} (it works once, for 5 minutes).\n`,
			);
			return EXIT.notConfirmed;
		}
		answer = await call(connection, command, { ...input, confirmation: asked.id });
	}

	if (options.json) io.stdout(`${JSON.stringify(answer, null, 2)}\n`);
	else io.stdout(answer === null || answer === undefined ? "Done.\n" : renderHuman(answer));
	return EXIT.ok;
}
