import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { type InstallBranding, kilobytes, type LogoView, logoFrom, type WorkspaceBranding } from "./model.ts";

/** A logo change: undefined leaves it, null removes it, a file read replaces it. */
type LogoChange = { contentType: string; data: string } | null | undefined;

type Problem = { field: "logo" | "accentColour" | "name" | null; message: MessageKey } | null;

function problemOf(error: unknown): NonNullable<Problem> {
	const { code, data } = (error ?? {}) as { code?: string; data?: { field?: string } };
	const field = data?.field;
	if (code === "BRANDING_INVALID" && (field === "logo" || field === "accentColour" || field === "name")) {
		return { field, message: errorMessage(error) };
	}
	return { field: null, message: errorMessage(error) };
}

/** A logo: the one kept (its type and size), a new file to replace it, or removing it. */
function LogoField({
	id,
	label,
	current,
	change,
	onChange,
	problem,
}: {
	id: string;
	label: string;
	current: LogoView;
	change: LogoChange;
	onChange: (change: LogoChange) => void;
	problem: Problem;
}) {
	const t = useT();
	const invalid = problem?.field === "logo";
	const kept = change === undefined ? current : null;
	return (
		<Field data-invalid={invalid ? true : undefined}>
			<FieldLabel htmlFor={`${id}-file`}>{label}</FieldLabel>
			<p className="text-muted-foreground text-sm" id={`${id}-now`}>
				{change === null
					? t("branding.logoRemoved")
					: change
						? t("branding.logoChosen")
						: kept
							? t("branding.logoKept", {
									type: kept.contentType.replace("image/", "").toUpperCase(),
									size: kilobytes(kept.bytes),
								})
							: t("branding.noLogo")}
			</p>
			<Input
				id={`${id}-file`}
				type="file"
				accept="image/png,image/jpeg,image/webp"
				onChange={async (event) => {
					const file = event.target.files?.[0];
					onChange(file ? await logoFrom(file) : undefined);
				}}
				aria-invalid={invalid ? true : undefined}
				aria-describedby={`${id}-now ${id}-help${invalid ? ` ${id}-error` : ""}`}
			/>
			<FieldDescription id={`${id}-help`}>{t("branding.logoHelp")}</FieldDescription>
			{invalid && problem ? <FieldError id={`${id}-error`}>{t(problem.message)}</FieldError> : null}
			{current && change !== null ? (
				<Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => onChange(null)}>
					{t("branding.removeLogo")}
				</Button>
			) : null}
		</Field>
	);
}

/** The agency brand's name, accent colour and logo. */
function AgencyFields({
	id,
	name,
	setName,
	accent,
	setAccent,
	logo,
	setLogo,
	current,
	problem,
}: {
	id: string;
	name: string;
	setName: (value: string) => void;
	accent: string;
	setAccent: (value: string) => void;
	logo: LogoChange;
	setLogo: (value: LogoChange) => void;
	current: LogoView;
	problem: Problem;
}) {
	const t = useT();
	return (
		<>
			<Field data-invalid={problem?.field === "name" ? true : undefined}>
				<FieldLabel htmlFor={`${id}-agency-name`}>{t("branding.agencyName")}</FieldLabel>
				<Input
					id={`${id}-agency-name`}
					value={name}
					maxLength={100}
					onChange={(change) => setName(change.target.value)}
				/>
			</Field>
			<Field data-invalid={problem?.field === "accentColour" ? true : undefined}>
				<FieldLabel htmlFor={`${id}-accent`}>{t("branding.accentColour")}</FieldLabel>
				<Input
					id={`${id}-accent`}
					value={accent}
					maxLength={7}
					placeholder="#c2410c"
					spellCheck={false}
					className="max-w-40 font-mono"
					onChange={(change) => setAccent(change.target.value)}
					aria-invalid={problem?.field === "accentColour" ? true : undefined}
					aria-describedby={`${id}-accent-help${problem?.field === "accentColour" ? ` ${id}-accent-error` : ""}`}
				/>
				<FieldDescription id={`${id}-accent-help`}>{t("branding.accentHelp")}</FieldDescription>
				{problem?.field === "accentColour" ? (
					<FieldError id={`${id}-accent-error`}>{t(problem.message)}</FieldError>
				) : null}
			</Field>
			<LogoField
				id={`${id}-agency-logo`}
				label={t("branding.agencyLogo")}
				current={current}
				change={logo}
				onChange={setLogo}
				problem={problem}
			/>
		</>
	);
}

/**
 * Install settings › Reports (the Superadmin): the agency brand on every Report and Share link of the
 * Install, and whether the agency brand, the client brand and "Made with WebCraft" show. Workspaces
 * may replace it. Apart from Install branding (System emails).
 */
export function InstallBrandingPage({ branding }: { branding: InstallBranding }) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [name, setName] = useState(branding.name ?? "");
	const [accent, setAccent] = useState(branding.accentColour ?? "");
	const [logo, setLogo] = useState<LogoChange>(undefined);
	const [showAgency, setShowAgency] = useState(branding.showAgency);
	const [showClient, setShowClient] = useState(branding.showClient);
	const [madeWith, setMadeWith] = useState(branding.madeWith);
	const [problem, setProblem] = useState<Problem>(null);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblem(null);
		try {
			await (await getApi()).reportBranding.install.update({
				name: name.trim() || null,
				accentColour: accent.trim() || null,
				...(logo !== undefined ? { logo } : {}),
				showAgency,
				showClient,
				madeWith,
			});
			setLogo(undefined);
			toast.success(t("branding.saved"));
			await router.invalidate();
		} catch (error) {
			const found = problemOf(error);
			if (found.field) setProblem(found);
			else toast.error(t(found.message));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="max-w-3xl">
			<PageHeader heading={t("branding.installHeading")}>{t("branding.installIntro")}</PageHeader>
			<form onSubmit={save} noValidate className="space-y-6">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("branding.agencyTitle")}</h2>
						</CardTitle>
						<CardDescription>{t("branding.agencyIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						<FieldGroup className="gap-5">
							<AgencyFields
								id={id}
								name={name}
								setName={setName}
								accent={accent}
								setAccent={setAccent}
								logo={logo}
								setLogo={setLogo}
								current={branding.logo}
								problem={problem}
							/>
						</FieldGroup>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("branding.showTitle")}</h2>
						</CardTitle>
						<CardDescription>{t("branding.showIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						<FieldSet>
							<FieldLegend className="sr-only">{t("branding.showTitle")}</FieldLegend>
							{(
								[
									["agency", showAgency, setShowAgency],
									["client", showClient, setShowClient],
									["madeWith", madeWith, setMadeWith],
								] as const
							).map(([key, checked, set]) => (
								<Field key={key} orientation="horizontal">
									<Checkbox id={`${id}-${key}`} checked={checked} onCheckedChange={(value) => set(value === true)} />
									<FieldLabel htmlFor={`${id}-${key}`}>{t(`branding.show.${key}`)}</FieldLabel>
								</Field>
							))}
						</FieldSet>
					</CardContent>
				</Card>
				<Button type="submit" disabled={busy}>
					{t("branding.save")}
				</Button>
			</form>
		</div>
	);
}

/** A switch a Workspace may leave to the Install: on, off, or the Install's. */
function InheritedSwitch({
	id,
	label,
	value,
	installValue,
	onChange,
}: {
	id: string;
	label: string;
	value: boolean | null;
	installValue: boolean;
	onChange: (value: boolean | null) => void;
}) {
	const t = useT();
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<NativeSelect
				id={id}
				value={value === null ? "install" : value ? "on" : "off"}
				onChange={(change) => onChange(change.target.value === "install" ? null : change.target.value === "on")}
			>
				<NativeSelectOption value="install">
					{t(installValue ? "branding.asInstallShown" : "branding.asInstallHidden")}
				</NativeSelectOption>
				<NativeSelectOption value="on">{t("branding.shown")}</NativeSelectOption>
				<NativeSelectOption value="off">{t("branding.hidden")}</NativeSelectOption>
			</NativeSelect>
		</Field>
	);
}

/**
 * Workspace › Report branding (Staff): the Workspace's own agency brand in place of the Install's,
 * its client brand (its name and logo, for Workspace Dashboards and Sites without their own), and its
 * own choice of what shows.
 */
export function WorkspaceBrandingPage({ workspaceId, branding }: { workspaceId: string; branding: WorkspaceBranding }) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [ownAgency, setOwnAgency] = useState(branding.ownAgency);
	const [name, setName] = useState(branding.agency.name ?? "");
	const [accent, setAccent] = useState(branding.agency.accentColour ?? "");
	const [agencyLogo, setAgencyLogo] = useState<LogoChange>(undefined);
	const [clientName, setClientName] = useState(branding.client.name ?? "");
	const [clientLogo, setClientLogo] = useState<LogoChange>(undefined);
	const [showAgency, setShowAgency] = useState(branding.showAgency);
	const [showClient, setShowClient] = useState(branding.showClient);
	const [madeWith, setMadeWith] = useState(branding.madeWith);
	const [problem, setProblem] = useState<Problem>(null);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblem(null);
		try {
			await (await getApi()).reportBranding.workspace.update({
				workspaceId,
				ownAgency,
				agency: {
					name: name.trim() || null,
					accentColour: accent.trim() || null,
					...(agencyLogo !== undefined ? { logo: agencyLogo } : {}),
				},
				client: { name: clientName.trim() || null, ...(clientLogo !== undefined ? { logo: clientLogo } : {}) },
				showAgency,
				showClient,
				madeWith,
			});
			setAgencyLogo(undefined);
			setClientLogo(undefined);
			toast.success(t("branding.saved"));
			await router.invalidate();
		} catch (error) {
			const found = problemOf(error);
			if (found.field) setProblem(found);
			else toast.error(t(found.message));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="max-w-3xl">
			<PageHeader heading={t("branding.workspaceHeading")}>{t("branding.workspaceIntro")}</PageHeader>
			<form onSubmit={save} noValidate className="space-y-6">
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("branding.agencyTitle")}</h2>
						</CardTitle>
						<CardDescription>{t("branding.workspaceAgencyIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						<FieldGroup className="gap-5">
							<Field orientation="horizontal">
								<Checkbox
									id={`${id}-own`}
									checked={ownAgency}
									onCheckedChange={(value) => setOwnAgency(value === true)}
								/>
								<FieldLabel htmlFor={`${id}-own`}>{t("branding.ownAgency")}</FieldLabel>
							</Field>
							{ownAgency ? (
								<AgencyFields
									id={id}
									name={name}
									setName={setName}
									accent={accent}
									setAccent={setAccent}
									logo={agencyLogo}
									setLogo={setAgencyLogo}
									current={branding.agency.logo}
									problem={problem}
								/>
							) : null}
						</FieldGroup>
					</CardContent>
				</Card>
				<ClientCard
					id={id}
					intro={t("branding.workspaceClientIntro")}
					name={clientName}
					setName={setClientName}
					logo={clientLogo}
					setLogo={setClientLogo}
					current={branding.client.logo}
					problem={problem}
				/>
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("branding.showTitle")}</h2>
						</CardTitle>
						<CardDescription>{t("branding.workspaceShowIntro")}</CardDescription>
					</CardHeader>
					<CardContent>
						<FieldGroup className="gap-4">
							<InheritedSwitch
								id={`${id}-show-agency`}
								label={t("branding.show.agency")}
								value={showAgency}
								installValue={branding.install.showAgency}
								onChange={setShowAgency}
							/>
							<InheritedSwitch
								id={`${id}-show-client`}
								label={t("branding.show.client")}
								value={showClient}
								installValue={branding.install.showClient}
								onChange={setShowClient}
							/>
							<InheritedSwitch
								id={`${id}-made-with`}
								label={t("branding.show.madeWith")}
								value={madeWith}
								installValue={branding.install.madeWith}
								onChange={setMadeWith}
							/>
						</FieldGroup>
					</CardContent>
				</Card>
				<Button type="submit" disabled={busy}>
					{t("branding.save")}
				</Button>
			</form>
		</div>
	);
}

function ClientCard({
	id,
	intro,
	name,
	setName,
	logo,
	setLogo,
	current,
	problem,
}: {
	id: string;
	intro: string;
	name: string;
	setName: (value: string) => void;
	logo: LogoChange;
	setLogo: (value: LogoChange) => void;
	current: LogoView;
	problem: Problem;
}) {
	const t = useT();
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<h2>{t("branding.clientTitle")}</h2>
				</CardTitle>
				<CardDescription>{intro}</CardDescription>
			</CardHeader>
			<CardContent>
				<FieldGroup className="gap-5">
					<Field>
						<FieldLabel htmlFor={`${id}-client-name`}>{t("branding.clientName")}</FieldLabel>
						<Input
							id={`${id}-client-name`}
							value={name}
							maxLength={100}
							onChange={(change) => setName(change.target.value)}
							aria-describedby={`${id}-client-name-help`}
						/>
						<FieldDescription id={`${id}-client-name-help`}>{t("branding.clientNameHelp")}</FieldDescription>
					</Field>
					<LogoField
						id={`${id}-client-logo`}
						label={t("branding.clientLogo")}
						current={current}
						change={logo}
						onChange={setLogo}
						problem={problem}
					/>
				</FieldGroup>
			</CardContent>
		</Card>
	);
}

/** Site › Report branding (Staff): the Site's client brand, its name and logo. */
export function SiteBrandingPage({
	siteId,
	branding,
}: {
	siteId: string;
	branding: { client: { name: string | null; logo: LogoView } };
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [name, setName] = useState(branding.client.name ?? "");
	const [logo, setLogo] = useState<LogoChange>(undefined);
	const [problem, setProblem] = useState<Problem>(null);
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setProblem(null);
		try {
			await (await getApi()).reportBranding.site.update({
				siteId,
				client: { name: name.trim() || null, ...(logo !== undefined ? { logo } : {}) },
			});
			setLogo(undefined);
			toast.success(t("branding.saved"));
			await router.invalidate();
		} catch (error) {
			const found = problemOf(error);
			if (found.field) setProblem(found);
			else toast.error(t(found.message));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="max-w-3xl">
			<PageHeader heading={t("branding.siteHeading")}>{t("branding.siteIntro")}</PageHeader>
			<form onSubmit={save} noValidate className="space-y-6">
				<ClientCard
					id={id}
					intro={t("branding.siteClientIntro")}
					name={name}
					setName={setName}
					logo={logo}
					setLogo={setLogo}
					current={branding.client.logo}
					problem={problem}
				/>
				<Button type="submit" disabled={busy}>
					{t("branding.save")}
				</Button>
			</form>
		</div>
	);
}
