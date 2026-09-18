import { describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import { configureAmazonCurrency, configureAmazonPostcode } from "../../src/browser/context.js";
import { runFixture } from "./helpers.js";

describe("Amazon EUR session", () => {
  it("clears every domain variant and verifies one canonical EUR cookie", async () => {
    const { store, config } = runFixture();
    let cookies = [{ name: "i18n-prefs", value: "HKD", domain: ".amazon.de", path: "/" }, { name: "i18n-prefs", value: "EUR", domain: "www.amazon.de", path: "/" }];
    const context = {
      clearCookies: vi.fn(async () => { cookies = []; }),
      addCookies: vi.fn(async (items: Parameters<BrowserContext["addCookies"]>[0]) => { cookies.push(...items.map((item) => ({ name: item.name, value: item.value, domain: item.domain!, path: item.path! }))); }),
      cookies: vi.fn(async () => cookies),
    };
    await configureAmazonCurrency(context as unknown as BrowserContext, config);
    expect(context.clearCookies).toHaveBeenCalledWith({ name: "i18n-prefs", domain: expect.any(RegExp) });
    expect(cookies).toEqual([{ name: "i18n-prefs", value: "EUR", domain: ".amazon.de", path: "/" }]);
    store.close();
  });

  it("retries postcode setup when Amazon replaces the page execution context", async () => {
    const page = {
      evaluate: vi.fn()
        .mockRejectedValueOnce(new Error("Execution context was destroyed, most likely because of a navigation"))
        .mockResolvedValueOnce({ status: 200, valid: true, addressUpdated: 1, successful: 1, location: "10115 Berlin" }),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
    };
    await expect(configureAmazonPostcode(page as never, "10115", 2_000)).resolves.toEqual({
      status: 200, valid: true, addressUpdated: 1, successful: 1, location: "10115 Berlin",
    });
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.waitForLoadState).toHaveBeenCalledWith("domcontentloaded", { timeout: expect.any(Number) });
  });

  it("rejects HTTP 200 with an empty address response instead of crawling the wrong delivery region", async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue({ status: 200, valid: undefined, addressUpdated: undefined, successful: undefined, location: "Vereinigte Staaten" }),
      waitForLoadState: vi.fn(),
    };
    await expect(configureAmazonPostcode(page as never, "10115", 2_000)).rejects.toThrow("postcode setup was not verified");
  });
});
