"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "cn";
import * as React from "react";

import { DialogContainer } from "./dialog.tsx";

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
	return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
	return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
	return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

/**
 * The popover's surface, placed beside what opened it. It appears at once (no slide, no fade): a
 * popover that holds a search field or lists should be there the moment it is asked for.
 */
function PopoverContent({
	align = "start",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	collisionPadding = 8,
	anchor,
	className,
	...props
}: PopoverPrimitive.Popup.Props &
	Pick<
		PopoverPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset" | "anchor" | "collisionPadding"
	>) {
	return (
		// Inside a shadow root, the popover renders where the dialogs do, so its styles apply.
		<PopoverPrimitive.Portal container={React.useContext(DialogContainer)}>
			<PopoverPrimitive.Positioner
				className="isolate z-50 outline-none"
				anchor={anchor}
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
			>
				<PopoverPrimitive.Popup
					data-slot="popover-content"
					className={cn(
						"bg-popover text-popover-foreground ring-foreground/10 z-50 max-h-(--available-height) max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-lg text-sm shadow-lg ring-1 outline-none",
						className,
					)}
					{...props}
				/>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	);
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
	return <PopoverPrimitive.Title data-slot="popover-title" className={cn("font-medium", className)} {...props} />;
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
	return (
		<PopoverPrimitive.Description
			data-slot="popover-description"
			className={cn("text-muted-foreground text-sm", className)}
			{...props}
		/>
	);
}

export { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger };
