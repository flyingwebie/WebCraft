import type { RouterClient } from "@orpc/server";

import { audit } from "./procedures/audit.ts";
import { install } from "./procedures/install.ts";
import { invites } from "./procedures/invites.ts";
import { me } from "./procedures/me.ts";
import { members } from "./procedures/members.ts";
import { session } from "./procedures/session.ts";
import { setup } from "./procedures/setup.ts";
import { shell } from "./procedures/shell.ts";
import { sites } from "./procedures/sites.ts";
import { staff } from "./procedures/staff.ts";
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
	members,
	staff,
	invites,
	audit,
};

export type ApiRouter = typeof apiRouter;

/** A typed client for the Management API, as the admin and tests use it. */
export type ApiClient = RouterClient<ApiRouter>;
