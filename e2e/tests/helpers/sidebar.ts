import type { Page } from "@playwright/test";

export const openAccountMenu = async (page: Page) => {
  const toggle = page.getByRole("button", {
    name: "Account menu",
    exact: true,
  });
  if (
    (await toggle.isVisible()) &&
    (await toggle.getAttribute("aria-expanded")) !== "true"
  ) {
    await toggle.click();
  }
};
