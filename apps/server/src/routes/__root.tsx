import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { buttonVariants } from "@webcraft/ui/components/button.tsx";
import { Toaster } from "@webcraft/ui/components/sonner.tsx";

import appCss from "../index.css?url";
import { getApi } from "../ui/api.ts";
import { AdminIntl, useT } from "../ui/i18n.tsx";

export const Route = createRootRoute({
	// Every page needs to know who is signed in, the Admin language and theme, and the setup stage.
	beforeLoad: async () => {
		const api = await getApi();
		return { shell: await api.shell.context() };
	},
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ name: "robots", content: "noindex, nofollow" },
			{ title: "WebCraft" },
		],
		links: [{ rel: "stylesheet", href: appCss }],
	}),
	component: RootDocument,
	notFoundComponent: NotFound,
});

function RootDocument() {
	const { shell } = Route.useRouteContext();
	const { code, dir } = shell.language;
	return (
		<html lang={code} dir={dir} className={shell.theme === "system" ? undefined : shell.theme} suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body>
				<AdminIntl language={code}>
					<SkipLink />
					<Outlet />
					<Toaster theme={shell.theme} position="bottom-right" />
				</AdminIntl>
				<Scripts />
			</body>
		</html>
	);
}

/** The first thing the keyboard reaches on every page: a link past the navigation to the page itself. */
function SkipLink() {
	const t = useT();
	return (
		<a
			href="#main"
			className="focus:bg-background focus:text-foreground focus:outline-ring sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:px-4 focus:py-2 focus:shadow-md focus:outline-2"
		>
			{t("app.skipToContent")}
		</a>
	);
}

function NotFound() {
	const t = useT();
	return (
		<main
			id="main"
			tabIndex={-1}
			className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-4 p-8 outline-none"
		>
			<h1 className="text-2xl font-semibold">{t("notFound.heading")}</h1>
			<p className="text-muted-foreground">{t("notFound.body")}</p>
			<Link to="/" className={buttonVariants({ variant: "outline", className: "self-start" })}>
				{t("notFound.home")}
			</Link>
		</main>
	);
}
