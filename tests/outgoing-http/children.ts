// A process making outgoing calls for a test (`node-calls.ts` on Node, `bun-calls.ts` on Bun): the
// test sends it calls as data and gets their outcomes back.
import type { Call, Outcome } from "./calls.ts";

export const NODE_CALLS = new URL("./node-calls.ts", import.meta.url).pathname;
export const BUN_CALLS = new URL("./bun-calls.ts", import.meta.url).pathname;

export type CallsProcess = { call(call: Call): Promise<Outcome>; close(): Promise<void> };

/** Starts `command` (which reads calls on standard input and writes their outcomes) with `env`. */
export function startCalls(command: string[], env: Record<string, string | undefined> = process.env): CallsProcess {
	const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
	const waiting = new Map<number, (outcome: Outcome) => void>();
	let nextId = 0;
	let stderr = "";
	(async () => {
		for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) stderr += chunk;
	})();
	(async () => {
		let buffered = "";
		for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
			buffered += chunk;
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				const { id, outcome } = JSON.parse(line) as { id: number; outcome: Outcome };
				waiting.get(id)?.(outcome);
				waiting.delete(id);
			}
		}
		for (const settle of waiting.values()) settle({ error: { name: "ProcessExited", message: stderr } });
	})();
	return {
		call(call) {
			const id = nextId++;
			const outcome = new Promise<Outcome>((resolve) => waiting.set(id, resolve));
			child.stdin.write(`${JSON.stringify({ id, call })}\n`);
			child.stdin.flush();
			return outcome;
		},
		async close() {
			child.stdin.end();
			await child.exited;
		},
	};
}
