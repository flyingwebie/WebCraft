// SVG files: cleaned in the worker before anyone sees them, refused when cleaning fails or would
// change what they show (scripts, event handlers, foreignObject, outside references, entities),
// never resized, served with a policy that lets them run nothing, and shown on pages as <img>.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";

let install: TestInstall;
let siteId: string;
let editor: TestBrowser;
let postTypeId: string;

const onSite = (path: string) => `https://studio.sites.test${path}`;

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK_NS = 'xmlns:xlink="http://www.w3.org/1999/xlink"';

/** An SVG as a drawing program saves it: metadata, comments, editor attributes, defs and reuse. */
const LOGO = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with a drawing program -->
<svg ${SVG_NS} ${XLINK_NS} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
  xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
  xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"
  width="240px" height="120" viewBox="0 0 240 120" inkscape:version="1.3" sodipodi:docname="logo.svg">
  <sodipodi:namedview id="view" inkscape:zoom="2"/>
  <metadata><rdf:RDF><dc:title>Bakery logo</dc:title></rdf:RDF></metadata>
  <title>Acme Bakery</title>
  <defs>
    <linearGradient id="crust"><stop offset="0" stop-color="#c58b4b"/><stop offset="1" stop-color="#7a4a1d"/></linearGradient>
    <circle id="dot" r="4"/>
    <style>.word { fill: #3b2a1a; font-family: serif; }</style>
  </defs>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer">
    <rect x="0" y="0" width="120" height="120" rx="16" fill="url(#crust)"/>
    <use href="#dot" x="20" y="20"/>
    <use xlink:href="#dot" x="40" y="20"/>
    <image x="0" y="0" width="1" height="1" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="/>
    <text class="word" x="130" y="70">Acme&#160;&amp;&#x20;Co</text>
  </g>
</svg>
`;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "studio" })).id;
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Brands",
		urlPattern: "/brands/{slug}",
		fields: [{ key: "logo", label: "Logo", type: "media" }],
	});
	postTypeId = postType.id;
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: '<article><img src="{{ logo }}"></article>',
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
});

afterAll(async () => {
	await install.close();
});

async function uploadSvg(svg: string, name = "drawing.svg") {
	const { media } = await editor.api.media.upload({ siteId, file: upload(svg, name, "image/svg+xml") });
	expect(media).toMatchObject({ kind: "image", status: "processing", url: null });
	expect((await install.drainJobs()).failed).toEqual([]);
	return (await editor.api.media.get({ siteId, mediaId: media.id })).media;
}

describe("a clean SVG", () => {
	test("is kept as it shows, without what only the drawing program needs; never resized", async () => {
		const logo = await uploadSvg(LOGO, "Acme Logo.svg");

		expect(logo).toMatchObject({
			status: "ready",
			contentType: "image/svg+xml",
			width: 240,
			height: 120,
			variants: [],
			failure: null,
		});
		expect(logo.url).toMatch(/^\/_media\/[0-9a-f]{16}-acme-logo\.svg$/);

		const response = await install.request(onSite(logo.url ?? ""));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/svg+xml");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		const policy = response.headers.get("content-security-policy") ?? "";
		expect(policy).toContain("default-src 'none'");
		expect(policy).toContain("script-src 'none'");
		expect(policy).toContain("sandbox");
		const served = await response.text();

		// What it shows stays.
		for (const kept of [
			'viewBox="0 0 240 120"',
			"<title>Acme Bakery</title>",
			'<linearGradient id="crust">',
			'fill="url(#crust)"',
			'href="#dot"',
			"data:image/png;base64,",
			".word { fill: #3b2a1a;",
			"Acme &amp; Co</text>",
		]) {
			expect(served).toContain(kept);
		}
		// What only the drawing program reads goes.
		for (const gone of ["<!--", "<metadata", "sodipodi", "inkscape", "rdf:RDF", "<?xml"]) {
			expect(served).not.toContain(gone);
		}
	});

	test("shows on pages as <img>, with its size", async () => {
		const logo = await uploadSvg(LOGO, "brand.svg");
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title: "Acme", fields: { logo: logo.id } });
		await editor.api.entries.publish({ siteId, entryId: entry.id });

		const html = await expectSafePage(await install.request(onSite("/brands/acme")), "strict");
		const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1];
		expect(main).toBe(
			`<article><img src="${logo.url}" alt="" width="240" height="120" loading="eager" fetchpriority="high"></article>`,
		);
	});
});

/** A small SVG holding `inside`, with what it declares. */
const svgWith = (inside: string, attributes = "") =>
	`<svg ${SVG_NS} ${XLINK_NS} viewBox="0 0 10 10"${attributes}>${inside}</svg>`;

describe("an SVG that could run code or reach outside", () => {
	const hostile: [string, string, string][] = [
		["a script", svgWith('<script>alert("x")</script><rect width="5" height="5"/>'), "script"],
		[
			"a script in another namespace",
			svgWith('<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>'),
			"script",
		],
		["an event handler", svgWith('<rect width="5" height="5" onclick="steal()"/>'), "eventHandler"],
		["an event handler on the root", svgWith("<rect/>", ' onload="steal()"'), "eventHandler"],
		[
			"foreignObject",
			svgWith('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Hi</div></foreignObject>'),
			"foreignObject",
		],
		["HTML inside", svgWith('<div xmlns="http://www.w3.org/1999/xhtml">Hi</div>'), "element"],
		[
			"an outside image",
			svgWith('<image href="https://tracker.example/pixel.png" width="1" height="1"/>'),
			"outsideReference",
		],
		["an outside xlink image", svgWith('<image xlink:href="//tracker.example/p.png"/>'), "outsideReference"],
		["an outside <use>", svgWith('<use href="sprites.svg#icon"/>'), "outsideReference"],
		["a link", svgWith('<a href="https://example.com/"><rect width="5" height="5"/></a>'), "outsideReference"],
		[
			"a javascript: link",
			svgWith('<a href="javascript:steal()"><rect width="5" height="5"/></a>'),
			"outsideReference",
		],
		["an SVG data: image", svgWith('<image href="data:image/svg+xml;base64,PHN2Zy8+"/>'), "outsideReference"],
		["an outside url() in style", svgWith('<rect style="fill: url(https://tracker.example/x)"/>'), "outsideReference"],
		[
			"an outside url() in a presentation attribute",
			svgWith('<rect fill="url(https://tracker.example/x#g)"/>'),
			"outsideReference",
		],
		[
			"@import in a style sheet",
			svgWith('<style>@import url("https://fonts.example/a.css");</style>'),
			"outsideReference",
		],
		["an outside url() in a style sheet", svgWith("<style>rect { fill: url(/x.svg#g) }</style>"), "outsideReference"],
		[
			"a style sheet processing instruction",
			`<?xml-stylesheet href="https://evil.example/a.css"?>${svgWith("<rect/>")}`,
			"outsideReference",
		],
		["an entity", `<!DOCTYPE svg [<!ENTITY boom "lol">]>${svgWith("<text>&boom;</text>")}`, "entity"],
		[
			"an external entity",
			`<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${svgWith("<text>&xxe;</text>")}`,
			"entity",
		],
		[
			"an animation that sets an event handler",
			svgWith('<rect><set attributeName="onmouseover" to="steal()"/></rect>'),
			"element",
		],
		[
			"an animation that changes a link",
			svgWith('<a href="#x"><animate attributeName="href" values="javascript:steal()"/></a>'),
			"element",
		],
	];

	for (const [what, svg, found] of hostile) {
		test(`with ${what} is refused, and never served`, async () => {
			const refused = await uploadSvg(svg);
			expect(refused).toMatchObject({ status: "failed", url: null, failure: { reason: "svgUnsafe" } });
			expect(refused.failure?.found).toContain(found);
			// The raw upload is gone: no name to serve it under.
			expect(refused.variants).toEqual([]);
		});
	}

	test("a file that isn't readable SVG fails", async () => {
		for (const broken of [`<svg ${SVG_NS}><g></svg>`, `<svg ${SVG_NS}>&nbsp;</svg>`]) {
			const refused = await uploadSvg(broken);
			expect(refused).toMatchObject({ status: "failed", failure: { reason: "svgInvalid" } });
		}
		const notSvg = await uploadSvg(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><svg/></html>`);
		expect(notSvg).toMatchObject({ status: "failed", failure: { reason: "svgInvalid" } });
	});
});
