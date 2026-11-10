// The Content API as frontends built elsewhere use it (ADR 0029): `GET /_content/v1/…` on a Site's
// domains and its Staging address, with a Content key in the `Authorization` header, from a server
// (no `Origin`) or from a browser on another site (`Origin`, after a CORS preflight).
import { fromAddress, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

/** A frontend reading one Site's Content API from one client address. */
export type ContentClient = {
	/** Sends `GET <origin>/_content/v1<path>` with the key (unless `init` sets `authorization`). */
	get(path: string, init?: RequestInit): Promise<Response>;
	/** `get`, then the answer's JSON (and the response). */
	json<Body = Record<string, unknown>>(path: string, init?: RequestInit): Promise<{ response: Response; body: Body }>;
	/** Sends any request to `<origin>/_content/v1<path>`, without the key unless `init` sets one. */
	request(path: string, init?: RequestInit): Promise<Response>;
	/** The client address it sends from. */
	address: string;
};

let addresses = 0;

/** A frontend's client for the Content API at `origin`, sending `key` (none for null), from an address of its own. */
export function contentClient(
	install: TestInstall,
	origin: string,
	key: string | null,
	options: { address?: string } = {},
): ContentClient {
	const address = options.address ?? `198.18.${(++addresses >> 8) & 255}.${addresses & 255}`;
	const request = (path: string, init: RequestInit = {}) =>
		install.request(fromAddress(new Request(`${origin}/_content/v1${path}`, init), address));
	const get = (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		if (key !== null && !headers.has("authorization")) headers.set("authorization", `Bearer ${key}`);
		return request(path, { ...init, headers });
	};
	return {
		get,
		request,
		address,
		async json<Body>(path: string, init?: RequestInit) {
			const response = await get(path, init);
			const text = await response.text();
			return { response, body: (text === "" ? undefined : JSON.parse(text)) as Body };
		},
	};
}

/** A Site with a Content API, as the Content API tests read it: a bakery in English and French. */
export type Bakery = {
	workspaceId: string;
	siteId: string;
	/** Its Primary domain's origin, where visitors and frontends find it. */
	origin: string;
	staff: TestBrowser;
	/** A working Content key of the Site (no origins). */
	key: string;
	recipesId: string;
	categoriesId: string;
	/** Entry ids by title. */
	ids: Record<string, string>;
	/** A frontend sending the key from an address of its own. */
	frontend(options?: { address?: string }): ContentClient;
	/** Creates and publishes an Entry, answering its id. */
	publish(postTypeId: string, title: string, values?: Record<string, unknown>): Promise<string>;
};

/**
 * Makes a bakery: Staff, the Site live on its Primary domain in English (Default) and French, its
 * Content API on with one key, and two Post Types: `categories` (a colour) and `recipes`, whose Fields
 * cover every kind a list filters or sorts by, a Relationship to `categories` and one to `recipes`, a
 * Group, a Repeater, a media Field and a Body field. Each Entry is published one minute after the
 * one before, so the newest first is the reverse of the order they are made in.
 */
export async function bakery(install: TestInstall, slug: string): Promise<Bakery> {
	const workspaceId = (await install.createWorkspace(`Workspace ${slug}`)).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const origin = await goLive(install, siteId);
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	await staff.api.languages.add({ siteId, code: "fr" });
	const categoriesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Categories",
			key: "categories",
			urlPattern: "/categories/{slug}",
			fields: [{ key: "colour", label: "Colour", type: "text" }],
		})
	).postType.id;
	const recipesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Recipes",
			key: "recipes",
			urlPattern: "/recipes/{slug}",
			fields: [
				{ key: "body", label: "Body", type: "body" },
				{ key: "summary", label: "Summary", type: "text" },
				{ key: "price", label: "Price", type: "number" },
				{ key: "vegan", label: "Vegan", type: "boolean" },
				{ key: "bakedOn", label: "Baked on", type: "date", mode: "date" },
				{
					key: "kind",
					label: "Kind",
					type: "select",
					options: [
						{ value: "bread", label: "Bread" },
						{ value: "pastry", label: "Pastry" },
						{ value: "cake", label: "Cake" },
					],
				},
				{ key: "chef", label: "Chef's email", type: "email" },
				{ key: "notes", label: "Notes", type: "richText" },
				{ key: "category", label: "Category", type: "relationship", postTypes: ["categories"] },
				{ key: "pairsWith", label: "Pairs with", type: "relationship", postTypes: ["recipes"], multiple: true },
				{ key: "photo", label: "Photo", type: "media" },
				{
					key: "origin",
					label: "Origin",
					type: "group",
					fields: [
						{ key: "city", label: "City", type: "text" },
						{ key: "secret", label: "Secret", type: "text" },
					],
				},
				{ key: "steps", label: "Steps", type: "repeater", fields: [{ key: "text", label: "Text", type: "text" }] },
			],
		})
	).postType.id;
	await staff.api.contentApi.update({ siteId, enabled: true });
	const { secret } = await staff.api.contentApi.keys.create({ siteId, name: "Bakery app" });
	const ids: Record<string, string> = {};
	const publish = async (postTypeId: string, title: string, values: Record<string, unknown> = {}) => {
		const { entry } = await staff.api.entries.create({ siteId, postTypeId, title, ...values });
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		await install.clock.advance(60_000);
		ids[title] = entry.id;
		return entry.id;
	};
	return {
		workspaceId,
		siteId,
		origin,
		staff,
		key: secret,
		recipesId,
		categoriesId,
		ids,
		frontend: (options) => contentClient(install, origin, secret, options),
		publish,
	};
}
