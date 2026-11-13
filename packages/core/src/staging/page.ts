import { contentHash, escapeAttribute, escapeText, pageWords } from "@webcraft/renderer";

import { type StagingWords, stagingWords } from "./words.ts";

/** Where the Staging address keeps its own paths: following a link from the admin, the password form, its page's files. */
export const STAGING_PATH = "/_webcraft/staging/";

/** The page's stylesheet, a file on the Staging address named by its hash, so browsers keep it for a year. */
const STYLES = `:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--muted:#52525b;--card:#fff;--border:#d4d4d8;--accent:#c2410c;--accent-fg:#fff;--danger:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--card:#18181b;--border:#3f3f46;--accent:#fb923c;--accent-fg:#09090b;--danger:#fca5a5}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:28rem;background:var(--card);border:1px solid var(--border);border-radius:.75rem;padding:2rem}
main:focus{outline:none}
.skip{position:absolute;top:.5rem;left:.5rem;padding:.5rem 1rem;background:var(--card);color:var(--fg)}
.skip:not(:focus){clip-path:inset(50%);width:1px;height:1px;overflow:hidden;white-space:nowrap;padding:0}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 .25rem}
h2{font-size:1.125rem;margin:1.5rem 0 .25rem}
p{margin:.5rem 0;color:var(--muted)}
.site{font-weight:600;color:var(--fg);margin:0 0 1rem}
.problem{color:var(--danger);font-weight:600}
a.button,button{display:inline-block;min-height:2.5rem;padding:.5rem 1rem;border-radius:.5rem;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
form{border-top:1px solid var(--border);margin-top:1.5rem}
label{display:block;font-weight:600;margin:1rem 0 .25rem}
input{display:block;width:100%;min-height:2.5rem;padding:.5rem .75rem;border:1px solid var(--muted);border-radius:.5rem;background:var(--card);color:var(--fg);font:inherit}
input[aria-invalid="true"]{border-color:var(--danger)}
form button{margin-top:1rem}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
`;

/**
 * The page's stylesheet as the Staging address serves it: under `/_wc/`, like the Site's own files,
 * since the page shows to people the Site doesn't know and names nothing of what serves it.
 */
export const STAGING_STYLESHEET = { path: `/_wc/staging/page-${contentHash(STYLES)}.css`, css: STYLES } as const;

/**
 * The policy the page is sent with: it loads its own stylesheet and nothing else, runs no script, and
 * its form posts only to the Site.
 */
export const STAGING_PAGE_POLICY =
	"default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";

/** What the page says and offers. */
export type StagingPageOptions = {
	/** The page's language: the language of the path asked for. */
	language: string;
	direction: "ltr" | "rtl";
	siteName: string;
	/** Where signing in opens the Staging address from: the admin, back at this path. */
	signInUrl: string;
	/** The path asked for, which the password form goes on to. */
	path: string;
	/** Whether the Site has a staging password: the page then offers its form. */
	passwordForm: boolean;
	/** What went wrong with the password just given. */
	problem?: "wrongPassword" | "tooMany" | "tooManyForSite";
};

/**
 * The page a Staging address shows people it doesn't know: a link to sign in through the admin and,
 * when the Site has a staging password, a form to give it. Never kept, never indexed, unbranded, and
 * with no script, so it works anywhere.
 */
export function stagingPage(options: StagingPageOptions): string {
	const words: StagingWords = stagingWords(options.language);
	const problem = options.problem ? words[options.problem] : null;
	const title = `${problem ? `${words.errorPrefix} ` : ""}${words.title} · ${options.siteName}`;
	const form = options.passwordForm
		? [
				'<form method="post" action="/_webcraft/staging/password" novalidate>',
				`<h2>${escapeText(words.passwordTitle)}</h2>`,
				`<p id="password-help">${escapeText(words.passwordHelp)}</p>`,
				problem ? `<p class="problem" id="password-problem" role="alert">${escapeText(problem)}</p>` : "",
				`<label for="password">${escapeText(words.password)}</label>`,
				`<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="200" aria-describedby="${problem ? "password-problem password-help" : "password-help"}"${problem ? ' aria-invalid="true" autofocus' : ""}>`,
				`<input type="hidden" name="path" value="${escapeAttribute(options.path)}">`,
				`<button type="submit">${escapeText(words.submit)}</button>`,
				"</form>",
			].join("")
		: "";
	return [
		"<!doctype html>",
		`<html lang="${escapeAttribute(options.language)}" dir="${options.direction}">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="robots" content="noindex">',
		'<meta name="color-scheme" content="light dark">',
		`<title>${escapeText(title)}</title>`,
		`<link rel="stylesheet" href="${STAGING_STYLESHEET.path}">`,
		"</head>",
		"<body>",
		`<a class="skip" href="#main">${escapeText(pageWords(options.language).skipLink)}</a>`,
		'<main id="main" tabindex="-1">',
		`<h1>${escapeText(words.title)}</h1>`,
		`<p class="site">${escapeText(options.siteName)}</p>`,
		`<p>${escapeText(words.intro)}</p>`,
		`<p>${escapeText(words.signInHelp)}</p>`,
		`<p><a href="${escapeAttribute(options.signInUrl)}" class="button">${escapeText(words.signIn)}</a></p>`,
		form,
		"</main>",
		"</body>",
		"</html>",
	].join("\n");
}
