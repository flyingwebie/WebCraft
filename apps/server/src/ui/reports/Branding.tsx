import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { useId } from "react";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { SettingsForm, useSettingsSection } from "../settings/form.tsx";
import { SettingsCard, SettingsRow, SettingsRows, Switch } from "../settings/layout.tsx";
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

/** A card's error that belongs to no one field (a refusal, a failure to reach the server). */
function formProblem(problem: Problem) {
	return problem && problem.field === null ? problem : null;
}

/**
 * Install settings › Reports (the Superadmin): the agency brand on every Report and Share link of the
 * Install, and whether the agency brand, the client brand and "Made with WebCraft" show. Workspaces
 * may replace it. Apart from Install branding (System emails).
 */
export function InstallBrandingPage({ branding }: { branding: InstallBranding }) {
	const t = useT();
	return (
		<>
			<PageHeader heading={t("branding.installHeading")}>{t("branding.installIntro")}</PageHeader>
			<SettingsForm>
				<InstallBrandingForm branding={branding} />
			</SettingsForm>
		</>
	);
}

function InstallBrandingForm({ branding }: { branding: InstallBranding }) {
	const t = useT();
	const id = useId();
	const section = useSettingsSection({
		saved: {
			// The logo kept now: when it changes, the form starts again from it.
			current: branding.logo,
			name: branding.name ?? "",
			accent: branding.accentColour ?? "",
			logo: undefined as LogoChange,
			showAgency: branding.showAgency,
			showClient: branding.showClient,
			madeWith: branding.madeWith,
		},
		save: async ({ name, accent, logo, showAgency, showClient, madeWith }) =>
			(await getApi()).reportBranding.install.update({
				name: name.trim() || null,
				accentColour: accent.trim() || null,
				...(logo !== undefined ? { logo } : {}),
				showAgency,
				showClient,
				madeWith,
			}),
	});
	const problem = section.failure ? problemOf(section.failure) : null;
	const { values, set } = section;
	return (
		<form {...section.formProps} className="space-y-6">
			<SettingsCard title={t("branding.agencyTitle")} description={t("branding.agencyIntro")}>
				<FieldGroup className="gap-5">
					<AgencyFields
						id={id}
						name={values.name}
						setName={(name) => set({ name })}
						accent={values.accent}
						setAccent={(accent) => set({ accent })}
						logo={values.logo}
						setLogo={(logo) => set({ logo })}
						current={branding.logo}
						problem={problem}
					/>
				</FieldGroup>
			</SettingsCard>
			<SettingsCard title={t("branding.showTitle")} description={t("branding.showIntro")}>
				<SettingsRows>
					{(
						[
							["agency", "showAgency"],
							["client", "showClient"],
							["madeWith", "madeWith"],
						] as const
					).map(([key, field]) => (
						<SettingsRow key={key} label={t(`branding.show.${key}`)} htmlFor={`${id}-${key}`}>
							<Switch
								id={`${id}-${key}`}
								checked={values[field]}
								onCheckedChange={(checked) => set({ [field]: checked })}
							/>
						</SettingsRow>
					))}
				</SettingsRows>
			</SettingsCard>
			{formProblem(problem) ? <FieldError>{t(problem?.message ?? "errors.generic")}</FieldError> : null}
		</form>
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
		<SettingsRow label={label} htmlFor={id}>
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
		</SettingsRow>
	);
}

/**
 * Workspace › Report branding (Staff): the Workspace's own agency brand in place of the Install's,
 * its client brand (its name and logo, for Workspace Dashboards and Sites without their own), and its
 * own choice of what shows.
 */
export function WorkspaceBrandingPage({ workspaceId, branding }: { workspaceId: string; branding: WorkspaceBranding }) {
	const t = useT();
	return (
		<>
			<PageHeader heading={t("branding.workspaceHeading")}>{t("branding.workspaceIntro")}</PageHeader>
			<SettingsForm>
				<WorkspaceBrandingForm workspaceId={workspaceId} branding={branding} />
			</SettingsForm>
		</>
	);
}

function WorkspaceBrandingForm({ workspaceId, branding }: { workspaceId: string; branding: WorkspaceBranding }) {
	const t = useT();
	const id = useId();
	const section = useSettingsSection({
		saved: {
			currentAgencyLogo: branding.agency.logo,
			currentClientLogo: branding.client.logo,
			ownAgency: branding.ownAgency,
			name: branding.agency.name ?? "",
			accent: branding.agency.accentColour ?? "",
			agencyLogo: undefined as LogoChange,
			clientName: branding.client.name ?? "",
			clientLogo: undefined as LogoChange,
			showAgency: branding.showAgency,
			showClient: branding.showClient,
			madeWith: branding.madeWith,
		},
		save: async (values) =>
			(await getApi()).reportBranding.workspace.update({
				workspaceId,
				ownAgency: values.ownAgency,
				agency: {
					name: values.name.trim() || null,
					accentColour: values.accent.trim() || null,
					...(values.agencyLogo !== undefined ? { logo: values.agencyLogo } : {}),
				},
				client: {
					name: values.clientName.trim() || null,
					...(values.clientLogo !== undefined ? { logo: values.clientLogo } : {}),
				},
				showAgency: values.showAgency,
				showClient: values.showClient,
				madeWith: values.madeWith,
			}),
	});
	const problem = section.failure ? problemOf(section.failure) : null;
	const { values, set } = section;
	return (
		<form {...section.formProps} className="space-y-6">
			<SettingsCard title={t("branding.agencyTitle")} description={t("branding.workspaceAgencyIntro")}>
				<SettingsRows>
					<SettingsRow label={t("branding.ownAgency")} htmlFor={`${id}-own`}>
						<Switch id={`${id}-own`} checked={values.ownAgency} onCheckedChange={(ownAgency) => set({ ownAgency })} />
					</SettingsRow>
				</SettingsRows>
				{values.ownAgency ? (
					<FieldGroup className="gap-5">
						<AgencyFields
							id={id}
							name={values.name}
							setName={(name) => set({ name })}
							accent={values.accent}
							setAccent={(accent) => set({ accent })}
							logo={values.agencyLogo}
							setLogo={(agencyLogo) => set({ agencyLogo })}
							current={branding.agency.logo}
							problem={problem}
						/>
					</FieldGroup>
				) : null}
			</SettingsCard>
			<ClientCard
				id={id}
				intro={t("branding.workspaceClientIntro")}
				name={values.clientName}
				setName={(clientName) => set({ clientName })}
				logo={values.clientLogo}
				setLogo={(clientLogo) => set({ clientLogo })}
				current={branding.client.logo}
				problem={problem}
			/>
			<SettingsCard title={t("branding.showTitle")} description={t("branding.workspaceShowIntro")}>
				<SettingsRows>
					<InheritedSwitch
						id={`${id}-show-agency`}
						label={t("branding.show.agency")}
						value={values.showAgency}
						installValue={branding.install.showAgency}
						onChange={(showAgency) => set({ showAgency })}
					/>
					<InheritedSwitch
						id={`${id}-show-client`}
						label={t("branding.show.client")}
						value={values.showClient}
						installValue={branding.install.showClient}
						onChange={(showClient) => set({ showClient })}
					/>
					<InheritedSwitch
						id={`${id}-made-with`}
						label={t("branding.show.madeWith")}
						value={values.madeWith}
						installValue={branding.install.madeWith}
						onChange={(madeWith) => set({ madeWith })}
					/>
				</SettingsRows>
			</SettingsCard>
			{formProblem(problem) ? <FieldError>{t(problem?.message ?? "errors.generic")}</FieldError> : null}
		</form>
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
		<SettingsCard title={t("branding.clientTitle")} description={intro}>
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
		</SettingsCard>
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
	return (
		<>
			<PageHeader heading={t("branding.siteHeading")}>{t("branding.siteIntro")}</PageHeader>
			<SettingsForm>
				<SiteBrandingForm siteId={siteId} branding={branding} />
			</SettingsForm>
		</>
	);
}

function SiteBrandingForm({
	siteId,
	branding,
}: {
	siteId: string;
	branding: { client: { name: string | null; logo: LogoView } };
}) {
	const t = useT();
	const id = useId();
	const section = useSettingsSection({
		saved: { current: branding.client.logo, name: branding.client.name ?? "", logo: undefined as LogoChange },
		save: async ({ name, logo }) =>
			(await getApi()).reportBranding.site.update({
				siteId,
				client: { name: name.trim() || null, ...(logo !== undefined ? { logo } : {}) },
			}),
	});
	const problem = section.failure ? problemOf(section.failure) : null;
	return (
		<form {...section.formProps} className="space-y-6">
			<ClientCard
				id={id}
				intro={t("branding.siteClientIntro")}
				name={section.values.name}
				setName={(name) => section.set({ name })}
				logo={section.values.logo}
				setLogo={(logo) => section.set({ logo })}
				current={branding.client.logo}
				problem={problem}
			/>
			{formProblem(problem) ? <FieldError>{t(problem?.message ?? "errors.generic")}</FieldError> : null}
		</form>
	);
}
