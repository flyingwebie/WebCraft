/**
 * The edit requests the code panes send (BA-11): Code mode's (`code/editorMarkup`, `code/editorRead`,
 * `code/preview`, `code/scripts`, `code/saveScript`), from the shell, as `api.ts`'s `editRequests` sends
 * them, but keeping what a refusal says beside its code: the markup's problems with their lines and
 * columns (`TEMPLATE_MARKUP_INVALID`), the newer version someone saved (`CHANGED_MEANWHILE`).
 */

/** An answer: its JSON, or the refusal's code, words and data. */
export type CodeAnswer<T> =
	| { ok: true; data: T }
	| { ok: false; status: number; code: string; message: string; data: Record<string, unknown> };

export type CodeRequests = <T = unknown>(action: string, body: unknown) => Promise<CodeAnswer<T>>;

/** A problem of markup that can't be read, where it is. */
export type MarkupProblem = { line: number; column: number; message: string };

const EDIT_TOKEN_HEADER = "x-webcraft-edit-token";

export function codeRequests(token: string): CodeRequests {
	return async <T>(action: string, body: unknown): Promise<CodeAnswer<T>> => {
		try {
			const response = await fetch(`/_webcraft/edit/api/${action}`, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json", [EDIT_TOKEN_HEADER]: token },
				body: JSON.stringify(body),
			});
			const json: unknown = await response.json().catch(() => null);
			if (response.ok) return { ok: true, data: json as T };
			const refusal = (json ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
			return {
				ok: false,
				status: response.status,
				code: typeof refusal.code === "string" ? refusal.code : "generic",
				message: typeof refusal.message === "string" ? refusal.message : "",
				data: refusal.data && typeof refusal.data === "object" ? (refusal.data as Record<string, unknown>) : {},
			};
		} catch {
			return { ok: false, status: 0, code: "network", message: "", data: {} };
		}
	};
}

/** The problems a refusal lists (markup that can't be read), with their lines and columns. */
export function problemsOf(answer: CodeAnswer<unknown>): MarkupProblem[] {
	if (answer.ok) return [];
	const listed = answer.data.problems;
	if (!Array.isArray(listed)) return [];
	return listed.flatMap((each) => {
		const problem = each as Partial<MarkupProblem>;
		return typeof problem.line === "number" && typeof problem.message === "string"
			? [
					{
						line: problem.line,
						column: typeof problem.column === "number" ? problem.column : 1,
						message: problem.message,
					},
				]
			: [];
	});
}

/** A 1-based line of a text from an offset in it. */
export function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let at = 0; at < offset && at < text.length; at++) if (text[at] === "\n") line++;
	return line;
}

/** An offset in a text from a 1-based line and column. */
export function offsetAt(text: string, line: number, column = 1): number {
	let offset = 0;
	for (let now = 1; now < line; now++) {
		const next = text.indexOf("\n", offset);
		if (next < 0) return text.length;
		offset = next + 1;
	}
	return Math.min(text.length, offset + Math.max(0, column - 1));
}
