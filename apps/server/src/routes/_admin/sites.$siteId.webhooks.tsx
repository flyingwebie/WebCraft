import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { pageTitle } from "../../ui/i18n.tsx";
import { WebhooksPage } from "../../ui/webhooks/Webhooks.tsx";

/** Whose delivery log shows (the first Webhook's unless given), and the page of it: deliveries before one. */
const search = z.object({
	webhook: z.uuid().optional().catch(undefined),
	before: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_admin/sites/$siteId/webhooks")({
	staticData: { crumb: "webhooks.pageTitle" },
	validateSearch: search,
	loaderDeps: ({ search: { webhook, before } }) => ({ webhook, before }),
	loader: async ({ params, deps }) => {
		const api = await getApi();
		const { siteId } = params;
		const { webhooks, events } = await api.webhooks.list({ siteId });
		const shown = webhooks.find((webhook) => webhook.id === deps.webhook) ?? webhooks[0];
		if (!shown) return { webhooks, events, log: null };
		const before = shown.id === deps.webhook ? (deps.before ?? null) : null;
		// A page that no longer exists (its delivery is older than 30 days) starts from the newest.
		const page = await api.webhooks
			.deliveries({ siteId, webhookId: shown.id, before: before ?? undefined })
			.catch(() => api.webhooks.deliveries({ siteId, webhookId: shown.id }));
		return { webhooks, events, log: { webhook: shown, page, before } };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "webhooks.pageTitle") }],
	}),
	component: WebhooksRoute,
});

/**
 * Site › Webhooks (Site settings): Staff add, change, test and remove the Site's Webhooks here;
 * anyone else who sees the Site and follows a link here (the email about a Webhook switched off)
 * sees each one's origin, status and delivery log.
 */
function WebhooksRoute() {
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	return <WebhooksPage siteId={siteId} data={data} canEdit={place.permissions.includes("structure.edit")} />;
}
