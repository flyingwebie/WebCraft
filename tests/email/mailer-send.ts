// Run with `node` or `bun`: sends one email with the real Mailer, so a test can check how it connects
// on each runtime (the worker's and the web process's). Its one argument is JSON: the certificate
// authority the send trusts (PEM), and the server to send through. It writes one line of JSON: the
// server's answer, or what went wrong.
import { createSmtpMailer, type SmtpConnection, SmtpDeliveryError } from "@webcraft/core";

const { ca, smtp } = JSON.parse(process.argv[2] ?? "{}") as { ca: string; smtp: SmtpConnection };

const outcome = await createSmtpMailer({ ca })
	.send(
		{
			from: { name: "Acme Bakery", address: "hello@acmebakery.example" },
			to: "davide@agency.example",
			subject: "A pinned send",
			text: "Sent to the address checked.",
			html: "<p>Sent to the address checked.</p>",
		},
		smtp,
	)
	.then(
		(receipt) => ({ sent: receipt.response }),
		(error: unknown) => ({ failed: error instanceof SmtpDeliveryError ? error.response : String(error) }),
	);
process.stdout.write(`${JSON.stringify(outcome)}\n`);
