import { os } from "@orpc/server";
import {
	type Access,
	askConfirmation,
	type Confirmation,
	giveBackConfirmation,
	type InstallServices,
	isApiClient,
	type Permission,
	type PublishItem,
	publishPermission,
	type SiteScope,
	useConfirmation,
} from "@webcraft/core";
import { z } from "zod";

import type { ApiContext } from "./context.ts";

/** The `confirmation` input of a two-step procedure: the id the first call answered. */
export const confirmationInput = z.string().max(100).optional();

/** What a two-step change is about, worked out again on each call: its target and what the person is shown. */
type Described = { target: string; preview: unknown };

/**
 * Two steps for API clients (spec › Management API, ADR 0030): procedures that publish or delete
 * Structure, which the admin takes in one call (the person pressed Publish on what they see), take
 * a preview and a confirmation from an API client. Its first call changes nothing and answers
 * `{ confirmation: { id, expiresAt }, preview }`; calling again with `confirmation` (valid 5
 * minutes, once, while the preview is unchanged) goes ahead. Anyone who sends a `confirmation`
 * has it checked. It is used up only when the change goes ahead: one that fails gives it back. Put it after `.input(…)`; the input carries `siteId` and `confirmation`.
 *
 * The Site is opened with the Permission the change needs, so nobody is asked to confirm what they
 * may not do.
 */
export function confirmedForApiClients<Input extends { siteId: string; confirmation?: string | undefined }>(step: {
	/** The action, as the Audit log names it: `entry.publish`. */
	action: string;
	permission: (input: Input) => Permission;
	describe: (site: SiteScope, input: Input, services: InstallServices) => Promise<Described>;
}) {
	return os.$context<ApiContext & { access: Access }>().middleware(async ({ context, next }, input: Input) => {
		const given = input.confirmation;
		if (given === undefined && !isApiClient(context.access)) return next();
		const site = await context.services.data.site(context.access, input.siteId, step.permission(input));
		const { target, preview } = await step.describe(site, input, context.services);
		const request = { action: step.action, target, preview };
		if (given === undefined) {
			const confirmation: Confirmation = await askConfirmation(site, request);
			return { output: { confirmation, preview }, context: {} };
		}
		const used = await site.transaction((tx) => useConfirmation(tx, given, request));
		try {
			return await next();
		} catch (error) {
			// The change runs in its own transaction: when it fails, nothing went ahead, so the
			// confirmation works again rather than being spent on nothing.
			await giveBackConfirmation(site, used);
			throw error;
		}
	});
}

/**
 * Publishing through `confirmedForApiClients`: an API client is first shown what publishing the
 * item would do (`publishing.preview`: its name, whether it is new or changed, the Draft's version).
 */
export function confirmedPublish<Input extends { siteId: string; confirmation?: string | undefined }>(
	itemOf: (input: Input) => PublishItem,
) {
	return confirmedForApiClients<Input>({
		action: "publish",
		permission: (input) => publishPermission(itemOf(input)),
		describe: async (site, input, services) => {
			const item = itemOf(input);
			return {
				target: "id" in item ? `${item.kind}:${item.id}` : item.kind,
				preview: await services.publishing.preview(site, item),
			};
		},
	});
}
