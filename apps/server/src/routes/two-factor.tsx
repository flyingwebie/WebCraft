import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { getApi } from "../ui/api.ts";
import { AuthHeading, AuthLead, AuthPage } from "../ui/auth/AuthPage.tsx";
import { errorMessage } from "../ui/errors.ts";
import { pageTitle, useT } from "../ui/i18n.tsx";
import { localPath } from "../ui/local-path.ts";
import { TwoFactorSetupChoices } from "../ui/two-factor/Setup.tsx";

/**
 * Where a person who must use two-factor authentication (the Install requires it, or a Workspace
 * they are a Member of) lands right after signing in while they have none: they can set it up here
 * or sign out, and nothing else until they have.
 */
export const Route = createFileRoute("/two-factor")({
	validateSearch: z.object({ redirect: localPath.optional().catch(undefined) }),
	beforeLoad: ({ context, search }) => {
		const { shell } = context;
		if (!shell.person) throw redirect({ to: "/sign-in" });
		if (!shell.twoFactor?.mustSetUp) throw redirect({ href: search.redirect ?? "/" });
	},
	loader: async () => {
		const api = await getApi();
		return { requiredBy: (await api.me.twoFactor.get()).requiredBy };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "twoFactor.enforce.pageTitle") }],
	}),
	component: TwoFactorRequiredPage,
});

function TwoFactorRequiredPage() {
	const t = useT();
	const router = useRouter();
	const { shell } = Route.useRouteContext();
	const { requiredBy } = Route.useLoaderData();
	const search = Route.useSearch();
	const heading = useRef<HTMLHeadingElement>(null);
	const [busy, setBusy] = useState(false);
	const workspaces = requiredBy.workspaces.map((workspace) => workspace.name).join(", ");

	useEffect(() => heading.current?.focus(), []);

	const done = async () => {
		// Every navigation reloads the shell context, so the admin knows it is set up.
		await router.navigate({ href: search.redirect ?? "/" });
	};

	const signOut = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.session.signOut();
			await router.navigate({ to: "/sign-in" });
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setBusy(false);
		}
	};

	return (
		<AuthPage width="wide">
			<div className="grid gap-2">
				<AuthHeading ref={heading}>{t("twoFactor.enforce.heading")}</AuthHeading>
				<AuthLead>
					{requiredBy.install
						? t("twoFactor.enforce.byInstall")
						: t("twoFactor.enforce.byWorkspaces", { workspaces, count: requiredBy.workspaces.length })}
				</AuthLead>
				<AuthLead>{t("twoFactor.enforce.intro")}</AuthLead>
			</div>
			<TwoFactorSetupChoices account={shell.person?.email ?? ""} onAdded={done} />
			<div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
				<p className="text-muted-foreground text-sm">
					{t("twoFactor.enforce.signedInAs", { email: shell.person?.email ?? "" })}
				</p>
				<Button variant="outline" onClick={signOut} disabled={busy}>
					{t("twoFactor.enforce.signOut")}
				</Button>
			</div>
		</AuthPage>
	);
}
