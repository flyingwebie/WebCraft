import { installReportBranding, siteReportBranding, workspaceReportBranding } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import { personIdOf } from "../permissions/can.ts";
import type {
	BackgroundScope,
	BackgroundWorkspaceScope,
	Executor,
	InstallScope,
	SiteScope,
	WorkspaceScope,
} from "../tenancy/data-layer.ts";
import { BrandingInvalidError } from "./errors.ts";
import type { ReportBrand } from "./page.ts";

/**
 * How Reports and Share links are branded (spec story 133, #104). Three parts, each switched on or off:
 * the agency brand (its name, logo and accent colour: the Superadmin's for the Install, which a
 * Workspace may replace with its own), the client brand (the Site's name and logo, else the
 * Workspace's), and "Made with WebCraft". Kept apart from Install branding, which brands System emails
 * (GLOSSARY.md): its own tables, so changing one never changes the other.
 */

/** A logo as given: PNG, JPEG or WebP, base64. Its type is checked against its bytes. */
export type LogoInput = { contentType: string; data: string };

/** A logo as the admin sees it: its type and size. */
export type LogoView = { contentType: string; bytes: number } | null;

/** The largest logo, in bytes. */
export const LOGO_MAX_BYTES = 256 * 1024;

const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type AgencyBrandView = { name: string | null; accentColour: string | null; logo: LogoView };

export type InstallBrandingView = AgencyBrandView & { showAgency: boolean; showClient: boolean; madeWith: boolean };

export type WorkspaceBrandingView = {
	/** Whether the Workspace uses its own agency brand in place of the Install's. */
	ownAgency: boolean;
	agency: AgencyBrandView;
	/** The client's name (null: the Workspace's) and logo. */
	client: { name: string | null; logo: LogoView };
	/** Its own choice of what shows; null for the Install's (given as `install`). */
	showAgency: boolean | null;
	showClient: boolean | null;
	madeWith: boolean | null;
	install: { showAgency: boolean; showClient: boolean; madeWith: boolean };
};

export type SiteBrandingView = { client: { name: string | null; logo: LogoView } };

/** A change to an agency brand: each field left out stays; a logo of null removes it. */
export type AgencyBrandInput = { name?: string | null; accentColour?: string | null; logo?: LogoInput | null };

export type InstallBrandingInput = AgencyBrandInput & {
	showAgency?: boolean;
	showClient?: boolean;
	madeWith?: boolean;
};

export type WorkspaceBrandingInput = {
	ownAgency?: boolean;
	agency?: AgencyBrandInput;
	client?: { name?: string | null; logo?: LogoInput | null };
	showAgency?: boolean | null;
	showClient?: boolean | null;
	madeWith?: boolean | null;
};

export type SiteBrandingInput = { client: { name?: string | null; logo?: LogoInput | null } };

/** A logo checked: one of the image types, its bytes saying the same, at most 256 KB. */
export function checkedLogo(input: LogoInput): { bytes: Uint8Array; contentType: string } {
	const contentType = input.contentType.toLowerCase();
	if (!(LOGO_TYPES as readonly string[]).includes(contentType)) {
		throw new BrandingInvalidError("logo", "A logo is a PNG, JPEG or WebP image.");
	}
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data) || input.data.length > Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4) {
		throw new BrandingInvalidError("logo", "A logo is at most 256 KB.");
	}
	const bytes = new Uint8Array(Buffer.from(input.data, "base64"));
	if (bytes.byteLength === 0 || bytes.byteLength > LOGO_MAX_BYTES) {
		throw new BrandingInvalidError("logo", "A logo is at most 256 KB.");
	}
	if (sniff(bytes) !== contentType) {
		throw new BrandingInvalidError("logo", "That file isn't the PNG, JPEG or WebP image it says it is.");
	}
	return { bytes, contentType };
}

function sniff(bytes: Uint8Array): string | null {
	const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	const text = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
	if (bytes.byteLength >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
	return null;
}

function checkedName(name: string | null | undefined): string | null | undefined {
	if (name === undefined || name === null) return name;
	const trimmed = name.trim();
	if (trimmed.length > 100) throw new BrandingInvalidError("name", "A name has at most 100 characters.");
	return trimmed === "" ? null : trimmed;
}

function checkedColour(colour: string | null | undefined): string | null | undefined {
	if (colour === undefined || colour === null) return colour;
	const value = colour.trim().toLowerCase();
	if (!/^#[0-9a-f]{6}$/.test(value))
		throw new BrandingInvalidError("accentColour", "An accent colour is written #rrggbb.");
	return value;
}

function logoView(bytes: Uint8Array | null, type: string | null): LogoView {
	return bytes && type ? { contentType: type, bytes: bytes.byteLength } : null;
}

function dataUri(bytes: Uint8Array | null, type: string | null): string | null {
	return bytes && type ? `data:${type};base64,${Buffer.from(bytes).toString("base64")}` : null;
}

/** The columns a change to a logo sets: the logo checked, or none (null removes it, undefined leaves it). */
function logoColumns(logo: LogoInput | null | undefined, column: "agencyLogo" | "clientLogo") {
	if (logo === undefined) return {};
	if (logo === null) return { [column]: null, [`${column}Type`]: null };
	const checked = checkedLogo(logo);
	return { [column]: Buffer.from(checked.bytes), [`${column}Type`]: checked.contentType };
}

type InstallRow = typeof installReportBranding.$inferSelect;

const INSTALL_DEFAULTS = { showAgency: true, showClient: true, madeWith: true };

async function installRow(db: Executor): Promise<InstallRow | undefined> {
	const [row] = await db.select().from(installReportBranding).where(eq(installReportBranding.id, 1));
	return row;
}

function installView(row: InstallRow | undefined): InstallBrandingView {
	return {
		name: row?.agencyName ?? null,
		accentColour: row?.accentColour ?? null,
		logo: logoView(row?.agencyLogo ?? null, row?.agencyLogoType ?? null),
		showAgency: row?.showAgency ?? INSTALL_DEFAULTS.showAgency,
		showClient: row?.showClient ?? INSTALL_DEFAULTS.showClient,
		madeWith: row?.madeWith ?? INSTALL_DEFAULTS.madeWith,
	};
}

export async function installBranding(scope: InstallScope): Promise<InstallBrandingView> {
	return installView(await installRow(scope.db));
}

export async function updateInstallBranding(
	scope: InstallScope,
	input: InstallBrandingInput,
): Promise<InstallBrandingView> {
	const name = checkedName(input.name);
	const accentColour = checkedColour(input.accentColour);
	const set = {
		...(name !== undefined ? { agencyName: name } : {}),
		...(accentColour !== undefined ? { accentColour } : {}),
		...logoColumns(input.logo, "agencyLogo"),
		...(input.showAgency !== undefined ? { showAgency: input.showAgency } : {}),
		...(input.showClient !== undefined ? { showClient: input.showClient } : {}),
		...(input.madeWith !== undefined ? { madeWith: input.madeWith } : {}),
		updatedAt: scope.now(),
		updatedBy: personIdOf(scope.access.actor),
	};
	await scope.transaction(async (tx) => {
		await tx.db
			.insert(installReportBranding)
			.values({ id: 1, ...set })
			.onConflictDoUpdate({ target: installReportBranding.id, set });
		await tx.audit("reportBranding.change", { level: "install", changed: changedFields(input) });
	});
	return installBranding(scope);
}

type WorkspaceRow = typeof workspaceReportBranding.$inferSelect;

async function workspaceRow(scope: { db: Executor; workspace: { id: string } }): Promise<WorkspaceRow | undefined> {
	const [row] = await scope.db
		.select()
		.from(workspaceReportBranding)
		.where(eq(workspaceReportBranding.workspaceId, scope.workspace.id));
	return row;
}

export async function workspaceBranding(scope: WorkspaceScope): Promise<WorkspaceBrandingView> {
	const row = await workspaceRow(scope);
	const install = installView(await installRow(scope.db));
	return {
		ownAgency: row?.ownAgency ?? false,
		agency: {
			name: row?.agencyName ?? null,
			accentColour: row?.accentColour ?? null,
			logo: logoView(row?.agencyLogo ?? null, row?.agencyLogoType ?? null),
		},
		client: { name: row?.clientName ?? null, logo: logoView(row?.clientLogo ?? null, row?.clientLogoType ?? null) },
		showAgency: row?.showAgency ?? null,
		showClient: row?.showClient ?? null,
		madeWith: row?.madeWith ?? null,
		install: { showAgency: install.showAgency, showClient: install.showClient, madeWith: install.madeWith },
	};
}

export async function updateWorkspaceBranding(
	scope: WorkspaceScope,
	input: WorkspaceBrandingInput,
): Promise<WorkspaceBrandingView> {
	const agencyName = checkedName(input.agency?.name);
	const accentColour = checkedColour(input.agency?.accentColour);
	const clientName = checkedName(input.client?.name);
	const set = {
		...(input.ownAgency !== undefined ? { ownAgency: input.ownAgency } : {}),
		...(agencyName !== undefined ? { agencyName } : {}),
		...(accentColour !== undefined ? { accentColour } : {}),
		...logoColumns(input.agency?.logo, "agencyLogo"),
		...(clientName !== undefined ? { clientName } : {}),
		...logoColumns(input.client?.logo, "clientLogo"),
		...(input.showAgency !== undefined ? { showAgency: input.showAgency } : {}),
		...(input.showClient !== undefined ? { showClient: input.showClient } : {}),
		...(input.madeWith !== undefined ? { madeWith: input.madeWith } : {}),
		updatedAt: scope.now(),
		updatedBy: personIdOf(scope.access.actor),
	};
	await scope.transaction(async (tx) => {
		await tx.db
			.insert(workspaceReportBranding)
			.values({ workspaceId: tx.workspace.id, ...set })
			.onConflictDoUpdate({ target: workspaceReportBranding.workspaceId, set });
		await tx.audit("reportBranding.change", { level: "workspace", changed: changedFields(input) });
	});
	return workspaceBranding(scope);
}

export async function siteBranding(scope: SiteScope): Promise<SiteBrandingView> {
	const row = await scope.first(siteReportBranding);
	return {
		client: { name: row?.clientName ?? null, logo: logoView(row?.clientLogo ?? null, row?.clientLogoType ?? null) },
	};
}

export async function updateSiteBranding(scope: SiteScope, input: SiteBrandingInput): Promise<SiteBrandingView> {
	const clientName = checkedName(input.client.name);
	const set = {
		...(clientName !== undefined ? { clientName } : {}),
		...logoColumns(input.client.logo, "clientLogo"),
		updatedAt: scope.now(),
		updatedBy: personIdOf(scope.access.actor),
	};
	await scope.transaction(async (tx) => {
		await tx.db
			.insert(siteReportBranding)
			.values({ workspaceId: tx.workspace.id, siteId: tx.site.id, ...set })
			.onConflictDoUpdate({ target: [siteReportBranding.workspaceId, siteReportBranding.siteId], set });
		await tx.audit("reportBranding.change", { level: "site", changed: changedFields(input) });
	});
	return siteBranding(scope);
}

/** The names of what a change sets, for the Audit log (never a logo's bytes). */
function changedFields(input: object): string[] {
	const found: string[] = [];
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined) continue;
		if (value && typeof value === "object" && !("data" in value)) {
			for (const inner of changedFields(value)) found.push(`${key}.${inner}`);
		} else found.push(key);
	}
	return found;
}

/**
 * The brand a Report or Share link shows: for a Site Dashboard's, the Site's client brand (its name,
 * else the Site's own, and its logo, else the Workspace's); for a Workspace Dashboard's, the
 * Workspace's. The agency brand is the Workspace's own when it has one, else the Install's.
 */
export async function resolveBrand(
	scope: BackgroundScope | BackgroundWorkspaceScope,
	site: { name: string } | null,
): Promise<ReportBrand> {
	const install = await installRow(scope.db);
	const workspace = await workspaceRow(scope);
	const siteRow = scope.level === "background" ? await (scope as BackgroundScope).first(siteReportBranding) : undefined;
	const showAgency = workspace?.showAgency ?? install?.showAgency ?? INSTALL_DEFAULTS.showAgency;
	const showClient = workspace?.showClient ?? install?.showClient ?? INSTALL_DEFAULTS.showClient;
	const madeWith = workspace?.madeWith ?? install?.madeWith ?? INSTALL_DEFAULTS.madeWith;
	const agencySource = workspace?.ownAgency
		? {
				name: workspace.agencyName,
				accent: workspace.accentColour,
				logo: dataUri(workspace.agencyLogo, workspace.agencyLogoType),
			}
		: {
				name: install?.agencyName ?? null,
				accent: install?.accentColour ?? null,
				logo: dataUri(install?.agencyLogo ?? null, install?.agencyLogoType ?? null),
			};
	const workspaceLogo = dataUri(workspace?.clientLogo ?? null, workspace?.clientLogoType ?? null);
	const client = site
		? {
				name: siteRow?.clientName ?? site.name,
				logo: dataUri(siteRow?.clientLogo ?? null, siteRow?.clientLogoType ?? null) ?? workspaceLogo,
			}
		: { name: workspace?.clientName ?? scope.workspace.name, logo: workspaceLogo };
	const hasAgency = Boolean(agencySource.name || agencySource.logo || agencySource.accent);
	return {
		agency: showAgency && hasAgency ? agencySource : null,
		client: showClient ? client : null,
		madeWith,
	};
}
