import type { RouterClient } from "@orpc/server";

import { audit } from "./procedures/audit.ts";
import { components } from "./procedures/components.ts";
import { consentBanner } from "./procedures/consent.ts";
import { designSystem } from "./procedures/design-system.ts";
import { domains } from "./procedures/domains.ts";
import { editMode } from "./procedures/edit-mode.ts";
import { entries } from "./procedures/entries.ts";
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
import { pages } from "./procedures/pages.ts";
import { postTypes } from "./procedures/post-types.ts";
import { scripts } from "./procedures/scripts.ts";
import { session } from "./procedures/session.ts";
import { setup } from "./procedures/setup.ts";
import { shell } from "./procedures/shell.ts";
import { csp, libraries, outsideScripts } from "./procedures/site-scripts.ts";
import { sites } from "./procedures/sites.ts";
import { staff } from "./procedures/staff.ts";
import { templates } from "./procedures/templates.ts";
import { webhooks } from "./procedures/webhooks.ts";
import { workspaces } from "./procedures/workspaces.ts";

/**
 * Every procedure, by name. The admin calls them all; the public ones will also be served under
 * `/api/v1` with an OpenAPI spec. Every procedure here so far is internal to the admin.
 */
export const apiRouter = {
	setup,
	session,
	shell,
	me,
	install,
	workspaces,
	sites,
	postTypes,
	entries,
	globals,
	languages,
	domains,
	webhooks,
	templates,
	components,
	forms,
	loops,
	scripts,
	libraries,
	outsideScripts,
	csp,
	consentBanner,
	designSystem,
	media,
	imports,
	pages,
	editMode,
	members,
	staff,
	invites,
	audit,
	modules,
};

export type ApiRouter = typeof apiRouter;

/** A typed client for the Management API, as the admin and tests use it. */
export type ApiClient = RouterClient<ApiRouter>;
