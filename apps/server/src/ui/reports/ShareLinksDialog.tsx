import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { BanIcon, CopyIcon } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { StateBadge } from "../settings/layout.tsx";
import { PageSheet } from "../shell/page.tsx";
import { REPORT_LANGUAGE_NAMES, type ReportLanguage, type ReportPlace, type ShareLinkView } from "./model.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/** How long a new link works: a few days from today, never, or until a day chosen. */
const EXPIRIES = ["in7", "in30", "in90", "in365", "never", "day"] as const;
type Expiry = (typeof EXPIRIES)[number];
const EXPIRY_DAYS: Partial<Record<Expiry, number>> = { in7: 7, in30: 30, in90: 90, in365: 365 };

/** A day, short and in UTC as every admin date is: "16 Dec", with its year once it isn't this one. */
function useShortDay() {
	const t = useT();
	return (value: Date | string, now = new Date()) => {
		const date = new Date(value);
		const month = t(`content.when.months.${MONTHS[date.getUTCMonth()] ?? "jan"}` as MessageKey);
		return date.getUTCFullYear() === now.getUTCFullYear()
			? t("content.when.day", { day: date.getUTCDate(), month })
			: t("content.when.dayYear", { day: date.getUTCDate(), month, year: date.getUTCFullYear() });
	};
}

/**
 * A Dashboard's Share links, a sheet over the page from the Dashboard's Share button: each link's
 * name, the last four characters of its address, whether it works, its password, expiry and how often
 * it was opened. Staff revoke links and make new ones with the short form (a Sensitive action:
 * "Confirm it's you" first); a new link's whole address shows once, with Copy. Owners see the list.
 */
export function ShareLinksDialog({
	place,
	dashboardId,
	canManage,
	language,
	onClose,
	finalFocus,
}: {
	place: ReportPlace;
	dashboardId: string;
	canManage: boolean;
	/** The page's language a new link starts with: the person's own. */
	language: string;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const id = useId();
	const shortDay = useShortDay();
	const [links, setLinks] = useState<ShareLinkView[] | null>(null);
	const [made, setMade] = useState<{ name: string; url: string } | null>(null);
	const [revoking, setRevoking] = useState<string | null>(null);
	const load = async () => {
		try {
			setLinks((await (await getApi()).shareLinks.list({ ...place, dashboardId })).links);
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- loads once when the sheet opens.
	useEffect(() => {
		void load();
	}, []);
	const revoke = async (link: ShareLinkView) => {
		// A small destructive action: the second click on the same button does it.
		if (revoking !== link.id) return setRevoking(link.id);
		setRevoking(null);
		try {
			await (await getApi()).shareLinks.revoke({ ...place, shareLinkId: link.id });
			toast.success(t("shareLinks.revoked", { name: link.name }));
			await load();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={t("shareLinks.title")}
			description={t("shareLinks.intro")}
			finalFocus={finalFocus}
			className="data-[side=right]:sm:max-w-76.5"
			footer={
				canManage ? (
					<Button type="submit" form={`${id}-new`} className="w-full">
						{t("shareLinks.make")}
					</Button>
				) : undefined
			}
		>
			<div className="grid grid-cols-[minmax(0,1fr)] gap-4">
				{made ? <MadeLink name={made.name} url={made.url} /> : null}
				{links === null ? (
					<p className="text-muted-foreground text-sm">{t("shareLinks.loading")}</p>
				) : links.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("shareLinks.empty")}</p>
				) : (
					<ul className="grid grid-cols-[minmax(0,1fr)] gap-2.5" aria-label={t("shareLinks.listLabel")}>
						{links.map((link) => (
							<li key={link.id} className="bg-muted grid grid-cols-[minmax(0,1fr)] gap-1.5 rounded-[10px] p-3">
								<div className="flex items-center justify-between gap-2">
									<p className="min-w-0 truncate text-sm font-medium" title={link.name}>
										{link.name}
									</p>
									<StateBadge tone={link.state === "active" ? "success" : "neutral"}>
										{t(`shareLinks.states.${link.state}`)}
									</StateBadge>
								</div>
								<p className="text-muted-foreground font-mono text-xs">{t("shareLinks.endsIn", { hint: link.hint })}</p>
								<p className="text-muted-foreground text-xs">
									{link.password ? t("shareLinks.withPassword") : t("shareLinks.withoutPassword")}
									{" · "}
									{link.expiresAt
										? t("shareLinks.expires", { day: shortDay(link.expiresAt) })
										: t("shareLinks.noExpiry")}
								</p>
								<div className="flex min-h-6 items-center justify-between gap-2">
									<p className="text-muted-foreground text-xs">
										{t("shareLinks.opens", { count: link.opens })}
										{link.lastOpenedAt ? (
											<>
												{" · "}
												<time dateTime={new Date(link.lastOpenedAt).toISOString()} title={formatUtc(link.lastOpenedAt)}>
													{t("shareLinks.lastOpened", { at: shortDay(link.lastOpenedAt) })}
												</time>
											</>
										) : null}
									</p>
									{canManage && link.state === "active" ? (
										<Button
											variant={revoking === link.id ? "destructive" : "ghost"}
											size="xs"
											className={revoking === link.id ? undefined : "text-muted-foreground"}
											onClick={() => void revoke(link)}
											onBlur={() => setRevoking((current) => (current === link.id ? null : current))}
											aria-label={
												revoking === link.id
													? t("shareLinks.revokeAgain", { name: link.name })
													: t("shareLinks.revokeLabel", { name: link.name })
											}
										>
											<BanIcon aria-hidden="true" />
											{revoking === link.id ? t("shareLinks.revokeSure") : t("shareLinks.revoke")}
										</Button>
									) : null}
								</div>
							</li>
						))}
					</ul>
				)}
				{canManage ? (
					<NewLink
						id={`${id}-new`}
						place={place}
						dashboardId={dashboardId}
						language={language}
						onMade={async (link) => {
							setMade(link);
							await load();
						}}
					/>
				) : null}
			</div>
		</PageSheet>
	);
}

/** The address of a link just made, whole: shown this once, with a way to copy it. */
function MadeLink({ name, url }: { name: string; url: string }) {
	const t = useT();
	const id = useId();
	const [said, setSaid] = useState("");
	const address = useRef<HTMLInputElement>(null);
	// The address is what the person came for: focus goes to it, to copy.
	useEffect(() => {
		const input = address.current;
		if (!input) return;
		input.focus();
		input.select();
		// Selected whole, but shown from its start: the Site's own address first.
		input.scrollLeft = 0;
	}, []);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(url);
			setSaid(t("shareLinks.copied"));
		} catch {
			setSaid(t("shareLinks.copyFailed"));
		}
	};
	return (
		<div className="grid gap-2.5 rounded-[10px] border border-emerald-600 bg-emerald-600/7 p-3 dark:border-emerald-500 dark:bg-emerald-500/10">
			<p className="sr-only" role="status">
				{t("shareLinks.made", { name })}
			</p>
			<div className="flex gap-2">
				<label htmlFor={`${id}-url`} className="sr-only">
					{t("shareLinks.address")}
				</label>
				<Input
					ref={address}
					id={`${id}-url`}
					value={url}
					readOnly
					className="min-w-0 flex-1 font-mono"
					aria-describedby={`${id}-help`}
				/>
				<Button type="button" variant="outline" size="sm" className="h-9" onClick={() => void copy()}>
					<CopyIcon aria-hidden="true" />
					{t("shareLinks.copy")}
				</Button>
			</div>
			<p id={`${id}-help`} className="text-muted-foreground text-xs">
				{t("shareLinks.shownOnce")}
			</p>
			<p className="sr-only" aria-live="polite">
				{said}
			</p>
		</div>
	);
}

/** The short form for a new link: its name, a password if wanted, how long it works, and its page's language. */
function NewLink({
	id,
	place,
	dashboardId,
	language: personLanguage,
	onMade,
}: {
	id: string;
	place: ReportPlace;
	dashboardId: string;
	language: string;
	onMade: (link: { name: string; url: string }) => Promise<void>;
}) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const startLanguage: ReportLanguage =
		personLanguage in REPORT_LANGUAGE_NAMES ? (personLanguage as ReportLanguage) : "en";
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [expiry, setExpiry] = useState<Expiry>("in30");
	const [day, setDay] = useState("");
	const [language, setLanguage] = useState<ReportLanguage>(startLanguage);
	const [problem, setProblem] = useState<{ field: string | null; message: MessageKey } | null>(null);
	const [busy, setBusy] = useState(false);
	const expiresAt = (): Date | null => {
		if (expiry === "never") return null;
		if (expiry === "day") return day === "" ? null : new Date(`${day}T23:59:59Z`);
		const now = new Date();
		const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
		// The link works until the end of that day (UTC).
		return new Date(today + (EXPIRY_DAYS[expiry] ?? 30) * DAY_MS + DAY_MS - 1000);
	};
	const make = async (event: FormEvent) => {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setProblem(null);
		try {
			const api = await getApi();
			const made = await runSensitive(() =>
				api.shareLinks.create({
					...place,
					dashboardId,
					name,
					language,
					password: password === "" ? null : password,
					expiresAt: expiresAt(),
				}),
			);
			setName("");
			setPassword("");
			await onMade({ name: made.link.name, url: made.url });
			await router.invalidate();
		} catch (error) {
			const { code, data } = (error ?? {}) as { code?: string; data?: { field?: string } };
			if (code === "SHARE_LINK_INVALID" && data?.field) setProblem({ field: data.field, message: errorMessage(error) });
			else toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};
	const invalid = (field: string) => problem?.field === field;
	return (
		<form id={id} onSubmit={make} noValidate aria-labelledby={`${id}-title`} className="grid gap-2.5">
			<h3 id={`${id}-title`} className="text-sm font-semibold">
				{t("shareLinks.newTitle")}
			</h3>
			<FieldGroup className="gap-4">
				<Field data-invalid={invalid("name") ? true : undefined}>
					<FieldLabel htmlFor={`${id}-name`}>{t("shareLinks.name")}</FieldLabel>
					<Input
						id={`${id}-name`}
						value={name}
						required
						maxLength={100}
						placeholder={t("shareLinks.namePlaceholder")}
						onChange={(change) => setName(change.target.value)}
						aria-invalid={invalid("name") ? true : undefined}
						aria-describedby={invalid("name") ? `${id}-name-error` : undefined}
					/>
					{invalid("name") && problem ? <FieldError id={`${id}-name-error`}>{t(problem.message)}</FieldError> : null}
				</Field>
				<Field data-invalid={invalid("password") ? true : undefined}>
					<FieldLabel htmlFor={`${id}-password`}>{t("shareLinks.password")}</FieldLabel>
					<Input
						id={`${id}-password`}
						type="password"
						autoComplete="new-password"
						value={password}
						maxLength={200}
						placeholder={t("shareLinks.passwordPlaceholder")}
						onChange={(change) => setPassword(change.target.value)}
						aria-invalid={invalid("password") ? true : undefined}
						aria-describedby={`${id}-password-help${invalid("password") ? ` ${id}-password-error` : ""}`}
					/>
					<FieldDescription id={`${id}-password-help`}>{t("shareLinks.passwordHelp")}</FieldDescription>
					{invalid("password") && problem ? (
						<FieldError id={`${id}-password-error`}>{t(problem.message)}</FieldError>
					) : null}
				</Field>
				<Field data-invalid={invalid("expiresAt") ? true : undefined}>
					<FieldLabel htmlFor={`${id}-expires`}>{t("shareLinks.expiry")}</FieldLabel>
					<NativeSelect
						id={`${id}-expires`}
						className="w-full"
						value={expiry}
						onChange={(change) => setExpiry(change.target.value as Expiry)}
						aria-invalid={invalid("expiresAt") && expiry !== "day" ? true : undefined}
						aria-describedby={invalid("expiresAt") && expiry !== "day" ? `${id}-expires-error` : undefined}
					>
						{EXPIRIES.map((each) => (
							<NativeSelectOption key={each} value={each}>
								{t(`shareLinks.expiries.${each}`)}
							</NativeSelectOption>
						))}
					</NativeSelect>
					{expiry === "day" ? (
						<Input
							id={`${id}-day`}
							type="date"
							value={day}
							onChange={(change) => setDay(change.target.value)}
							aria-label={t("shareLinks.expiryDay")}
							aria-invalid={invalid("expiresAt") ? true : undefined}
							aria-describedby={`${id}-day-help${invalid("expiresAt") ? ` ${id}-expires-error` : ""}`}
						/>
					) : null}
					{expiry === "day" ? (
						<FieldDescription id={`${id}-day-help`}>{t("shareLinks.expiryHelp")}</FieldDescription>
					) : null}
					{invalid("expiresAt") && problem ? (
						<FieldError id={`${id}-expires-error`}>{t(problem.message)}</FieldError>
					) : null}
				</Field>
				<Field>
					<FieldLabel htmlFor={`${id}-language`}>{t("shareLinks.language")}</FieldLabel>
					<NativeSelect
						id={`${id}-language`}
						className="w-full"
						value={language}
						onChange={(change) => setLanguage(change.target.value as ReportLanguage)}
					>
						{Object.entries(REPORT_LANGUAGE_NAMES).map(([code, label]) => (
							<NativeSelectOption key={code} value={code} lang={code}>
								{label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			</FieldGroup>
		</form>
	);
}
