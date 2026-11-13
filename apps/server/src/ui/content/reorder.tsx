import { GripVerticalIcon } from "lucide-react";
import { type DragEvent, type ReactNode, useCallback, useState } from "react";

/** The list with the item at `from` moved to `to`. */
export function moveItem<Item>(items: readonly Item[], from: number, to: number): Item[] {
	if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return [...items];
	const next = [...items];
	const [moved] = next.splice(from, 1);
	if (moved !== undefined) next.splice(to, 0, moved);
	return next;
}

/**
 * Dragging items of one list into a new order, by a handle. Dragging is for pointers only: every list
 * that uses it also offers Move up and Move down (in each item's menu), the keyboard way to do the
 * same, so the handle itself is not a control.
 */
export function useDragOrder(onMove: (from: number, to: number) => void) {
	const [dragging, setDragging] = useState<number | null>(null);
	const [over, setOver] = useState<number | null>(null);

	const end = () => {
		setDragging(null);
		setOver(null);
	};

	return {
		dragging,
		over,
		/** Props for an item: where another item can be dropped. */
		itemProps(index: number) {
			return {
				onDragOver(event: DragEvent<HTMLElement>) {
					if (dragging === null) return;
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "move";
					if (over !== index) setOver(index);
				},
				onDrop(event: DragEvent<HTMLElement>) {
					if (dragging === null) return;
					event.preventDefault();
					event.stopPropagation();
					onMove(dragging, index);
					end();
				},
				"data-drop-target": over === index && dragging !== null && dragging !== index ? "true" : undefined,
			};
		},
		/** Props for an item's handle; `row` is the element the pointer drags (the whole item). */
		handleProps(index: number, row: () => HTMLElement | null) {
			return {
				draggable: true,
				onDragStart(event: DragEvent<HTMLElement>) {
					event.stopPropagation();
					event.dataTransfer.effectAllowed = "move";
					event.dataTransfer.setData("text/plain", String(index));
					const element = row();
					if (element) event.dataTransfer.setDragImage(element, 16, 16);
					setDragging(index);
				},
				onDragEnd: end,
			};
		},
	};
}

/** The grip a pointer drags an item by. Hidden from assistive technology: the item's menu moves it too. */
export function DragHandle(props: ReturnType<ReturnType<typeof useDragOrder>["handleProps"]>): ReactNode {
	return (
		<span
			{...props}
			aria-hidden="true"
			className="text-muted-foreground hover:text-foreground flex cursor-grab items-center self-stretch px-1 active:cursor-grabbing"
		>
			<GripVerticalIcon className="size-4" />
		</span>
	);
}

/** Repeating the same action must still change the live region's text. */
export function useAnnouncement() {
	const [announcement, setAnnouncement] = useState({ text: "", count: 0 });
	const announce = useCallback((text: string) => {
		setAnnouncement((before) => ({ text, count: before.count + 1 }));
	}, []);
	return [`${announcement.text}${announcement.count % 2 === 0 ? "" : " "}`, announce] as const;
}

/** A polite announcement for screen readers, such as where an item moved to. */
export function Announcer({ message }: { message: string }) {
	return (
		<p role="status" aria-live="polite" className="sr-only">
			{message}
		</p>
	);
}
