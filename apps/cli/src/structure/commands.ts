import { CliError, EXIT } from "../exit-codes.ts";
import type { RunContext } from "../remote/connection.ts";

export async function runStructure(
	_context: RunContext,
	command: string,
	_args: string[],
	_help: boolean,
): Promise<number> {
	throw new CliError(EXIT.usage, `webcraft structure ${command} isn't ready yet.`);
}
