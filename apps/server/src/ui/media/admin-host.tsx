import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { ADMIN_MEDIA_HOST, type MediaHost, type MediaUseLink } from "./host.tsx";

/**
 * The admin's link to a place a file is used in: an Entry, the Globals for everyone; a Loop and the
 * SEO settings for Staff (Structure). Other places are words.
 */
const AdminUseLink: MediaUseLink = ({ siteId, use, structure, className, children }) => {
	switch (use.kind) {
		case "entry":
			return (
				<Link
					to="/sites/$siteId/entries/$postTypeId/$entryId"
					params={{ siteId, postTypeId: use.postType.id, entryId: use.id }}
					className={className}
				>
					{children}
				</Link>
			);
		case "globals":
			return (
				<Link to="/sites/$siteId/globals" params={{ siteId }} className={className}>
					{children}
				</Link>
			);
		case "seoSettings":
			return structure ? (
				<Link to="/sites/$siteId/seo" params={{ siteId }} className={className}>
					{children}
				</Link>
			) : (
				<span>{children}</span>
			);
		case "loop":
			return structure ? (
				<Link to="/sites/$siteId/loops/$loopId" params={{ siteId, loopId: use.id }} className={className}>
					{children}
				</Link>
			) : (
				<span>{children}</span>
			);
		default:
			return <span>{children}</span>;
	}
};

/** The admin's host for the shared Media parts: its own API, links to its own screens, and its toasts. */
export const ADMIN_HOST: MediaHost = {
	...ADMIN_MEDIA_HOST,
	UseLink: AdminUseLink,
	notify: (kind, text) => (kind === "success" ? toast.success(text) : toast.error(text)),
};
