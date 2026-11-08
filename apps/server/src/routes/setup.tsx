import { createFileRoute, notFound, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

import { pageTitle } from "../ui/i18n.tsx";
import { SetupWizard } from "../ui/setup/SetupWizard.tsx";

export const Route = createFileRoute("/setup")({
	// The link in the web log carries the setup token.
	validateSearch: z.object({ token: z.string().max(512).optional() }),
	beforeLoad: ({ context }) => {
		const { shell } = context;
		// Once setup is finished the wizard is gone for good.
		if (shell.setup.stage === "done") throw notFound();
		if (shell.setup.stage === "continue" && shell.person?.installRole !== "superadmin") {
			throw redirect({ to: "/sign-in", search: { redirect: "/setup" } });
		}
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "setup.pageTitle") }] }),
	component: SetupPage,
});

function SetupPage() {
	const { shell } = Route.useRouteContext();
	const { token } = Route.useSearch();
	const navigate = useNavigate();
	const [linkedToken] = useState(token);

	// The token has been read: take it out of the address bar, so it stays out of the browser's history.
	useEffect(() => {
		if (token) void navigate({ to: "/setup", search: {}, replace: true });
	}, [token, navigate]);

	return <SetupWizard shell={shell} linkedToken={linkedToken} />;
}
