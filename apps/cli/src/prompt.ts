/** Whether the command runs on a terminal a person types into. */
export function interactive(): boolean {
	return Boolean(process.stdin.isTTY);
}

/** Asks a question on the terminal and answers the line typed, echoed as usual. */
export async function ask(question: string): Promise<string> {
	process.stderr.write(question);
	return readLine(false);
}

/** Asks for a secret on the terminal without echoing what is typed. */
export async function askSecret(question: string): Promise<string> {
	process.stderr.write(question);
	const answer = await readLine(true);
	process.stderr.write("\n");
	return answer;
}

/** The first line of standard input, for scripts that pipe a secret in. */
export async function firstLineOfStandardInput(): Promise<string> {
	const text = await Bun.stdin.text();
	return text.split(/\r?\n/, 1)[0] ?? "";
}

/** Reads one line from the terminal. Hidden lines are read in raw mode, so nothing is echoed. */
function readLine(hidden: boolean): Promise<string> {
	const stdin = process.stdin;
	return new Promise((resolve, reject) => {
		let line = "";
		if (hidden) stdin.setRawMode(true);
		stdin.setEncoding("utf8");
		stdin.resume();
		const done = (error?: Error) => {
			stdin.off("data", onData);
			if (hidden) stdin.setRawMode(false);
			stdin.pause();
			if (error) reject(error);
			else resolve(line);
		};
		const onData = (chunk: string) => {
			for (const character of chunk) {
				if (character === "\r" || character === "\n") return done();
				if (character === "\u0003") return done(new Error("Cancelled."));
				if (character === "\u007f" || character === "\b") line = Array.from(line).slice(0, -1).join("");
				else line += character;
			}
		};
		stdin.on("data", onData);
	});
}
