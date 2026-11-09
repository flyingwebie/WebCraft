// The sample board: a Workspace-level Module, off until Staff switch it on in a Workspace. Its pins
// are Workspace data.
import {
	defineModule,
	desc,
	moduleSchema,
	procedure,
	text,
	timestamp,
	uuid,
	workspaceColumns,
	z,
} from "@webcraft/module-sdk";

const schema = moduleSchema("sample-board");

export const pins = schema.table("pins", {
	...workspaceColumns(),
	id: uuid("id").primaryKey().defaultRandom(),
	text: text("text").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const sampleBoard = defineModule({
	manifest: {
		id: "sample-board",
		name: { en: "Sample board" },
		description: { en: "Pins short messages to a Workspace." },
		version: "1.0.0",
		sdk: "^1.0.0",
		level: "workspace",
		onByDefault: false,
		adminLanguages: ["en"],
		permissions: [{ key: "pins.edit", label: { en: "Pin messages" }, roles: ["staff", "owner"] }],
	},
	tables: [pins],
	migrations: [
		{
			name: "0001-pins",
			sql: `
CREATE TABLE pins (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	text text NOT NULL,
	created_at timestamp with time zone NOT NULL
);
`,
		},
	],
	procedures: {
		pins: {
			list: procedure({
				permission: "workspace.view",
				kind: "read",
				input: z.object({}),
				async run(_input, context) {
					return { pins: await context.data.select(pins, undefined, { orderBy: [desc(pins.createdAt)] }) };
				},
			}),
			add: procedure({
				permission: "pins.edit",
				input: z.object({ text: z.string().trim().min(1).max(200) }),
				async run({ text: body }, context) {
					return { pin: await context.data.insert(pins, { text: body, createdAt: context.now() }) };
				},
			}),
		},
	},
	adminPages: [{ path: "board", label: { en: "Board" }, permission: "workspace.view" }],
});
