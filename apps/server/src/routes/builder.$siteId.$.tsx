import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../ui/api.ts";
import { Builder } from "../ui/builder/Builder.tsx";
import { targetFromPath, targetTitle } from "../ui/builder/model.ts";
import { errorCode } from "../ui/errors.ts";
import { messageIn, pageTitleOf, useT } from "../ui/i18n.tsx";
import { Forbidden } from "../ui/PageHeader.tsx";

/** Answers that mean the builder has nothing to open at this address. */
const NOT_THERE = new Set([
	"SITE_NOT_FOUND",
	"POST_TYPE_NOT_FOUND",
	"COMPONENT_NOT_FOUND",
	"COMPONENT_FROM_MODULE",
	"PAGES_HAVE_NO_ENTRY_TEMPLATE",
	"ARCHIVE_UNAVAILABLE",
	"BAD_REQUEST",
]);

/**
 * The visual builder, full-screen and outside the admin shell (Structure, Staff only): one Template
 * (`site-template`, `search-template`, `entry-template/<Post Type>`, `archive-template/<Post Type>`)
 * or one of the Site's Components (`component/<id>`).
 */
/** What is selected when it opens: where a Filter is placed (`?filter=<id>`, from the Filter builder). */
const search = z.object({
	element: z.string().max(128).optional().catch(undefined),
	returnPath: z.string().max(2000).regex(/^\/(?![/\\])[^\s\\?#]*$/).optional().catch(undefined),
	returnTitle: z.string().max(300).optional().catch(undefined),
	returnRef: z.string().max(1000).regex(/^(site|content)(?:\/[A-Za-z0-9_-]{1,64}){0,10}$/).optional().catch(undefined),
	filter: z.uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/builder/$siteId/$")({
	validateSearch: search,
	beforeLoad: ({ context, location }) => {
		const { shell } = context;
		if (shell.setup.stage === "claim") throw redirect({ to: "/setup" });
		if (!shell.person) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
	},
	loader: async ({ params }) => {
		const target = targetFromPath(params._splat ?? "");
		if (!target) throw notFound();
		const api = await getApi();
		try {
			const { site, permissions } = await api.sites.get({ siteId: params.siteId });
			if (!permissions.includes("structure.edit")) return { site, target, opened: null };
			return { site, target, opened: await api.builder.open({ siteId: params.siteId, target }) };
		} catch (error) {
			if (NOT_THERE.has(errorCode(error) ?? "")) throw notFound();
			throw error;
		}
	},
	head: ({ match, loaderData }) => {
		const language = match.context.shell.language.code;
		const target = loaderData?.target;
		const opened = loaderData?.opened;
		const name =
			!target || !opened
				? undefined
				: target.kind === "component"
					? opened.component?.name
					: target.kind === "entryTemplate" || target.kind === "archiveTemplate"
						? messageIn(language, `builder.titles.${target.kind}`, { postType: opened.postType?.name ?? "" })
						: messageIn(language, `builder.kinds.${target.kind}`);
		return { meta: [{ title: pageTitleOf(language, name, loaderData?.site.name) }] };
	},
	component: BuilderPage,
});

function BuilderPage() {
	const t = useT();
	const { site, target, opened } = Route.useLoaderData();
	const { filter, element, returnPath, returnTitle, returnRef } = Route.useSearch();
	if (!opened) {
		return (
			<main id="main" tabIndex={-1} className="mx-auto max-w-xl p-10 outline-none">
				<Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />
			</main>
		);
	}
	const back =
		target.kind === "component"
			? ({ to: "/sites/$siteId/components", label: t("builder.backToComponents") } as const)
			: ({ to: "/sites/$siteId/templates", label: t("builder.backToTemplates") } as const);
	return (
		<Builder
			key={`${site.id}/${targetTitle(t, opened, target)}`}
			siteId={site.id}
			target={target}
			initial={opened}
			back={back}
			returnPage={returnPath && returnRef ? { path: returnPath, title: returnTitle || returnPath, ref: returnRef } : undefined}
			{...(element ? { select: { element } } : filter ? { select: { filter } } : {})}
		/>
	);
}
