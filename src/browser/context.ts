import type { Browser, BrowserContext, Page, Response } from "playwright";
import type { AppConfig } from "../shared/types.js";
import { sleep } from "../shared/utils.js";

const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;

export interface AmazonContext {
  context: BrowserContext;
  page: Page;
  proxyPort: number;
}

type CurrencyContext = Pick<BrowserContext, "addCookies" | "clearCookies" | "cookies">;
type PostcodePage = Pick<Page, "evaluate" | "waitForLoadState">;

export interface AmazonPostcodeResult {
  status: number;
  valid: boolean | number | undefined;
  addressUpdated: boolean | number | undefined;
  successful: boolean | number | undefined;
  location: string;
}

export async function configureAmazonCurrency(context: CurrencyContext, config: AppConfig): Promise<void> {
  const marketplaceHost = new URL(config.amazon.marketplace).hostname;
  const cookieHost = marketplaceHost.replace(/^www\./, "");
  const cookieDomain = `.${cookieHost}`;
  const domainPattern = new RegExp(`(^|\\.)${cookieHost.replaceAll(".", "\\.")}$`);
  await context.clearCookies({ name: "i18n-prefs", domain: domainPattern });
  await context.addCookies([{ name: "i18n-prefs", value: config.amazon.currency, domain: cookieDomain, path: "/", secure: true, sameSite: "Lax" }]);
  const cookies = (await context.cookies(config.amazon.marketplace)).filter((cookie) => cookie.name === "i18n-prefs");
  if (cookies.length !== 1 || cookies[0]?.value !== config.amazon.currency || cookies[0]?.domain !== cookieDomain) throw new Error(`Amazon currency cookie must be ${config.amazon.currency}`);
}

export async function configureAmazonPostcode(page: PostcodePage, postcode: string, timeoutMs: number): Promise<AmazonPostcodeResult> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const result = await page.evaluate(async (value) => {
        const modalRaw = document.querySelector("#nav-global-location-data-modal-action")?.getAttribute("data-a-modal") ?? "";
        let modalHeaders: Record<string, string> = {};
        try { modalHeaders = (JSON.parse(modalRaw) as { ajaxHeaders?: Record<string, string> }).ajaxHeaders ?? {}; } catch { /* Fall back to the page token below. */ }
        const token = modalHeaders["anti-csrftoken-a2z"]
          ?? (document.querySelector("#glowValidationToken") as HTMLInputElement | null)?.value
          ?? "";
        const body = new URLSearchParams({
          locationType: "LOCATION_INPUT",
          zipCode: value,
          deviceType: "desktop",
          storeContext: "NoStoreName",
          pageType: "Gateway",
          actionSource: "desktop-modal",
        });
        const result = await fetch("/portal-migration/hz/glow/address-change?actionSource=glow", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            ...(token ? { "anti-csrftoken-a2z": token } : {}),
          },
          body: body.toString(),
        });
        let payload: { isValidAddress?: boolean | number; isAddressUpdated?: boolean | number; successful?: boolean | number } = {};
        try { payload = await result.json() as typeof payload; } catch { /* Invalid JSON is rejected by the caller. */ }
        let location = "";
        if (result.status === 200 && (payload.isValidAddress === true || payload.isValidAddress === 1)) {
          const homepage = await fetch("/", { credentials: "include", cache: "no-store" });
          if (homepage.ok) {
            const parsed = new DOMParser().parseFromString(await homepage.text(), "text/html");
            location = (parsed.querySelector("#glow-ingress-line2")?.textContent ?? "").replace(/\s+/g, " ").trim();
          }
        }
        return {
          status: result.status,
          valid: payload.isValidAddress,
          addressUpdated: payload.isAddressUpdated,
          successful: payload.successful,
          location,
        };
      }, postcode);
      if (result.status !== 200 || (result.valid !== true && result.valid !== 1) || !result.location.includes(postcode)) {
        throw new Error(`Amazon postcode setup was not verified; HTTP ${result.status}, location ${result.location || "missing"}`);
      }
      return result;
    } catch (error) {
      if (!/execution context was destroyed|cannot find context|most likely because of a navigation/i.test(String(error)) || Date.now() >= deadline) throw error;
      const remaining = Math.max(1, deadline - Date.now());
      await page.waitForLoadState("domcontentloaded", { timeout: Math.min(5_000, remaining) }).catch(() => undefined);
      await sleep(Math.min(250, remaining));
    }
  }
}

async function hasBlockMarkers(page: Page, status: number): Promise<boolean> {
  return page.evaluate((responseStatus) => {
    const text = `${document.title} ${document.body?.innerText ?? ""}`;
    return responseStatus === 429 || responseStatus === 503
      || Boolean(document.querySelector("#captchacharacters, form[action*='validateCaptcha']"))
      || /service unavailable|robot check|verify that you.re not a robot/i.test(text);
  }, status);
}

async function reload(page: Page, config: AppConfig, deadline: number): Promise<Response | null> {
  while (true) {
    try {
      return await page.reload({ waitUntil: "domcontentloaded", timeout: config.browser.navigationTimeoutMs });
    } catch (error) {
      if (!/ERR_ABORTED|detached|aborted|interrupted/i.test(String(error)) || Date.now() >= deadline) throw error;
      await sleep(500);
    }
  }
}

async function navigate(page: Page, url: string, config: AppConfig): Promise<Response | null> {
  const deadline = Date.now() + config.browser.navigationTimeoutMs;
  while (true) {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.browser.navigationTimeoutMs });
    } catch (error) {
      if (!/ERR_ABORTED|detached|aborted|interrupted/i.test(String(error)) || Date.now() >= deadline) throw error;
      await sleep(500);
    }
  }
}

async function initializeAmazonSession(context: BrowserContext, page: Page, config: AppConfig, proxyPort: number): Promise<void> {
  await configureAmazonCurrency(context, config);
  let response = await navigate(page, `${config.amazon.marketplace}/`, config);
  let status = response?.status() ?? 0;
  const deadline = Date.now() + config.browser.wafWaitSeconds * 1_000;
  while (await hasBlockMarkers(page, status)) {
    if (Date.now() >= deadline) throw new Error(`Amazon WAF did not clear on proxy port ${proxyPort}; HTTP ${status || "unknown"}`);
    await sleep(1_000);
    response = await reload(page, config, deadline);
    status = response?.status() ?? 0;
  }
  const postcode = await configureAmazonPostcode(page, config.amazon.postcode, config.browser.navigationTimeoutMs);
  if (!postcode.location.includes(config.amazon.postcode)) throw new Error(`Amazon postcode setup failed on proxy port ${proxyPort}; location was not verified`);
  await navigate(page, `${config.amazon.marketplace}${config.browser.controlPath}`, config);
}

export async function refreshAmazonSession(amazon: AmazonContext, config: AppConfig): Promise<void> {
  await initializeAmazonSession(amazon.context, amazon.page, config, amazon.proxyPort);
}

export async function createAmazonContext(browser: Browser, config: AppConfig, proxyPort: number): Promise<AmazonContext> {
  const context = await browser.newContext({
    proxy: { server: `http://127.0.0.1:${proxyPort}` },
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    bypassCSP: true,
  });
  try {
    await context.route("**/*", async (route) => {
      if (["image", "media", "font", "stylesheet"].includes(route.request().resourceType())) await route.abort();
      else await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(config.browser.navigationTimeoutMs);
    await initializeAmazonSession(context, page, config, proxyPort);
    return { context, page, proxyPort };
  } catch (error) {
    await Promise.race([
      context.close().catch(() => undefined),
      sleep(CONTEXT_CLOSE_TIMEOUT_MS),
    ]);
    throw error;
  }
}
