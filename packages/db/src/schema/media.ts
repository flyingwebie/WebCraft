import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites, workspaces } from "./tenancy.ts";

// The Media library (`@webcraft/core` › media). Folders, Media items and their stored files are Site
// data: each carries `workspace_id` and `site_id`, with a foreign key to `sites (workspace_id, id)`.
// The files themselves are in the Install's storage (local disk or an S3-compatible bucket), one
// folder per Workspace and Site; these tables say where each one is (ADRs 0026, 0027).

/** A Site's Media library folders. Names are unique on the Site, whatever their case. */
export const mediaFolders = pgTable(
	"media_folders",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		name: text("name").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "media_folders_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("media_folders_site_id_id_unique").on(table.siteId, table.id),
		uniqueIndex("media_folders_site_id_name_unique").on(table.siteId, sql`lower(${table.name})`),
	],
);

/**
 * Media items: one uploaded file each, as people see it in the Media library. Its title, alt text
 * and caption are stored per language in `texts` (ADR 0003). An image is `processing` until the
 * worker has made its cleaned original, then `ready`; `failed` when it couldn't be read.
 */
export const media = pgTable(
	"media",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The folder it is filed in; null for none. */
		folderId: uuid("folder_id"),
		/** `image`, `document`, `video` or `audio`. */
		kind: text("kind").notNull(),
		/** The file's name as it was uploaded. */
		fileName: text("file_name").notNull(),
		/** The type of the original visitors get (a HEIC photo's is `image/jpeg` once converted). */
		contentType: text("content_type").notNull(),
		sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
		/** The original's size in pixels, upright; null for files that aren't images, or until processed. */
		width: integer("width"),
		height: integer("height"),
		status: text("status").notNull(),
		/** Title, alt text and caption, per language: `{ values: { alt: { en: { value, by } } } }`. */
		texts: jsonb("texts").notNull().default(sql`'{"values":{}}'::jsonb`),
		/** Who uploaded it; null once that person is deleted. */
		uploadedBy: uuid("uploaded_by").references(() => people.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		/**
		 * When it went to the Trash, and who put it there; null while it is in the library. A file in the
		 * Trash isn't served or shown on pages, and is deleted for good 30 days later.
		 */
		trashedAt: timestamp("trashed_at", { withTimezone: true }),
		trashedBy: uuid("trashed_by").references(() => people.id, { onDelete: "set null" }),
		/** An image's Focal point, as percentages of its width and height (0 to 100); null for none. */
		focalX: integer("focal_x"),
		focalY: integer("focal_y"),
		/**
		 * Why the worker refused the file (`failed`), or the file meant to replace it (the item keeps
		 * its own): `{ reason, replacement?, found? }`. Null when nothing was refused.
		 */
		failure: jsonb("failure"),
	},
	(table) => [
		foreignKey({
			name: "media_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		// A folder of the same Site; folders are emptied before they are deleted.
		foreignKey({
			name: "media_folder_fkey",
			columns: [table.siteId, table.folderId],
			foreignColumns: [mediaFolders.siteId, mediaFolders.id],
		}),
		unique("media_site_id_id_unique").on(table.siteId, table.id),
		index("media_site_id_created_at_index").on(table.siteId, table.createdAt),
		index("media_site_id_trashed_at_index").on(table.siteId, table.trashedAt),
		check("media_kind_known", sql`${table.kind} in ('image', 'document', 'video', 'audio')`),
		check("media_status_known", sql`${table.status} in ('processing', 'ready', 'failed')`),
		check(
			"media_focal_point_known",
			sql`(${table.focalX} is null and ${table.focalY} is null) or (${table.focalX} between 0 and 100 and ${table.focalY} between 0 and 100)`,
		),
	],
);

/**
 * The stored files of a Media item: the raw `upload` (private, until the worker has cleaned an
 * image), the `original` visitors get, and its `variant`s (AVIF and WebP widths). `name` is how an
 * original or variant is served, `/_media/<name>`: its content hash and a readable name. `storage`
 * says which storage holds it (`disk` or `s3`), so changing the Install's storage never breaks a URL.
 */
export const mediaFiles = pgTable(
	"media_files",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		mediaId: uuid("media_id").notNull(),
		role: text("role").notNull(),
		name: text("name").notNull(),
		/** `jpeg`, `png`, `webp`, `avif`, `gif`, `heic`, `pdf`, `mp4`, … */
		format: text("format").notNull(),
		contentType: text("content_type").notNull(),
		width: integer("width"),
		height: integer("height"),
		sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
		storage: text("storage").notNull(),
		/** Where the storage keeps it: `<workspace id>/<site id>/media/<name>`. */
		key: text("key").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/**
		 * When Replace file put another file in its place: it is still served under its name for 30
		 * days, for pages loaded before, then deleted. Null for the item's current files.
		 */
		retiredAt: timestamp("retired_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "media_files_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "media_files_media_fkey",
			columns: [table.siteId, table.mediaId],
			foreignColumns: [media.siteId, media.id],
		}).onDelete("cascade"),
		index("media_files_site_id_name_index").on(table.siteId, table.name),
		index("media_files_media_id_index").on(table.mediaId),
		// Identical bytes uploaded twice share one stored file: it is removed only once no row names it.
		index("media_files_key_index").on(table.key),
		check("media_files_role_known", sql`${table.role} in ('upload', 'original', 'variant')`),
		check("media_files_storage_known", sql`${table.storage} in ('disk', 's3')`),
	],
);

/**
 * Where the Install stores Media: one row, with id 1, written when the Superadmin first changes it;
 * until then local disk. The S3 settings stay when the Install switches back to disk, so files kept
 * in the bucket can still be read. The bucket's secret access key is a secret
 * (`storage.s3.secretAccessKey` of the Install), never stored here.
 */
export const installStorage = pgTable(
	"install_storage",
	{
		id: integer("id").primaryKey().default(1),
		/** `disk` or `s3`: where new files go. */
		kind: text("kind").notNull().default("disk"),
		s3Endpoint: text("s3_endpoint"),
		s3Region: text("s3_region"),
		s3Bucket: text("s3_bucket"),
		/** Put in front of every key, so one bucket can hold several Installs. */
		s3Prefix: text("s3_prefix").notNull().default(""),
		/** Path-style addresses (`<endpoint>/<bucket>/<key>`), which self-hosted stores need. */
		s3PathStyle: boolean("s3_path_style").notNull().default(true),
		s3AccessKeyId: text("s3_access_key_id"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [
		check("install_storage_single_row", sql`${table.id} = 1`),
		check("install_storage_kind_known", sql`${table.kind} in ('disk', 's3')`),
	],
);

/**
 * A Workspace's Media storage quota, set by Staff: the most bytes its Sites' Media may take in the
 * Install's storage (identical files stored once counted once). Uploads that would go past it are
 * refused. `warned_at` is when the Workspace was last told it passed 80%; cleared once it is back
 * under, so the next time it passes 80% it is told again. No row: no quota.
 */
export const mediaQuotas = pgTable(
	"media_quotas",
	{
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull(),
		warnedAt: timestamp("warned_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [
		primaryKey({ columns: [table.workspaceId] }),
		check("media_quotas_positive", sql`${table.quotaBytes} > 0`),
	],
);
