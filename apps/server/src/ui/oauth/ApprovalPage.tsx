import { Link } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Button, buttonVariants } from "@webcraft/ui/components/button.tsx";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@webcraft/ui/components/field.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { BotIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import { ToolsetChoice } from "../account/ToolsetChoice.tsx";
import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";

/** What the approval page shows: the checked request, where the person may approve it, and the Toolsets on offer. */
export type ApprovalData = Awaited<ReturnType<ApiClient["oauth"]["check"]>> & { parameters: Record<string, string> };

/**
 * The approval page: an AI client asks to act as the person. It shows the client's name and the
 * host it sends them back to plainly (with a warning when that is their own device, where any app
 * could use the name), and lets them choose the Workspace, its Sites, the Toolsets (Submissions off,
 * with a warning), read-only or not, and whether it may publish. Approving is a Sensitive action.
 */
export function ApprovalPage({ data, person }: { data: ApprovalData; person: { name: string } }) {
	const t = useT();
	return (
		<main
			id="main"
			tabIndex={-1}
			className="bg-muted flex min-h-svh items-start justify-center p-4 outline-none sm:p-8"
		>
			<div className="bg-card text-card-foreground w-full max-w-xl rounded-xl border p-6 shadow-sm sm:p-8">
				{data.check.kind === "ask" ? (
					<ApprovalForm data={data} request={data.check.request} person={person} />
				) : (
					<>
						<h1 className="mb-3 text-2xl font-semibold tracking-tight">{t("oauth.refusedHeading")}</h1>
						<p className="text-muted-foreground mb-6 text-sm">
							{data.check.kind === "refused" && data.check.problem === "redirectUri"
								? t("oauth.refusedRedirect")
								: t("oauth.refusedClient")}
						</p>
						<Link to="/" className={buttonVariants({ variant: "outline" })}>
							{t("oauth.toAdmin")}
						</Link>
					</>
				)}
			</div>
		</main>
	);
}

type Request = Extract<ApprovalData["check"], { kind: "ask" }>["request"];

function ApprovalForm({ data, request, person }: { data: ApprovalData; request: Request; person: { name: string } }) {
	const t = useT();
	const client = request.client;
	return (
		<ApprovalChoices
			clientName={client.name}
			workspaces={data.workspaces}
			toolsets={data.toolsets}
			heading={t("oauth.heading", { client: client.name })}
			intro={t("oauth.intro", { client: client.name, person: person.name })}
			details={
				<>
					<dt className="text-muted-foreground">{t("oauth.client")}</dt>
					<dd className="font-medium break-all">{client.name}</dd>
					<dt className="text-muted-foreground">{t("oauth.sendsBackTo")}</dt>
					<dd className="font-mono break-all">{client.redirectHost}</dd>
				</>
			}
			warning={client.onThisDevice ? t("oauth.onThisDevice", { client: client.name }) : null}
			onApprove={async (choice) => {
				const api = await getApi();
				const { redirectTo } = await api.oauth.approve({ parameters: data.parameters, ...choice });
				window.location.assign(redirectTo);
			}}
			onDeny={async () => {
				const api = await getApi();
				const { redirectTo } = await api.oauth.deny({ parameters: data.parameters });
				window.location.assign(redirectTo);
			}}
		/>
	);
}

/** What the person chose: the Workspace, its Sites, the Toolsets, read-only and May publish. */
export type ApprovalChoice = {
	workspaceId: string;
	sites: "all" | string[];
	readOnly: boolean;
	mayPublish: boolean;
	toolsets: string[];
};

/**
 * The choices an approval offers, shared by AI clients' requests and device sign-ins: the Workspace,
 * its Sites, the Toolsets, read-only or not, and May publish, then Approve (a Sensitive action, run
 * through "Confirm it's you") or Deny. `onApprove` and `onDeny` go on from there; their failures
 * show above the buttons.
 */
export function ApprovalChoices({
	clientName,
	workspaces,
	toolsets: offered,
	heading,
	intro,
	details,
	warning,
	onApprove,
	onDeny,
}: {
	clientName: string;
	workspaces: ApprovalData["workspaces"];
	toolsets: ApprovalData["toolsets"];
	heading: string;
	intro: string;
	details: ReactNode;
	warning: string | null;
	onApprove(choice: ApprovalChoice): Promise<void>;
	onDeny(): Promise<void>;
}) {
	const t = useT();
	const id = useId();
	const runSensitive = useSensitiveAction();
	const data = { workspaces, toolsets: offered };
	const [workspaceId, setWorkspaceId] = useState(data.workspaces[0]?.id ?? "");
	const [reach, setReach] = useState<"all" | "chosen">("all");
	const [chosenSites, setChosenSites] = useState<Set<string>>(() => new Set());
	const [toolsets, setToolsets] = useState<Set<string>>(
		() => new Set(data.toolsets.filter((toolset) => !toolset.optIn).map((toolset) => toolset.key)),
	);
	const [readOnly, setReadOnly] = useState(false);
	const [mayPublish, setMayPublish] = useState(false);
	const [problem, setProblem] = useState<{ field: "sites" | "toolsets" | null; message: MessageKey } | null>(null);
	const [busy, setBusy] = useState(false);
	const workspace = data.workspaces.find((each) => each.id === workspaceId);

	const approve = async (event: FormEvent) => {
		event.preventDefault();
		if (reach === "chosen" && chosenSites.size === 0) {
			setProblem({ field: "sites", message: "oauth.sitesRequired" });
			return;
		}
		if (toolsets.size === 0) {
			setProblem({ field: "toolsets", message: "toolsets.required" });
			return;
		}
		setBusy(true);
		setProblem(null);
		try {
			await runSensitive(() =>
				onApprove({
					workspaceId,
					sites: reach === "all" ? "all" : [...chosenSites],
					readOnly,
					mayPublish: !readOnly && mayPublish,
					toolsets: [...toolsets],
				}),
			);
		} catch (failure) {
			setProblem({ field: null, message: errorMessage(failure) });
			setBusy(false);
		}
	};

	const deny = async () => {
		setBusy(true);
		try {
			await onDeny();
		} catch (failure) {
			setProblem({ field: null, message: errorMessage(failure) });
			setBusy(false);
		}
	};

	if (data.workspaces.length === 0) {
		return (
			<>
				<h1 className="mb-3 text-2xl font-semibold tracking-tight">{heading}</h1>
				<p className="text-muted-foreground mb-6 text-sm">{t("oauth.noWorkspaces")}</p>
				<Button variant="outline" onClick={deny} disabled={busy}>
					{t("oauth.deny")}
				</Button>
			</>
		);
	}

	return (
		<form onSubmit={approve} noValidate>
			<div className="mb-6 flex items-start gap-3">
				<BotIcon aria-hidden="true" className="text-muted-foreground mt-1 size-6 shrink-0" />
				<div className="grid gap-1">
					<h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
					<p className="text-muted-foreground text-sm">{intro}</p>
				</div>
			</div>
			<dl className="bg-muted/50 mb-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border p-3 text-sm">
				{details}
			</dl>
			{warning ? (
				<p className="border-destructive/40 bg-destructive/5 mb-6 flex gap-2 rounded-md border p-3 text-sm">
					<TriangleAlertIcon aria-hidden="true" className="text-destructive size-5 shrink-0" />
					{warning}
				</p>
			) : null}
			<FieldGroup className="gap-6">
				<Field>
					<FieldLabel htmlFor={`${id}-workspace`}>{t("oauth.workspace")}</FieldLabel>
					<NativeSelect
						id={`${id}-workspace`}
						value={workspaceId}
						onChange={(event) => {
							setWorkspaceId(event.target.value);
							setChosenSites(new Set());
						}}
					>
						{data.workspaces.map((each) => (
							<NativeSelectOption key={each.id} value={each.id}>
								{each.name}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
				<FieldSet data-invalid={problem?.field === "sites" ? true : undefined}>
					<FieldLegend variant="label">{t("oauth.sites")}</FieldLegend>
					<div className="flex flex-col gap-2">
						<label className="flex items-center gap-2 text-sm">
							<input
								type="radio"
								name={`${id}-reach`}
								checked={reach === "all"}
								onChange={() => setReach("all")}
								className="accent-primary size-4"
							/>
							{t("oauth.allSites")}
						</label>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="radio"
								name={`${id}-reach`}
								checked={reach === "chosen"}
								onChange={() => setReach("chosen")}
								className="accent-primary size-4"
							/>
							{t("oauth.chosenSites")}
						</label>
						{reach === "chosen" ? (
							<div className="flex flex-col gap-2 ps-6">
								{(workspace?.sites ?? []).map((site) => (
									<label key={site.id} className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											checked={chosenSites.has(site.id)}
											onChange={(event) =>
												setChosenSites((current) => {
													const next = new Set(current);
													if (event.target.checked) next.add(site.id);
													else next.delete(site.id);
													return next;
												})
											}
											className="accent-primary size-4"
										/>
										{site.name}
									</label>
								))}
								{workspace?.sites.length === 0 ? (
									<p className="text-muted-foreground text-sm">{t("oauth.noSitesToChoose")}</p>
								) : null}
							</div>
						) : null}
					</div>
					{problem?.field === "sites" ? <FieldError>{t(problem.message)}</FieldError> : null}
				</FieldSet>
				<ToolsetChoice
					offered={data.toolsets}
					chosen={toolsets}
					onChange={setToolsets}
					problem={problem?.field === "toolsets" ? problem.message : null}
				/>
				<FieldSet>
					<FieldLegend variant="label">{t("oauth.access")}</FieldLegend>
					<div className="flex flex-col gap-2">
						<label className="flex items-center gap-2 text-sm">
							<input
								type="radio"
								name={`${id}-access`}
								checked={!readOnly}
								onChange={() => setReadOnly(false)}
								className="accent-primary size-4"
							/>
							{t("oauth.readWrite")}
						</label>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="radio"
								name={`${id}-access`}
								checked={readOnly}
								onChange={() => setReadOnly(true)}
								className="accent-primary size-4"
							/>
							{t("oauth.readOnly")}
						</label>
					</div>
				</FieldSet>
				<Field>
					<label className="flex items-start gap-2 text-sm">
						<input
							type="checkbox"
							checked={!readOnly && mayPublish}
							disabled={readOnly}
							onChange={(event) => setMayPublish(event.target.checked)}
							aria-describedby={`${id}-publish-help`}
							className="accent-primary mt-0.5 size-4 shrink-0"
						/>
						<span className="font-medium">{t("oauth.mayPublish")}</span>
					</label>
					<FieldDescription id={`${id}-publish-help`} className="ms-6">
						{t("oauth.mayPublishHelp")}
					</FieldDescription>
				</Field>
				<p className="text-muted-foreground text-sm">{t("oauth.limits")}</p>
				{problem?.field === null ? <FieldError>{t(problem.message)}</FieldError> : null}
				<div className="flex flex-wrap justify-end gap-2">
					<Button type="button" variant="outline" onClick={deny} disabled={busy}>
						{t("oauth.deny")}
					</Button>
					<Button type="submit" disabled={busy}>
						{t("oauth.approve", { client: clientName })}
					</Button>
				</div>
			</FieldGroup>
		</form>
	);
}
