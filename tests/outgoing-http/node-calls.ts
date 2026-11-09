// Run with `node`: makes outgoing calls with the worker's outgoing HTTP, so a test running on Bun can
// check how it behaves on Node. It reads one call per line on standard input (`{ id, call }`, JSON)
// and writes one outcome per line (`{ id, outcome }`), in whatever order the calls finish. The first
// argument is the certificate authority (PEM) the calls trust.
import { createInterface } from "node:readline";
import { createNodeHttp } from "@webcraft/core";

import { type Call, runCall } from "./calls.ts";

const http = createNodeHttp({ ca: process.argv[2] });

for await (const line of createInterface({ input: process.stdin })) {
	const { id, call } = JSON.parse(line) as { id: number; call: Call };
	runCall(http, call).then((outcome) => process.stdout.write(`${JSON.stringify({ id, outcome })}\n`));
}
