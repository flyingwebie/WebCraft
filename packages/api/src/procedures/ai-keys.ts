import { AI_CAP_MAX, AI_KEY_LIMITS, AI_PROVIDERS } from "@webcraft/core";
import { z } from "zod";

import { onInstall, onWorkspace, sensitive, signedIn } from "../context.ts";
import { id } from "../inputs.ts";

const provider = z.enum(AI_PROVIDERS);
const model = z.string().trim().min(1).max(AI_KEY_LIMITS.model);
/** An OpenAI-compatible provider's address (`https://llm.example.com/v1`); null for every other provider. */
const endpoint = z.string().trim().max(AI_KEY_LIMITS.endpoint).nullable();
/** The key itself; write-only. */
const key = z.string().trim().min(1).max(AI_KEY_LIMITS.key);
/** Dollars per million input and output tokens; null for WebCraft's estimate for the model. */
const price = z.object({ input: z.number().min(0).max(10_000), output: z.number().min(0).max(10_000) }).nullable();
/** Dollars a month (estimated cost); null for none. */
const monthlyCap = z.number().min(0.01).max(AI_CAP_MAX).nullable();

/**
 * A Workspace's AI keys (ADR 0011): its own key, which its Owners and Staff set (`aiKey.manage`), and
 * the shared Install key the Superadmin assigned to it, shown without the key. The own key wins.
 * Setting, replacing and removing the own key is a Sensitive action (`aiKey.change`): the key is a
 * secret, and the endpoint decides where it is sent. Keys are write-only: only "set" and the last 4
 * characters are ever shown.
 */
export const aiKeys = {
	/** The Workspace's own key, the shared key assigned to it, which one calls go through, and this month's usage. */
	get: signedIn
		.input(z.object({ workspaceId: id }))
		.use(onWorkspace("aiKey.manage"))
		.handler(({ context }) => context.services.aiKeys.view(context.workspace)),

	/**
	 * Sets the Workspace's own key: its provider, model, endpoint (OpenAI-compatible only), price and
	 * monthly cap. Without `key` the stored key is kept, but only while the provider and endpoint stay
	 * as they are: a stored key is never sent anywhere new.
	 */
	setOwn: signedIn
		.input(
			z.object({
				workspaceId: id,
				provider,
				model,
				endpoint,
				key: key.optional(),
				price: price.optional(),
				monthlyCap: monthlyCap.optional(),
			}),
		)
		.use(onWorkspace("aiKey.manage"))
		.use(sensitive("aiKey.change"))
		.handler(async ({ context, input }) => {
			const { workspaceId: _, ...settings } = input;
			await context.services.aiKeys.setOwn(context.workspace, settings);
			return context.services.aiKeys.view(context.workspace);
		}),

	/** Removes the Workspace's own key; calls go through the shared key, if one is assigned. */
	removeOwn: signedIn
		.input(z.object({ workspaceId: id }))
		.use(onWorkspace("aiKey.manage"))
		.use(sensitive("aiKey.change"))
		.handler(async ({ context }) => {
			await context.services.aiKeys.removeOwn(context.workspace);
			return context.services.aiKeys.view(context.workspace);
		}),

	/** Sets or removes the own key's monthly cap (dollars of estimated cost). */
	setOwnCap: signedIn
		.input(z.object({ workspaceId: id, monthlyCap }))
		.use(onWorkspace("aiKey.manage"))
		.handler(async ({ context, input }) => {
			await context.services.aiKeys.setOwnCap(context.workspace, input.monthlyCap);
			return context.services.aiKeys.view(context.workspace);
		}),

	/** Test: one small call with the own key; answers whether it went through, or why not. */
	testOwn: signedIn
		.input(z.object({ workspaceId: id }))
		.use(onWorkspace("aiKey.manage"))
		.handler(({ context }) => context.services.aiKeys.testOwn(context.workspace)),
};

/** A shared Install key's settings, as the Superadmin's form sends them. */
const sharedKey = {
	name: z.string().trim().min(1).max(AI_KEY_LIMITS.name),
	provider,
	model,
	endpoint,
	price: price.optional(),
};

/**
 * Shared Install keys: AI keys the Superadmin adds and assigns to Workspaces, each Workspace with a
 * required monthly cap (Install settings › AI). Adding, replacing or removing one, and letting shared
 * keys reach endpoints inside the Install's network, are Sensitive actions (`aiKey.change`).
 */
export const sharedAiKeys = {
	/** Every shared key (only "set" and its last 4 characters), the Workspaces it is assigned to, and every Workspace. */
	list: onInstall("install.manage").handler(({ context }) => context.services.aiKeys.shared.list(context.install)),

	add: onInstall("install.manage")
		.use(sensitive("aiKey.change"))
		.input(z.object({ ...sharedKey, key }))
		.handler(async ({ context, input }) => ({ key: await context.services.aiKeys.shared.add(context.install, input) })),

	/** Changes a shared key. Without `key` the stored key is kept, but only while its provider and endpoint stay. */
	update: onInstall("install.manage")
		.use(sensitive("aiKey.change"))
		.input(z.object({ keyId: id, ...sharedKey, key: key.optional() }))
		.handler(async ({ context, input }) => {
			const { keyId, ...settings } = input;
			return { key: await context.services.aiKeys.shared.update(context.install, keyId, settings) };
		}),

	/** Removes a shared key; the Workspaces it was assigned to have none until another is assigned. */
	remove: onInstall("install.manage")
		.use(sensitive("aiKey.change"))
		.input(z.object({ keyId: id }))
		.handler(async ({ context, input }) => {
			await context.services.aiKeys.shared.remove(context.install, input.keyId);
			return { removed: true };
		}),

	/** Test: one small call with the shared key. */
	test: onInstall("install.manage")
		.input(z.object({ keyId: id }))
		.handler(({ context, input }) => context.services.aiKeys.shared.test(context.install, input.keyId)),

	/** Assigns a shared key to a Workspace with its monthly cap (required), or takes it away (`keyId: null`). */
	assign: onInstall("install.manage")
		.input(z.object({ workspaceId: id, keyId: id.nullable(), monthlyCap }))
		.handler(async ({ context, input }) => {
			await context.services.aiKeys.shared.assign(context.install, input.workspaceId, input.keyId, input.monthlyCap);
			return { assigned: input.keyId !== null };
		}),

	/** Whether shared keys may call an OpenAI-compatible endpoint inside the Install's own network. */
	setPrivateEndpoints: onInstall("install.manage")
		.use(sensitive("aiKey.change"))
		.input(z.object({ on: z.boolean() }))
		.handler(async ({ context, input }) => {
			await context.services.aiKeys.shared.setPrivateEndpoints(context.install, input.on);
			return { privateEndpoints: input.on };
		}),
};
