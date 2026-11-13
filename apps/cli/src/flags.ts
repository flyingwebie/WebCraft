import { CliError, EXIT } from "./exit-codes.ts";

/**
 * One flag read from the command line: `--name`, `--name=value`, or `-f` (a short flag, always one
 * character after a single `-`, never carrying `=value`). A name starting with `no-` (`--no-trash`)
 * is kept as written - whether that negates another flag or is itself a flag called "no-trash" is
 * for the caller to decide from what it knows about its own flags; the tokenizer only reads syntax.
 */
export type Flag = {
	/** The name, with its leading `--` or `-` stripped: `--site-id` is `"site-id"`, `-y` is `"y"`. */
	name: string;
	/** The value after `=`, for `--name=value`; undefined when it wasn't written that way. */
	inline: string | undefined;
	/** A short flag (`-f`): one character after a single `-`. */
	short: boolean;
	/** Exactly as written, to quote in an error or to pass the flag through unparsed. */
	raw: string;
};

/**
 * Walks `args` one flag at a time: `--flag`, `--flag=value`, `-f` (a short flag); `--flag value`
 * (the value in a following argument) is `value(flag, …)` once the caller knows that flag takes
 * one. Every argument that isn't a flag - and everything after a bare `--`, flags included - is
 * collected into `rest`, in order; a command that takes no positional arguments treats a non-empty
 * `rest` as an error, one that takes some (such as `webcraft structure push`'s own words, or the
 * next parser down the line) reads it once this one is done with its own flags.
 *
 * Shared by every option parser in the CLI - `globalOptions` (`cli.ts`), `options` (`account/
 * commands.ts`), `parseOptions` (`structure/commands.ts`) and `inputOf` (`remote/input.ts`, which
 * layers a procedure's input schema on top: kebab-case aliases, `--no-` negation of a boolean
 * property, repeated list options, `--data`) - each knowing its own flags and what to do with one
 * it doesn't recognise (throw, or, only the global parser, pass it through for the next parser).
 */
export function readFlags(args: readonly string[]): {
	next(): Flag | null;
	value(flag: Flag, message: string): string;
	rest: string[];
} {
	const rest: string[] = [];
	let index = 0;
	return {
		next() {
			while (index < args.length) {
				const arg = args[index++] ?? "";
				if (arg === "--") {
					rest.push(...args.slice(index));
					index = args.length;
					return null;
				}
				if (arg === "-" || !arg.startsWith("-")) {
					rest.push(arg);
					continue;
				}
				if (!arg.startsWith("--")) {
					// A short flag is one letter after one dash (-y, -h, -V); anything else is positional.
					if (arg.length !== 2) {
						rest.push(arg);
						continue;
					}
					return { name: arg.slice(1), inline: undefined, short: true, raw: arg };
				}
				const body = arg.slice(2);
				const equals = body.indexOf("=");
				return {
					name: equals === -1 ? body : body.slice(0, equals),
					inline: equals === -1 ? undefined : body.slice(equals + 1),
					short: false,
					raw: arg,
				};
			}
			return null;
		},
		value(flag, message) {
			if (flag.inline !== undefined) return flag.inline;
			const value = args[index];
			if (value === undefined) throw new CliError(EXIT.usage, message);
			index++;
			return value;
		},
		rest,
	};
}
