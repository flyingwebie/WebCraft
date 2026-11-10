import { AsyncLocalStorage } from "node:async_hooks";

import { type Clock, systemClock } from "./clock.ts";
import { redactLogEntry } from "./redaction.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The levels, from the most to the least talkative. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const satisfies readonly LogLevel[];

export type LogFields = Record<string, unknown>;

export type LogEntry = LogFields & {
	time: string;
	level: LogLevel;
	msg: string;
};

/** Structured logging: one JSON object per line. */
export type Logger = {
	debug(msg: string, fields?: LogFields): void;
	info(msg: string, fields?: LogFields): void;
	warn(msg: string, fields?: LogFields): void;
	error(msg: string, fields?: LogFields): void;
	/** A logger that adds `fields` to every entry, such as `{ job: "sample.ping" }`. */
	child(fields: LogFields): Logger;
};

/**
 * What a line says about the work it belongs to, filled in by whoever starts that work, so every line
 * written meanwhile carries it, however deep the code that writes it: the request (`requestId`), the
 * job (`job`, `jobId`), the Workspace and Site the work is on (`workspaceId`, `siteId`, set as the
 * data layer opens them) and the Module whose code runs (`module`).
 */
export type LogContext = {
	requestId?: string;
	job?: string;
	jobId?: string;
	workspaceId?: string;
	siteId?: string;
	module?: string;
};

const contexts = new AsyncLocalStorage<LogContext>();

/**
 * Runs `work` with `fields` added to the log context it was called in: every line written while it
 * runs (and in what it starts, such as promises it waits for) carries them.
 */
export function withLogContext<Result>(fields: LogContext, work: () => Result): Result {
	return contexts.run({ ...contexts.getStore(), ...fields }, work);
}

/** Runs `work` outside any work's log context: the process's own upkeep, started from inside a request. */
export function withoutLogContext<Result>(work: () => Result): Result {
	return contexts.exit(work);
}

/** What the current work's log lines carry; empty outside any. */
export function currentLogContext(): LogContext {
	return { ...contexts.getStore() };
}

/**
 * Notes where the current work is (a Workspace, a Site), for the rest of its lines: the data layer
 * calls it as it opens one. Outside any work it does nothing.
 */
export function noteLogPlace(place: { workspaceId: string; siteId?: string | null }): void {
	const store = contexts.getStore();
	if (!store) return;
	store.workspaceId = place.workspaceId;
	if (place.siteId) store.siteId = place.siteId;
	else delete store.siteId;
}

/** How log lines are written: JSON (the default) or, for `bun run dev` only, one readable line each. */
export type LogFormat = "json" | "pretty";

type LoggerOptions = {
	/** Fields added to every entry, such as `{ process: "worker" }`. */
	fields?: LogFields;
	/** Receives each entry. Defaults to writing one line to standard output in `format`. */
	write?: (entry: LogEntry) => void;
	clock?: Clock;
	/** The least important level written: `info` unless given (`WEBCRAFT_LOG_LEVEL`). */
	level?: LogLevel;
	/** How lines are written to standard output: JSON unless given (`WEBCRAFT_LOG_FORMAT`). */
	format?: LogFormat;
};

/**
 * Creates a logger that writes one JSON object per line to standard output: `time` (ISO, UTC),
 * `level`, `msg`, the fields given and the log context's. Every entry is redacted first
 * (`redaction.ts`): secrets, cookies, Authorization headers, form contents and email bodies never
 * reach a line.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
	const write = options.write ?? (options.format === "pretty" ? writePrettyLine : writeJsonLine);
	const clock = options.clock ?? systemClock;
	const base = options.fields ?? {};
	const least = LOG_LEVELS.indexOf(options.level ?? "info");

	const log = (level: LogLevel, msg: string, fields?: LogFields) => {
		if (LOG_LEVELS.indexOf(level) < least) return;
		write(
			redactLogEntry({
				time: clock.now().toISOString(),
				level,
				msg,
				...base,
				...contexts.getStore(),
				...fields,
			}),
		);
	};

	return {
		debug: (msg, fields) => log("debug", msg, fields),
		info: (msg, fields) => log("info", msg, fields),
		warn: (msg, fields) => log("warn", msg, fields),
		error: (msg, fields) => log("error", msg, fields),
		child: (fields) => createLogger({ ...options, write, clock, fields: { ...base, ...fields } }),
	};
}

/** A setting of the process's logs is malformed. */
export class LogSettingsError extends Error {
	override name = "LogSettingsError";
}

/**
 * The process's log settings from its environment: `WEBCRAFT_LOG_LEVEL` (`debug`, `info`, `warn` or
 * `error`; `info` unless set) and `WEBCRAFT_LOG_FORMAT` (`json`, or `pretty`, which `bun run dev`
 * sets; `json` unless set). Refuses anything else, as every setting is.
 */
export function logSettings(env: Record<string, string | undefined>): { level: LogLevel; format: LogFormat } {
	const level = env.WEBCRAFT_LOG_LEVEL?.trim().toLowerCase() || "info";
	if (!(LOG_LEVELS as readonly string[]).includes(level)) {
		throw new LogSettingsError(`WEBCRAFT_LOG_LEVEL must be debug, info, warn or error (got "${level}").`);
	}
	const format = env.WEBCRAFT_LOG_FORMAT?.trim().toLowerCase() || "json";
	if (format !== "json" && format !== "pretty") {
		throw new LogSettingsError(`WEBCRAFT_LOG_FORMAT must be json or pretty (got "${format}").`);
	}
	return { level: level as LogLevel, format };
}

function writeJsonLine(entry: LogEntry): void {
	process.stdout.write(`${JSON.stringify(entry)}\n`);
}

/** `bun run dev`'s lines: the time, the level and the message, then the other fields as JSON. */
function writePrettyLine(entry: LogEntry): void {
	const { time, level, msg, process: from, ...rest } = entry;
	const error = rest.error as { stack?: string } | undefined;
	if (error?.stack) delete rest.error;
	const fields = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
	const where = typeof from === "string" ? `${from} ` : "";
	const line = `${time.slice(11, 23)} ${where}${level.toUpperCase().padEnd(5)} ${msg}${fields}`;
	process.stdout.write(`${error?.stack ? `${line}\n${error.stack}` : line}\n`);
}
