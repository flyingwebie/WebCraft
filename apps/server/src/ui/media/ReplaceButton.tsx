import { Button } from "@webcraft/ui/components/button.tsx";
import { LoaderIcon, ReplaceIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { useMediaHost } from "./host.tsx";
import type { MediaItem } from "./preview.ts";

/** Replace file: a new file of the same kind for the item, keeping its id and every use. */
export function ReplaceButton({
	siteId,
	item,
	onChanged,
}: {
	siteId: string;
	item: MediaItem;
	onChanged(): Promise<void>;
}) {
	const t = useT();
	const host = useMediaHost();
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const replace = async (file: File | undefined) => {
		if (!file) return;
		setBusy(true);
		try {
			await (await host.api()).replace({ siteId, mediaId: item.id, file });
			toast.success(t("media.replace.replaced", { name: file.name }));
			await onChanged();
		} catch (failure) {
			toast.error(t("media.replace.failed", { name: file.name, reason: t(errorMessage(failure)) }));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<input
				ref={input}
				type="file"
				hidden
				tabIndex={-1}
				aria-hidden="true"
				onChange={(event) => {
					void replace(event.target.files?.[0]);
					event.target.value = "";
				}}
			/>
			<Button variant="outline" onClick={() => input.current?.click()} disabled={busy}>
				{busy ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : <ReplaceIcon aria-hidden="true" />}
				{t("media.replace.button")}
			</Button>
		</>
	);
}
