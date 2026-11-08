/**
 * Auth: WebCraft's own sign-in interface, with Better Auth (version pinned) behind it, so the rest
 * of WebCraft never imports Better Auth directly: sessions and their lifetime, the recent identity
 * check, lockout and the leaked-password check. Later tickets add 2FA, passkeys and Impersonation.
 */
export {
	type Auth,
	type AuthOptions,
	type AuthRequest,
	createAuth,
	InvalidCredentialsError,
	SESSION_IDLE_LIMIT_MS,
	SESSION_MAX_AGE_MS,
	type Session,
	type SessionDetails,
} from "./auth.ts";
export {
	LEAKED_PASSWORD_RANGE_URL,
	type LeakedPasswordCheckOptions,
	leakedPasswordCheck,
} from "./leaked-passwords.ts";
export {
	assertNewPasswordAllowed,
	MAX_PASSWORD_LENGTH,
	MIN_PASSWORD_LENGTH,
	type PasswordCheck,
	type PasswordProblem,
	PasswordRefusedError,
} from "./passwords.ts";
export {
	assertValidEmail,
	EmailInUseError,
	InvalidEmailError,
	type NewPerson,
	normaliseEmail,
} from "./people.ts";
