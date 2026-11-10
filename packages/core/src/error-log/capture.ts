import { currentLogContext, type LogContext, type LogFields, type Logger } from "../log.ts";
import { isModuleFailure } from "../modules/errors.ts";
import type { ErrorLog, ErrorSource } from "./service.ts";

/**
 * A logger that also notes each unexpected failure in the Error log: a line at error level with an
 * `error` field. That is WebCraft's one rule for unexpected failures, wherever they happen: the web
 * process's 500s, a Management API call that broke, a job that threw, a failure caught and logged so
 * the work goes on. Failures WebCraft expects (an outside server that doesn't answer, a refusal) are
 * logged at warn or not at all; a Module's own failures are in its Module log instead.
 */
export function reportingFailures(log: Logger, errorLog: ErrorLog): Logger {
	return {
		debug: (msg, fields) => log.debug(msg, fields),
		info: (msg, fields) => log.info(msg, fields),
		warn: (msg, fields) => log.warn(msg, fields),
		error(msg, fields) {
			log.error(msg, fields);
			const failure = unexpectedFailure(fields?.error);
			if (!failure) return;
			const context = currentLogContext();
			errorLog.capture(failure, { source: sourceOf(fields ?? {}, context), context });
		},
		child: (fields) => reportingFailures(log.child(fields), errorLog),
	};
}

/** The failure an error-level line is about, unwrapped from the API's answer; null when it isn't one to note. */
function unexpectedFailure(value: unknown): Error | null {
	if (!(value instanceof Error)) return null;
	// An API's answer to an error carries it as its cause.
	const failure = value.constructor.name === "ORPCError" && value.cause instanceof Error ? value.cause : value;
	return isModuleFailure(failure) ? null : failure;
}

/** Where a failure happened: the job it ran in, else the request (its procedure, or method and path). */
function sourceOf(fields: LogFields, context: LogContext): ErrorSource {
	if (context.job) return { kind: "job", name: context.job };
	if (!context.requestId) return { kind: "process", name: null };
	if (typeof fields.procedure === "string") return { kind: "request", name: fields.procedure };
	if (typeof fields.url === "string") {
		try {
			const method = typeof fields.method === "string" ? fields.method : "GET";
			return { kind: "request", name: `${method} ${new URL(fields.url).pathname}` };
		} catch {
			// Not a URL: the request is all that is known.
		}
	}
	return { kind: "request", name: null };
}
