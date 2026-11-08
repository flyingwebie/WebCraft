import { z } from "zod";

import { defineJob } from "./define.ts";

/**
 * The sample job: a working example of a job that uses outgoing HTTP, the Mailer and the Clock,
 * and the job the test harness's sample test drains. It asks a URL for its status and emails the
 * answer. Nothing in WebCraft enqueues it; copy its shape for real jobs.
 */
export const samplePing = defineJob({
	name: "sample.ping",
	payload: z.object({
		url: z.url({ protocol: /^https?$/ }),
		notify: z.email(),
	}),
	// A failed ping is tried twice more, a minute apart.
	queue: { retryLimit: 2, retryDelay: 60 },
	async run({ url, notify }, { http, mailer, clock, log }) {
		const response = await http(new Request(url, { method: "GET" }));
		await response.body?.cancel();
		const checkedAt = clock.now().toISOString();
		await mailer.send({
			to: notify,
			subject: `${url} answered ${response.status}`,
			text: `Checked ${url} at ${checkedAt}: HTTP ${response.status}.`,
		});
		log.info("Pinged a URL", { url, status: response.status });
	},
});
