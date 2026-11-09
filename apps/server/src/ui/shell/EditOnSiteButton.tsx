import { Button } from "@webcraft/ui/components/button.tsx";
import { SquarePenIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";

/**
 * "Edit on site": opens the Site's home page on its own address in Edit mode (ADR 0022). The admin
 * asks for a single-use link, valid 60 seconds, and goes there; following it signs this browser
 * into Edit mode on the Site's domain.
 */
export function EditOnSiteButton({ siteId, className }: { siteId: string; className?: string }) {
	const t = useT();
	const [opening, setOpening] = useState(false);

	const open = async () => {
		setOpening(true);
		try {
			const api = await getApi();
			const { url } = await api.editMode.open({ siteId, path: "/" });
			window.location.assign(url);
		} catch (error) {
			toast.error(t(errorMessage(error)));
			setOpening(false);
		}
	};

	return (
		<Button variant="outline" size="sm" className={className} onClick={open} disabled={opening}>
			<SquarePenIcon aria-hidden="true" />
			{t("site.editOnSite")}
		</Button>
	);
}
