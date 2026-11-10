import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../ui/api.ts";
import { pageTitle } from "../ui/i18n.tsx";
import { DevicePage } from "../ui/oauth/DevicePage.tsx";

/**
 * Signing in a device (RFC 8628's verification page): `webcraft login` shows the person a short code
 * and this address (with the code filled in, `?user_code=…`). Signed in, they check the code, see
 * which client asks, and approve it for one Workspace with the Sites, Toolsets and access they
 * choose, or deny it. The web process serves this page with headers that keep it out of other
 * sites' frames.
 */
export const Route = createFileRoute("/oauth/device")({
	validateSearch: z.object({ user_code: z.string().max(20).optional().catch(undefined) }),
	beforeLoad: ({ context, location }) => {
		const { shell } = context;
		if (shell.setup.stage === "claim") throw redirect({ to: "/setup" });
		if (!shell.person) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
		return { person: shell.person };
	},
	loaderDeps: ({ search }) => ({ userCode: search.user_code ?? null }),
	loader: async ({ deps }) => {
		if (!deps.userCode) return { userCode: null, data: null };
		const api = await getApi();
		return { userCode: deps.userCode, data: await api.oauth.checkDevice({ userCode: deps.userCode }) };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "oauth.device.pageTitle") }] }),
	component: DeviceRoute,
});

function DeviceRoute() {
	const { userCode, data } = Route.useLoaderData();
	const { person } = Route.useRouteContext();
	return <DevicePage userCode={userCode} data={data} person={person} key={userCode ?? ""} />;
}
