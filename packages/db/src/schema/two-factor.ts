import { bigint, boolean, bytea, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";

/**
 * A person's authenticator app (TOTP, RFC 6238): one per person, added once its first code was
 * right. Its secret is not here: it is a secret of the secret store, encrypted under the Master key
 * (`person:<person id>:authenticator`), so rotating the Master key carries it over.
 *
 * `last_used_step` is the 30-second time step of the last code accepted, so no code is accepted twice.
 */
export const authenticators = pgTable("authenticators", {
	personId: uuid("person_id")
		.primaryKey()
		.references(() => people.id, { onDelete: "cascade" }),
	lastUsedStep: bigint("last_used_step", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

/**
 * A person's backup codes: 10 single-use codes for signing in when their authenticator app or
 * passkey is out of reach. Only a keyed hash of each is kept (HMAC-SHA256 under a key held in the
 * secret store), and a used code keeps its row with `used_at`, so it is never accepted again.
 */
export const backupCodes = pgTable(
	"backup_codes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		codeHash: text("code_hash").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		usedAt: timestamp("used_at", { withTimezone: true }),
	},
	(table) => [unique("backup_codes_person_code_unique").on(table.personId, table.codeHash)],
);

/**
 * A person's passkeys (WebAuthn credentials), registered with the admin's hostname as the relying
 * party. Each holds its public key (a COSE key) and the signature counter the authenticator last
 * reported; nothing here is secret.
 */
export const passkeys = pgTable(
	"passkeys",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		/** The credential id the authenticator chose, base64url. */
		credentialId: text("credential_id").notNull().unique(),
		/** The credential's public key, as the COSE key the authenticator gave. */
		publicKey: bytea("public_key").notNull(),
		/** Its COSE algorithm: -7 (ES256), -8 (EdDSA) or -257 (RS256). */
		algorithm: integer("algorithm").notNull(),
		signCount: bigint("sign_count", { mode: "number" }).notNull().default(0),
		/** How the browser said it reaches the authenticator (`internal`, `hybrid`, `usb`…), as hints. */
		transports: text("transports").array().notNull().default([]),
		/** Whether the passkey is synced to the person's other devices (the authenticator's backup state). */
		backedUp: boolean("backed_up").notNull().default(false),
		/** The person's name for it, such as "Work laptop". */
		name: text("name").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
	},
	(table) => [index("passkeys_person_id_idx").on(table.personId)],
);
