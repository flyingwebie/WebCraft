import { z } from "zod";

import { defineJob } from "./define.ts";

/**
 * The sample job: a working example of a job that uses outgoing HTTP, the Clock and the log, and
 * the job the test harness's sample test drains. It asks a URL for its status and logs the answer.
 * Nothing in WebCraft enqueues it; copy its shape for real jobs. (A job that emails someone sends
 * a System email with `services.email.send`, never through the Mailer itself.)
 */
export const samplePing = defineJob({
	name: "sample.ping",
	payload: z.object({
		url: z.url({ protocol: /^https?$/ }),
	}),
	// A failed ping is tried twice more, a minute apart.
	queue: { retryLimit: 2, retryDelay: 60 },
	async run({ url }, { http, clock, log }) {
		const response = await http(new Request(url, { method: "GET" }));
		await response.body?.cancel();
		log.info("Pinged a URL", { url, status: response.status, checkedAt: clock.now().toISOString() });
	},
});
