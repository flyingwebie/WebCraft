import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { FieldError } from "@webcraft/ui/components/field.tsx";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";

/** A Module where Staff switch it, as `modules.siteList` and `modules.workspaceList` answer. */
export type PlaceModule = Awaited<ReturnType<ApiClient["modules"]["siteList"]>>["modules"][number];

/** The Site or Workspace whose Modules are switched here. */
export type ModulePlace = { level: "site"; siteId: string } | { level: "workspace"; workspaceId: string };

type Removal = Awaited<ReturnType<ApiClient["modules"]["removeSiteData"]>>;

/**
 * The Modules of one Site (or Workspace), each with Staff's switch, and removing its data there in
 * two steps: what would be deleted is shown first, then deleted with the confirmation.
 */
export function PlaceModules({ place, modules }: { place: ModulePlace; modules: PlaceModule[] }) {
	const t = useT();
	if (modules.length === 0) {
		return (
			<p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">
				{t(place.level === "site" ? "modules.place.siteEmpty" : "modules.place.workspaceEmpty")}
			</p>
		);
	}
	return (
		<ul className="grid gap-4">
			{modules.map((module) => (
				<ModuleRow key={module.id} place={place} module={module} />
			))}
		</ul>
	);
}

function ModuleRow({ place, module }: { place: ModulePlace; module: PlaceModule }) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [busy, setBusy] = useState(false);
	const approved = module.status === "approved";

	const toggle = async (on: boolean) => {
		setBusy(true);
		try {
			const api = await getApi();
			if (place.level === "site") await api.modules.setOnSite({ siteId: place.siteId, moduleId: module.id, on });
			else await api.modules.setOnWorkspace({ workspaceId: place.workspaceId, moduleId: module.id, on });
			toast.success(t(on ? "modules.place.switchedOn" : "modules.place.switchedOff", { name: module.name }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<li className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_auto] sm:items-start">
			<div className="grid gap-1">
				<h2 className="font-medium">{module.name}</h2>
				<p className="text-muted-foreground text-sm">{module.description}</p>
				{approved ? null : (
					<p id={`${id}-waiting`} className="text-muted-foreground text-sm">
						{t("modules.place.waiting")}. {t("modules.place.cannotSwitchOn")}
					</p>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-3 sm:justify-end">
				<label className="flex items-center gap-2 text-sm" htmlFor={`${id}-on`}>
					<Checkbox
						id={`${id}-on`}
						checked={module.on && approved}
						disabled={busy || (!approved && !module.on)}
						aria-describedby={approved ? undefined : `${id}-waiting`}
						aria-label={t(place.level === "site" ? "modules.place.siteSwitch" : "modules.place.workspaceSwitch", {
							name: module.name,
						})}
						onCheckedChange={(checked) => toggle(checked === true)}
					/>
					<span aria-hidden="true">{t("modules.place.on")}</span>
				</label>
				<RemoveDataDialog place={place} module={module} />
			</div>
		</li>
	);
}

/** Removing a Module's data from the place: the first call shows what would go, the second deletes it. */
function RemoveDataDialog({ place, module }: { place: ModulePlace; module: PlaceModule }) {
	const t = useT();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [preview, setPreview] = useState<Extract<Removal, { removed: false }> | null>(null);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);

	const call = async (confirmation?: string) => {
		const api = await getApi();
		return place.level === "site"
			? api.modules.removeSiteData({ siteId: place.siteId, moduleId: module.id, confirmation })
			: api.modules.removeWorkspaceData({ workspaceId: place.workspaceId, moduleId: module.id, confirmation });
	};

	const ask = async () => {
		setOpen(true);
		setPreview(null);
		setError(null);
		try {
			const answer = await call();
			if (!answer.removed) setPreview(answer);
		} catch (failure) {
			setError(errorMessage(failure));
		}
	};

	const remove = async () => {
		if (!preview) return;
		setBusy(true);
		setError(null);
		try {
			await call(preview.confirmation.id);
			toast.success(t("modules.remove.removed", { name: module.name }));
			setOpen(false);
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
			// What would be deleted may have changed: show it again.
			const answer = await call().catch(() => null);
			if (answer && !answer.removed) setPreview(answer);
		} finally {
			setBusy(false);
		}
	};

	const empty = preview !== null && preview.secrets === 0 && preview.tables.every((table) => table.rows === 0);

	return (
		<>
			<Button
				ref={trigger}
				variant="outline"
				size="sm"
				onClick={ask}
				aria-label={t("modules.place.removeDataOf", { name: module.name })}
			>
				{t("modules.place.removeData")}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent closeLabel={t("modules.remove.close")} finalFocus={trigger}>
					<DialogHeader className="pe-8">
						<DialogTitle>{t("modules.remove.title", { name: module.name })}</DialogTitle>
						<DialogDescription>
							{t(place.level === "site" ? "modules.remove.siteBody" : "modules.remove.workspaceBody", {
								name: module.name,
							})}
						</DialogDescription>
					</DialogHeader>
					{preview === null ? (
						error ? null : (
							<p className="text-muted-foreground" aria-live="polite">
								{t("modules.remove.loading")}
							</p>
						)
					) : empty ? (
						<p>{t("modules.remove.nothing", { name: module.name })}</p>
					) : (
						<section className="grid gap-2">
							<h3 className="font-medium">{t("modules.remove.what")}</h3>
							<ul className="grid list-disc gap-1 ps-5">
								{preview.tables.map((table) => (
									<li key={table.table}>{t("modules.remove.rows", { table: table.table, rows: table.rows })}</li>
								))}
								{preview.secrets > 0 ? <li>{t("modules.remove.secrets", { count: preview.secrets })}</li> : null}
							</ul>
						</section>
					)}
					{error ? <FieldError>{t(error)}</FieldError> : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("modules.remove.cancel")}</DialogClose>
						<Button variant="destructive" onClick={remove} disabled={busy || preview === null}>
							{t("modules.remove.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
