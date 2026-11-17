// Awaits a promise before a test asserts on it. Bun's `expect(promise).rejects` and `.resolves`
// wait for the promise without running queued `setImmediate` callbacks, so anything the promise
// waits on through one (the test clock settling the job queue, pg-pool releasing a connection)
// sits until some timer happens to wake the event loop: up to a second each time. Tests await
// first and assert on the value instead (AGENTS.md, "Tests"); lint refuses `.rejects` and
// `.resolves`.

/** What `promise` rejected with. Fails the test when it resolves instead. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
	let value: unknown;
	try {
		value = await promise;
	} catch (reason) {
		return reason;
	}
	throw new Error(`Expected a rejection, but the promise resolved with ${describe(value)}.`);
}

/** A function that throws what `promise` rejected with, for `toThrow`. Fails when it resolves. */
export async function thrown(promise: Promise<unknown>): Promise<() => never> {
	const reason = await rejection(promise);
	return () => {
		throw reason;
	};
}

function describe(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
