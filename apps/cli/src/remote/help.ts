import { type Catalogue, commandsUnder, type RemoteCommand } from "./catalogue.ts";
import { choicesOf, kindsOf, optionName, placeholder, propertiesOf } from "./input.ts";

/** The groups of remote commands (their first word), with how many commands each has. */
export function groupsHelp(catalogue: Catalogue): string {
	const groups = new Map<string, number>();
	for (const command of catalogue.commands) {
		const first = command.words[0] ?? "";
		groups.set(first, (groups.get(first) ?? 0) + 1);
	}
	const width = Math.max(0, ...[...groups.keys()].map((name) => name.length));
	return [...groups.entries()]
		.map(([name, count]) => `  ${name.padEnd(width)}  ${count} command${count === 1 ? "" : "s"}`)
		.join("\n");
}

/** The commands under some words (`webcraft entries --help`), each with its summary. */
export function listHelp(catalogue: Catalogue, prefix: readonly string[]): string | null {
	const commands = commandsUnder(catalogue, prefix);
	if (commands.length === 0) return null;
	const names = commands.map((command) => command.words.join(" "));
	const width = Math.min(48, Math.max(...names.map((name) => name.length)));
	const lines = commands.map((command, index) => {
		const name = names[index] ?? "";
		const marks = [command.access === "read" ? "reads" : "changes", command.confirmation ? "confirm" : null]
			.filter(Boolean)
			.join(", ");
		return `  ${name.padEnd(width)}  ${command.summary} [${marks}]`;
	});
	return `Commands under webcraft ${prefix.join(" ")}:\n${lines.join("\n")}\n\nSee webcraft <command> --help for a command's options.\n`;
}

/** One command's help: what it does, its options from the procedure's input schema, and its marks. */
export function commandHelp(command: RemoteCommand): string {
	const properties = propertiesOf(command.input);
	const required = new Set(Array.isArray(command.input.required) ? (command.input.required as string[]) : []);
	const rows = Object.entries(properties)
		.filter(([name]) => name !== "confirmation")
		.map(([name, schema]) => {
			const kinds = kindsOf(schema);
			const value = placeholder(schema, command, name);
			const left =
				kinds.has("boolean") && kinds.size <= 2
					? `--${optionName(name)}, --no-${optionName(name)}`
					: `--${optionName(name)} ${value}`;
			const notes = [
				required.has(name) ? "required" : null,
				kinds.has("null") && !kinds.has("boolean") ? "null allowed" : null,
				typeof schema.description === "string" ? schema.description : null,
				choicesOf(schema) === null && value.endsWith("…") ? "repeat it for several" : null,
			].filter(Boolean);
			return { left, right: notes.join("; ") };
		});
	const width = Math.min(44, Math.max(10, ...rows.map((row) => row.left.length)));
	const options = rows.length
		? rows.map((row) => `  ${row.left.padEnd(width)}  ${row.right}`.trimEnd()).join("\n")
		: "  (none)";
	const notes = [
		command.access === "read" ? "It only reads." : "It changes the Install.",
		command.publishes ? "It publishes: what visitors see changes." : null,
		command.confirmation
			? "It takes two steps: the Install shows what it would do first; it goes ahead once you confirm (or with --yes)."
			: null,
		`Toolsets: ${command.toolsets === "always" ? "every client" : command.toolsets.join(", ")}.`,
	].filter(Boolean);
	return (
		`webcraft ${command.words.join(" ")}\n\n${command.summary}\n\n` +
		`Options:\n${options}\n` +
		`  --data <json|@file|->${" ".repeat(Math.max(1, width - 20))}  the whole input as JSON (options change it)\n\n` +
		`${notes.join("\n")}\nProcedure: ${command.operationId} (POST /api/v1/${command.path}).\n`
	);
}
