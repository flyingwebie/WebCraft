import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
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
import {
	BlocksIcon,
	CodeIcon,
	FileTextIcon,
	InfoIcon,
	LayoutTemplateIcon,
	ListIcon,
	type LucideIcon,
	MailIcon,
	PaletteIcon,
	RepeatIcon,
	ShieldCheckIcon,
	SlidersHorizontalIcon,
	UploadIcon,
} from "lucide-react";
import { type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useOpenStaging } from "../shell/StagingButton.tsx";

/** One Draft of the Site, as `publishing.drafts` lists it. */
export type SiteDraft = Awaited<ReturnType<ApiClient["publishing"]["drafts"]>>["drafts"][number];

type Item = SiteDraft["item"];

/** An item's key, to tick it and find it again. */
function keyOf(item: Item): string {
	return `${item.kind}:${"id" in item ? item.id : ""}`;
}

/**
 * Publish all (ADR 0014), in the admin's top bar: every Draft of the Site the person may publish, with
 * how many there are. It opens the list (variant A of the navigation prototype): Content, then
 * Structure (Staff only, shown to Members but never theirs to tick), each item with what changed and
 * who changed it last, ticked unless the person unticks it, and a link to see it on the Staging
 * address. Publishing goes through the Management API's two calls: the preview, then its confirmation.
 */
export function PublishAllButton({
	siteId,
	count,
	open: openAtStart = false,
}: {
	siteId: string;
	/** How many Drafts the person may publish. */
	count: number;
	/** Open the list at once: the editing bar links here to Publish all. */
	open?: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(openAtStart);
	const trigger = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (openAtStart) setOpen(true);
	}, [openAtStart]);
	return (
		<>
			<Button ref={trigger} size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
				<UploadIcon aria-hidden="true" />
				{t("publishAll.button")}{" "}
				<Badge variant="secondary" className="ms-1 tabular-nums">
					{count}
				</Badge>
				{/* Its name says what the number counts: "Publish all 3 changes". */}
				<span className="sr-only"> {t("publishAll.changesCounted", { count })}</span>
			</Button>
			{open ? <PublishAllDialog siteId={siteId} onClose={() => setOpen(false)} finalFocus={trigger} /> : null}
		</>
	);
}

/** The list of Drafts, ticked, and the publish that follows. */
function PublishAllDialog({
	siteId,
	onClose,
	finalFocus,
}: {
	siteId: string;
	onClose: () => void;
	finalFocus: RefObject<HTMLButtonElement | null>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [drafts, setDrafts] = useState<SiteDraft[] | null>(null);
	const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const api = await getApi();
				const { drafts: listed } = await api.publishing.drafts({ siteId });
				if (!cancelled) setDrafts(listed);
			} catch (failure) {
				if (!cancelled) setProblem(t(errorMessage(failure)));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [siteId, t]);

	const mine = useMemo(() => (drafts ?? []).filter((draft) => draft.canPublish), [drafts]);
	const ticked = mine.filter((draft) => !unticked.has(keyOf(draft.item)));
	const allTicked = ticked.length === mine.length && mine.length > 0;

	const toggle = (draft: SiteDraft, on: boolean) => {
		const next = new Set(unticked);
		if (on) next.delete(keyOf(draft.item));
		else next.add(keyOf(draft.item));
		setUnticked(next);
	};
	const toggleAll = (on: boolean) => setUnticked(on ? new Set() : new Set(mine.map((draft) => keyOf(draft.item))));

	const publish = async () => {
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			const items = ticked.map((draft) => draft.item);
			const preview = await api.publishing.publishAll({ siteId, items });
			if (preview.published || !preview.confirmation) return;
			const done = await api.publishing.publishAll({ siteId, items, confirmation: preview.confirmation.id });
			toast.success(t("publishAll.published", { count: done.published ? done.items.length : 0 }));
			onClose();
			await router.invalidate();
		} catch (failure) {
			setProblem(refusalText(t, failure));
		} finally {
			setBusy(false);
		}
	};

	const groups: { key: "content" | "structure"; label: MessageKey }[] = [
		{ key: "content", label: "publishAll.content" },
		{ key: "structure", label: "publishAll.structure" },
	];
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("publishAll.close")} finalFocus={finalFocus} className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("publishAll.title")}</DialogTitle>
					<DialogDescription>
						{drafts === null
							? t("publishAll.loading")
							: drafts.length === 0
								? t("publishAll.none")
								: t("publishAll.intro", { count: drafts.length })}
					</DialogDescription>
				</DialogHeader>
				{drafts && drafts.length > 0 ? (
					<div className="-mx-1 grid max-h-[60vh] gap-4 overflow-y-auto px-1">
						<div className="flex items-center gap-3">
							<Checkbox
								id={`${id}-all`}
								checked={allTicked}
								indeterminate={ticked.length > 0 && !allTicked}
								disabled={mine.length === 0}
								onCheckedChange={(value) => toggleAll(value === true)}
							/>
							<label htmlFor={`${id}-all`} className="text-sm font-medium">
								{t("publishAll.selected", { selected: ticked.length, total: mine.length })}
							</label>
						</div>
						{groups.map((group) => {
							const listed = drafts.filter((draft) => draft.group === group.key);
							if (listed.length === 0) return null;
							const staffOnly = group.key === "structure" && listed.every((draft) => !draft.canPublish);
							return (
								<section key={group.key} aria-labelledby={`${id}-${group.key}`} className="grid gap-2">
									<h3
										id={`${id}-${group.key}`}
										className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase"
									>
										{t(group.label)}
										{staffOnly ? (
											<Badge variant="outline" className="font-normal normal-case">
												{t("publishAll.staffOnly")}
											</Badge>
										) : null}
									</h3>
									<ul className="grid gap-2">
										{listed.map((draft) => (
											<DraftRow
												key={keyOf(draft.item)}
												id={`${id}-${keyOf(draft.item)}`}
												siteId={siteId}
												draft={draft}
												ticked={draft.canPublish && !unticked.has(keyOf(draft.item))}
												onToggle={(on) => toggle(draft, on)}
											/>
										))}
									</ul>
								</section>
							);
						})}
					</div>
				) : null}
				{problem ? (
					<p role="alert" className="text-destructive text-sm">
						{problem}
					</p>
				) : null}
				<DialogFooter className="items-center sm:justify-between">
					<p className="text-muted-foreground flex items-center gap-2 text-sm">
						<InfoIcon aria-hidden="true" className="size-4 shrink-0" />
						{t("publishAll.cacheNote")}
					</p>
					<div className="flex gap-2">
						<DialogClose render={<Button variant="outline" type="button" />}>{t("publishAll.cancel")}</DialogClose>
						<Button onClick={publish} disabled={busy || ticked.length === 0}>
							<UploadIcon aria-hidden="true" />
							{t("publishAll.publish", { count: ticked.length })}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** One Draft: its tick, what it is, what changed and who changed it, its status, and View on the Staging address. */
function DraftRow({
	id,
	siteId,
	draft,
	ticked,
	onToggle,
}: {
	id: string;
	siteId: string;
	draft: SiteDraft;
	ticked: boolean;
	onToggle: (on: boolean) => void;
}) {
	const t = useT();
	const Icon = iconOf(draft);
	const title = titleOf(t, draft);
	const details = [
		kindOf(t, draft),
		draft.changes.length > 0
			? t("publishAll.changes", { list: draft.changes.map((change) => changeLabel(t, draft, change)).join(", ") })
			: null,
		draft.changedBy
			? draft.changedBy.via
				? t("publishAll.changedVia", { person: draft.changedBy.name, client: draft.changedBy.via })
				: draft.changedBy.name
			: null,
		formatUtc(draft.changedAt),
	].filter((part): part is string => part !== null);
	return (
		<li className="flex items-center gap-3 rounded-lg border p-3">
			<Checkbox
				id={id}
				checked={ticked}
				disabled={!draft.canPublish}
				onCheckedChange={(value) => onToggle(value === true)}
				aria-describedby={`${id}-details`}
			/>
			<Icon aria-hidden="true" className="text-muted-foreground size-5 shrink-0" />
			<div className="grid min-w-0 flex-1 gap-0.5">
				<label htmlFor={id} className="truncate text-sm font-medium">
					{title}
				</label>
				<p id={`${id}-details`} className="text-muted-foreground truncate text-xs">
					{details.join(" · ")}
					{!draft.canPublish ? ` · ${t("publishAll.staffOnly")}` : ""}
				</p>
			</div>
			<Badge variant={draft.status === "new" ? "secondary" : "outline"}>
				{t(draft.status === "new" ? "publishAll.new" : "publishAll.changed")}
			</Badge>
			<ViewOnStaging siteId={siteId} path={draft.path ?? "/"} name={title} />
		</li>
	);
}

/** Opens the Staging address at the item's page, through the single-use link the admin asks for. */
function ViewOnStaging({ siteId, path, name }: { siteId: string; path: string; name: string }) {
	const t = useT();
	const { opening, open } = useOpenStaging(siteId);
	const view = () => open(path);
	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={view}
			disabled={opening}
			aria-label={t("publishAll.viewLabel", { name })}
		>
			{t("publishAll.view")}
		</Button>
	);
}

type T = ReturnType<typeof useT>;

/** What a refused Publish all says: which item stopped it, and why, or the error's own words. */
function refusalText(t: T, failure: unknown): string {
	const refusal = failure as {
		code?: unknown;
		data?: { name?: unknown; item?: { kind?: unknown }; code?: unknown; data?: unknown };
	};
	if (refusal.code === "PUBLISH_ALL_REFUSED" && refusal.data) {
		const name =
			typeof refusal.data.name === "string" && refusal.data.name !== "" ? refusal.data.name : t("publishAll.untitled");
		return t("publishAll.refused", {
			name,
			reason: t(errorMessage({ code: refusal.data.code, data: refusal.data.data })),
		});
	}
	return t(errorMessage(failure));
}

/** What the Draft is called: its name, or what it is when it has none (the Globals, the Design system). */
function titleOf(t: T, draft: SiteDraft): string {
	if (draft.name !== null && draft.name !== "") return draft.name;
	if (draft.item.kind === "entry") return t("publishAll.untitled");
	return kindOf(t, draft);
}

/** What kind of item a Draft is: an Entry's Post Type, a Template's kind, or the item's kind. */
function kindOf(t: T, draft: SiteDraft): string {
	switch (draft.item.kind) {
		case "entry":
			return draft.postType?.name ?? t("publishAll.kinds.entry");
		case "template":
			switch (draft.templateKind) {
				case "site":
					return t("publishAll.kinds.siteTemplate");
				case "archive":
					return t("publishAll.kinds.archiveTemplate", { postType: draft.postType?.name ?? "" });
				case "search":
					return t("publishAll.kinds.searchTemplate");
				default:
					return t("publishAll.kinds.entryTemplate", { postType: draft.postType?.name ?? "" });
			}
		case "script":
			return draft.scriptKind === "page" ? t("publishAll.kinds.pageScript") : t("publishAll.kinds.siteScript");
		case "component":
			return t("publishAll.kinds.component");
		case "loop":
			return t("publishAll.kinds.loop");
		case "form":
			return t("publishAll.kinds.form");
		case "formEmails":
			return t("publishAll.kinds.formEmails");
		case "globals":
			return t("publishAll.kinds.globals");
		case "consentBanner":
			return t("publishAll.kinds.consentBanner");
		case "designSystem":
			return t("publishAll.kinds.designSystem");
	}
}

/** One changed value: a Field by its label, a built-in value or a Design system section by its name. */
function changeLabel(t: T, draft: SiteDraft, change: SiteDraft["changes"][number]): string {
	if (change.label !== null) return change.label;
	if (draft.item.kind === "formEmails") {
		if (change.key === "notifications") return t("publishAll.sections.notifications");
		if (change.key === "autoReply") return t("publishAll.sections.autoReply");
	}
	if (draft.item.kind === "designSystem") {
		switch (change.key) {
			case "tokens":
				return t("publishAll.sections.tokens");
			case "classes":
				return t("publishAll.sections.classes");
			case "baseStyles":
				return t("publishAll.sections.baseStyles");
			case "customCss":
				return t("publishAll.sections.customCss");
			case "darkMode":
				return t("publishAll.sections.darkMode");
		}
	}
	switch (change.key) {
		case "title":
			return t("publishAll.builtIns.title");
		case "slug":
			return t("publishAll.builtIns.slug");
		case "parent":
			return t("publishAll.builtIns.parent");
		case "seo":
			return t("publishAll.builtIns.seo");
		case "hiddenLanguages":
			return t("publishAll.builtIns.hiddenLanguages");
		default:
			return change.key;
	}
}

function iconOf(draft: SiteDraft): LucideIcon {
	switch (draft.item.kind) {
		case "entry":
			return FileTextIcon;
		case "globals":
			return SlidersHorizontalIcon;
		case "consentBanner":
			return ShieldCheckIcon;
		case "designSystem":
			return PaletteIcon;
		case "component":
			return BlocksIcon;
		case "loop":
			return RepeatIcon;
		case "form":
			return ListIcon;
		case "formEmails":
			return MailIcon;
		case "template":
			return LayoutTemplateIcon;
		case "script":
			return CodeIcon;
	}
}
