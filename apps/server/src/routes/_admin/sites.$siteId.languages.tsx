import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { SiteLanguage, SiteLanguages } from "@webcraft/core";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { EllipsisIcon, PencilIcon, PlusIcon, StarIcon, TrashIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorCode, errorMessage } from "../../ui/errors.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";
import { SettingsForm, useSettingsSection } from "../../ui/settings/form.tsx";
import {
	describedBy,
	SettingsCard,
	SettingsListRow,
	SettingsRow,
	SettingsRows,
	StateBadge,
	Switch,
} from "../../ui/settings/layout.tsx";
import { PageSheet } from "../../ui/shell/page.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/languages")({
	staticData: { crumb: "siteLanguages.pageTitle", width: "form" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return null;
		const api = await getApi();
		return api.languages.list({ siteId: params.siteId });
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "siteLanguages.pageTitle") }],
	}),
	component: LanguagesPage,
});

type Settings = SiteLanguages;
type Language = SiteLanguage;
type Direction = SiteLanguage["direction"];

/**
 * Site › Languages (Structure, Staff only): the languages the Site is written in, each with its
 * code, name, direction, address prefix and optional domain; adding, changing and removing them,
 * choosing the Default language after a warning, and the browser-language redirect. Like every Site
 * setting, a change applies when saved and isn't part of Publish all.
 */
function LanguagesPage() {
	const t = useT();
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	const { settings } = data;
	return (
		<>
			<PageHeader heading={t("siteLanguages.heading")}>{t("siteLanguages.intro")}</PageHeader>
			<SettingsForm>
				<div className="grid gap-6">
					<SettingsCard
						title={t("siteLanguages.listTitle")}
						description={t("siteLanguages.listIntro")}
						action={<AddLanguage siteId={siteId} />}
					>
						<SettingsRows>
							{settings.languages.map((language) => (
								<SettingsListRow
									key={language.code}
									badge={
										<>
											<StateBadge className="font-mono">{language.code}</StateBadge>
											{language.default ? <StateBadge tone="info">{t("siteLanguages.default")}</StateBadge> : null}
										</>
									}
									detail={[
										`${t("siteLanguages.addresses")}: ${language.prefix === null ? t("siteLanguages.noPrefix") : `/${language.prefix}/…`}`,
										t(`siteLanguages.directions.${language.direction}`),
										...(language.domain ? [`${t("siteLanguages.domain")}: ${language.domain}`] : []),
									].join(" · ")}
									actions={<LanguageActions siteId={siteId} language={language} settings={settings} />}
								>
									<span lang={language.code} dir={language.direction}>
										{language.name}
									</span>
								</SettingsListRow>
							))}
						</SettingsRows>
					</SettingsCard>
					<BrowserRedirect siteId={siteId} on={settings.browserLanguageRedirect} />
					<p className="text-muted-foreground text-sm">{t("siteLanguages.appliesAtOnce")}</p>
				</div>
			</SettingsForm>
		</>
	);
}

/** The direction choices of a language: from its code, or set by hand. */
function DirectionSelect({
	id,
	value,
	onChange,
	auto,
}: {
	id: string;
	value: Direction | "";
	onChange: (value: Direction | "") => void;
	auto: boolean;
}) {
	const t = useT();
	return (
		<NativeSelect id={id} value={value} onChange={(event) => onChange(event.target.value as Direction | "")}>
			{auto ? <NativeSelectOption value="">{t("siteLanguages.directions.auto")}</NativeSelectOption> : null}
			<NativeSelectOption value="ltr">{t("siteLanguages.directions.ltr")}</NativeSelectOption>
			<NativeSelectOption value="rtl">{t("siteLanguages.directions.rtl")}</NativeSelectOption>
		</NativeSelect>
	);
}

/** Adding a language, in a sheet: its BCP 47 code, and optionally its name, direction and domain. */
function AddLanguage({ siteId }: { siteId: string }) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [open, setOpen] = useState(false);
	const [code, setCode] = useState("");
	const [name, setName] = useState("");
	const [direction, setDirection] = useState<Direction | "">("");
	const [domain, setDomain] = useState("");
	const [busy, setBusy] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (busy || !code.trim()) return;
		setBusy(true);
		try {
			const api = await getApi();
			const { settings } = await api.languages.add({
				siteId,
				code,
				...(name.trim() ? { name } : {}),
				...(direction ? { direction } : {}),
				...(domain.trim() ? { domain } : {}),
			});
			const added = settings.languages.at(-1);
			toast.success(t("siteLanguages.added", { name: added?.name ?? code }));
			setCode("");
			setName("");
			setDirection("");
			setDomain("");
			setOpen(false);
			await router.invalidate();
		} catch (failure) {
			toast.error(errorCode(failure) === "PATH_TAKEN" ? t("siteLanguages.prefixTaken") : t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Button variant="outline" onClick={() => setOpen(true)}>
				<PlusIcon aria-hidden="true" />
				{t("siteLanguages.add")}
			</Button>
			<PageSheet
				open={open}
				onOpenChange={setOpen}
				title={t("siteLanguages.addTitle")}
				description={t("siteLanguages.addIntro")}
				footer={
					<>
						<Button type="button" variant="outline" onClick={() => setOpen(false)}>
							{t("siteLanguages.cancel")}
						</Button>
						<Button type="submit" form={`${id}-form`} disabled={busy || !code.trim()}>
							{t("siteLanguages.add")}
						</Button>
					</>
				}
			>
				<form id={`${id}-form`} onSubmit={submit} noValidate>
					<FieldGroup className="gap-5">
						<Field>
							<FieldLabel htmlFor={`${id}-code`}>{t("siteLanguages.code")}</FieldLabel>
							<Input
								id={`${id}-code`}
								value={code}
								required
								maxLength={35}
								autoComplete="off"
								onChange={(event) => setCode(event.target.value)}
								aria-describedby={`${id}-code-help`}
							/>
							<FieldDescription id={`${id}-code-help`}>{t("siteLanguages.codeHelp")}</FieldDescription>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-name`}>{t("siteLanguages.nameOptional")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								maxLength={100}
								onChange={(event) => setName(event.target.value)}
								aria-describedby={`${id}-name-help`}
							/>
							<FieldDescription id={`${id}-name-help`}>{t("siteLanguages.nameHelp")}</FieldDescription>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-direction`}>{t("siteLanguages.direction")}</FieldLabel>
							<DirectionSelect id={`${id}-direction`} value={direction} onChange={setDirection} auto />
						</Field>
						<Field>
							<FieldLabel htmlFor={`${id}-domain`}>{t("siteLanguages.domainOptional")}</FieldLabel>
							<Input
								id={`${id}-domain`}
								value={domain}
								maxLength={253}
								autoComplete="off"
								onChange={(event) => setDomain(event.target.value)}
								aria-describedby={`${id}-domain-help`}
							/>
							<FieldDescription id={`${id}-domain-help`}>{t("siteLanguages.domainHelp")}</FieldDescription>
						</Field>
					</FieldGroup>
				</form>
			</PageSheet>
		</>
	);
}

/** The browser-language redirect on a first visit to the home page: off by default. Saved with the foot bar. */
function BrowserRedirect({ siteId, on }: { siteId: string; on: boolean }) {
	const t = useT();
	const id = useId();
	const section = useSettingsSection({
		saved: { on },
		save: async (values) =>
			(await getApi()).languages.setBrowserRedirect({ siteId, browserLanguageRedirect: values.on }),
	});
	return (
		<SettingsCard title={t("siteLanguages.redirectTitle")}>
			<SettingsRows>
				<SettingsRow
					label={t("siteLanguages.redirectLabel")}
					help={t("siteLanguages.redirectHelp")}
					htmlFor={`${id}-redirect`}
				>
					<Switch
						id={`${id}-redirect`}
						checked={section.values.on}
						onCheckedChange={(value) => section.set({ on: value })}
						aria-describedby={describedBy(`${id}-redirect`)}
					/>
				</SettingsRow>
			</SettingsRows>
			{section.error ? <FieldError>{t(section.error)}</FieldError> : null}
		</SettingsCard>
	);
}

/** A language's actions: change its settings, make it the Default language, remove it. */
function LanguageActions({ siteId, language, settings }: { siteId: string; language: Language; settings: Settings }) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	const [editing, setEditing] = useState(false);
	const [making, setMaking] = useState(false);
	const [removing, setRemoving] = useState(false);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={trigger}
					render={
						<Button variant="ghost" size="icon-sm" aria-label={t("siteLanguages.actionsOf", { name: language.name })} />
					}
				>
					<EllipsisIcon aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-56">
					<DropdownMenuItem onClick={() => setEditing(true)}>
						<PencilIcon aria-hidden="true" />
						{t("siteLanguages.edit")}
					</DropdownMenuItem>
					{language.default ? null : (
						<>
							<DropdownMenuItem onClick={() => setMaking(true)}>
								<StarIcon aria-hidden="true" />
								{t("siteLanguages.makeDefault")}
							</DropdownMenuItem>
							<DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
								<TrashIcon aria-hidden="true" />
								{t("siteLanguages.remove")}
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{editing ? (
				<EditLanguageDialog
					siteId={siteId}
					language={language}
					onClose={() => setEditing(false)}
					finalFocus={trigger}
				/>
			) : null}
			{making ? (
				<MakeDefaultDialog
					siteId={siteId}
					language={language}
					current={settings.languages.find((candidate) => candidate.default)}
					onClose={() => setMaking(false)}
					finalFocus={trigger}
				/>
			) : null}
			{removing ? (
				<RemoveLanguageDialog
					siteId={siteId}
					language={language}
					onClose={() => setRemoving(false)}
					finalFocus={trigger}
				/>
			) : null}
		</>
	);
}

type DialogProps = {
	siteId: string;
	language: Language;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
};

function EditLanguageDialog({ siteId, language, onClose, finalFocus }: DialogProps) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [name, setName] = useState(language.name);
	const [direction, setDirection] = useState<Direction | "">(language.direction);
	const [domain, setDomain] = useState(language.domain ?? "");
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const api = await getApi();
			await api.languages.update({
				siteId,
				code: language.code,
				name,
				direction: direction || language.direction,
				domain: domain.trim() ? domain : null,
			});
			toast.success(t("siteLanguages.saved"));
			onClose();
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={t("siteLanguages.editTitle", { name: language.name })}
			description={t("siteLanguages.editIntro", { code: language.code })}
			finalFocus={finalFocus}
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("siteLanguages.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`} disabled={busy}>
						{t("siteLanguages.save")}
					</Button>
				</>
			}
		>
			<form id={`${id}-form`} onSubmit={save} noValidate>
				<FieldGroup className="gap-5">
					<Field>
						<FieldLabel htmlFor={`${id}-name`}>{t("siteLanguages.name")}</FieldLabel>
						<Input id={`${id}-name`} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
					</Field>
					<Field>
						<FieldLabel htmlFor={`${id}-direction`}>{t("siteLanguages.direction")}</FieldLabel>
						<DirectionSelect id={`${id}-direction`} value={direction} onChange={setDirection} auto={false} />
					</Field>
					<Field>
						<FieldLabel htmlFor={`${id}-domain`}>{t("siteLanguages.domainOptional")}</FieldLabel>
						<Input
							id={`${id}-domain`}
							value={domain}
							maxLength={253}
							autoComplete="off"
							onChange={(event) => setDomain(event.target.value)}
							aria-describedby={`${id}-domain-help`}
						/>
						<FieldDescription id={`${id}-domain-help`}>{t("siteLanguages.domainHelp")}</FieldDescription>
					</Field>
				</FieldGroup>
			</form>
		</PageSheet>
	);
}

/** What a two-step change answered first: its preview and the confirmation to send back. */
type Asked<Preview> = { preview: Preview; confirmation: string } | null;

/** What one step of a two-step change answers: done, or what it would change and the confirmation to send back. */
type StepAnswer<Preview> = { done: true } | { done: false; preview: Preview; confirmation: string };

/**
 * A change that takes two steps: the first call answers what it would change, and confirming sends
 * the confirmation back with the same call. A failure starts it over.
 */
function useTwoStep<Preview>(options: {
	call: (confirmation: string | undefined) => Promise<StepAnswer<Preview>>;
	done: () => Promise<void>;
	failed: (failure: unknown) => void;
}) {
	const [asked, setAsked] = useState<Asked<Preview>>(null);
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		try {
			const answer = await options.call(asked?.confirmation);
			if (!answer.done) {
				setAsked({ preview: answer.preview, confirmation: answer.confirmation });
				return;
			}
			await options.done();
		} catch (failure) {
			setAsked(null);
			options.failed(failure);
		} finally {
			setBusy(false);
		}
	};
	return { asked, busy, run };
}

/**
 * Making a language the Default language: the first call shows the warning with what would change
 * (addresses, Entries without a title of their own there); confirming sends the confirmation back.
 */
function MakeDefaultDialog({ siteId, language, current, onClose, finalFocus }: DialogProps & { current?: Language }) {
	const t = useT();
	const router = useRouter();
	const { asked, busy, run } = useTwoStep<{ changedPaths: number; withoutOwnTitle: number }>({
		call: async (confirmation) => {
			const api = await getApi();
			const answer = await api.languages.setDefault({
				siteId,
				code: language.code,
				...(confirmation ? { confirmation } : {}),
			});
			return answer.changed
				? { done: true }
				: { done: false, preview: answer.preview, confirmation: answer.confirmation.id };
		},
		done: async () => {
			toast.success(t("siteLanguages.defaultChanged", { name: language.name }));
			onClose();
			await router.invalidate();
		},
		failed: (failure) =>
			toast.error(errorCode(failure) === "PATH_TAKEN" ? t("siteLanguages.prefixTaken") : t(errorMessage(failure))),
	});
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("siteLanguages.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("siteLanguages.makeDefaultTitle", { name: language.name })}</DialogTitle>
					<DialogDescription>
						{t("siteLanguages.makeDefaultWarning", {
							name: language.name,
							current: current?.name ?? "",
							prefix: current?.code.toLowerCase() ?? "",
						})}
					</DialogDescription>
				</DialogHeader>
				{asked ? (
					<ul className="my-4 list-disc space-y-1 ps-5 text-sm" aria-live="polite">
						<li>{t("siteLanguages.changedPaths", { count: asked.preview.changedPaths })}</li>
						<li>{t("siteLanguages.withoutOwnTitle", { count: asked.preview.withoutOwnTitle, name: language.name })}</li>
					</ul>
				) : null}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>{t("siteLanguages.cancel")}</DialogClose>
					<Button onClick={run} disabled={busy}>
						{asked ? t("siteLanguages.makeDefaultConfirm") : t("siteLanguages.checkChanges")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Removing a language: the first call shows how many pages it has; confirming removes it. */
function RemoveLanguageDialog({ siteId, language, onClose, finalFocus }: DialogProps) {
	const t = useT();
	const router = useRouter();
	const { asked, busy, run } = useTwoStep<{ pages: number }>({
		call: async (confirmation) => {
			const api = await getApi();
			const answer = await api.languages.remove({
				siteId,
				code: language.code,
				...(confirmation ? { confirmation } : {}),
			});
			return answer.removed
				? { done: true }
				: { done: false, preview: answer.preview, confirmation: answer.confirmation.id };
		},
		done: async () => {
			toast.success(t("siteLanguages.removed", { name: language.name }));
			onClose();
			await router.invalidate();
			document.getElementById("main")?.focus();
		},
		failed: (failure) => toast.error(t(errorMessage(failure))),
	});
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent closeLabel={t("siteLanguages.close")} finalFocus={finalFocus}>
				<DialogHeader>
					<DialogTitle>{t("siteLanguages.removeTitle", { name: language.name })}</DialogTitle>
					<DialogDescription>{t("siteLanguages.removeBody", { name: language.name })}</DialogDescription>
				</DialogHeader>
				{asked ? (
					<p className="my-4 text-sm" aria-live="polite">
						{t("siteLanguages.removePages", { count: asked.preview.pages, name: language.name })}
					</p>
				) : null}
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>{t("siteLanguages.cancel")}</DialogClose>
					<Button variant={asked ? "destructive" : "default"} onClick={run} disabled={busy}>
						{asked ? t("siteLanguages.removeConfirm") : t("siteLanguages.checkChanges")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
