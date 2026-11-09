import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";

/**
 * A Post Type's Revisions (Structure, Staff only): whether publishing its Entries saves Revisions.
 * Turned off, publishing saves none; the Revisions saved before stay until the Install's retention
 * removes them, and Checkpoints are still saved while its Entries are edited.
 */
export function PostTypeRevisions({
	siteId,
	postType,
}: {
	siteId: string;
	postType: { id: string; name: string; revisions: boolean };
}) {
	const t = useT();
	const router = useRouter();
	const [revisions, setRevisions] = useState(postType.revisions);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			await api.postTypes.update({ siteId, postTypeId: postType.id, revisions });
			toast.success(t("history.postType.saved"));
			await router.invalidate();
		} catch (failure) {
			setError(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form onSubmit={submit} className="grid max-w-xl gap-6" noValidate>
			<label className="flex items-start gap-3 text-sm">
				<input
					type="checkbox"
					checked={revisions}
					onChange={(event) => setRevisions(event.target.checked)}
					aria-describedby="post-type-revisions-help"
					className="accent-primary mt-0.5 size-4 shrink-0"
				/>
				<span className="flex flex-col gap-1">
					<span className="font-medium">{t("history.postType.label", { name: postType.name })}</span>
					<span id="post-type-revisions-help" className="text-muted-foreground">
						{t("history.postType.help")}
					</span>
				</span>
			</label>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			<div>
				<Button type="submit" disabled={busy || revisions === postType.revisions}>
					{t("history.postType.save")}
				</Button>
			</div>
		</form>
	);
}
