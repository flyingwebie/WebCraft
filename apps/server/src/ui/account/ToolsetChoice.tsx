import { FieldDescription, FieldError, FieldLegend, FieldSet } from "@webcraft/ui/components/field.tsx";
import { TriangleAlertIcon } from "lucide-react";
import { useId } from "react";

import { type MessageKey, useT } from "../i18n.tsx";

/** One Toolset on offer, as `apiTokens.list` and `oauth.check` answer it. */
export type OfferedToolset = { key: string; module: { id: string; name: string } | null; optIn: boolean };

/** WebCraft's own Toolsets, named and described by the admin's messages. */
const NAMED: Record<string, { label: MessageKey; description: MessageKey }> = {
	content: { label: "toolsets.content.label", description: "toolsets.content.description" },
	media: { label: "toolsets.media.label", description: "toolsets.media.description" },
	structure: { label: "toolsets.structure.label", description: "toolsets.structure.description" },
	forms: { label: "toolsets.forms.label", description: "toolsets.forms.description" },
	publishing: { label: "toolsets.publishing.label", description: "toolsets.publishing.description" },
	translation: { label: "toolsets.translation.label", description: "toolsets.translation.description" },
	siteSettings: { label: "toolsets.siteSettings.label", description: "toolsets.siteSettings.description" },
	analytics: { label: "toolsets.analytics.label", description: "toolsets.analytics.description" },
	submissions: { label: "toolsets.submissions.label", description: "toolsets.submissions.description" },
};

/** The Toolsets a new client starts with: every one offered but those that are opt-in. */
export function defaultToolsets(offered: readonly OfferedToolset[]): Set<string> {
	return new Set(offered.filter((toolset) => !toolset.optIn).map((toolset) => toolset.key));
}

/** A Toolset's name in the admin's language. */
export function useToolsetName(): (key: string, offered?: readonly OfferedToolset[]) => string {
	const t = useT();
	return (key, offered) => {
		const named = NAMED[key];
		if (named) return t(named.label);
		const module = offered?.find((toolset) => toolset.key === key)?.module;
		return module?.name ?? key.replace(/^m\./, "");
	};
}

/**
 * Choosing the Toolsets a client may use: a checkbox each, with what it covers. Opt-in Toolsets
 * (Submissions) start off and carry a warning, shown again plainly once ticked.
 */
export function ToolsetChoice({
	offered,
	chosen,
	onChange,
	problem,
}: {
	offered: readonly OfferedToolset[];
	chosen: ReadonlySet<string>;
	onChange: (chosen: Set<string>) => void;
	problem?: MessageKey | null;
}) {
	const t = useT();
	const id = useId();
	const nameOf = useToolsetName();
	return (
		<FieldSet data-invalid={problem ? true : undefined}>
			<FieldLegend variant="label">{t("toolsets.legend")}</FieldLegend>
			<FieldDescription id={`${id}-help`}>{t("toolsets.help")}</FieldDescription>
			<div className="flex flex-col gap-3">
				{offered.map((toolset) => {
					const named = NAMED[toolset.key];
					const description = named
						? t(named.description)
						: t("toolsets.moduleDescription", { module: nameOf(toolset.key, offered) });
					const ticked = chosen.has(toolset.key);
					return (
						<div key={toolset.key} className="flex flex-col gap-1">
							<label className="flex items-start gap-2 text-sm">
								<input
									type="checkbox"
									checked={ticked}
									onChange={(event) => {
										const next = new Set(chosen);
										if (event.target.checked) next.add(toolset.key);
										else next.delete(toolset.key);
										onChange(next);
									}}
									aria-describedby={`${id}-${toolset.key}-about${toolset.optIn ? ` ${id}-${toolset.key}-warning` : ""}`}
									className="accent-primary mt-0.5 size-4 shrink-0"
								/>
								<span className="flex flex-col">
									<span className="font-medium">{nameOf(toolset.key, offered)}</span>
									<span id={`${id}-${toolset.key}-about`} className="text-muted-foreground text-xs">
										{description}
									</span>
								</span>
							</label>
							{toolset.optIn ? (
								<p
									id={`${id}-${toolset.key}-warning`}
									className={
										ticked
											? "border-destructive/40 bg-destructive/5 text-foreground ms-6 flex gap-2 rounded-md border p-2 text-xs"
											: "text-muted-foreground ms-6 flex gap-2 text-xs"
									}
								>
									<TriangleAlertIcon aria-hidden="true" className="text-destructive size-4 shrink-0" />
									{t("toolsets.submissionsWarning")}
								</p>
							) : null}
						</div>
					);
				})}
			</div>
			{problem ? <FieldError>{t(problem)}</FieldError> : null}
		</FieldSet>
	);
}
