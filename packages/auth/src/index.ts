/**
 * Auth: WebCraft's own sign-in interface, with Better Auth (version pinned) behind it, so the rest
 * of WebCraft never imports Better Auth directly: sessions and their lifetime, the recent identity
 * check, lockout, the leaked-password check, and second factors (authenticator apps, backup codes
 * and passkeys). Impersonation rides on these sessions: `@webcraft/core`'s `services.impersonation`
 * says who an admin session acts as.
 */
export {
	type Auth,
	type AuthOptions,
	type AuthRequest,
	createAuth,
	type IdentityProof,
	InvalidCredentialsError,
	type PasskeyCreationOptions,
	type PasskeyRequestOptions,
	SESSION_IDLE_LIMIT_MS,
	SESSION_MAX_AGE_MS,
	type Session,
	type SessionDetails,
	type SignInResult,
} from "./auth.ts";
export {
	LEAKED_PASSWORD_RANGE_URL,
	type LeakedPasswordCheckOptions,
	leakedPasswordCheck,
} from "./leaked-passwords.ts";
export {
	type AccountLock,
	AccountLockedError,
	LOCK_AFTER_FAILED_ATTEMPTS,
	LOCK_DURATION_MS,
} from "./lockout.ts";
export {
	assertNewPasswordAllowed,
	hashPassword,
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	type PasswordCheck,
	type PasswordProblem,
	PasswordRefusedError,
	verifyPassword,
} from "./passwords.ts";
export {
	assertValidEmail,
	EmailInUseError,
	InvalidEmailError,
	type NewPerson,
	normaliseEmail,
} from "./people.ts";
export { BACKUP_CODE_COUNT } from "./two-factor/backup-codes.ts";
export {
	AuthenticatorExistsError,
	type CodeUse,
	SecondFactorNotFoundError,
	SignInExpiredError,
	TwoFactorCodeInvalidError,
	TwoFactorOffError,
} from "./two-factor/errors.ts";
export { SECOND_STEP_MS } from "./two-factor/pending.ts";
export type {
	AlsoInTransaction,
	FactorChange,
	PasskeySummary,
	SecondFactorKeys,
	SecondFactorMethod,
	SecondFactorSummary,
	SecondStepMethod,
	SecretSlot,
} from "./two-factor/second-factors.ts";
export {
	type AssertionCredential,
	PASSKEY_ALGORITHMS,
	PasskeyInvalidError,
	type RegistrationCredential,
} from "./two-factor/webauthn.ts";
