import type { AdminLanguageCode } from "@webcraft/core/admin-languages";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";
import { IntlProvider } from "use-intl";
import type en from "../../../../messages/en.json";
import { type MediaHost, MediaHostProvider, type MediaUseLink } from "../../../media/host.tsx";
import type { ShellConfig } from "../../api.ts";
import { managementApi } from "../../management.ts";
import { pickMedia } from "./pick.ts";
import { notify } from "./toasts.tsx";

/**
 * The shared Media parts (`ui/media/*`) as the building area runs them (BA-22): the Management API on
 * the Site's address, files shown from the Site's own `/_media/`, the admin's words for those parts in
 * the person's Admin language (`config.adminMessages`), a place a file is used in linked to the admin
 * (a new tab), and a media Field's Choose answered by the Media picker.
 */
export function ShellMedia({ config, children }: { config: ShellConfig; children: ReactNode }) {
	const host = useShellMediaHost(config);
	return (
		<IntlProvider
			locale={config.language as AdminLanguageCode}
			// Only the parts the reused Media parts read: what they don't is never asked for.
			messages={config.adminMessages as unknown as typeof en}
			timeZone="UTC"
		>
			<AdminOfSite value={config.admin}>
				<MediaHostProvider value={host}>{children}</MediaHostProvider>
			</AdminOfSite>
		</IntlProvider>
	);
}

/** The admin's address of the Site (`config.admin`), for the links of places a file is used in. */
const AdminOfSite = createContext("");

/** A place a file is used in, linked to where the admin changes it (a new tab); words where there is none. */
const ShellUseLink: MediaUseLink = ({ use, structure, className, children }) => {
	const admin = useContext(AdminOfSite);
	const href =
		use.kind === "entry"
			? `${admin}/entries/${use.postType.id}/${use.id}`
			: use.kind === "globals"
				? `${admin}/globals`
				: use.kind === "loop" && structure
					? `${admin}/loops/${use.id}`
					: use.kind === "seoSettings" && structure
						? `${admin}/seo`
						: null;
	return href ? (
		<a href={href} target="_blank" rel="noopener noreferrer" className={className}>
			{children}
		</a>
	) : (
		<span>{children}</span>
	);
};

/** The building area's Media host, for the config's Site and session. */
export function useShellMediaHost(config: ShellConfig): MediaHost {
	return useMemo(() => {
		const api = managementApi(config.token).media;
		return {
			api: async () => api,
			site: true,
			UseLink: ShellUseLink,
			choose: ({ current }) => pickMedia({ current }),
			focusMain: () =>
				document
					.querySelector<HTMLElement>("[data-wc-media-heading], [data-wc-place-back], #wc-canvas")
					?.focus({ preventScroll: true }),
			notify,
		};
	}, [config.token]);
}
