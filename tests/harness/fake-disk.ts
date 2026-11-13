import type { DiskRoom, DiskSpace } from "@webcraft/core";

/** The disk local storage is on, as Install health reads its room: plenty unless a test says otherwise. */
export type FakeDisk = {
	readonly space: DiskSpace;
	/** From now on the disk has this much room (null: it can't be read). */
	set(room: DiskRoom | null): void;
};

/** 100 GB, nearly all free. */
const PLENTY: DiskRoom = { freeBytes: 90 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 };

export function createFakeDisk(): FakeDisk {
	let room: DiskRoom | null = PLENTY;
	return {
		space: async () => room,
		set(next) {
			room = next;
		},
	};
}
