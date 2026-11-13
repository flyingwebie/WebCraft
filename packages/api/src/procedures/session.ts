import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
	authEndpoint,
	inAdminSessionBeforeTwoFactor,
	notWhileImpersonating,
	procedure,
	rateLimited,
	setCookies,
	withPerson,
} from "../context.ts";
import { assertionCredential, authenticatorCode, email, password, signInCode } from "../inputs.ts";
import { personView } from "../views.ts";

/** Signing in and out of the admin. */
export const session = {
	/** The signed-in person, or null. */
	current: procedure.use(withPerson).handler(({ context }) => ({
		person: context.person ? personView(context.person) : null,
	})),

	/**
	 * Checks an email and password. For a person without a second factor it starts a session (the
	 * answer sets the session cookie) and answers them; for a person with one it answers
	 * `secondStep`, the ways they can take the second step (`session.secondStep`, or a passkey),
	 * which this browser has 5 minutes for.
	 */
	signIn: authEndpoint.input(z.object({ email, password })).handler(async ({ context, input }) => {
		const { services } = context;
		const result = await services.auth.signIn(input, context);
		setCookies(context, result.setCookie);
		if (result.secondStep) return { person: null, secondStep: result.secondStep };
		const person = await services.people.get(result.personId);
		if (!person) throw new ORPCError("INTERNAL_SERVER_ERROR");
		return { person: personView(person), secondStep: null };
	}),

	/**
	 * The second step of signing in, after a right password in this browser: a code from the
	 * person's authenticator app, or one of their backup codes (used up). Starts the session. Wrong
	 * codes count towards the lockout, like wrong passwords.
	 */
	secondStep: authEndpoint
		.input(z.object({ method: z.enum(["authenticator", "backupCode"]), code: signInCode }))
		.handler(async ({ context, input }) => {
			const { services } = context;
			const { personId, setCookie } = await services.auth.secondStep(input, context);
			setCookies(context, setCookie);
			if (input.method === "backupCode") await services.twoFactor.backupCodeUsed(personId, context.via);
			const person = await services.people.get(personId);
			if (!person) throw new ORPCError("INTERNAL_SERVER_ERROR");
			return { person: personView(person) };
		}),

	/**
	 * Options for signing in with a passkey: for the person whose second step waits in this browser,
	 * or for anyone (the device offers its own passkey for the admin).
	 */
	passkeyOptions: authEndpoint.handler(async ({ context }) => ({
		options: await context.services.auth.passkeySignInOptions(context),
	})),

	/**
	 * Signs in with a passkey: alone (it counts as both factors: the device verified the person) or
	 * as the second step after a right password. Starts the session.
	 */
	signInWithPasskey: authEndpoint
		.input(z.object({ credential: assertionCredential }))
		.handler(async ({ context, input }) => {
			const { services } = context;
			const { personId, setCookie } = await services.auth.signInWithPasskey(input.credential, context);
			setCookies(context, setCookie);
			const person = await services.people.get(personId);
			if (!person) throw new ORPCError("INTERNAL_SERVER_ERROR");
			return { person: personView(person) };
		}),

	/** Options for confirming who the signed-in person is with one of their passkeys. */
	identityPasskeyOptions: inAdminSessionBeforeTwoFactor
		.use(notWhileImpersonating("identityCheck"))
		.use(rateLimited("auth"))
		.handler(async ({ context }) => ({
			options: await context.services.auth.identityPasskeyOptions(context.session),
		})),

	/**
	 * Confirms who the signed-in person is, for this browser's session only: with their password, a
	 * code from their authenticator app or one of their passkeys. Sensitive actions are allowed in it
	 * for the next 10 minutes. Wrong passwords and codes count towards the lockout.
	 */
	confirmIdentity: inAdminSessionBeforeTwoFactor
		.use(notWhileImpersonating("identityCheck"))
		.use(rateLimited("auth"))
		.input(
			z.union([z.object({ password }), z.object({ authenticatorCode }), z.object({ passkey: assertionCredential })]),
		)
		.handler(async ({ context, input }) => {
			await context.services.auth.confirmIdentity(context.session, input, context);
			return { ok: true as const };
		}),

	/**
	 * Ends this browser's session: the answer clears the session cookie. An impersonation going on in
	 * it ends first, recorded as ended by signing out.
	 */
	signOut: procedure.handler(async ({ context }) => {
		const { session } = await context.services.auth.session(context);
		if (session) await context.services.impersonation.stop(session, "signedOut");
		const { setCookie } = await context.services.auth.signOut(context.headers);
		setCookies(context, setCookie);
		return { ok: true as const };
	}),
};
