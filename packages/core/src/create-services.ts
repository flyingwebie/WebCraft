import { createAuth, leakedPasswordCheck } from "@webcraft/auth";
import { databaseOn } from "@webcraft/db";
import type { AnyModuleDefinition } from "@webcraft/module-sdk";
import { createAccessibilityStatement } from "./accessibility/statement.ts";
import { createAccount, reportAccountLock } from "./account.ts";
import { createAiKeys } from "./ai/keys.ts";
import { createApiTokens } from "./api-tokens.ts";
import { createAuditLog } from "./audit-log.ts";
import { createBackups } from "./backups/service.ts";
import { createBuilder } from "./builder/index.ts";
import { createCdns } from "./cdns/index.ts";
import { createChecks } from "./checks/index.ts";
import { createCodeMode } from "./code-mode/index.ts";
import { createConsent } from "./consent/index.ts";
import {
	addLanguage,
	cancelScheduled,
	countDrafts,
	countReviewsToAct,
	createComponent,
	createEntry,
	createLoop,
	createPostType,
	createReviews,
	deleteComponent,
	deleteEntry,
	entryBodyComponents,
	getArchiveTemplate,
	getArchiveTemplateMarkup,
	getComponent,
	getComponentMarkup,
	getEntry,
	getEntryTemplate,
	getEntryTemplateMarkup,
	getGlobals,
	getLoop,
	getPostType,
	getReview,
	getScheduled,
	getScript,
	getSearchTemplate,
	getSearchTemplateMarkup,
	getSiteTemplate,
	getSiteTemplateMarkup,
	getSpecialPages,
	itemReviewHistory,
	listComponents,
	listEntries,
	listLoops,
	listPostTypes,
	listReviews,
	listScheduled,
	listTemplates,
	pasteBody,
	publish,
	publishAll,
	publishPreview,
	removeLanguage,
	renameComponent,
	reschedule,
	runDueScheduledPublishes,
	saveArchiveTemplate,
	saveArchiveTemplateMarkup,
	saveComponentDraft,
	saveComponentMarkup,
	saveDraft,
	saveEntryTemplate,
	saveEntryTemplateMarkup,
	saveGlobalsDraft,
	saveLoopDraft,
	saveLoopItems,
	saveScriptDraft,
	saveSearchTemplate,
	saveSearchTemplateMarkup,
	saveSiteTemplate,
	saveSiteTemplateMarkup,
	scheduleAll,
	scheduleItem,
	scheduleUnpublish,
	scriptById,
	sendBackReview,
	setBrowserLanguageRedirect,
	setDefaultLanguage,
	setGlobalFields,
	setSpecialPage,
	siteDrafts,
	siteLanguages,
	submitForReview,
	updateLanguage,
	updatePostType,
	updateScheduled,
	withdrawReview,
} from "./content/index.ts";
import { createContentApi } from "./content-api/index.ts";
import { createDashboards } from "./dashboards/index.ts";
import {
	createClass,
	deleteClass,
	exportDesignTokens,
	getDesignSystem,
	importDesignTokens,
	saveDesignSystemDraft,
	updateClass,
} from "./design-system/drafts.ts";
import { exportDesignSystemFile, importDesignSystemFile } from "./design-system/file.ts";
import { previewDesignSystem } from "./design-system/preview.ts";
import { createDiscovery } from "./discovery/index.ts";
import { systemDiskSpace } from "./disk.ts";
import { createDomains } from "./domains/index.ts";
import { createEditMode } from "./edit-mode/index.ts";
import { createEmail } from "./email/index.ts";
import { reportingFailures } from "./error-log/capture.ts";
import { createErrorLog } from "./error-log/service.ts";
import { createErrorTracker } from "./error-log/tracker.ts";
import { createFilters } from "./filters/index.ts";
import { createForms, createFormTokens, createFormUploads, UPLOAD_ATTACHMENT } from "./forms/index.ts";
import { createSubmissionActions } from "./forms/kept.ts";
import { createGuardedFetch } from "./guarded-fetch.ts";
import { createInstallHealth } from "./health/service.ts";
import { createHistory } from "./history/index.ts";
import { createImpersonation } from "./impersonation.ts";
import { createImports } from "./imports/index.ts";
import { createInstallSettings, MEDIA_MAX_FILE_BYTES } from "./install-settings.ts";
import { coreJobs } from "./jobs/index.ts";
import { createMasterKeyBackup } from "./master-key-backup.ts";
import { MEDIA_IMPORT_TIMEOUT_MS } from "./media/import.ts";
import { createInstallStorage } from "./media/install-storage.ts";
import { createMediaLibrary } from "./media/library.ts";
import { FIRST_PARTY_MODULES } from "./modules/first-party.ts";
import { createModuleHost, type ModuleHost } from "./modules/host.ts";
import { createOAuth } from "./oauth.ts";
import { createPeople } from "./people.ts";
import { loadPersonActor } from "./permissions/actors.ts";
import { createPopups } from "./popups/index.ts";
import { createRateLimits } from "./rate-limits.ts";
import { createReports, createShareLinks, type Reports, reportsPrepare, reportsRender } from "./reports/index.ts";
import { createSiteSearch } from "./search/service.ts";
import {
	apiTokenKey,
	contentCursorKey,
	contentKeyKey,
	domainVerificationKey,
	editModeSigningKey,
	formTimeKey,
	type MasterKey,
	mcpRequestStateKey,
	oauthKey,
	rateLimitKey,
	sessionSigningSecret,
	shareLinkPasswordKey,
	siteExportLinkKey,
	stagingPasswordKey,
	visitorIdKey,
} from "./secrets/master-key.ts";
import { createSecrets, installSecretsOnly, openSecrets, writeSecret } from "./secrets/store.ts";
import { createSeo } from "./seo/index.ts";
import type { InstallPorts, InstallServices } from "./services.ts";
import { createInstallSetup } from "./setup.ts";
import { entryTemplateData, globalsData, loopData } from "./site-pages/data-samples.ts";
import { createSitePages, reservedSlugs, stagingUrl } from "./site-pages/index.ts";
import { createSiteScripts } from "./site-scripts/index.ts";
import { createSiteTransfer } from "./site-transfer/index.ts";
import { socialCardsAfterAudit } from "./social-cards/jobs.ts";
import { createStaging } from "./staging/index.ts";
import { createDataLayer } from "./tenancy/data-layer.ts";
import { createInvites } from "./tenancy/invites.ts";
import { createMembers } from "./tenancy/members.ts";
import { createMemberships } from "./tenancy/memberships.ts";
import { createSite, listSites } from "./tenancy/sites.ts";
import { createStaff } from "./tenancy/staff.ts";
import { createWorkspace, listWorkspaces } from "./tenancy/workspaces.ts";
import { offeredToolsets } from "./toolsets.ts";
import { createTranslations } from "./translation/service.ts";
import { createTwoFactor } from "./two-factor/index.ts";
import { createSecondFactorKeys } from "./two-factor/keys.ts";
import { createUpdates } from "./updates.ts";
import { createWebhooks } from "./webhooks/index.ts";
import { createWorkers } from "./workers.ts";

export type CreateServicesOptions = {
	/** The Modules this Install loads: the first-party Modules of this build unless given. */
	modules?: readonly AnyModuleDefinition[];
	/** How long Import from URL waits for a file; 30 seconds unless given (the test harness waits less). */
	mediaImportTimeoutMs?: number;
	/**
	 * Refuse a Master key that isn't the Install's current one, as web and worker do when they
	 * start (default). Only code that must not read the database yet turns this off.
	 */
	checkMasterKey?: boolean;
	/** Lower Site export thresholds (rows fetched at a time, archive part size): the test harness's, to test streaming. */
	siteTransfer?: { batchRows?: number; partBytes?: number };
};

/**
 * Builds an Install's services on top of its ports and Master key. Web, worker and the test harness
 * all build them here, so they work the same way everywhere.
 */
export async function createInstallServices(
	givenPorts: InstallPorts,
	masterKey: MasterKey,
	options: CreateServicesOptions = {},
): Promise<InstallServices> {
	// Every line logged at error level with an `error` is an unexpected failure: the Error log notes it.
	const errorLog = createErrorLog({
		database: givenPorts.database,
		clock: givenPorts.clock,
		log: givenPorts.log,
		tracker: givenPorts.config.errorDsn
			? createErrorTracker({
					dsn: givenPorts.config.errorDsn,
					fetch: createGuardedFetch({ http: givenPorts.http, dns: givenPorts.dns }),
					clock: givenPorts.clock,
					log: givenPorts.log,
				})
			: null,
	});
	const ports: InstallPorts = { ...givenPorts, log: reportingFailures(givenPorts.log, errorLog) };
	const { database, clock, log, config } = ports;
	const secretsOptions = { database, masterKey, clock };
	// Every secret; the data layer hands out a Workspace's or a Site's, `services.secrets` the Install's.
	const store = options.checkMasterKey === false ? createSecrets(secretsOptions) : await openSecrets(secretsOptions);
	const settings = createInstallSettings(database);
	const installSecrets = installSecretsOnly(store);
	// The Module host and Webhooks hear of every Audit log entry once its change is saved: Modules
	// react to some, and a publish fires the Site's Webhooks.
	const listeners: { afterAudit: ModuleHost["afterAudit"][] } = { afterAudit: [] };
	const data = createDataLayer({
		componentSources: () => modules.components,
		database,
		clock,
		secrets: store,
		// Each listener hears of every entry, whatever the others do: one that fails is logged.
		afterAudit: async (entry) => {
			for (const listener of listeners.afterAudit) {
				try {
					await listener(entry);
				} catch (error) {
					log.error("What follows a saved change failed", {
						action: entry.action,
						workspaceId: entry.workspaceId,
						siteId: entry.siteId,
						error,
					});
				}
			}
		},
		log,
	});
	// Email reads the Install SMTP's password and a Site's own server's, each only for its send.
	// A queued email may name a file to send with it (a Report's PDF), read when it is sent; Reports
	// are built further down, on top of email.
	const storage = createInstallStorage({
		database,
		secrets: installSecrets,
		http: ports.http,
		clock,
		log,
		directory: config.storageDir,
	});
	// Form uploads: private files of Submissions, in the same storage as Media but never served on Sites.
	const formUploads = createFormUploads({ data, storage, clock, log, adminOrigin: config.adminOrigin });
	// Form uploads a Notification attaches are read the same way, by their kind.
	const attachments: { read: Reports["attachment"] | null } = { read: null };
	const email = createEmail({
		...ports,
		secrets: store,
		settings,
		data,
		attachment: (ref) =>
			ref.kind === UPLOAD_ATTACHMENT ? formUploads.attachment(ref) : (attachments.read?.(ref) ?? Promise.resolve(null)),
	});
	const auth = createAuth({
		database,
		clock,
		adminOrigin: config.adminOrigin,
		secondFactorKeys: createSecondFactorKeys({ database, secrets: store }),
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
	const twoFactor = createTwoFactor({
		database,
		auth,
		clock,
		email,
		issuer: async () => (await settings.read()).name ?? "WebCraft",
	});
	const guardedFetch = createGuardedFetch({ http: ports.http, dns: ports.dns });
	const webhooks = createWebhooks({
		config,
		database,
		data,
		secrets: store,
		fetch: guardedFetch,
		jobs: ports.jobs,
		clock,
		log,
		email,
	});
	const rateLimits = createRateLimits({ database, clock, log, keyHash: await rateLimitKey(masterKey) });
	const modules = createModuleHost({
		uploads: formUploads,
		database,
		data,
		email,
		jobs: ports.jobs,
		fetch: guardedFetch,
		clock,
		log,
		modules: options.modules ?? FIRST_PARTY_MODULES,
		// What follows a kept Form Submission: its Notifications, Auto-reply and Webhooks.
		submissionActions: createSubmissionActions({ data, email, webhooks, clock, log }),
		rateLimits,
		countries: ports.countries,
		visitorIdKey: await visitorIdKey(masterKey),
	});
	listeners.afterAudit.push(modules.afterAudit, webhooks.afterAudit, socialCardsAfterAudit(ports.jobs, log));
	// The Components of Modules: placed on Sites where their Module runs.
	const componentSources = modules.components;
	const actors = { person: (personId: string) => loadPersonActor(database.db, personId) };
	const impersonation = createImpersonation({
		database,
		clock,
		jobs: ports.jobs,
		actors,
		hasSecondFactor: (personId) => auth.hasSecondFactor(personId),
	});
	const people = createPeople({ database, clock });
	const toolsets = () => offeredToolsets(modules.registry);
	const apiTokens = createApiTokens({
		database,
		clock,
		people,
		rateLimits,
		keyHash: await apiTokenKey(masterKey),
		toolsets,
	});
	const oauth = createOAuth({
		database,
		clock,
		people,
		rateLimits,
		keyHash: await oauthKey(masterKey),
		issuer: config.adminOrigin,
		toolsets,
	});
	const memberships = createMemberships({ database, clock });
	const aiKeys = createAiKeys({ database, secrets: store, clock, log, email, ai: ports.ai });
	// AI translation hears of every publish, after it is saved, and queues its work for the worker.
	const translations = createTranslations({
		database,
		data,
		ai: ports.ai,
		keys: aiKeys,
		jobs: ports.jobs,
		clock,
		log,
		actors: { person: (personId: string) => loadPersonActor(database.db, personId) },
	});
	listeners.afterAudit.push(translations.afterAudit);
	// Review emails go once what they are about is saved: a submission, a publish, a schedule, a send back.
	const reviewEmails = createReviews({ database, data, email, log });
	listeners.afterAudit.push(reviewEmails.afterAudit);
	const media = createMediaLibrary({
		storage,
		jobs: ports.jobs,
		settings,
		email,
		log,
		clock,
		ai: ports.ai,
		aiKeys,
		fetch: createGuardedFetch({
			http: ports.http,
			dns: ports.dns,
			ceilings: { maxBytes: MEDIA_MAX_FILE_BYTES.max, timeoutMs: MEDIA_IMPORT_TIMEOUT_MS },
		}),
		importTimeoutMs: options.mediaImportTimeoutMs,
	});
	const formTokens = createFormTokens({ key: await formTimeKey(masterKey), clock });
	const sitePages = createSitePages({
		database,
		config,
		data,
		storage,
		components: componentSources,
		formsOn: async (site) => (await modules.submissionsKeptBy(site)) !== null,
		formToken: (site) => formTokens.issue(site.id),
		moduleHosts: async (site) => (await modules.outsideHostsAt(site, "en")).map((found) => found.host),
		moduleScripts: (site) => modules.siteScriptsAt(site),
		redirects: (site, request, paths) => modules.redirectFor(site, request, paths),
		misses: { keeps: modules.keepsNotFoundLog, note: (site, miss) => modules.noteMiss(site, miss) },
	});
	const dashboardService = createDashboards({ database, data, modules, clock });
	const reports = createReports({
		database,
		data,
		dashboards: dashboardService,
		aiKeys,
		ai: ports.ai,
		email,
		jobs: ports.jobs,
		clock,
		log,
		people,
		pdf: ports.pdf,
		queue: {
			prepare: async (ref) => {
				await ports.jobs.send(reportsPrepare, ref);
			},
			render: async (ref, startAfter) => {
				await ports.jobs.send(reportsRender, ref, startAfter ? { startAfter } : {});
			},
		},
	});
	attachments.read = reports.attachment;
	const members = createMembers({ database, email });
	const siteTransfer = createSiteTransfer({
		database,
		storage,
		secrets: installSecrets,
		data,
		actors,
		modules,
		members,
		jobs: ports.jobs,
		clock,
		log,
		config,
		linkKey: await siteExportLinkKey(masterKey),
		tuning: options.siteTransfer,
		writeImportSecret: (client, site, name, value) =>
			writeSecret(
				databaseOn(client),
				masterKey,
				clock,
				{ owner: { kind: "site", workspaceId: site.workspaceId, siteId: site.id }, name },
				value,
			),
		// Only the server commands use these: no person (and so no Site scope) acts there.
		commandSecrets: {
			names: (site) => store.names({ kind: "site", workspaceId: site.workspaceId, siteId: site.id }, ""),
			useWith: (site, name, use) =>
				store.useWith({ owner: { kind: "site", workspaceId: site.workspaceId, siteId: site.id }, name }, use),
		},
	});
	const backups = createBackups({
		config,
		database,
		secrets: installSecrets,
		http: ports.http,
		clock,
		log,
		fingerprint: await masterKey.fingerprint(),
		modules: options.modules ?? FIRST_PARTY_MODULES,
	});
	const workers = createWorkers({ database, clock });
	return {
		...ports,
		secrets: installSecrets,
		auth,
		account: createAccount({ database, auth, clock }),
		twoFactor,
		impersonation,
		rateLimits,
		people,
		aiKeys,
		translations,
		apiTokens,
		oauth,
		mcpRequestStateKey: await mcpRequestStateKey(masterKey),
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
		postTypes: {
			list: listPostTypes,
			get: getPostType,
			create: createPostType,
			update: updatePostType,
			data: entryTemplateData,
		},
		entries: {
			list: listEntries,
			get: getEntry,
			create: createEntry,
			saveDraft,
			delete: deleteEntry,
			bodyComponents: entryBodyComponents,
			pasteBody,
		},
		globals: { get: getGlobals, setFields: setGlobalFields, saveDraft: saveGlobalsDraft, data: globalsData },
		templates: {
			list: listTemplates,
			entryTemplate: getEntryTemplate,
			saveEntryTemplate: (scope, postTypeId, tree) => saveEntryTemplate(scope, postTypeId, tree, componentSources),
			entryTemplateMarkup: (scope, postTypeId) => getEntryTemplateMarkup(scope, postTypeId, componentSources),
			saveEntryTemplateMarkup: (scope, postTypeId, markup, base) =>
				saveEntryTemplateMarkup(scope, postTypeId, markup, componentSources, base),
			siteTemplate: getSiteTemplate,
			saveSiteTemplate: (scope, tree) => saveSiteTemplate(scope, tree, componentSources),
			siteTemplateMarkup: (scope) => getSiteTemplateMarkup(scope, componentSources),
			saveSiteTemplateMarkup: (scope, markup, base) => saveSiteTemplateMarkup(scope, markup, componentSources, base),
			archiveTemplate: getArchiveTemplate,
			saveArchiveTemplate: (scope, postTypeId, tree) => saveArchiveTemplate(scope, postTypeId, tree, componentSources),
			archiveTemplateMarkup: (scope, postTypeId) => getArchiveTemplateMarkup(scope, postTypeId, componentSources),
			saveArchiveTemplateMarkup: (scope, postTypeId, markup, base) =>
				saveArchiveTemplateMarkup(scope, postTypeId, markup, componentSources, base),
			searchTemplate: getSearchTemplate,
			saveSearchTemplate: (scope, tree) => saveSearchTemplate(scope, tree, componentSources),
			searchTemplateMarkup: (scope) => getSearchTemplateMarkup(scope, componentSources),
			saveSearchTemplateMarkup: (scope, markup, base) =>
				saveSearchTemplateMarkup(scope, markup, componentSources, base),
		},
		components: {
			list: (scope) => listComponents(scope, componentSources),
			get: (scope, componentId) => getComponent(scope, componentId, componentSources),
			create: (scope, input) => createComponent(scope, input, componentSources),
			saveDraft: (scope, componentId, change) => saveComponentDraft(scope, componentId, change, componentSources),
			markup: (scope, componentId) => getComponentMarkup(scope, componentId, componentSources),
			saveMarkup: (scope, componentId, input, base) =>
				saveComponentMarkup(scope, componentId, input, componentSources, base),
			rename: (scope, componentId, name) => renameComponent(scope, componentId, name, componentSources),
			delete: (scope, componentId, confirmation) => deleteComponent(scope, componentId, confirmation, componentSources),
		},
		popups: createPopups(componentSources),
		forms: createForms({
			data,
			uploads: formUploads,
			modules,
			rateLimits,
			tokens: formTokens,
			fetch: createGuardedFetch({ http: ports.http, dns: ports.dns }),
			clock,
			log,
		}),
		filters: createFilters({ sources: componentSources }),
		loops: {
			list: listLoops,
			get: getLoop,
			create: createLoop,
			saveDraft: saveLoopDraft,
			saveItems: saveLoopItems,
			data: loopData,
		},
		domains: createDomains({
			config,
			database,
			data,
			http: ports.http,
			dns: ports.dns,
			tls: ports.tls,
			clock,
			log,
			email,
			verificationKey: await domainVerificationKey(masterKey),
		}),
		cdns: createCdns({ database, clock, log, jobs: ports.jobs, fetch: guardedFetch }),
		webhooks,
		dashboards: dashboardService,
		scripts: { get: getScript, byId: scriptById, saveDraft: saveScriptDraft },
		languages: {
			get: siteLanguages,
			add: (scope, input) => addLanguage({ config }, scope, input),
			update: (scope, code, change) => updateLanguage({ config }, scope, code, change),
			setDefault: setDefaultLanguage,
			remove: removeLanguage,
			setBrowserRedirect: setBrowserLanguageRedirect,
		},
		pages: {
			settings: getSpecialPages,
			setHomePage: (scope, pageId) => setSpecialPage(scope, "home", pageId),
			setNotFoundPage: (scope, pageId, language) => setSpecialPage(scope, "notFound", pageId, language),
			setSearchPage: (scope, pageId) => setSpecialPage(scope, "search", pageId),
		},
		designSystem: {
			get: getDesignSystem,
			saveDraft: saveDesignSystemDraft,
			createClass,
			updateClass,
			deleteClass,
			exportTokens: exportDesignTokens,
			importTokens: importDesignTokens,
			preview: previewDesignSystem,
			exportFile: exportDesignSystemFile,
			importFile: importDesignSystemFile,
		},
		publishing: {
			publish: (scope, item) => publish(scope, item, componentSources),
			preview: publishPreview,
			drafts: siteDrafts,
			count: countDrafts,
			publishAll: (scope, items, confirmation) => publishAll(scope, items, confirmation, componentSources),
			scheduled: listScheduled,
			getScheduled,
			schedule: (scope, item, at) => scheduleItem(scope, item, at, componentSources),
			scheduleAll: (scope, items, at, confirmation) => scheduleAll(scope, items, at, confirmation, componentSources),
			scheduleUnpublish,
			reschedule,
			updateScheduled: (scope, scheduleId) => updateScheduled(scope, scheduleId, componentSources),
			cancelScheduled,
			runDue: () => runDueScheduledPublishes({ database, data, clock, log, email, actors, componentSources }),
		},
		reviews: {
			submit: submitForReview,
			withdraw: withdrawReview,
			sendBack: sendBackReview,
			list: listReviews,
			get: getReview,
			countToAct: countReviewsToAct,
			ofItem: itemReviewHistory,
		},
		history: createHistory({ database, componentSources }),
		sitePages,
		checks: createChecks(sitePages, componentSources),
		accessibilityStatement: createAccessibilityStatement({ sources: componentSources, saveDraft }),
		search: createSiteSearch({ database, data, clock, log }),
		consent: createConsent({ data, rateLimits }),
		seo: createSeo(),
		contentApi: createContentApi({
			database,
			data,
			config,
			clock,
			components: componentSources,
			keyHash: await contentKeyKey(masterKey),
			cursorKey: await contentCursorKey(masterKey),
		}),
		discovery: createDiscovery({
			data,
			// A page a rule sends elsewhere has no page for visitors: asked for a batch at once, then each
			// path a rule answers followed as a request is (chains, circles, targets gone).
			async redirected(host, pages) {
				const ruled = await modules.pathsWithRules(
					host.site,
					pages.map((page) => ({ path: page.sitePath, language: page.language })),
				);
				const sent = new Set<string>();
				for (const page of pages) {
					if (ruled.has(page.sitePath) && (await sitePages.redirect(host, new URL(page.loc).pathname))) {
						sent.add(page.sitePath);
					}
				}
				return sent;
			},
		}),
		siteScripts: createSiteScripts({ fetch: guardedFetch, storage, moduleHosts: modules.outsideHostsAt }),
		editMode: createEditMode({
			database,
			clock,
			config,
			auth,
			data,
			actors,
			signingKey: await editModeSigningKey(masterKey),
			mustSetUpTwoFactor: twoFactor.mustSetUp,
			pageContent: (host, pathname) => sitePages.pageContent(host, pathname),
			media,
		}),
		staging: createStaging({
			database,
			clock,
			config,
			auth,
			data,
			actors,
			passwordKey: await stagingPasswordKey(masterKey),
			mustSetUpTwoFactor: twoFactor.mustSetUp,
		}),
		codeMode: createCodeMode({ data, sources: componentSources, pages: sitePages }),
		builder: createBuilder({ sources: componentSources }),
		memberships,
		members,
		staff: createStaff({ email }),
		invites: createInvites({ database, auth, settings, clock, memberships }),
		audit: createAuditLog({ database, data, clock }),
		email,
		storage,
		media,
		imports: createImports({ storage, jobs: ports.jobs, modules }),
		modules,
		backups,
		updates: createUpdates({ database, feed: config.updateFeed, fetch: guardedFetch, clock, log }),
		workers,
		errorLog,
		health: createInstallHealth({
			database,
			clock,
			log,
			schema: { modules: modules.schemas },
			workers,
			storage,
			disk: ports.disk ?? systemDiskSpace,
			backups,
			email,
			errorLog,
			jobs: ports.jobs,
			queueNames: coreJobs.map((job) => job.name),
		}),
		siteTransfer,
		reports,
		shareLinks: createShareLinks({
			database,
			data,
			dashboards: dashboardService,
			clock,
			config,
			passwordKey: await shareLinkPasswordKey(masterKey),
		}),
	};
}
