import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { isValidElement, type ReactElement } from "react";

// WebCraft: transitions leave out opacity. A Button that stops being disabled (its own `disabled`, or
// a disabled fieldset around it) shows full contrast at once instead of fading from the dimmed look.
const buttonVariants = cva(
	"group/button focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate] outline-none select-none focus-visible:ring-3 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				// WebCraft: hover darkens, so the label keeps at least the contrast it has at rest.
				default: "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklch,var(--primary),black_12%)]",
				outline:
					"border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 shadow-xs",
				secondary:
					"bg-secondary text-secondary-foreground aria-expanded:bg-secondary aria-expanded:text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
				ghost:
					"hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
				// WebCraft: solid in light mode, where red text on a pale red fill falls short of 4.5:1;
				// hover darkens, so the label keeps at least the contrast it has at rest. In dark the label is
				// the lighter red step: the destructive red itself on its own tint falls under 4.5:1 on a
				// card, a popover or a muted row and once hovered; the lighter step keeps 4.8:1 and more on
				// the page, a card, a popover and a muted row, at rest and hovered.
				destructive:
					"bg-destructive focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40 text-white hover:bg-[color-mix(in_oklch,var(--destructive),black_12%)] dark:text-red-300",
				// WebCraft: `text-primary` is the primary colour's text step (`--primary-text` in globals.css),
				// which keeps 4.5:1 on the page in dark as well; the fill's orange does not.
				link: "text-primary underline-offset-4 hover:underline",
			},
			size: {
				default:
					"h-9 gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
				xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5",
				lg: "h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
				icon: "size-9",
				"icon-xs":
					"size-6 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-8 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-md",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

/**
 * WebCraft: a Button drawn as a link (`render={<Link … />}`, an anchor) stays a link: it is drawn with
 * the button's look and nothing else, so assistive technology hears a link and Enter follows it, as
 * on any link. Base UI's Button would make it a `role="button"` that Space activates. A Button drawn
 * as another element that is not a `<button>` is a button without the native element (Base UI logs
 * an error unless it is told so); `nativeButton` still overrides.
 */
function Button({
	className,
	variant = "default",
	size = "default",
	render,
	nativeButton,
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	const classes = cn(buttonVariants({ variant, size, className: className as string | undefined }));
	if (nativeButton === undefined && isLink(render)) {
		const { disabled: _disabled, focusableWhenDisabled: _focusable, ...linkProps } = props;
		return <LinkButton render={render} className={classes} {...(linkProps as useRender.ComponentProps<"a">)} />;
	}
	return (
		<ButtonPrimitive
			data-slot="button"
			className={classes}
			render={render}
			nativeButton={nativeButton ?? !(isValidElement(render) && render.type !== "button")}
			{...props}
		/>
	);
}

/** An element that goes somewhere: an anchor, or a router link (it has `to` or `href`). */
function isLink(render: unknown): render is ReactElement<{ to?: unknown; href?: unknown }> {
	if (!isValidElement<{ to?: unknown; href?: unknown }>(render)) return false;
	return render.type === "a" || render.props.to !== undefined || render.props.href !== undefined;
}

function LinkButton({ render, ref, ...props }: useRender.ComponentProps<"a">) {
	return useRender({
		defaultTagName: "a",
		render,
		ref,
		props: mergeProps<"a">({ "data-slot": "button" } as useRender.ComponentProps<"a">, props),
	});
}

export { Button, buttonVariants };
