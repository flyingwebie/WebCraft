import { type Clock, systemClock } from "./clock.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

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

type LoggerOptions = {
	/** Fields added to every entry, such as `{ process: "worker" }`. */
	fields?: LogFields;
	/** Receives each entry. Defaults to writing one JSON line to standard output. */
	write?: (entry: LogEntry) => void;
	clock?: Clock;
};

/** Creates a logger that writes JSON lines to standard output. */
export function createLogger(options: LoggerOptions = {}): Logger {
	const write = options.write ?? writeJsonLine;
	const clock = options.clock ?? systemClock;
	const base = options.fields ?? {};

	const log = (level: LogLevel, msg: string, fields?: LogFields) => {
		write({
			time: clock.now().toISOString(),
			level,
			msg,
			...base,
			...serialiseErrors(fields ?? {}),
		});
	};

	return {
		debug: (msg, fields) => log("debug", msg, fields),
		info: (msg, fields) => log("info", msg, fields),
		warn: (msg, fields) => log("warn", msg, fields),
		error: (msg, fields) => log("error", msg, fields),
		child: (fields) => createLogger({ write, clock, fields: { ...base, ...fields } }),
	};
}

function writeJsonLine(entry: LogEntry): void {
	process.stdout.write(`${JSON.stringify(entry)}\n`);
}

/** `Error` objects have no enumerable fields, so JSON would drop their message and stack. */
function serialiseErrors(fields: LogFields): LogFields {
	const result: LogFields = {};
	for (const [key, value] of Object.entries(fields)) {
		result[key] = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
	}
	return result;
}
