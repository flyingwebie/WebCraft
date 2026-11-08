import type { Auth } from "@webcraft/auth";
import type { Database } from "@webcraft/db";

import type { AuditEntry } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { InstallConfig } from "./config.ts";
import type {
	DraftChange,
	Entry,
	NewEntry,
	NewPostType,
	PostType,
	PostTypeChange,
	Published,
	PublishItem,
	SavedTemplateMarkup,
	Template,
	TemplateMarkup,
} from "./content/index.ts";
import type { Email, Mailer } from "./email/index.ts";
import type { OutgoingHttp } from "./http.ts";
import type { InstallSettings } from "./install-settings.ts";
import type { JobQueue } from "./jobs/define.ts";
import type { Logger } from "./log.ts";
import type { MasterKeyBackup } from "./master-key-backup.ts";
import type { People } from "./people.ts";
import type { PersonActor } from "./permissions/can.ts";
import type { InstallSecrets } from "./secrets/store.ts";
import type { InstallSetup } from "./setup.ts";
import type { SitePages } from "./site-pages/index.ts";
import type {
	Access,
	DataLayer,
	InstallScope,
	Site,
	SiteScope,
	Workspace,
	WorkspaceScope,
} from "./tenancy/data-layer.ts";
import type { MembershipsService } from "./tenancy/memberships.ts";
import type { InvitesService, StaffService } from "./tenancy/staff.ts";
import type { WorkspaceSummary } from "./tenancy/workspaces.ts";

/**
 * The edges of a running Install: real adapters in the processes, fakes in tests. Everything else
 * in `InstallServices` is built on top of them by `createInstallServices`.
 */
export type InstallPorts = {
	config: InstallConfig;
	database: Database;
	jobs: JobQueue;
	mailer: Mailer;
	http: OutgoingHttp;
	clock: Clock;
	log: Logger;
};

/**
 * Everything a running Install's code works with. The web process, the worker and the test
 * harness each build one with `createInstallServices`: real adapters in the processes, fakes at the
 * edges in tests.
 */
export type InstallServices = InstallPorts & {
	/**
	 * The Install's own secrets (Install SMTP, shared AI keys), encrypted under the Master key;
	 * write-only. A Workspace's or Site's secrets are reached through the data layer instead.
	 */
	secrets: InstallSecrets;
	/** Signing in and out, and sessions. */
	auth: Auth;
	/** People with an account, and their admin preferences. */
	people: People;
	/** The setup wizard and its token. */
	setup: InstallSetup;
	/** Install settings › General. */
	settings: InstallSettings;
	/** Whether the Superadmin has stored the Master key outside the server. */
	masterKey: MasterKeyBackup;
	/**
	 * The tenant data layer: opens the Install, a Workspace or a Site for an actor after checking
	 * their Permission. Every query on tenant data goes through it (ADR 0007).
	 */
	data: DataLayer;
	/** Who people are to `can()`: their roles and what they reach. */
	actors: { person(personId: string): Promise<PersonActor> };
	workspaces: {
		/** The Workspaces the actor can see. */
		list(access: Access): Promise<WorkspaceSummary[]>;
		/** Creates a Workspace; open the Install with `workspace.create` first. */
		create(scope: InstallScope, input: { name: string }): Promise<Workspace>;
	};
	sites: {
		/** The Sites of the scope's Workspace the actor can see. */
		list(scope: WorkspaceScope): Promise<Site[]>;
		/** Creates a Site; open its Workspace with `site.create` first. */
		create(scope: WorkspaceScope, input: { name: string; slug: string }): Promise<Site>;
		/** Where the Site's Staging address is (`https://<slug>.<sites domain>`), or null without a sites domain. */
		stagingUrl(site: Pick<Site, "slug">): string | null;
	};
	/** Post Types: the kinds of Entry a Site holds, their URL patterns and Fields. Structure: open the Site with `structure.edit` to change them. */
	postTypes: {
		list(scope: SiteScope): Promise<PostType[]>;
		get(scope: SiteScope, postTypeId: string): Promise<PostType>;
		create(scope: SiteScope, input: NewPostType): Promise<PostType>;
		update(scope: SiteScope, postTypeId: string, change: PostTypeChange): Promise<PostType>;
	};
	/** Entries, each with a Draft and a published version. Open the Site with `entry.edit` to change them. */
	entries: {
		list(scope: SiteScope, postTypeId: string, language?: string): Promise<Entry[]>;
		get(scope: SiteScope, entryId: string, language?: string): Promise<Entry>;
		create(scope: SiteScope, input: NewEntry): Promise<Entry>;
		/** The one way an Entry's Draft changes. */
		saveDraft(scope: SiteScope, entryId: string, change: DraftChange): Promise<Entry>;
	};
	/** Templates, stored as element trees with a Draft and a published version. Structure: `structure.edit`. */
	templates: {
		/** A Post Type's Entry template, or null while it has none. */
		entryTemplate(scope: SiteScope, postTypeId: string): Promise<Template | null>;
		saveEntryTemplate(scope: SiteScope, postTypeId: string, tree: unknown): Promise<Template>;
		/** A Post Type's Entry template as Template markup (its Draft and published version), or null while it has none. */
		entryTemplateMarkup(
			scope: SiteScope,
			postTypeId: string,
		): Promise<{ template: Template | null; markup: TemplateMarkup | null }>;
		/** Saves an Entry template's Draft from Template markup; inline styles become generated Classes. */
		saveEntryTemplateMarkup(scope: SiteScope, postTypeId: string, markup: string): Promise<SavedTemplateMarkup>;
	};
	publishing: {
		/**
		 * Publishes one item: copies its Draft over the published version, clears the Site's page cache
		 * and writes the Audit log. Open the Site with `publishPermission(item)`.
		 */
		publish(scope: SiteScope, item: PublishItem): Promise<Published>;
	};
	/** The Site side: which Site a hostname belongs to, and its published pages. */
	sitePages: SitePages;
	/** Memberships: Members' roles in a Workspace and the Sites they reach. */
	memberships: MembershipsService;
	/** Staff: inviting them, their Workspaces, pending invites. */
	staff: StaffService;
	/** Invite links: what they offer, and accepting them. */
	invites: InvitesService;
	audit: {
		/** The newest entries of the whole Install's Audit log; open the Install with `audit.view` first. */
		list(scope: InstallScope, options: { limit: number }): Promise<AuditEntry[]>;
	};
	/** The Install SMTP, Install branding, the System email sender, the Email log and email preferences. */
	email: Email;
};
