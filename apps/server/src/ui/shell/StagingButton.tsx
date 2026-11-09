import { Button } from "@webcraft/ui/components/button.tsx";
import { EyeIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";

/**
 * "Staging" in the top bar: opens the Site's Staging address, which shows it with all its Drafts
 * (ADR 0014), in a new tab. The admin's session never reaches the Staging address, so the admin asks
 * for a single-use link, valid 60 seconds, which lets that tab in.
 */
export function StagingButton({ siteId, path = "/" }: { siteId: string; path?: string }) {
	const t = useT();
	const { opening, open } = useOpenStaging(siteId);
	return (
		<Button variant="ghost" size="sm" onClick={() => open(path)} disabled={opening}>
			<EyeIcon aria-hidden="true" />
			{t("staging.button")}
		</Button>
	);
}

/**
 * Opens a page of the Site's Staging address in a new tab, through the single-use link the admin
 * asks for (the admin's session never reaches the Staging address). Answers whether it is opening.
 */
export function useOpenStaging(siteId: string): { opening: boolean; open(path: string): Promise<void> } {
	const t = useT();
	const [opening, setOpening] = useState(false);
	const open = async (path: string) => {
		setOpening(true);
		// The tab opens on the click itself (browsers let only a click open one); the address arrives in it.
		const tab = window.open("about:blank", "_blank");
		if (tab) tab.opener = null;
		try {
			const api = await getApi();
			const { url } = await api.staging.open({ siteId, path });
			if (tab) tab.location.href = url;
			else window.location.assign(url);
		} catch (failure) {
			tab?.close();
			toast.error(t(errorMessage(failure)));
		} finally {
			setOpening(false);
		}
	};
	return { opening, open };
}
