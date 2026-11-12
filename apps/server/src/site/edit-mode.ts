import { ORPCError } from "@orpc/server";
import { limitBody, MULTIPART_ALLOWANCE, toApiError } from "@webcraft/api";
import {
	type AdminLanguageCode,
	CODE_MODE_SCRIPT_PATH,
	CODE_MODE_STYLESHEET_PATH,
	CONSENT_CATEGORIES,
	componentSourceTarget,
	configureLayout,
	EDIT_MODE_PATH,
	type EditSession,
	editModePolicy,
	type FieldInput,
	getPageLayout,
	type InstallServices,
	isAdminLanguage,
	isCodeSelection,
	LIBRARIES_PER_SITE,
	MEDIA_TEXT_MAX_LENGTH,
	MediaTooLargeError,
	madeTexts,
	newComponentPlace,
	PASTE_MAX_LENGTH,
	type PageEditing,
	RateLimitedError,
	REVIEW_LIMITS,
	SCRIPT_MAX_LENGTH,
	type SiteHost,
	type SiteScope,
	treePath,
} from "@webcraft/core";
import { BODY_LIMITS } from "@webcraft/renderer";
import { z } from "zod";

import { clientAddress } from "../client-address.ts";
import en from "../messages/en.json" with { type: "json" };
import it from "../messages/it.json" with { type: "json" };
import { json, plainText } from "../responses.ts";
import { cookieValue, siteCookie, siteCookieName } from "./cookies.ts";
import { EDIT_ASSETS_PATH, editBarAssets } from "./edit-bar/assets.ts";

/**
 * Edit mode on a Site's own domain (ADR 0022), at the path the Install keeps for it,
 * `/_webcraft/edit/…`: following an "Edit on site" link sets the edit cookie. Answers null for
 * paths outside it.
 */
export async function editModeEndpoint(
	services: InstallServices,
	request: Request,
	host: SiteHost,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(EDIT_MODE_PATH)) return null;
	const rest = url.pathname.slice(EDIT_MODE_PATH.length);
	if (rest === "enter") {
		if (request.method !== "GET") return plainText(405, "Method Not Allowed", { allow: "GET" });
		return enter(services, request, host, url.searchParams.get("token") ?? "");
	}
	if (rest.startsWith(EDIT_API_PREFIX)) return editRequest(services, request, host, rest.slice(EDIT_API_PREFIX.length));
	if (url.pathname.startsWith(CODE_MODE_STYLESHEET_PATH)) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return plainText(405, "Method Not Allowed", { allow: "GET, HEAD" });
		}
		return codeModeStylesheet(services, request, host);
	}
	if (url.pathname.startsWith(CODE_MODE_SCRIPT_PATH)) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return plainText(405, "Method Not Allowed", { allow: "GET, HEAD" });
		}
		return codeModeScript(services, request, host, url.pathname.slice(CODE_MODE_SCRIPT_PATH.length));
	}
	if (url.pathname.startsWith(EDIT_ASSETS_PATH)) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return plainText(405, "Method Not Allowed", { allow: "GET, HEAD" });
		}
		return assetFile(request, url.pathname.slice(EDIT_ASSETS_PATH.length));
	}
	return plainText(404, "Not Found", { "x-robots-tag": "noindex" });
}

/**
 * The editing bar's words, by Admin language: the `editBar` part of the admin's message files, with
 * the presence wording it shares with Co-editing's own screens (who else is here, via a client or AI
 * translation, who published) read from `coEditing.*` instead of a second copy under `editBar.*`.
 */
const barWordsOf = (messages: typeof en) => ({
	...messages.editBar,
	pageLayout: messages.pageLayout,
	isHere: messages.coEditing.isHere,
	via: messages.coEditing.via,
	viaTranslation: messages.coEditing.viaTranslation,
	someone: messages.coEditing.someone,
	publishedBy: messages.coEditing.publishedBy,
	// The block editor's words, shared with the admin's (#79).
	body: messages.body,
	codeMode: { ...messages.editBar.codeMode, checks: messages.checks },
});
const BAR_WORDS: Record<AdminLanguageCode, ReturnType<typeof barWordsOf>> = { en: barWordsOf(en), it: barWordsOf(it) };

/** Where the editing bar sends edit requests, under `/_webcraft/edit/`: `api/<action>`. */
const EDIT_API_PREFIX = "api/";

/** The header edit requests carry the Edit mode session's header token in. */
export const EDIT_TOKEN_HEADER = "x-webcraft-edit-token";

/** What an edit request may do, by action: each gets the session and the request's JSON body. */
const EDIT_ACTIONS: Readonly<Record<string, EditAction>> = {
	/**
	 * Turns Code mode on for this browser (ADR 0016): its pages then show the Drafts of the Site's
	 * Structure, every element tagged. Only for someone who may change the Structure (`structure.edit`).
	 */
	"code/start": async (services, session, _body, request) => {
		await services.codeMode.access(session);
		const response = json(200, { code: true });
		const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - services.clock.now().getTime()) / 1000));
		response.headers.append("set-cookie", siteCookie(new URL(request.url).hostname, "code", "on", maxAge));
		return response;
	},
	/**
	 * Opens what an element comes from (by the reference the page tags it with): its Template or
	 * Component as Template markup, for Code mode's HTML panel.
	 */
	"code/editor": async (services, session, body, _request, host) => {
		const scope = await services.codeMode.access(session);
		return json(200, {
			...(await services.codeMode.editor(scope, host, parse(codeSource, body))),
			adminOrigin: services.config.adminOrigin,
		});
	},
	"code/historyDesign": async (services, session) => {
		const scope = await services.codeMode.access(session);
		return json(200, await services.builder.historyDesign(scope));
	},
	"code/transferHistory": async (services, session, body) => {
		const scope = await services.codeMode.access(session);
		const input = parse(z.object({ payload: z.string().max(8_000_000) }), body);
		return json(200, await services.builder.transferHistory(scope, input.payload));
	},
	"code/claimHistory": async (services, session, body) => {
		const scope = await services.codeMode.access(session);
		const input = parse(z.object({ token: z.string().max(100) }), body);
		return json(200, await services.builder.claimHistory(scope, input.token));
	},
	"code/reverseHistory": async (services, session, body) => {
		const scope = await services.codeMode.access(session);
		const input = parse(z.object({ resource: z.string().max(1000), from: z.json(), to: z.json() }), body);
		return json(200, await services.builder.reverseHistory(scope, input.resource, input.from, input.to));
	},
	/**
	 * What the Command menu needs in Code mode: the Permissions the person holds on the Site (checked
	 * with `can()`) and Go to's Pages, Entries by Post Type, Templates and Components.
	 */
	"code/commandMenu": async (services, session) => {
		const scope = await services.codeMode.access(session);
		return json(200, await services.builder.commandMenu(scope));
	},
	"code/editorService": async (services, session, body) => {
		const scope = await services.codeMode.access(session);
		const { method, input } = parse(
			z.object({
				method: z.enum([
					"classes.create",
					"classes.update",
					"media.list",
					"globals.get",
					"globals.setFields",
					"postTypes.get",
					"postTypes.update",
				]),
				input: z.unknown(),
			}),
			body,
		);
		switch (method) {
			case "classes.create":
				return json(
					200,
					await services.designSystem.createClass(scope, parse(z.object({ name: z.string().max(200) }), input)),
				);
			case "classes.update": {
				// Restyled from the Inspector, or renamed from the CSS panel (a Generated Class keeps its name unless renamed).
				const { classId, ...change } = parse(
					z
						.object({
							classId: designId,
							styles: z.string().max(CSS_MAX_LENGTH).optional(),
							name: z.string().max(200).optional(),
						})
						.refine((value) => value.styles !== undefined || value.name !== undefined),
					input,
				);
				return json(200, await services.designSystem.updateClass(scope, classId, change));
			}
			case "media.list":
				return json(
					200,
					await services.media.list(
						scope,
						parse(
							z.object({ search: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() }),
							input,
						),
					),
				);
			case "globals.get":
				return json(200, { globals: await services.globals.get(scope) });
			case "globals.setFields": {
				const { fields } = parse(z.object({ fields: z.array(z.unknown()).max(200) }), input);
				return json(200, { globals: await services.globals.setFields(scope, fields as FieldInput[]) });
			}
			case "postTypes.get": {
				const { postTypeId } = parse(z.object({ postTypeId: z.uuid() }), input);
				return json(200, { postType: await services.postTypes.get(scope, postTypeId) });
			}
			case "postTypes.update": {
				const { postTypeId, fields } = parse(
					z.object({ postTypeId: z.uuid(), fields: z.array(z.unknown()).max(200) }),
					input,
				);
				return json(200, {
					postType: await services.postTypes.update(scope, postTypeId, { fields: fields as FieldInput[] }),
				});
			}
		}
	},

	"code/editorMarkup": async (services, session, body, _request, host) => {
		const scope = await services.codeMode.access(session);
		return json(
			200,
			await services.codeMode.editorMarkup(
				scope,
				host,
				parse(
					codeSource.extend({
						draft: z.object({
							tree: z.unknown(),
							props: z.array(z.custom<FieldInput>()).optional(),
							styles: z.record(z.string().max(64), z.string().max(CSS_MAX_LENGTH)).optional(),
						}),
					}),
					body,
				),
			),
		);
	},
	"code/editorRead": async (services, session, body, _request, host) => {
		const scope = await services.codeMode.access(session);
		return json(
			200,
			await services.codeMode.editorRead(
				scope,
				host,
				parse(codeSource.extend({ markup: z.string().max(MARKUP_MAX_LENGTH) }), body),
			),
		);
	},

	"code/open": async (services, session, body, _request, host) => {
		const scope = await services.codeMode.access(session);
		return json(200, await services.codeMode.open(scope, host, parse(codeSource, body)));
	},
	/**
	 * The page as Code mode shows it with unsaved markup in place of its source's Draft, rendered by
	 * the server through the same parser as saving; nothing is saved.
	 */
	"code/preview": async (services, session, body, _request, host) => {
		const scope = await services.codeMode.access(session);
		const input = parse(codePreview, body);
		return json(200, await services.codeMode.preview(host, await pageEditing(session, scope), input));
	},
	/** Saves markup to its Template's or Component's Draft, based on the version it was opened at. */
	"code/save": async (services, session, body, _request, host) => {
		const scope = await services.codeMode.access(session);
		return json(200, await services.codeMode.save(scope, host, parse(codeSave, body)));
	},
	/** What the CSS panel shows for an element: its Classes with their uses, the breakpoints, the Site CSS and the tokens. */
	"code/css": async (services, session, body, _request, host) => {
		const scope = await services.codeMode.access(session);
		return json(200, await services.codeMode.css(scope, host, parse(codeCss, body)));
	},
	/** Saves a piece of a Class, or the Site CSS, to the Design system's Draft, based on the version it was opened at. */
	"code/saveCss": async (services, session, body) => {
		const scope = await services.codeMode.access(session);
		return json(200, await services.codeMode.saveCss(scope, parse(codeSaveCss, body)));
	},
	/**
	 * Make Component (#134): moves an element or Placement of a Template's or Component's Draft into a
	 * new Component, with Props for what it read there, and places it instead, in one step
	 * (`components.make`).
	 */
	"code/makeComponent": async (services, session, body) => {
		const scope = await services.codeMode.access(session);
		return json(200, await services.components.make(scope, parse(codeMakeComponent, body)));
	},
	/** New Component (#134): an empty Component, placed at the insert point when `place` is given (`components.create`). */
	"code/createComponent": async (services, session, body) => {
		const scope = await services.codeMode.access(session);
		const { place, ...input } = parse(codeCreateComponent, body);
		if (place) return json(200, await services.components.createPlaced(scope, input, place));
		return json(200, { component: await services.components.create(scope, input) });
	},
	/** Makes a Class of the Design system's Draft from a name the HTML panel doesn't know. */
	"code/createClass": async (services, session, body) => {
		const scope = await services.codeMode.access(session);
		return json(200, await services.codeMode.createClass(scope, parse(codeClassName, body).name));
	},
	/**
	 * The page's scripts for the JS panel: the Site script and the page's own, with their Drafts' files;
	 * with `ref` (the element selected), the Component script of its Placement, for the Component tab.
	 */
	"code/scripts": async (services, session, body, _request, host) => {
		const scope = await services.codeMode.access(session);
		const input = parse(codeScripts, body);
		return json(200, await services.codeMode.scripts(scope, host, input.path, input.ref));
	},
	/**
	 * Saves the Site script's, the page's script's or a Component script's Draft, based on the version
	 * it was opened at. It runs on the page only when Staff press Run, which loads the file this
	 * answers, or load the page.
	 */
	"code/saveScript": async (services, session, body, _request, host) => {
		const scope = await services.codeMode.access(session);
		const input = parse(codeSaveScript, body);
		if (input.kind === "component") {
			const { kind: _, path: __, ...change } = input;
			return json(200, await services.codeMode.saveComponentScript(scope, change));
		}
		return json(200, await services.codeMode.saveScript(scope, host, input));
	},
	/**
	 * Turns Safe mode on for this browser (ADR 0022): its pages in Edit mode run none of the Site's own
	 * scripts (its Libraries, Site script and page scripts), so a broken one can't lock anyone out.
	 */
	"safe/start": async (services, session, _body, request) => {
		const response = json(200, { safe: true });
		const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - services.clock.now().getTime()) / 1000));
		response.headers.append("set-cookie", siteCookie(new URL(request.url).hostname, SAFE_COOKIE, "on", maxAge));
		return response;
	},
	/** Turns Safe mode off for this browser: its pages run the Site's own scripts again. */
	"safe/stop": async (_services, _session, _body, request) => {
		const response = json(200, { safe: false });
		response.headers.append("set-cookie", siteCookie(new URL(request.url).hostname, SAFE_COOKIE, "", 0));
		return response;
	},
	/** Turns Code mode off for this browser: its pages are Content editing's again. */
	"code/stop": async (_services, _session, _body, request) => {
		const response = json(200, { code: false });
		response.headers.append("set-cookie", siteCookie(new URL(request.url).hostname, "code", "", 0));
		return response;
	},
	/** Saves a value typed in place to the Draft (a body's Blocks too, when the shared Draft isn't open). */
	save: async (services, session, body) => json(200, await services.editMode.save(session, parse(regionChange, body))),
	/** The block editor: a body's Blocks in the page's language, and the Blocks and Components it may add. */
	"body/get": async (services, session, body) =>
		json(200, await services.editMode.body(session, parse(bodyRegion, body))),
	/** What was pasted into a body, converted to Blocks (HTML, Markdown or plain text); nothing is saved. */
	"body/paste": async (services, session, body) =>
		json(200, await services.editMode.pasteBody(session, parse(bodyPaste, body))),
	/** Page details: the page's Entry's values that don't show on the page, with their fallbacks. */
	details: async (services, session, body) =>
		json(200, await services.editMode.details(session, parse(detailsItem, body))),
	/** Saves a change from Page details to the Draft. */
	"details/save": async (services, session, body) =>
		json(200, await services.editMode.saveDetails(session, parse(detailsChange, body))),
	/** The item form of one of a Loop's own items: its Fields and values in a language. */
	"loop/get": async (services, session, body) =>
		json(200, await services.editMode.loops.item(session, parse(loopItem, body))),
	/** Saves some of a Loop item's values in a language, as the item form sends them. */
	"loop/save": async (services, session, body) =>
		json(200, await services.editMode.loops.save(session, parse(loopItemValues, body))),
	/** Moves a Loop item to another place, in every language. */
	"loop/move": async (services, session, body) =>
		json(200, await services.editMode.loops.move(session, parse(loopMove, body))),
	/** Copies a Loop item right after it. */
	"loop/duplicate": async (services, session, body) =>
		json(200, await services.editMode.loops.duplicate(session, parse(loopItem, body))),
	/** Removes a Loop item, answering what puts it back (the undo). */
	"loop/remove": async (services, session, body) =>
		json(200, await services.editMode.loops.remove(session, parse(loopItem, body))),
	/** Puts back a Loop item removed in this session. */
	"loop/restore": async (services, session, body) =>
		json(200, await services.editMode.loops.restore(session, parse(loopRestore, body).restore)),
	/** Adds a Loop item after one, or first. */
	"loop/add": async (services, session, body) =>
		json(200, await services.editMode.loops.add(session, parse(loopAdd, body))),
	/** Where a query Loop's items (Entries) are changed: their own pages, or the admin's editor. */
	"loop/entries": async (services, session, body) =>
		json(200, await services.editMode.loops.entries(session, parse(loopEntries, body))),
	/** The image popover's Media library: the Site's images (a search, a folder, a page) and its folders. */
	"media/list": async (services, session, body) =>
		json(200, await services.editMode.media.list(session, parse(mediaQuery, body))),
	/** One image, its alt text in a language, and whether alt text can be suggested. */
	"media/get": async (services, session, body) => {
		const input = parse(mediaOne, body);
		return json(200, await services.editMode.media.get(session, input.media, input.language));
	},
	/** Changes an image's alt text in a language, or its Focal point: live at once, as in the library. */
	"media/update": async (services, session, body) => {
		const { media, ...change } = parse(mediaChange, body);
		return json(200, await services.editMode.media.update(session, media, change));
	},
	/** An AI provider's alt text for an image in a language; nothing is saved. */
	"media/suggestAlt": async (services, session, body) => {
		const input = parse(mediaOne, body);
		return json(200, await services.editMode.media.suggestAlt(session, input.media, input.language));
	},
	/** Puts a new image (or none) in an image region's media Field, in the Draft. */
	image: async (services, session, body) =>
		json(200, await services.editMode.saveImage(session, parse(imageChange, body))),
	/**
	 * What the editing bar shows for a page: its changes, the Site's pages, who is editing, and the
	 * bar's words in the person's Admin language.
	 */
	"layout/mediaGet": async (services, session, body) => {
		const input = parse(z.object({ mediaId: z.uuid() }), body);
		return json(200, { media: await services.media.get(session.scope, input.mediaId) });
	},
	"layout/media": async (services, session, body) =>
		json(
			200,
			await services.media.list(
				session.scope,
				parse(
					z.object({
						search: z.string().max(200).optional(),
						limit: z.number().int().min(1).max(100).optional(),
						offset: z.number().int().min(0).optional(),
					}),
					body,
				),
			),
		),
	"layout/get": async (_services, session, body) => {
		const input = parse(z.object({ entryId: z.uuid(), language: z.string().optional() }), body);
		return json(200, await getPageLayout(session.scope, input.entryId, input.language));
	},
	"layout/save": async (services, session, body) => {
		const input = parse(
			z.object({
				entryId: z.uuid(),
				language: z.string().optional(),
				layout: z.unknown(),
				basedOn: z.string().min(1).max(100),
			}),
			body,
		);
		return session.scope.transaction(async (tx) => {
			await services.entries.saveDraft(tx, input.entryId, {
				layout: input.layout,
				layoutBasedOn: input.basedOn,
			});
			return json(200, await getPageLayout(tx, input.entryId, input.language));
		});
	},
	"layout/configure": async (_services, session, body) =>
		json(
			200,
			await configureLayout(
				session.scope,
				parse(
					z.object({ enabled: z.boolean().optional(), allowedComponents: z.array(z.string()).max(1000).optional() }),
					body,
				),
			),
		),
	state: async (services, session, body, _request, host) => {
		const state = await services.editMode.pageState(session, host, parse(pagePath, body).path);
		const chosen = state.person.adminLanguage;
		const language = chosen && isAdminLanguage(chosen) ? chosen : (await services.settings.read()).defaultAdminLanguage;
		return json(200, { ...state, adminLanguage: language, words: BAR_WORDS[language] });
	},
	/** Undoes one of the page's changes. */
	undo: async (services, session, body, _request, host) =>
		json(200, await services.editMode.undo(session, host, parse(pageChange, body))),
	/** Discards every change of the page. */
	discard: async (services, session, body, _request, host) =>
		json(200, await services.editMode.discard(session, host, parse(pagePath, body).path)),
	/** Publishes the page's changes. */
	publish: async (services, session, body, _request, host) =>
		json(200, await services.editMode.publish(session, host, parse(pagePath, body).path)),
	/** Submits the page's changes for Review, with an optional note (GLOSSARY.md › Review). */
	"review/submit": async (services, session, body, _request, host) =>
		json(200, await services.editMode.submitForReview(session, host, parse(reviewSubmission, body))),
	/** Withdraws the page's Reviews the person submitted. */
	"review/withdraw": async (services, session, body, _request, host) =>
		json(200, await services.editMode.withdrawReview(session, host, parse(pagePath, body).path)),
	/** Ends Edit mode for this browser: the cookie is cleared and opens nothing any more. */
	end: async (services, session, _body, request) => {
		await services.editMode.end(session);
		const response = json(200, { ended: true });
		response.headers.append("set-cookie", clearEditCookie(request));
		response.headers.append("set-cookie", siteCookie(new URL(request.url).hostname, SAFE_COOKIE, "", 0));
		return response;
	},
};

type EditAction = (
	services: InstallServices,
	session: EditSession,
	body: unknown,
	request: Request,
	host: SiteHost,
) => Promise<Response>;

const pagePath = z.object({ path: z.string().max(2000) });

/** The page submitted for Review, with an optional note. */
const reviewSubmission = z.object({
	path: z.string().max(2000),
	note: z
		.string()
		.max(REVIEW_LIMITS.noteMax)
		.nullish()
		.transform((note) => note?.trim() || null),
});

/** A reference to what an element comes from, as pages in Code mode tag it (`data-wc-code`); null for the page's content. */
const codeRef = z.string().max(1000).nullable();

const codeSource = z.object({ path: z.string().max(2000), ref: codeRef });

/** Make Component and New Component (#134): the Management API's inputs, as Code mode sends them. */
const codeMakeComponent = z.object({
	name: z.string().max(200),
	source: componentSourceTarget,
	path: treePath,
	node: z.unknown(),
	texts: madeTexts.optional(),
});
const codeCreateComponent = z.object({ name: z.string().max(200), place: newComponentPlace.optional() });

/** The longest Template markup Code mode sends, in characters, as the Management API takes it. */
const MARKUP_MAX_LENGTH = 2_000_000;

/** A Draft's version as reading it answered, or null when there was none. */
const draftVersion = z
	.string()
	.regex(/^[0-9a-f]{16}$/)
	.nullable();

/** The longest CSS Code mode sends, in characters, as the Design system takes it. */
const CSS_MAX_LENGTH = 200_000;

/** The id of a Class or a breakpoint token. */
const designId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Which CSS a save or preview changes: one piece of a Class (its styles, own CSS, or a breakpoint's styles), or the Site CSS. */
const cssTarget = z.union([
	z.object({ kind: z.literal("class"), classId: designId, part: z.literal("styles") }),
	z.object({ kind: z.literal("class"), classId: designId, part: z.literal("css") }),
	z.object({ kind: z.literal("class"), classId: designId, part: z.literal("breakpoint"), breakpointId: designId }),
	z.object({ kind: z.literal("site") }),
]);

const codePreview = z.object({
	path: z.string().max(2000),
	markup: z.object({ ref: z.string().max(1000), text: z.string().max(MARKUP_MAX_LENGTH) }).optional(),
	css: z.object({ target: cssTarget, text: z.string().max(CSS_MAX_LENGTH) }).optional(),
});

const codeSaveCss = z.object({ target: cssTarget, text: z.string().max(CSS_MAX_LENGTH), version: draftVersion });

const codeClassName = z.object({ name: z.string().max(200) });

/**
 * What the CSS panel reads for an element: by the Classes its shared document gives it now (ids in
 * order, token utilities among them), else by its reference.
 */
const codeCss = codeSource.extend({ classes: z.array(z.string().max(200)).max(500).optional() });

const codeScripts = z.object({ path: z.string().max(2000), ref: z.string().max(1000).nullable().optional() });

const codeSaveScript = z.discriminatedUnion("kind", [
	z.object({
		path: z.string().max(2000),
		kind: z.enum(["site", "page"]),
		code: z.string().max(SCRIPT_MAX_LENGTH),
		version: draftVersion,
	}),
	z.object({
		path: z.string().max(2000),
		kind: z.literal("component"),
		componentId: z.string().uuid(),
		code: z.string().max(SCRIPT_MAX_LENGTH),
		consentCategory: z.enum(CONSENT_CATEGORIES).optional(),
		libraryIds: z.array(z.string().uuid()).max(LIBRARIES_PER_SITE).optional(),
		version: draftVersion,
	}),
]);

const codeSave = z.object({
	path: z.string().max(2000),
	ref: z.string().max(1000),
	markup: z.string().max(MARKUP_MAX_LENGTH),
	version: draftVersion,
});

const pageChange = z.object({ path: z.string().max(2000), item: z.string().max(100), key: z.string().max(200) });

const regionChange = z.object({
	item: z.string().max(100),
	field: z.string().max(200),
	/** Text, rich text's HTML, or a body's Blocks (the block editor's region). */
	value: z.union([z.string().max(200_000), z.array(z.unknown()).max(BODY_LIMITS.blocks), z.null()]),
	language: z.string().max(35).optional(),
});

const bodyRegion = z.object({
	item: z.string().max(100),
	field: z.string().max(200),
	language: z.string().max(35).optional(),
});

const bodyPaste = bodyRegion.extend({
	html: z.string().max(PASTE_MAX_LENGTH).optional(),
	text: z.string().max(PASTE_MAX_LENGTH).optional(),
});

const imageChange = z.object({
	item: z.string().max(100),
	field: z.string().max(200),
	media: z.string().max(100).nullable(),
	block: z.string().max(64).optional(),
	language: z.string().max(35).optional(),
});

const detailsItem = z.object({ item: z.string().max(100), language: z.string().max(35).optional() });

/** An SEO field as the drawer sends it: text, null or "" to clear it. */
const seoText = z.string().max(2000).nullable().optional();

const detailsChange = detailsItem.extend({
	title: z.string().max(2000).optional(),
	slug: z.string().max(200).optional(),
	seo: z
		.object({
			title: seoText,
			description: seoText,
			canonical: seoText,
			image: z.string().max(100).nullable().optional(),
			noindex: z.boolean().optional(),
		})
		.optional(),
	summary: z.string().max(200_000).nullable().optional(),
});

/** A Loop's id and one of its own items, by id. */
const loopItem = z.object({
	loop: z.string().max(100),
	item: z.string().max(64),
	language: z.string().max(35).optional(),
});

const loopItemValues = loopItem.extend({ values: z.record(z.string().max(100), z.unknown()) });

const loopMove = loopItem.extend({ to: z.number().int().min(0).max(1000) });

/** The Entries a page's query Loops show, at most as many as a page lists. */
const loopEntries = z.object({
	entries: z.array(z.string().max(100)).max(2000),
	language: z.string().max(35).optional(),
});

const loopAdd = z.object({ loop: z.string().max(100), after: z.string().max(64).nullable() });

/** What `loop/remove` answered to put the item back: at most a Loop item's worth of values. */
const loopRestore = z.object({ restore: z.string().max(2_000_000) });

const mediaId = z.string().max(100);

const mediaQuery = z.object({
	search: z.string().max(200).optional(),
	folderId: z.string().max(100).optional(),
	offset: z.number().int().min(0).max(100_000).optional(),
	language: z.string().max(35).optional(),
});

const mediaOne = z.object({ media: mediaId, language: z.string().max(35).optional() });

const mediaChange = z.object({
	media: mediaId,
	language: z.string().max(35).optional(),
	alt: z.string().max(MEDIA_TEXT_MAX_LENGTH.alt).nullable().optional(),
	focalPoint: z
		.object({ x: z.number().int().min(0).max(100), y: z.number().int().min(0).max(100) })
		.nullable()
		.optional(),
});

/** A body that isn't what the action takes. */
class BadEditRequest extends Error {}

function parse<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
	const parsed = schema.safeParse(body);
	if (!parsed.success) throw new BadEditRequest("The request isn't what this action takes.");
	return parsed.data;
}

/**
 * An edit request from the editing bar (ADR 0022). Each one is checked from scratch: it must be a
 * `POST` from the Site's own pages (its `Origin`, and `Sec-Fetch-Site` when the browser sends it),
 * carry an edit cookie whose session still holds (the admin session it came from, the person's
 * access to the Site, at most 8 hours), and that session's header token, which no other site can
 * read. Refusals answer JSON with a code, as the Management API does.
 */
async function editRequest(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	action: string,
): Promise<Response> {
	if (request.method !== "POST") return plainText(405, "Method Not Allowed", { allow: "POST" });
	if (!fromSitePages(request)) {
		return json(403, { code: "EDIT_REQUEST_REFUSED", message: "Edit requests must come from the Site's own pages." });
	}
	const edit = await editSessionOf(services, request, host);
	if (!edit.session) {
		const ended = json(401, { code: "EDIT_MODE_ENDED", message: "Edit mode has ended. Open it again from the admin." });
		if (edit.stale) ended.headers.append("set-cookie", clearEditCookie(request));
		return ended;
	}
	const token = request.headers.get(EDIT_TOKEN_HEADER) ?? "";
	if (!(await services.editMode.checkHeaderToken(edit.session, token))) {
		return json(403, { code: "EDIT_REQUEST_REFUSED", message: "The request has no valid Edit mode token." });
	}
	if (action === UPLOAD_ACTION) return refusalsAsJson(() => uploadMedia(services, edit.session, request));
	const answer = Object.hasOwn(EDIT_ACTIONS, action) ? EDIT_ACTIONS[action] : undefined;
	if (!answer) return json(404, { code: "NOT_FOUND", message: "There is no such edit request." });
	const session = edit.session;
	return refusalsAsJson(async () => {
		const contentType = request.headers.get("content-type") ?? "";
		if (!/^application\/json(;|$)/i.test(contentType)) throw new BadEditRequest("Send the request as JSON.");
		const body: unknown = await request.json().catch(() => {
			throw new BadEditRequest("The request isn't valid JSON.");
		});
		return answer(services, session, body, request, host);
	});
}

/** An edit request's answer, with refusals answered as the Management API words them: `{ code, message, data }`. */
async function refusalsAsJson(work: () => Promise<Response>): Promise<Response> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof BadEditRequest) return json(400, { code: "BAD_REQUEST", message: error.message });
		const refusal = toApiError(error);
		if (!(refusal instanceof ORPCError)) throw error;
		return json(refusal.status, { code: refusal.code, message: refusal.message, data: refusal.data });
	}
}

/** The edit request that uploads a file to the Site's Media library: a multipart body, not JSON. */
const UPLOAD_ACTION = "media/upload";

/**
 * Uploads a file from the image popover to the Site's Media library, as the admin's Media screen
 * does (`media.upload`): a multipart body with `file` and an optional `folderId`, kept to the Install's
 * largest file before it is read (a body that says it is larger is refused at once).
 */
async function uploadMedia(services: InstallServices, session: EditSession, request: Request): Promise<Response> {
	if (!/^multipart\/form-data(;|$)/i.test(request.headers.get("content-type") ?? "")) {
		throw new BadEditRequest("Send the file as multipart/form-data.");
	}
	const { maxFileBytes } = await services.settings.media();
	const refusal = () => new MediaTooLargeError(maxFileBytes);
	const limited = limitBody(request, maxFileBytes + MULTIPART_ALLOWANCE, refusal);
	if ("refused" in limited) throw limited.refused;
	const form = await limited.request.formData().catch(() => {
		throw limited.overflowed() ? refusal() : new BadEditRequest("The upload isn't a form with a file.");
	});
	const file = form.get("file");
	const folderId = form.get("folderId");
	if (!(file instanceof File)) throw new BadEditRequest("The upload has no file.");
	if (file.size > maxFileBytes) throw refusal();
	return json(
		200,
		await services.editMode.media.upload(session, {
			fileName: file.name,
			data: new Uint8Array(await file.arrayBuffer()),
			folderId: typeof folderId === "string" && folderId ? folderId : null,
		}),
	);
}

/**
 * Whether a request comes from the Site's own pages: its `Origin` is the Site's, and the browser
 * (when it says) calls it same-origin. Browsers send `Origin` with every `POST`, so a request without
 * one doesn't come from a page in Edit mode.
 */
function fromSitePages(request: Request): boolean {
	const fetchSite = request.headers.get("sec-fetch-site");
	if (fetchSite !== null && fetchSite !== "same-origin") return false;
	const origin = request.headers.get("origin");
	if (!origin) return false;
	try {
		return new URL(origin).host === new URL(request.url).host;
	} catch {
		return false;
	}
}

/**
 * One of the editing bar's files. Each is named by the hash of its content, so browsers keep it for
 * a year; it holds nothing about the Site or the person, so anyone may load it.
 */
async function assetFile(request: Request, name: string): Promise<Response> {
	const file = (await editBarAssets()).byName.get(name);
	if (!file) return plainText(404, "Not Found", { "x-robots-tag": "noindex" });
	return new Response(request.method === "HEAD" ? null : file.body, {
		headers: {
			"content-type": file.contentType,
			"cache-control": "public, max-age=31536000, immutable",
			"x-content-type-options": "nosniff",
			"x-robots-tag": "noindex",
		},
	});
}

/**
 * Whether a page request comes in Edit mode: the Edit mode session its edit cookie holds, checked
 * again (the admin session it came from, the person's access). `stale` when it carries an edit
 * cookie that no longer opens Edit mode: the answer clears it.
 */
export async function editSessionOf(
	services: InstallServices,
	request: Request,
	host: SiteHost,
): Promise<{ session: EditSession; stale: false } | { session: null; stale: boolean }> {
	const cookie = cookieValue(request, editCookieName(new URL(request.url).hostname));
	if (!cookie) return { session: null, stale: false };
	const session = await services.editMode.session(host, cookie);
	return session ? { session, stale: false } : { session: null, stale: true };
}

/**
 * Headers on every page in Edit mode: never kept by anyone, never indexed, never framed, under Edit
 * mode's strict policy (ADRs 0022, 0023: scripts and stylesheets only from the Site's own domain, so
 * no outside script runs with the person's edit session). A page's own answer gives the policy with
 * the Site's allowed hosts, which the Site's own scripts may call.
 */
export const EDIT_MODE_PAGE_HEADERS: Readonly<Record<string, string>> = {
	"cache-control": "no-store",
	"x-robots-tag": "noindex, nofollow",
	"referrer-policy": "same-origin",
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"content-security-policy": editModePolicy(),
};

/** The cookie that says a browser wants Safe mode: `webcraft.safe`, for the rest of the Edit mode session. */
const SAFE_COOKIE = "safe";

/** Whether the request asks for Safe mode (ADR 0022): its pages in Edit mode run none of the Site's own scripts. */
export function safeModeOf(request: Request): boolean {
	return cookieValue(request, siteCookieName(new URL(request.url).hostname, SAFE_COOKIE)) === "on";
}

/**
 * What a page needs to render for Edit mode: the person's scope, and WebCraft's files in <head>. With
 * `code` (the Site opened with `structure.edit`), the page is rendered for Code mode, which loads its
 * own script after the editing bar's. With `safe`, it runs none of the Site's own scripts (Safe mode).
 */
export async function pageEditing(session: EditSession, code?: SiteScope | null, safe = false): Promise<PageEditing> {
	const files = await editBarAssets();
	const safeMeta: [string, string][] = safe ? [["webcraft-safe-mode", "on"]] : [];
	if (code) {
		return {
			scope: code,
			code: true,
			safe,
			head: {
				meta: [["webcraft-edit-token", session.headerToken], ["webcraft-code-mode", "on"], ...safeMeta],
				scripts: [files.script.path, files.codeScript.path],
				stylesheets: [files.pageStyles.path],
			},
		};
	}
	return {
		scope: session.scope,
		safe,
		head: {
			meta: [["webcraft-edit-token", session.headerToken], ...safeMeta],
			scripts: [files.script.path],
			stylesheets: [files.pageStyles.path],
		},
	};
}

/**
 * The Site opened for Code mode when the request asks for it (its Code mode cookie) and the person
 * may change the Site's Structure; null otherwise, and the page is Content editing's.
 */
export async function codeModeOf(
	services: InstallServices,
	request: Request,
	session: EditSession,
): Promise<SiteScope | null> {
	if (cookieValue(request, siteCookieName(new URL(request.url).hostname, "code")) !== "on") return null;
	return services.codeMode.openIfAllowed(session);
}

/**
 * The Draft of one of the Site's scripts, as a page in Code mode runs it: only for Staff in Code mode,
 * never kept by anyone. A plain 404 for everyone else, and for any other name.
 */
async function codeModeScript(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	name: string,
): Promise<Response> {
	const edit = await editSessionOf(services, request, host);
	const scope = edit.session && (await services.codeMode.openIfAllowed(edit.session));
	const code = scope ? await services.codeMode.draftScript(scope, name) : null;
	if (code === null) return plainText(404, "Not Found", { "x-robots-tag": "noindex" });
	return new Response(request.method === "HEAD" ? null : code, {
		headers: {
			"content-type": "text/javascript; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-robots-tag": "noindex",
		},
	});
}

/**
 * The stylesheet a page in Code mode links, built from the Design system's Draft and the Drafts of
 * the Site's trees: only for Staff in Code mode, never kept by anyone. A plain 404 for everyone else.
 */
async function codeModeStylesheet(services: InstallServices, request: Request, host: SiteHost): Promise<Response> {
	const edit = await editSessionOf(services, request, host);
	const scope = edit.session && (await services.codeMode.openIfAllowed(edit.session));
	if (!scope) return plainText(404, "Not Found", { "x-robots-tag": "noindex" });
	const css = await services.codeMode.stylesheet(scope);
	return new Response(request.method === "HEAD" ? null : css, {
		headers: {
			"content-type": "text/css; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-robots-tag": "noindex",
		},
	});
}

/** A page in Edit mode, as HTML with Edit mode's headers (and the page's own policy, when given). */
export function editModeHtml(status: number, html: string, headers: Record<string, string> = {}): Response {
	return new Response(html, {
		status,
		headers: { "content-type": "text/html; charset=utf-8", ...EDIT_MODE_PAGE_HEADERS, ...headers },
	});
}

/** The `Set-Cookie` line that clears an edit cookie that no longer opens Edit mode. */
export function clearEditCookie(request: Request): string {
	return editCookie(new URL(request.url).hostname, "", 0);
}

/**
 * Follows an "Edit on site" link: uses it up, sets the edit cookie and sends the browser on to the
 * page, so the link's token never stays in the address bar or the history. A link that doesn't work
 * (used, expired, another Site's) says so plainly.
 */
async function enter(services: InstallServices, request: Request, host: SiteHost, token: string): Promise<Response> {
	const headers = { "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };
	try {
		// The link holds a token, so trying links is limited like signing in.
		await services.rateLimits.hit("auth", clientAddress(request, services.config));
	} catch (error) {
		if (!(error instanceof RateLimitedError)) throw error;
		return plainText(429, "Too many attempts. Wait a moment, then try again.", {
			...headers,
			"retry-after": String(error.retryAfterSeconds),
		});
	}
	const entered = token ? await services.editMode.enter(host, token) : null;
	const safe = new URL(request.url).searchParams.get("safe") === "1";
	if (!entered) {
		return plainText(
			403,
			"This Edit mode link has expired or was used already. Open Edit mode again from the admin.",
			headers,
		);
	}
	const query = new URL(request.url).searchParams;
	const code = query.get("code") === "1";
	if (code) {
		const session = await services.editMode.session(host, entered.cookie);
		if (!session) return plainText(403, "Code mode is unavailable.", headers);
		if (!(await services.codeMode.openIfAllowed(session)))
			return plainText(403, "Code mode needs permission to edit Structure.", headers);
	}
	const selection = query.get("selection");
	const history = new URL(request.url).searchParams.get("history");
	const selected =
		code && selection && isCodeSelection(selection) ? `#wc-selection=${encodeURIComponent(selection)}` : "";
	const hostname = new URL(request.url).hostname;
	const maxAge = Math.max(0, Math.floor((entered.expiresAt.getTime() - services.clock.now().getTime()) / 1000));
	const answer = new Response(null, {
		status: 303,
		headers: {
			location:
				entered.path +
				selected +
				(history && /^[A-Za-z0-9_-]{43}$/.test(history) ? `${selected ? "&" : "#"}wc-history=${history}` : ""),
			"cache-control": "no-store",
			...headers,
		},
	});
	answer.headers.append("set-cookie", editCookie(hostname, entered.cookie, maxAge));
	if (code) answer.headers.append("set-cookie", siteCookie(hostname, "code", "on", maxAge));
	// A link opened from "Edit in Safe mode" starts Safe mode; any other link ends it.
	if (safe) answer.headers.append("set-cookie", siteCookie(hostname, SAFE_COOKIE, "on", maxAge));
	else if (safeModeOf(request)) answer.headers.append("set-cookie", siteCookie(hostname, SAFE_COOKIE, "", 0));
	return answer;
}

/**
 * The edit cookie's name: with the `__Host-` prefix (only this hostname, `Secure`, path `/`), except
 * on a plain-HTTP development hostname under `.localhost`. It is named `webcraft.…` like every cookie
 * WebCraft sets on a Site's domain, so Modules' Site routes never see it (`isWebCraftCookie`).
 */
export function editCookieName(hostname: string): string {
	return siteCookieName(hostname, "edit");
}

/** The `Set-Cookie` line for the edit cookie: `HttpOnly`, `Secure` (but in development), `SameSite=Lax`. */
function editCookie(hostname: string, value: string, maxAge: number): string {
	return siteCookie(hostname, "edit", value, maxAge);
}
