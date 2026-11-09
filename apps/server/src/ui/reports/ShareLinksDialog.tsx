import { useRouter } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { CopyIcon, LinkIcon, PlusIcon } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc, formatUtcDate } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { REPORT_LANGUAGE_NAMES, type ReportLanguage, type ReportPlace, type ShareLinkView } from "./model.ts";

/**
 * A Dashboard's Share links (the Share button on a Dashboard): each link's state, password, expiry
 * and how often it was opened. Staff make new ones (a Sensitive action: "Confirm it's you" first) and
 * revoke them; the address shows once, right after it is made. Owners see the list.
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
	const [links, setLinks] = useState<ShareLinkView[] | null>(null);
	const [made, setMade] = useState<{ name: string; url: string } | null>(null);
	const [making, setMaking] = useState(false);
	const load = async () => {
		try {
			setLinks((await (await getApi()).shareLinks.list({ ...place, dashboardId })).links);
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: loads once when the dialog opens.
	useEffect(() => {
		void load();
	}, []);
	const revoke = async (link: ShareLinkView) => {
		try {
			await (await getApi()).shareLinks.revoke({ ...place, shareLinkId: link.id });
			toast.success(t("shareLinks.revoked", { name: link.name }));
			await load();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		}
	};
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				closeLabel={t("shareLinks.close")}
				finalFocus={finalFocus}
				className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
			>
				<DialogHeader>
					<DialogTitle>{t("shareLinks.title")}</DialogTitle>
					<DialogDescription>{t("shareLinks.intro")}</DialogDescription>
				</DialogHeader>
				<div className="my-6 space-y-6">
					{made ? <MadeLink name={made.name} url={made.url} /> : null}
					{links === null ? (
						<p className="text-muted-foreground text-sm">{t("shareLinks.loading")}</p>
					) : links.length === 0 ? (
						<p className="text-muted-foreground text-sm">{t("shareLinks.empty")}</p>
					) : (
						<ul className="divide-y rounded-md border" aria-label={t("shareLinks.listLabel")}>
							{links.map((link) => (
								<li key={link.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
									<div className="min-w-0 space-y-1">
										<p className="font-medium break-all">
											{link.name} <span className="text-muted-foreground font-mono text-xs">…{link.hint}</span>
										</p>
										<div className="flex flex-wrap gap-2">
											<Badge variant={link.state === "active" ? "secondary" : "outline"}>
												{t(`shareLinks.states.${link.state}`)}
											</Badge>
											<Badge variant="outline">
												{link.password ? t("shareLinks.withPassword") : t("shareLinks.withoutPassword")}
											</Badge>
										</div>
										<p className="text-muted-foreground text-sm">
											{link.expiresAt
												? t("shareLinks.expires", { day: formatUtcDate(link.expiresAt) })
												: t("shareLinks.noExpiry")}
											{" · "}
											{t("shareLinks.opens", { count: link.opens })}
											{link.lastOpenedAt
												? ` · ${t("shareLinks.lastOpened", { at: formatUtc(link.lastOpenedAt) })}`
												: ""}
										</p>
									</div>
									{canManage && link.state === "active" ? (
										<Button
											variant="outline"
											size="sm"
											onClick={() => void revoke(link)}
											aria-label={t("shareLinks.revokeLabel", { name: link.name })}
										>
											{t("shareLinks.revoke")}
										</Button>
									) : null}
								</li>
							))}
						</ul>
					)}
					{canManage && !making ? (
						<Button variant="outline" onClick={() => setMaking(true)}>
							<PlusIcon aria-hidden="true" />
							{t("shareLinks.new")}
						</Button>
					) : null}
					{canManage && making ? (
						<NewLink
							id={`${id}-new`}
							place={place}
							dashboardId={dashboardId}
							language={language}
							onMade={async (link) => {
								setMade(link);
								setMaking(false);
								await load();
							}}
							onCancel={() => setMaking(false)}
						/>
					) : null}
				</div>
				<DialogFooter>
					<DialogClose render={<Button type="button" variant="outline" />}>{t("shareLinks.close")}</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** The address of a link just made: shown this once, with a way to copy it. */
function MadeLink({ name, url }: { name: string; url: string }) {
	const t = useT();
	const id = useId();
	const [said, setSaid] = useState("");
	const address = useRef<HTMLInputElement>(null);
	// The form that made it is gone: focus goes to its address, to copy.
	useEffect(() => {
		address.current?.focus();
		address.current?.select();
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
		<div className="bg-muted/40 space-y-2 rounded-md border p-3" role="status">
			<p className="flex items-center gap-2 font-medium">
				<LinkIcon aria-hidden="true" className="size-4" />
				{t("shareLinks.made", { name })}
			</p>
			<Field>
				<FieldLabel htmlFor={`${id}-url`}>{t("shareLinks.address")}</FieldLabel>
				<div className="flex gap-2">
					<Input
						ref={address}
						id={`${id}-url`}
						value={url}
						readOnly
						className="font-mono"
						aria-describedby={`${id}-help`}
					/>
					<Button type="button" variant="outline" onClick={() => void copy()}>
						<CopyIcon aria-hidden="true" />
						{t("shareLinks.copy")}
					</Button>
				</div>
				<FieldDescription id={`${id}-help`}>{t("shareLinks.shownOnce")}</FieldDescription>
			</Field>
			<p className="sr-only" aria-live="polite">
				{said}
			</p>
		</div>
	);
}

function NewLink({
	id,
	place,
	dashboardId,
	language: personLanguage,
	onMade,
	onCancel,
}: {
	id: string;
	place: ReportPlace;
	dashboardId: string;
	language: string;
	onMade: (link: { name: string; url: string }) => Promise<void>;
	onCancel: () => void;
}) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [expires, setExpires] = useState("");
	const [language, setLanguage] = useState<ReportLanguage>(
		personLanguage in REPORT_LANGUAGE_NAMES ? (personLanguage as ReportLanguage) : "en",
	);
	const [problem, setProblem] = useState<{ field: string | null; message: MessageKey } | null>(null);
	const [busy, setBusy] = useState(false);
	const nameInput = useRef<HTMLInputElement>(null);
	// The form opens where the person asked for it: focus goes to its first field.
	useEffect(() => {
		nameInput.current?.focus();
	}, []);
	const make = async (event: FormEvent) => {
		event.preventDefault();
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
					expiresAt: expires === "" ? null : new Date(`${expires}T23:59:59Z`),
				}),
			);
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
		<form id={id} onSubmit={make} noValidate className="space-y-4 rounded-md border p-4">
			<h3 className="font-medium">{t("shareLinks.newTitle")}</h3>
			<FieldGroup className="gap-4">
				<Field data-invalid={invalid("name") ? true : undefined}>
					<FieldLabel htmlFor={`${id}-name`}>{t("shareLinks.name")}</FieldLabel>
					<Input
						ref={nameInput}
						id={`${id}-name`}
						value={name}
						required
						maxLength={100}
						onChange={(change) => setName(change.target.value)}
						aria-invalid={invalid("name") ? true : undefined}
						aria-describedby={`${id}-name-help${invalid("name") ? ` ${id}-name-error` : ""}`}
					/>
					<FieldDescription id={`${id}-name-help`}>{t("shareLinks.nameHelp")}</FieldDescription>
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
					<Input
						id={`${id}-expires`}
						type="date"
						value={expires}
						onChange={(change) => setExpires(change.target.value)}
						aria-invalid={invalid("expiresAt") ? true : undefined}
						aria-describedby={`${id}-expires-help${invalid("expiresAt") ? ` ${id}-expires-error` : ""}`}
					/>
					<FieldDescription id={`${id}-expires-help`}>{t("shareLinks.expiryHelp")}</FieldDescription>
					{invalid("expiresAt") && problem ? (
						<FieldError id={`${id}-expires-error`}>{t(problem.message)}</FieldError>
					) : null}
				</Field>
				<Field>
					<FieldLabel htmlFor={`${id}-language`}>{t("shareLinks.language")}</FieldLabel>
					<NativeSelect
						id={`${id}-language`}
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
			<div className="flex flex-wrap gap-2">
				<Button type="submit" disabled={busy}>
					{t("shareLinks.make")}
				</Button>
				<Button type="button" variant="outline" onClick={onCancel}>
					{t("shareLinks.cancel")}
				</Button>
			</div>
		</form>
	);
}
