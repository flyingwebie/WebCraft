import type { Page } from "playwright";

/**
 * "Edit on site" in the admin's top bar on a Site's screen, as a person uses it at the window's
 * width: its own button where the bar has room, else an item of "More for this Site", the menu the
 * bar keeps it in where it is narrow (a phone).
 */
export async function chooseEditOnSite(page: Page): Promise<void> {
	const button = page.getByRole("button", { name: "Edit on site", exact: true });
	const more = page.getByRole("button", { name: "More for this Site", exact: true });
	await button.or(more).filter({ visible: true }).first().waitFor();
	if (await button.isVisible()) {
		await button.click();
		return;
	}
	await more.click();
	await page.getByRole("menuitem", { name: "Edit on site", exact: true }).click();
}
