import type { ModuleContext, ModuleTable } from "./context.ts";

/**
 * Redirect rules and the 404 log (SDK 1.5): the two places where the Site request pipeline asks a
 * Module, besides its own routes and Form Submissions (ADR 0024).
 *
 * Paths here are **Site paths**: a path on the Site as its Staging address writes it, every language
 * but the Default language under its prefix (`/blog/fresh-bread`, `/fr/blog/pain-frais`), with each
 * segment percent-encoded as in a URL. A request on a language's own domain (`fr.example.com/x`) is
 * the Site path `/fr/x`; WebCraft turns every target back into the address it has on the visitor's
 * hostname, so a Module never deals with hostnames or prefixes on domains.
 */

/** A request the Site pipeline asks a Module's Redirect rules about. */
export type RedirectRequest = {
	/** The Site path asked for: decoded segments encoded again, no trailing slash, no query. */
	path: string;
	/** The language the path is in (its prefix's, else the Default language), a BCP 47 tag. */
	language: string;
};

/** Where a Redirect rule sends a request. */
export type RedirectTarget = {
	/**
	 * A Site path (`/blog/daily-bread`), or an absolute `https://` address on another site; WebCraft
	 * ignores anything else (and says so in the Module log). It keeps the request's query string,
	 * adding the parameters the target doesn't set itself.
	 */
	to: string;
	/** 301 for a page that moved for good; 302 for one that is elsewhere for now. */
	status: 301 | 302;
	/**
	 * Only where no page answers the path: a rule WebCraft made when a published path changed steps
	 * aside once a page is published at its old path again, so it never hides a live page. Rules
	 * without it come before the Site's own pages.
	 */
	whereNoPage?: boolean;
};

/**
 * How a Module keeps a Site's Redirect rules (SDK 1.5; at most one Module of a build, Site-level
 * only). The Site pipeline asks `find` for every `GET` and `HEAD` request on a Site where the
 * Module runs, before anything else answers (only Redirect domains come earlier), except for the
 * paths the Install keeps (`/_…`). It must be quick: one or two indexed reads of the Module's own
 * tables, and nothing else.
 *
 * WebCraft keeps `find`'s answers with the Site's page cache, so it is asked once per path until
 * the Site's pages change: a publish, a setting, or the Module changing one of `tables` (any
 * `insert`, `update` or `delete` on them clears the Site's page cache with the change). It follows
 * a target that is itself a Site path through the rules again (a chain, answered in one hop), and
 * never follows a loop: the request then goes on to the Site's pages, and the Module log says so.
 * A `find` that throws, or doesn't answer within half a second, is taken as "no rule" and goes to
 * the Module log; the page never fails because of it.
 */
export type RedirectRules = {
	/** The Module's tables `find` reads. */
	tables: readonly ModuleTable[];
	/** The rule for a request's Site path, or null when none sends it elsewhere. */
	find(request: RedirectRequest, context: ModuleContext): Promise<RedirectTarget | null>;
};

/** Declares how a Module keeps Redirect rules. */
export function redirectRules(rules: RedirectRules): RedirectRules {
	return rules;
}

/**
 * Requests for a path where no page is, as the Site pipeline hands them to the Module keeping the
 * 404 log: one entry per Site path, language and referring host, with how many requests came.
 */
export type PageMiss = {
	/** The Site path asked for (see above). Never its query string, which may hold personal data. */
	path: string;
	language: string;
	/** The host of the page that linked here (`news.example.org`), from the `Referer` header; null without one. */
	referrerHost: string | null;
	/** How many requests asked for it in this batch. */
	hits: number;
	firstAt: Date;
	lastAt: Date;
};

/**
 * How a Module keeps a Site's 404 log (SDK 1.5; at most one Module of a build, Site-level only).
 * The Site pipeline notes each request its 404 page answers, from a browser (not a robot, by its
 * user agent; `GET` only; never in Edit mode), for a path where a page could be (not a file with a
 * dot in its name, nor the Install's own `/_…` paths). It never waits for the Module: it gathers the
 * misses for a few seconds and hands them over as a background job, so the 404 answer is never
 * slower, nor fails, because of the log. A `record` that fails is tried twice more, like any job.
 */
export type NotFoundLog = {
	/** Keeps the misses of one Site (the context's). */
	record(misses: readonly PageMiss[], context: ModuleContext): Promise<void>;
};

/** Declares how a Module keeps the 404 log. */
export function notFoundLog(log: NotFoundLog): NotFoundLog {
	return log;
}
