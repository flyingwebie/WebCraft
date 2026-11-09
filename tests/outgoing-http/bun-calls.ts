// Run with `bun`: makes outgoing calls with the web process's outgoing HTTP in a process of its own,
// so a test can start it with an environment of its own (such as `HTTP_PROXY`). Same protocol as
// `node-calls.ts`: one call per line on standard input, one outcome per line out; the first argument
// is the certificate authority (PEM) the calls trust.
import { createInterface } from "node:readline";
import { createBunHttp } from "@webcraft/server/outgoing-http";

import { type Call, runCall } from "./calls.ts";

const http = createBunHttp({ ca: process.argv[2] });

for await (const line of createInterface({ input: process.stdin })) {
	const { id, call } = JSON.parse(line) as { id: number; call: Call };
	runCall(http, call).then((outcome) => process.stdout.write(`${JSON.stringify({ id, outcome })}\n`));
}
