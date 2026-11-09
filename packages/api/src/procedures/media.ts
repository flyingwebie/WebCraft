import { MEDIA_FOLDER_NAME_MAX_LENGTH, MEDIA_KINDS, MEDIA_TEXT_MAX_LENGTH, MediaTooLargeError } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** A language tag, such as `en`; the Site decides which it has. */
const language = z.string().min(2).max(35);

/** A text of a Media item in one language; null clears it. */
const mediaText = (max: number) => z.string().max(max).nullable();

const folderName = z.string().trim().min(1).max(MEDIA_FOLDER_NAME_MAX_LENGTH);

/**
 * A Site's Media library: Content, with no Draft. Everyone who reaches the Site sees it and uploads
 * to it (`media.upload`); Authors change only their own uploads, while Editors, Owners and Staff
 * (`media.manage`) change every file and the folders.
 */
export const media = {
	/** The files of the library, newest first: in a folder (`none` for no folder), matching a search, of a kind. */
	list: signedIn
		.input(
			z.object({
				siteId: id,
				folderId: z.union([id, z.literal("none")]).optional(),
				search: z.string().max(200).optional(),
				kind: z.enum(MEDIA_KINDS).optional(),
				language: language.optional(),
				limit: z.number().int().min(1).max(200).optional(),
				offset: z.number().int().min(0).optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			const { siteId: _, ...query } = input;
			return context.services.media.list(site, query);
		}),

	/** What the library takes and holds: the largest file, the Workspace's storage, the Trash. */
	overview: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "site.view");
		return context.services.media.overview(site);
	}),

	/** One file, with its texts in a language (the Site's Default language unless given). */
	get: signedIn
		.input(z.object({ siteId: id, mediaId: id, language: language.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return { media: await context.services.media.get(site, input.mediaId, input.language) };
		}),

	/**
	 * Uploads a file: an image (JPEG, PNG, WebP, AVIF, HEIC, GIF, SVG), a PDF, video or audio, at most
	 * the Install's largest file (50 MB unless the Superadmin sets another). What it is comes from its
	 * bytes, never its name. Images are cleaned by the worker before
	 * anyone can see them (`status: "processing"` until then); other files are served at once.
	 */
	upload: signedIn
		.input(z.object({ siteId: id, file: z.instanceof(File), folderId: id.nullable().optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "media.upload");
			const { maxFileBytes } = await context.services.settings.media();
			if (input.file.size > maxFileBytes) throw new MediaTooLargeError(maxFileBytes);
			const data = new Uint8Array(await input.file.arrayBuffer());
			return {
				media: await context.services.media.upload(site, {
					fileName: input.file.name,
					data,
					folderId: input.folderId,
				}),
			};
		}),

	/**
	 * Changes a file's title, alt text or caption (in a language), or its folder. Your own uploads with
	 * `media.upload`; every file with `media.manage`. Live at once: pages showing it change too.
	 */
	update: signedIn
		.input(
			z.object({
				siteId: id,
				mediaId: id,
				language: language.optional(),
				title: mediaText(MEDIA_TEXT_MAX_LENGTH.title).optional(),
				alt: mediaText(MEDIA_TEXT_MAX_LENGTH.alt).optional(),
				caption: mediaText(MEDIA_TEXT_MAX_LENGTH.caption).optional(),
				folderId: id.nullable().optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "media.upload");
			const { siteId: _, mediaId, ...change } = input;
			return { media: await context.services.media.update(site, mediaId, change) };
		}),

	/** The library's folders. */
	folders: {
		/** Every folder, by name, with how many files each holds; `total` counts every file. */
		list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "site.view");
			return context.services.media.folders.list(site);
		}),

		create: signedIn.input(z.object({ siteId: id, name: folderName })).handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "media.manage");
			return { folder: await context.services.media.folders.create(site, input.name) };
		}),

		rename: signedIn
			.input(z.object({ siteId: id, folderId: id, name: folderName }))
			.handler(async ({ context, input }) => {
				const site = await context.services.data.site(context.access, input.siteId, "media.manage");
				return { folder: await context.services.media.folders.rename(site, input.folderId, input.name) };
			}),

		/** Deletes a folder; its files stay in the library, in no folder. */
		delete: signedIn.input(z.object({ siteId: id, folderId: id })).handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "media.manage");
			await context.services.media.folders.delete(site, input.folderId);
			return {};
		}),
	},
};
