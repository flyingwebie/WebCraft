import type { RouterClient } from "@orpc/server";

import { aiKeys, sharedAiKeys } from "./procedures/ai-keys.ts";
import { apiTokens } from "./procedures/api-tokens.ts";
import { audit } from "./procedures/audit.ts";
import { builder } from "./procedures/builder.ts";
import { components } from "./procedures/components.ts";
import { consentBanner } from "./procedures/consent.ts";
import { dashboards, dashboardTemplates } from "./procedures/dashboards.ts";
import { designSystem } from "./procedures/design-system.ts";
import { domains } from "./procedures/domains.ts";
import { editMode } from "./procedures/edit-mode.ts";
import { entries } from "./procedures/entries.ts";
import { filters } from "./procedures/filters.ts";
import { forms } from "./procedures/forms.ts";
import { globals } from "./procedures/globals.ts";
import { imports } from "./procedures/imports.ts";
import { install } from "./procedures/install.ts";
import { invites } from "./procedures/invites.ts";
import { languages } from "./procedures/languages.ts";
import { loops } from "./procedures/loops.ts";
import { me } from "./procedures/me.ts";
import { media } from "./procedures/media.ts";
import { members } from "./procedures/members.ts";
import { modules } from "./procedures/modules.ts";
import { aiClients, oauth } from "./procedures/oauth.ts";
import { pages } from "./procedures/pages.ts";
import { postTypes } from "./procedures/post-types.ts";
import { publishing } from "./procedures/publishing.ts";
import { scripts } from "./procedures/scripts.ts";
import { seoSettings } from "./procedures/seo.ts";
import { session } from "./procedures/session.ts";
import { setup } from "./procedures/setup.ts";
import { shell } from "./procedures/shell.ts";
import { csp, libraries, outsideScripts } from "./procedures/site-scripts.ts";
import { siteSmtp } from "./procedures/site-smtp.ts";
import { sites } from "./procedures/sites.ts";
import { staff } from "./procedures/staff.ts";
import { staging } from "./procedures/staging.ts";
import { templates } from "./procedures/templates.ts";
import { protectedTerms, translations } from "./procedures/translations.ts";
import { webhooks } from "./procedures/webhooks.ts";
import { workspaces } from "./procedures/workspaces.ts";

/**
 * Every procedure, by name. The admin calls them all at `/api/rpc`; the public ones (`PROCEDURES`
 * in `catalogue.ts` says which) are also served to API tokens at `/api/v1`, with an OpenAPI document.
 */
export const apiRouter = {
	setup,
	session,
	shell,
	me,
	apiTokens,
	oauth,
	aiClients,
	install,
	sharedAiKeys,
	aiKeys,
	workspaces,
	sites,
	postTypes,
	entries,
	globals,
	languages,
	translations,
	protectedTerms,
	domains,
	webhooks,
	siteSmtp,
	templates,
	components,
	filters,
	forms,
	loops,
	scripts,
	libraries,
	outsideScripts,
	csp,
	consentBanner,
	seoSettings,
	designSystem,
	builder,
	media,
	imports,
	pages,
	editMode,
	staging,
	publishing,
	members,
	staff,
	invites,
	audit,
	modules,
	dashboards,
	dashboardTemplates,
};

export type ApiRouter = typeof apiRouter;

/** A typed client for the Management API, as the admin and tests use it. */
export type ApiClient = RouterClient<ApiRouter>;
