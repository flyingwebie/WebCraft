import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

import appCss from "../index.css?url";

export const Route = createRootRoute({
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
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<Outlet />
				<Scripts />
			</body>
		</html>
	);
}

function NotFound() {
	return (
		<main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-2 p-8">
			<h1 className="text-2xl font-semibold">Page not found</h1>
		</main>
	);
}
