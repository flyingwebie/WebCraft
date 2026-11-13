// Failure while finishing an import must leave neither a Site nor its files/jobs behind.
// A real key rotation races the import at the external S3 edge; no DB or service is mocked.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeS3, createTestInstall, TEST_MASTER_KEY } from "../harness/index.ts";
import { exportedArchive, PASSPHRASE, uploadArchive } from "../harness/site-transfer.ts";

const CLI = new URL("../../apps/cli/src/main.ts", import.meta.url).pathname;
const NEW_KEY = Buffer.alloc(32, 19).toString("base64");

test("a Master key rotation during import rolls back the Site, its secrets, Audit and queued work together", async () => {
	const install = await createTestInstall();
	const directory = await mkdtemp(join(tmpdir(), "webcraft-transfer-finalization-"));
	try {
		let admin = await install.superadmin();
		const source = (await install.createWorkspace("Source")).id;
		const destination = (await install.createWorkspace("Destination")).id;
		const siteId = (await install.createSite(source, { slug: "source" })).id;
		await admin.api.siteSmtp.update({
			siteId,
			fromName: null,
			replyTo: null,
			server: {
				host: "smtp.example",
				port: 587,
				security: "starttls",
				username: "source",
				fromAddress: "hello@example.org",
				password: "source-smtp-password",
			},
		});
		await install.drainJobs();
		const archive = await exportedArchive(install, admin, siteId, { passphrase: PASSPHRASE });

		let rotated = false;
		let armed = false;
		const settings = {
			endpoint: "https://atomic.storage.test",
			bucket: "private",
			region: "eu-west-1",
			accessKeyId: "TEST",
			secretAccessKey: "storage-password",
		};
		const bucket = createFakeS3(
			{
				...install.http,
				respond(method, url, answer) {
					install.http.respond(method, url, async (request) => {
						if (armed && !rotated && request.method === "GET" && request.url.endsWith("/part-000002")) {
							const child = Bun.spawn(["bun", CLI, "admin", "rotate-key"], {
								cwd: directory,
								env: {
									PATH: process.env.PATH ?? "",
									...install.env,
									WEBCRAFT_OLD_SECRET_KEY: TEST_MASTER_KEY,
									WEBCRAFT_SECRET_KEY: NEW_KEY,
								},
								stdout: "pipe",
								stderr: "pipe",
							});
							const [code, stderr] = await Promise.all([
								child.exited,
								new Response(child.stderr).text(),
								new Response(child.stdout).text(),
							]);
							expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
							rotated = true;
						}
						return typeof answer === "function" ? answer(request) : answer;
					});
				},
			},
			settings,
		);
		await admin.api.install.storage.update({ kind: "s3", ...settings, prefix: "install", pathStyle: true });
		// The second part contains the last table/index bytes and both EOF blocks. It must
		// be consumed, rather than merely prefetched after the tar reader has finished.
		const uploaded = await uploadArchive(admin, destination, archive, { partBytes: archive.length - 2048 });
		await admin.api.siteImports.start({
			workspaceId: destination,
			importId: uploaded.id,
			name: "Atomic copy",
			slug: "atomic-copy",
			passphrase: PASSPHRASE,
		});
		armed = true;
		await install.drainJobs({ only: ["siteImports.run"] });
		expect(rotated).toBe(true);
		await install.restart({ masterKey: NEW_KEY });
		admin = await install.superadmin();
		const { import: result } = await admin.api.siteImports.get({ workspaceId: destination, importId: uploaded.id });
		expect(result.status).toBe("failed");
		expect(result.site).toBeNull();
		expect((await admin.api.sites.list({ workspaceId: destination })).sites).toEqual([]);
		expect([...bucket.objects.keys()].filter((key) => key.includes("/media/"))).toEqual([]);
		const jobs = await install.drainJobs({ only: ["media.process", "media.variants", "socialCards.render"] });
		expect(jobs.completed).toEqual([]);
		expect(jobs.failed).toEqual([]);
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
});
