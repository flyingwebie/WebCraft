import { SMTPServer } from "smtp-server";

/** An email as the local SMTP server received it: the envelope and the whole message. */
export type ReceivedEmail = { from: string; to: string[]; message: string };

/**
 * A real SMTP server on this machine, for tests that run the real Mailer (the worker process, the
 * production web process in browser tests). Plain SMTP on 127.0.0.1; it asks for the username and
 * password given, and takes every email.
 */
export type LocalSmtpServer = {
	host: "127.0.0.1";
	port: number;
	/** Every email it took, oldest first. */
	readonly received: readonly ReceivedEmail[];
	/** The first email it took, waiting for one when none has arrived yet. */
	firstEmail(timeoutMs?: number): Promise<ReceivedEmail>;
	close(): Promise<void>;
};

export async function startSmtpServer(account: { username: string; password: string }): Promise<LocalSmtpServer> {
	const received: ReceivedEmail[] = [];
	const waiting: ((email: ReceivedEmail) => void)[] = [];
	const server = new SMTPServer({
		logger: false,
		disabledCommands: ["STARTTLS"],
		authMethods: ["PLAIN", "LOGIN"],
		onAuth(auth, _session, done) {
			if (auth.username === account.username && auth.password === account.password) {
				return done(null, { user: auth.username });
			}
			done(Object.assign(new Error("Authentication failed"), { responseCode: 535 }));
		},
		onData(stream, session, done) {
			let message = "";
			stream.setEncoding("utf8");
			stream.on("data", (chunk: string) => {
				message += chunk;
			});
			stream.on("end", () => {
				const email = {
					from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
					to: session.envelope.rcptTo.map((recipient) => recipient.address),
					message,
				};
				received.push(email);
				for (const resolve of waiting.splice(0)) resolve(email);
				done();
			});
		},
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.server.address();
	if (typeof address !== "object" || !address) throw new Error("The local SMTP server didn't start.");

	return {
		host: "127.0.0.1",
		port: address.port,
		received,
		firstEmail(timeoutMs = 20_000) {
			const already = received[0];
			if (already) return Promise.resolve(already);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`No email arrived in ${timeoutMs} ms.`)), timeoutMs);
				waiting.push((email) => {
					clearTimeout(timer);
					resolve(email);
				});
			});
		},
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}
