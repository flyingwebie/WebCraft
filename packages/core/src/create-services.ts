import { createAuth, leakedPasswordCheck } from "@webcraft/auth";
import type { ModuleDefinition } from "@webcraft/module-sdk";

import { createAccount, reportAccountLock } from "./account.ts";
import { listAuditEntries } from "./audit.ts";
import {
	addLanguage,
	createEntry,
	createPostType,
	deleteEntry,
	getEntry,
	getEntryTemplate,
	getEntryTemplateMarkup,
	getGlobals,
	getPostType,
	getSiteTemplate,
	getSiteTemplateMarkup,
	getSpecialPages,
	listEntries,
	listPostTypes,
	publish,
	saveDraft,
	saveEntryTemplate,
	saveEntryTemplateMarkup,
	saveGlobalsDraft,
	saveSiteTemplate,
	saveSiteTemplateMarkup,
	setBrowserLanguageRedirect,
	setDefaultLanguage,
	setGlobalFields,
	setSpecialPage,
	siteLanguages,
	updateLanguage,
	updatePostType,
} from "./content/index.ts";
import {
	createClass,
	deleteClass,
	exportDesignTokens,
	getDesignSystem,
	importDesignTokens,
	saveDesignSystemDraft,
	updateClass,
} from "./design-system/drafts.ts";
import { createEditMode } from "./edit-mode/index.ts";
import { createEmail } from "./email/index.ts";
import { createGuardedFetch } from "./guarded-fetch.ts";
import { createInstallSettings } from "./install-settings.ts";
import { createMasterKeyBackup } from "./master-key-backup.ts";
import { createInstallStorage } from "./media/install-storage.ts";
import { createMediaLibrary } from "./media/library.ts";
import { FIRST_PARTY_MODULES } from "./modules/first-party.ts";
import { createModuleHost, type ModuleHost } from "./modules/host.ts";
import { createPeople } from "./people.ts";
import { loadPersonActor } from "./permissions/actors.ts";
import { createRateLimits } from "./rate-limits.ts";
import { editModeSigningKey, type MasterKey, sessionSigningSecret } from "./secrets/master-key.ts";
import { createSecrets, installSecretsOnly, openSecrets } from "./secrets/store.ts";
import type { InstallPorts, InstallServices } from "./services.ts";
import { createInstallSetup } from "./setup.ts";
import { createSitePages, reservedSlugs, stagingUrl } from "./site-pages/index.ts";
import { createDataLayer } from "./tenancy/data-layer.ts";
import { createInvites } from "./tenancy/invites.ts";
import { createMembers } from "./tenancy/members.ts";
import { createMemberships } from "./tenancy/memberships.ts";
import { createSite, listSites } from "./tenancy/sites.ts";
import { createStaff } from "./tenancy/staff.ts";
import { createWorkspace, listWorkspaces } from "./tenancy/workspaces.ts";

export type CreateServicesOptions = {
	/** The Modules this Install loads: the first-party Modules of this build unless given. */
	modules?: readonly ModuleDefinition[];
	/**
	 * Refuse a Master key that isn't the Install's current one, as web and worker do when they
	 * start (default). Only code that must not read the database yet turns this off.
	 */
	checkMasterKey?: boolean;
};

/**
 * Builds an Install's services on top of its ports and Master key. Web, worker and the test harness
 * all build them here, so they work the same way everywhere.
 */
export async function createInstallServices(
	ports: InstallPorts,
	masterKey: MasterKey,
	options: CreateServicesOptions = {},
): Promise<InstallServices> {
	const { database, clock, log, config } = ports;
	const secretsOptions = { database, masterKey, clock };
	// Every secret; the data layer hands out a Workspace's or a Site's, `services.secrets` the Install's.
	const store = options.checkMasterKey === false ? createSecrets(secretsOptions) : await openSecrets(secretsOptions);
	const settings = createInstallSettings(database);
	const installSecrets = installSecretsOnly(store);
	const email = createEmail({ ...ports, secrets: installSecrets, settings });
	const auth = createAuth({
		database,
		clock,
		adminOrigin: config.adminOrigin,
		secret: await sessionSigningSecret(masterKey),
		log,
		passwordChecks: [
			leakedPasswordCheck({
				http: ports.http,
				log,
				enabled: async () => (await settings.security()).leakedPasswordCheck,
			}),
		],
		onAccountLocked: reportAccountLock({ database, clock, email }),
	});
	// The Module host hears of every Audit log entry once its change is saved: Modules react to some.
	const listeners: { afterAudit?: ModuleHost["afterAudit"] } = {};
	const data = createDataLayer({
		database,
		clock,
		secrets: store,
		afterAudit: (entry) => listeners.afterAudit?.(entry) ?? Promise.resolve(),
	});
	const modules = createModuleHost({
		database,
		data,
		email,
		jobs: ports.jobs,
		fetch: createGuardedFetch({ http: ports.http, dns: ports.dns }),
		clock,
		log,
		modules: options.modules ?? FIRST_PARTY_MODULES,
	});
	listeners.afterAudit = modules.afterAudit;
	const actors = { person: (personId: string) => loadPersonActor(database.db, personId) };
	const memberships = createMemberships({ database, clock });
	const storage = createInstallStorage({
		database,
		secrets: installSecrets,
		http: ports.http,
		clock,
		log,
		directory: config.storageDir,
	});
	const sitePages = createSitePages({ database, config, data, storage });
	return {
		...ports,
		secrets: installSecrets,
		auth,
		account: createAccount({ database, auth, clock }),
		rateLimits: createRateLimits({ database, clock, log }),
		people: createPeople({ database, clock }),
		setup: createInstallSetup({ database, auth, config, clock, log }),
		settings,
		masterKey: createMasterKeyBackup({ database, clock, log, fingerprint: await masterKey.fingerprint() }),
		data,
		actors,
		workspaces: {
			list: (access) => listWorkspaces(database, access),
			create: createWorkspace,
		},
		sites: {
			list: listSites,
			create: (scope, input) => createSite(scope, input, reservedSlugs(config)),
			stagingUrl: (site) => stagingUrl(config, site.slug),
		},
		postTypes: { list: listPostTypes, get: getPostType, create: createPostType, update: updatePostType },
		entries: { list: listEntries, get: getEntry, create: createEntry, saveDraft, delete: deleteEntry },
		globals: { get: getGlobals, setFields: setGlobalFields, saveDraft: saveGlobalsDraft },
		templates: {
			entryTemplate: getEntryTemplate,
			saveEntryTemplate,
			entryTemplateMarkup: getEntryTemplateMarkup,
			saveEntryTemplateMarkup,
			siteTemplate: getSiteTemplate,
			saveSiteTemplate,
			siteTemplateMarkup: getSiteTemplateMarkup,
			saveSiteTemplateMarkup,
		},
		languages: {
			get: siteLanguages,
			add: (scope, input) => addLanguage({ config }, scope, input),
			update: (scope, code, change) => updateLanguage({ config }, scope, code, change),
			setDefault: setDefaultLanguage,
			setBrowserRedirect: setBrowserLanguageRedirect,
		},
		pages: {
			settings: getSpecialPages,
			setHomePage: (scope, pageId) => setSpecialPage(scope, "home", pageId),
			setNotFoundPage: (scope, pageId, language) => setSpecialPage(scope, "notFound", pageId, language),
		},
		designSystem: {
			get: getDesignSystem,
			saveDraft: saveDesignSystemDraft,
			createClass,
			updateClass,
			deleteClass,
			exportTokens: exportDesignTokens,
			importTokens: importDesignTokens,
		},
		publishing: { publish },
		sitePages,
		editMode: createEditMode({
			database,
			clock,
			config,
			auth,
			data,
			actors,
			signingKey: await editModeSigningKey(masterKey),
			pageContent: (host, pathname) => sitePages.pageContent(host, pathname),
		}),
		memberships,
		members: createMembers({ database, email }),
		staff: createStaff({ email }),
		invites: createInvites({ database, auth, settings, clock, memberships }),
		audit: { list: (scope, options) => listAuditEntries(scope.db, options) },
		email,
		storage,
		media: createMediaLibrary({ storage, jobs: ports.jobs }),
		modules,
	};
}
