import { Button } from "@webcraft/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { ChevronDownIcon, ShieldIcon, SquarePenIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";

/**
 * "Edit on site": opens the Site's home page on its own address in Edit mode (ADR 0022). The admin
 * asks for a single-use link, valid 60 seconds, and goes there; following it signs this browser
 * into Edit mode on the Site's domain. Its menu opens Safe mode instead: Edit mode with none of the
 * Site's own scripts, for when a broken one gets in the way.
 */
export function EditOnSiteButton({ siteId, className }: { siteId: string; className?: string }) {
	const t = useT();
	const [opening, setOpening] = useState(false);

	const open = async (safeMode: boolean) => {
		setOpening(true);
		try {
			const api = await getApi();
			const { url } = await api.editMode.open({ siteId, path: "/", safeMode });
			window.location.assign(url);
		} catch (error) {
			toast.error(t(errorMessage(error)));
			setOpening(false);
		}
	};

	return (
		<div className={`flex ${className ?? ""}`}>
			<Button variant="outline" size="sm" className="rounded-e-none" onClick={() => open(false)} disabled={opening}>
				<SquarePenIcon aria-hidden="true" />
				{t("site.editOnSite")}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="outline"
							size="icon-sm"
							className="rounded-s-none border-s-0"
							aria-label={t("site.editOptions")}
							disabled={opening}
						/>
					}
				>
					<ChevronDownIcon aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-64">
					<DropdownMenuItem onClick={() => open(true)}>
						<ShieldIcon aria-hidden="true" />
						<span className="grid">
							<span>{t("site.editInSafeMode")}</span>
							<span className="text-muted-foreground text-xs">{t("site.editInSafeModeHelp")}</span>
						</span>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
