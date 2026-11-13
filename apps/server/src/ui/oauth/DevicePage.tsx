import type { ApiClient } from "@webcraft/api";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { CircleCheckIcon, CircleXIcon, TerminalIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { ApprovalChoices } from "./ApprovalPage.tsx";

/** What the device page shows for a user code: the check, the Workspaces on offer and the Toolsets. */
export type DeviceData = Awaited<ReturnType<ApiClient["oauth"]["checkDevice"]>>;

/**
 * Signing in a device (`/oauth/device`, RFC 8628's verification page): `webcraft login` shows the
 * person a short code and this address. They type the code, see which client asks, when and from
 * which network the sign-in was started, and a warning to approve only one they started themselves,
 * then choose what it may do, as for an AI client. The client's polling picks the approval up by
 * itself.
 *
 * A link may carry the code (`?user_code=…`). It is looked up only for a browser on the network the
 * sign-in was started from; anyone else types the code their own terminal shows, so a link someone
 * sent can't walk a person into approving that someone's sign-in.
 */
export function DevicePage({
	userCode,
	data,
	person,
}: {
	userCode: string | null;
	data: DeviceData | null;
	person: { name: string };
}) {
	const [outcome, setOutcome] = useState<{ kind: "approved" | "denied"; client: string } | null>(null);
	// The code the person typed here, looked up: it replaces what the link's code answered.
	const [typed, setTyped] = useState<DeviceData | null>(null);
	const shown = typed ?? data;
	const check = shown?.check ?? null;
	return (
		<main
			id="main"
			tabIndex={-1}
			className="bg-muted flex min-h-svh items-start justify-center p-4 outline-none sm:p-8"
		>
			<div className="bg-card text-card-foreground w-full max-w-xl rounded-xl border p-6 shadow-sm sm:p-8">
				{outcome ? (
					<Outcome outcome={outcome} />
				) : check?.kind === "ask" && shown ? (
					<DeviceApproval data={shown} request={check.request} person={person} onDone={setOutcome} />
				) : (
					<CodeEntry
						// A link's code that wasn't looked up isn't filled in either: the person types their own.
						userCode={check?.kind === "type" ? null : userCode}
						fromLink={check?.kind === "type"}
						problem={check?.kind === "refused" ? check.problem : null}
						onChecked={setTyped}
					/>
				)}
			</div>
		</main>
	);
}

const PROBLEMS: Record<"unknown" | "expired" | "decided", MessageKey> = {
	unknown: "oauth.device.unknown",
	expired: "oauth.device.expired",
	decided: "oauth.device.decided",
};

/** The code entry: the code the terminal shows, then Continue, which looks it up as typed. */
function CodeEntry({
	userCode,
	fromLink,
	problem,
	onChecked,
}: {
	userCode: string | null;
	/** The person arrived by a link whose code wasn't looked up: they are told to type their own. */
	fromLink: boolean;
	problem: "unknown" | "expired" | "decided" | null;
	onChecked(data: DeviceData): void;
}) {
	const t = useT();
	const id = useId();
	const [value, setValue] = useState(userCode ?? "");
	const [failure, setFailure] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const message = failure ?? (problem ? PROBLEMS[problem] : null);

	useEffect(() => {
		if (problem) input.current?.focus();
	}, [problem]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const typed = value.trim();
		if (!typed) {
			setFailure("oauth.device.codeRequired");
			input.current?.focus();
			return;
		}
		setBusy(true);
		setFailure(null);
		try {
			const api = await getApi();
			onChecked(await api.oauth.checkDevice({ userCode: typed, typed: true }));
		} catch (error) {
			setFailure(errorMessage(error));
		}
		setBusy(false);
		input.current?.focus();
	};

	return (
		<form onSubmit={submit} noValidate>
			<div className="mb-6 flex items-start gap-3">
				<TerminalIcon aria-hidden="true" className="text-muted-foreground mt-1 size-6 shrink-0" />
				<div className="grid gap-1">
					<h1 className="text-2xl font-semibold tracking-tight">{t("oauth.device.heading")}</h1>
					<p className="text-muted-foreground text-sm">
						{fromLink ? t("oauth.device.typeIt") : t("oauth.device.enterIntro")}
					</p>
				</div>
			</div>
			<FieldGroup className="gap-6">
				<Field data-invalid={message ? true : undefined}>
					<FieldLabel htmlFor={`${id}-code`}>{t("oauth.device.codeLabel")}</FieldLabel>
					<Input
						ref={input}
						id={`${id}-code`}
						name="user_code"
						value={value}
						onChange={(event) => setValue(event.target.value)}
						autoComplete="off"
						autoCapitalize="characters"
						spellCheck={false}
						aria-invalid={message ? true : undefined}
						aria-describedby={`${id}-help${message ? ` ${id}-error` : ""}`}
						className="font-mono tracking-widest uppercase"
					/>
					<FieldDescription id={`${id}-help`}>{t("oauth.device.codeHelp")}</FieldDescription>
					{message ? <FieldError id={`${id}-error`}>{t(message)}</FieldError> : null}
				</Field>
				<div className="flex justify-end">
					<Button type="submit" disabled={busy}>
						{t("oauth.device.continue")}
					</Button>
				</div>
			</FieldGroup>
		</form>
	);
}

type Request = Extract<DeviceData["check"], { kind: "ask" }>["request"];

function DeviceApproval({
	data,
	request,
	person,
	onDone,
}: {
	data: DeviceData;
	request: Request;
	person: { name: string };
	onDone(outcome: { kind: "approved" | "denied"; client: string }): void;
}) {
	const t = useT();
	const client = request.client;
	return (
		<ApprovalChoices
			clientName={client.name}
			workspaces={data.workspaces}
			toolsets={data.toolsets}
			heading={t("oauth.device.approveHeading", { client: client.name })}
			intro={t("oauth.device.approveIntro", { client: client.name, person: person.name })}
			details={
				<>
					<dt className="text-muted-foreground">{t("oauth.device.client")}</dt>
					<dd className="font-medium break-all">{client.name}</dd>
					<dt className="text-muted-foreground">{t("oauth.device.codeShown")}</dt>
					<dd className="font-mono tracking-widest">{request.userCode}</dd>
					<dt className="text-muted-foreground">{t("oauth.device.requested")}</dt>
					<dd>
						{request.sameNetwork
							? t("oauth.device.requestedHere", { time: formatUtc(request.requestedAt) })
							: request.network
								? t("oauth.device.requestedFrom", { time: formatUtc(request.requestedAt), network: request.network })
								: t("oauth.device.requestedUnknown", { time: formatUtc(request.requestedAt) })}
					</dd>
				</>
			}
			warning={`${t("oauth.device.nameUnchecked")} ${t("oauth.device.warning")}`}
			onApprove={async (choice) => {
				const api = await getApi();
				await api.oauth.approveDevice({ userCode: request.userCode, ...choice });
				onDone({ kind: "approved", client: client.name });
			}}
			onDeny={async () => {
				const api = await getApi();
				await api.oauth.denyDevice({ userCode: request.userCode });
				onDone({ kind: "denied", client: client.name });
			}}
		/>
	);
}

/** After the decision: what happens now, said as the page's heading (focused, so it is announced). */
function Outcome({ outcome }: { outcome: { kind: "approved" | "denied"; client: string } }) {
	const t = useT();
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => heading.current?.focus(), []);
	const approved = outcome.kind === "approved";
	const Icon = approved ? CircleCheckIcon : CircleXIcon;
	return (
		<div className="flex items-start gap-3">
			<Icon aria-hidden="true" className="text-muted-foreground mt-1 size-6 shrink-0" />
			<div className="grid gap-1">
				<h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
					{approved ? t("oauth.device.approvedHeading", { client: outcome.client }) : t("oauth.device.deniedHeading")}
				</h1>
				<p className="text-muted-foreground text-sm">
					{approved ? t("oauth.device.approvedBody") : t("oauth.device.deniedBody")}
				</p>
			</div>
		</div>
	);
}
