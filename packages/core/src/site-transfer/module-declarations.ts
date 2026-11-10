/** Source declarations travel with stored Props; a destination Module may be absent or have changed. */
import { MODULE_ID } from "@webcraft/module-sdk";
import type pg from "pg";
import semver from "semver";
import { z } from "zod";
import { isComponentName, RESERVED_PROP_KEYS } from "../content/components.ts";
import type { ContentProblem } from "../content/errors.ts";
import { type FieldDefinition, type FieldInput, parseFields } from "../content/fields.ts";

// Reuse the Field parser, including its depth/count/type limits. No Template markup or Module code
// comes from an archive; these declarations only describe the values already stored in its Props.
const propsSchema = z.unknown().transform((value, context): FieldDefinition[] => {
	try {
		if (!Array.isArray(value)) throw new Error("Props must be a list.");
		const problems: ContentProblem[] = [];
		const fields = parseFields(value as FieldInput[], problems, {
			postTypeKeys: new Set(),
			owner: "moduleComponent",
			reservedKeys: RESERVED_PROP_KEYS,
			listName: "props",
		});
		if (problems.length) throw new Error(problems[0]?.message);
		return fields;
	} catch {
		context.addIssue({ code: "custom", message: "Invalid Module Component Field declarations." });
		return z.NEVER;
	}
});

export const moduleComponentDeclarationSchema = z
	.object({
		id: z.string().max(200),
		moduleId: z.string().min(2).max(32).regex(MODULE_ID),
		version: z.string().refine((value) => semver.valid(value) !== null),
		props: propsSchema,
	})
	.refine(
		(value) => value.id.startsWith(`${value.moduleId}:`) && isComponentName(value.id.slice(value.moduleId.length + 1)),
	);

export type ModuleComponentDeclaration = z.infer<typeof moduleComponentDeclarationSchema>;

export function modulePropFields(
	declarations: readonly ModuleComponentDeclaration[],
): ReadonlyMap<string, readonly FieldDefinition[]> {
	return new Map(declarations.map((component) => [component.id, component.props]));
}

/** Retained source contracts win over a different installed version when re-exporting imported data. */
export async function exportModuleDeclarations(
	client: pg.ClientBase,
	site: { workspaceId: string; id: string },
	current: readonly ModuleComponentDeclaration[],
): Promise<ModuleComponentDeclaration[]> {
	const result = await client.query<{
		component_id: string;
		module_id: string;
		module_version: string;
		props: FieldDefinition[];
	}>(
		"SELECT component_id, module_id, module_version, props FROM public.site_module_components WHERE workspace_id = $1 AND site_id = $2 ORDER BY component_id",
		[site.workspaceId, site.id],
	);
	const declarations = new Map(current.map((component) => [component.id, component]));
	for (const row of result.rows)
		declarations.set(row.component_id, {
			id: row.component_id,
			moduleId: row.module_id,
			version: row.module_version,
			props: row.props,
		});
	return [...declarations.values()];
}

/** Durable Site metadata, saved in the import transaction, independent of the expiring job report. */
export async function retainModuleDeclarations(
	client: pg.ClientBase,
	site: { workspaceId: string; id: string },
	declarations: readonly ModuleComponentDeclaration[],
): Promise<void> {
	for (const component of declarations)
		await client.query(
			"INSERT INTO public.site_module_components (workspace_id, site_id, component_id, module_id, module_version, props) VALUES ($1, $2, $3, $4, $5, $6)",
			[site.workspaceId, site.id, component.id, component.moduleId, component.version, JSON.stringify(component.props)],
		);
}
