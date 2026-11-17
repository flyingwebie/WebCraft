import type { BuildingAreaApiClient } from "@webcraft/api";
import { useCallback, useEffect, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import type { PostTypeRow } from "../../management.ts";

/** A Loop as `loops.get` answers it: its Draft and published version, its Loop items in the Default language. */
export type LoopRow = Awaited<ReturnType<BuildingAreaApiClient["loops"]["get"]>>["loop"];
/** What the Draft lists, as `loops.result` answers it. */
export type LoopResultRow = Awaited<ReturnType<BuildingAreaApiClient["loops"]["result"]>>;
export type LoopQueryRow = LoopRow["draft"]["query"];

/** The Loops place's list: the Site's Loops and Post Types, read as the place opens. */
export type LoopsData = { loops: LoopRow[]; postTypes: PostTypeRow[] };

/** An error's code, as the API answers it. */
export function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "network";
}

/** Why a call failed, in the person's words. */
export function reasonText(words: Words, error: unknown): string {
	const reasons = words.loops.reasons;
	const code = codeOf(error);
	switch (code) {
		case "LOOP_NAME_TAKEN":
			return reasons.taken;
		case "LOOP_INVALID":
		case "BAD_REQUEST":
			return reasons.invalid;
		case "LOOP_INCOMPLETE":
			return reasons.incomplete;
		case "FORBIDDEN":
			return reasons.forbidden;
		case "network":
			return reasons.network;
		default:
			return fill(reasons.generic, { code });
	}
}

/** A problem the server answered at a setting (`query.filters[1].value`). */
export type Problem = { at: string; message: string };

/** The problems of a `LOOP_INVALID` refusal; none for any other. */
export function problemsOf(error: unknown): Problem[] {
	if (codeOf(error) !== "LOOP_INVALID") return [];
	const problems = (error as { data?: { problems?: unknown } }).data?.problems;
	return Array.isArray(problems) ? (problems as Problem[]) : [];
}

/** The Site's Loops and Post Types, read each time the place opens (and again after a change). */
export function useLoopsData(api: BuildingAreaApiClient, siteId: string) {
	const [data, setData] = useState<LoopsData | null>(null);
	const [failed, setFailed] = useState<unknown>(null);
	const reload = useCallback(async () => {
		try {
			const [{ loops }, { postTypes }] = await Promise.all([
				api.loops.list({ siteId }),
				api.postTypes.list({ siteId }),
			]);
			setData({ loops: loops as LoopRow[], postTypes: postTypes as PostTypeRow[] });
			setFailed(null);
		} catch (error) {
			setFailed(error);
		}
	}, [api, siteId]);
	useEffect(() => {
		void reload();
	}, [reload]);
	return { data, failed, reload };
}

/**
 * What a Loop's Draft lists, read again whenever `version` changes (after each save), with when it
 * was read. A read that a newer one overtook is dropped.
 */
export function useLoopResult(api: BuildingAreaApiClient, siteId: string, loopId: string | null, version: number) {
	const [result, setResult] = useState<{ loopId: string; value: LoopResultRow; readAt: number } | null>(null);
	const [failed, setFailed] = useState<unknown>(null);
	const asked = useRef(0);
	const read = useCallback(async () => {
		if (!loopId) return;
		const ask = ++asked.current;
		try {
			const value = await api.loops.result({ siteId, loopId });
			if (ask !== asked.current) return;
			setResult({ loopId, value, readAt: Date.now() });
			setFailed(null);
		} catch (error) {
			if (ask === asked.current) setFailed(error);
		}
	}, [api, siteId, loopId]);
	// oxlint-disable-next-line react-hooks/exhaustive-deps -- read again after each save (`version`).
	useEffect(() => {
		void read();
	}, [read, version]);
	return { result: result && result.loopId === loopId ? result : null, failed, read };
}

/** A change to a Loop's Draft, as `loops.saveDraft` takes it. */
export type DraftChange = Parameters<BuildingAreaApiClient["loops"]["saveDraft"]>[0];

/**
 * Saves Loops' Drafts one change at a time, the newest last: a change made while one is saving waits,
 * merged with what waits for the same Loop (each part given replaces that part of the Draft, so the
 * newer part wins and the parts it leaves out stay).
 */
export function useDraftSaver(save: (change: DraftChange) => Promise<void>): (change: DraftChange) => void {
	const running = useRef(false);
	const waiting = useRef(new Map<string, DraftChange>());
	const latest = useRef(save);
	latest.current = save;
	return useCallback((change) => {
		waiting.current.set(change.loopId, { ...waiting.current.get(change.loopId), ...change });
		if (running.current) return;
		running.current = true;
		void (async () => {
			for (let next = first(waiting.current); next; next = first(waiting.current)) {
				waiting.current.delete(next.loopId);
				await latest.current(next);
			}
			running.current = false;
		})();
	}, []);
}

function first(waiting: ReadonlyMap<string, DraftChange>): DraftChange | undefined {
	return waiting.values().next().value;
}
