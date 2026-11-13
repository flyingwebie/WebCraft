import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Field, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { LinkIcon, LoaderIcon } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";

/**
 * Import from URL: the address of a file on the public internet, which WebCraft fetches through its
 * guarded fetcher and adds like an upload (into the folder open, if any).
 */
export function ImportDialog({
	siteId,
	folderId,
	onImported,
}: {
	siteId: string;
	folderId: string | null;
	onImported(): Promise<void>;
}) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (url.trim() === "") {
			setError("media.import.required");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const { media } = await api.media.importUrl({ siteId, url: url.trim(), folderId });
			toast.success(t("media.import.imported", { name: media.fileName }));
			setUrl("");
			setOpen(false);
			await onImported();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
				<LinkIcon aria-hidden="true" />
				{t("media.importUrl")}
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) setError(null);
				}}
			>
				<DialogContent closeLabel={t("media.import.close")} finalFocus={trigger}>
					<form onSubmit={submit} className="grid gap-6" noValidate>
						<DialogHeader>
							<DialogTitle>{t("media.import.title")}</DialogTitle>
							<DialogDescription id="media-import-help">{t("media.import.help")}</DialogDescription>
						</DialogHeader>
						<Field data-invalid={error ? true : undefined}>
							<FieldLabel htmlFor="media-import-url">{t("media.import.url")}</FieldLabel>
							<Input
								id="media-import-url"
								type="url"
								inputMode="url"
								value={url}
								onChange={(event) => setUrl(event.target.value)}
								placeholder="https://"
								autoComplete="off"
								spellCheck={false}
								required
								aria-invalid={error ? true : undefined}
								aria-describedby={["media-import-help", error ? "media-import-error" : null].filter(Boolean).join(" ")}
							/>
							{error ? <FieldError id="media-import-error">{t(error)}</FieldError> : null}
						</Field>
						<DialogFooter>
							<DialogClose render={<Button variant="outline" type="button" />}>{t("media.import.cancel")}</DialogClose>
							<Button type="submit" disabled={busy}>
								{busy ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : null}
								{t("media.import.submit")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
