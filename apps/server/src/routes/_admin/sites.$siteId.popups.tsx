import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { PlusIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { z } from "zod";

import { cellClass, headClass, headRowClass, TableFrame } from "../../ui/analytics/parts.tsx";
import { getApi } from "../../ui/api.ts";
import { loadMedia } from "../../ui/content/loaders.ts";
import { errorMessage } from "../../ui/errors.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { PageHeader } from "../../ui/PageHeader.tsx";
import { PopupSheet, PopupStatus } from "../../ui/popups/PopupSheet.tsx";
import { PageSheet } from "../../ui/shell/page.tsx";

const search = z.object({ popup: z.string().optional(), language: z.string().optional() });
export const Route = createFileRoute("/_admin/sites/$siteId/popups")({
	staticData: { crumb: "popups.title" },
	validateSearch: search,
	loaderDeps: ({ search }) => search,
	loader: async ({ params, deps, context }) => {
		const api = await getApi();
		const siteId = params.siteId;
		const { popups } = await api.popups.list({ siteId });
		// One Popup is open in its sheet while the address names it (`?popup=`).
		const selected = deps.popup && popups.some((p) => p.id === deps.popup) ? deps.popup : undefined;
		const value = selected ? await api.popups.get({ siteId, popupId: selected, language: deps.language }) : null;
		const postTypes =
			value && context.place.permissions.includes("structure.edit")
				? (await api.postTypes.list({ siteId })).postTypes
				: [];
		const entries = (await Promise.all(postTypes.map((p) => api.entries.list({ siteId, postTypeId: p.id })))).flatMap(
			(result) => result.entries.map((e) => ({ id: e.id, title: e.draft.title })),
		);
		const media = value ? await loadMedia(api, siteId, value.content.fields, value.content.draft.values) : {};
		return { popups, value, postTypes, entries, media };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "popups.title") }] }),
	component: PopupsPage,
});

/**
 * Site › Popups (Structure; the Popups Module): the Site's Popups as a list, each with its layout, its
 * Trigger and its state, as Site › Goals. A Popup opens in a sheet over the list (`?popup=`, kept in
 * the address so the builder can come back to it); New Popup asks for a name in a sheet and opens the
 * new Popup.
 */
function PopupsPage() {
	const t = useT();
	const navigate = useNavigate();
	const { siteId } = Route.useParams();
	const data = Route.useLoaderData();
	const { place } = Route.useRouteContext();
	const newButton = useRef<HTMLButtonElement>(null);
	// What opened the open Popup's sheet, for focus to go back to when it closes.
	const opener = useRef<HTMLElement | null>(null);
	const [creating, setCreating] = useState(false);
	if (place.level !== "site") return null;
	const structure = place.permissions.includes("structure.edit");
	const option = (value: string) => t(`popups.options.${value as "modal"}`);
	const close = () => navigate({ to: "/sites/$siteId/popups", params: { siteId }, search: {} });
	return (
		<>
			<PageHeader
				heading={t("popups.title")}
				action={
					structure ? (
						<Button ref={newButton} onClick={() => setCreating(true)}>
							<PlusIcon aria-hidden="true" />
							{t("popups.new")}
						</Button>
					) : null
				}
			>
				{t("popups.intro")}
			</PageHeader>
			<TableFrame>
				<Table aria-label={t("popups.title")} className="min-w-160 table-fixed">
					<colgroup>
						<col className="w-[30%]" />
						<col className="w-[18%]" />
						<col />
						<col className="w-44" />
					</colgroup>
					<TableHeader>
						<TableRow className={headRowClass}>
							<TableHead scope="col" className={headClass}>
								{t("popups.name")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("popups.layout")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("popups.trigger")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("popups.state")}
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.popups.length === 0 ? (
							<TableRow className="hover:bg-transparent">
								<TableCell colSpan={4} className="text-muted-foreground px-4 py-8 text-center whitespace-normal">
									{t("popups.none")}
								</TableCell>
							</TableRow>
						) : (
							data.popups.map((popup) => {
								const more = popup.draft.additionalTriggers.length;
								const trigger = option(popup.draft.trigger.kind);
								return (
									<TableRow key={popup.id} data-state={data.value?.popup.id === popup.id ? "selected" : undefined}>
										<TableCell className={cn(cellClass, "truncate")}>
											<Link
												to="/sites/$siteId/popups"
												params={{ siteId }}
												search={{ popup: popup.id }}
												onClick={(event) => {
													opener.current = event.currentTarget;
												}}
												aria-current={data.value?.popup.id === popup.id ? "page" : undefined}
												className="font-medium underline-offset-4 hover:underline"
												title={popup.name}
											>
												{popup.name}
											</Link>
										</TableCell>
										<TableCell className={cn(cellClass, "text-muted-foreground truncate")}>
											{option(popup.draft.layout)}
										</TableCell>
										<TableCell className={cn(cellClass, "text-muted-foreground truncate")}>
											{more > 0 ? t("popups.triggerAndMore", { trigger, count: more }) : trigger}
										</TableCell>
										<TableCell className={cellClass}>
											<PopupStatus status={popup.status} />
										</TableCell>
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</TableFrame>
			{creating ? (
				<NewPopupSheet
					siteId={siteId}
					finalFocus={newButton}
					onClose={() => setCreating(false)}
					onCreated={(popupId) => {
						setCreating(false);
						opener.current = newButton.current;
						return navigate({ to: "/sites/$siteId/popups", params: { siteId }, search: { popup: popupId } });
					}}
				/>
			) : null}
			{data.value ? (
				<PopupSheet
					key={`${data.value.popup.id}-${data.value.content.language}`}
					view={data.value}
					knownMedia={data.media}
					siteId={siteId}
					structure={structure}
					permissions={place.permissions}
					languages={place.languages}
					postTypes={data.postTypes}
					entries={data.entries}
					finalFocus={opener}
					onClose={() => void close()}
					onLanguage={async (language) => {
						await navigate({
							to: "/sites/$siteId/popups",
							params: { siteId },
							search: { popup: data.value?.popup.id, language },
						});
					}}
				/>
			) : null}
		</>
	);
}

/** New Popup: its name, in a sheet; the new Popup then opens in its own. */
function NewPopupSheet({
	siteId,
	finalFocus,
	onClose,
	onCreated,
}: {
	siteId: string;
	finalFocus: RefObject<HTMLElement | null>;
	onClose: () => void;
	onCreated: (popupId: string) => Promise<unknown>;
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [name, setName] = useState("");
	const [problem, setProblem] = useState("");
	const [busy, setBusy] = useState(false);
	const create = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		setBusy(true);
		setProblem("");
		try {
			const { popup } = await (await getApi()).popups.create({ siteId, name });
			await router.invalidate();
			await onCreated(popup.id);
		} catch (error) {
			setProblem(t(errorMessage(error)));
			setBusy(false);
		}
	};
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={t("popups.new")}
			description={t("popups.newIntro")}
			finalFocus={finalFocus}
			className="data-[side=right]:sm:max-w-95"
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("popups.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`} disabled={busy || !name.trim()}>
						{t("popups.create")}
					</Button>
				</>
			}
		>
			<form id={`${id}-form`} onSubmit={create} noValidate>
				<Field data-invalid={problem ? true : undefined}>
					<FieldLabel htmlFor={`${id}-name`}>{t("popups.name")}</FieldLabel>
					<Input
						id={`${id}-name`}
						value={name}
						required
						autoFocus
						maxLength={120}
						onChange={(e) => setName(e.target.value)}
						aria-invalid={problem ? true : undefined}
						aria-describedby={problem ? `${id}-problem` : `${id}-help`}
					/>
					{problem ? (
						<FieldError id={`${id}-problem`}>{problem}</FieldError>
					) : (
						<FieldDescription id={`${id}-help`}>{t("popups.nameHelp")}</FieldDescription>
					)}
				</Field>
			</form>
		</PageSheet>
	);
}
