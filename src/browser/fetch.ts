import type { Page } from "playwright";
import { REVIEW_COUNT_SELECTOR } from "../amazon/listing-selectors.js";
import type { StoreDocumentSnapshot } from "../amazon/parsing.js";
import type { ProductSellerDocumentSnapshot } from "../amazon/product-seller.js";

export interface BrowserDocument {
  status: number;
  url: string;
  html: string;
}

export function validateStoreResponseEnvelope(contentType: string, declaredLength: number | null, actualLength: number, maxResponseBytes: number): void {
  if (!/\btext\/html\b/i.test(contentType)) throw new Error(`Unexpected Content-Type: ${contentType || "missing"}`);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) throw new Error(`Invalid Content-Length: ${declaredLength}`);
  if (declaredLength !== null && declaredLength > maxResponseBytes) throw new Error(`Response exceeds ${maxResponseBytes} bytes (declared ${declaredLength})`);
  if (actualLength > maxResponseBytes) throw new Error(`Response exceeds ${maxResponseBytes} bytes (actual ${actualLength})`);
}

export async function fetchDocument(page: Page, url: string, timeoutMs: number): Promise<BrowserDocument> {
  return page.evaluate(async ({ target, timeout }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(target, { credentials: "include", signal: controller.signal, redirect: "follow" });
      return { status: response.status, url: response.url, html: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }, { target: url, timeout: timeoutMs });
}

export async function fetchProductSellerSnapshot(page: Page, url: string, timeoutMs: number, maxResponseBytes: number): Promise<ProductSellerDocumentSnapshot> {
  const snapshot = await page.evaluate(async ({ target, timeout, byteLimit }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = performance.now();
    try {
      const response = await fetch(target, { credentials: "include", signal: controller.signal, redirect: "follow" });
      const contentType = response.headers.get("content-type") ?? "";
      if (!/\btext\/html\b/i.test(contentType)) throw new Error(`Unexpected Content-Type: ${contentType || "missing"}`);
      const declaredLengthText = response.headers.get("content-length") ?? "";
      const declaredLength = declaredLengthText ? Number(declaredLengthText) : null;
      if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) throw new Error(`Invalid Content-Length: ${declaredLengthText}`);
      if (declaredLength !== null && declaredLength > byteLimit) throw new Error(`Response exceeds ${byteLimit} bytes (declared ${declaredLength})`);
      const body = await response.arrayBuffer();
      if (body.byteLength > byteLimit) throw new Error(`Response exceeds ${byteLimit} bytes (actual ${body.byteLength})`);
      const html = new TextDecoder().decode(body);
      const document = new DOMParser().parseFromString(html, "text/html");
      const clean = Function(
        "value",
        "return (value ?? '').replace(/[\\u200e\\u200f\\u202a-\\u202e]/g, '').replace(/\\s+/g, ' ').trim();",
      ) as (value: string | null | undefined) => string;
      const bodyText = clean(document.body?.textContent).toLocaleLowerCase("de-DE");
      const seller = document.querySelector("#sellerProfileTriggerId, #merchant-info a[href*='seller='], #merchantInfoFeature_feature_div a[href*='seller='], #tabular-buybox a[href*='seller='], #desktop_buybox a[href*='seller='], #apex_desktop a[href*='seller='], a[href*='/sp?'][href*='seller=']");
      let sellerName = clean(seller?.textContent);
      if (/^learn more(?: about)?(?: the)? seller$/i.test(sellerName)) sellerName = "";
      const merchantFeature = document.querySelector("#merchantInfoFeature_feature_div");
      const merchantLabel = clean(merchantFeature?.querySelector(".offer-display-feature-label")?.textContent);
      if (!sellerName && /seller|sold by|verk[aä]ufer/i.test(merchantLabel)) {
        sellerName = [...(merchantFeature?.querySelectorAll(".offer-display-feature-text-message") ?? [])]
          .map((element) => clean(element.textContent))
          .filter((value) => value && !/^learn more(?: about)?(?: the)? seller$/i.test(value))
          .at(-1) ?? "";
      }
      let merchantId = "";
      for (const state of document.querySelectorAll("#desktop_buybox script[type='a-state'], #buybox script[type='a-state'], #apex_desktop script[type='a-state']")) {
        try {
          const payload = JSON.parse(state.textContent ?? "") as { asin?: unknown; merchantId?: unknown };
          const stateAsin = typeof payload.asin === "string" ? clean(payload.asin).toUpperCase() : "";
          const stateMerchantId = typeof payload.merchantId === "string" ? clean(payload.merchantId).toUpperCase() : "";
          if (stateMerchantId && (!stateAsin || stateAsin === target.split("/dp/").at(-1)?.split(/[/?#]/)[0]?.toUpperCase())) { merchantId = stateMerchantId; break; }
        } catch { /* Ignore unrelated Amazon state blocks. */ }
      }
      if (!merchantId) merchantId = clean((document.querySelector("#merchantID") as HTMLInputElement | null)?.value).toUpperCase();
      const asinInput = document.querySelector("input[name='items[0.base][asin]'], input#ASIN") as HTMLInputElement | null;
      return {
        status: response.status,
        url: response.url,
        blocked: response.status === 429 || response.status === 503
          || Boolean(document.querySelector("#captchacharacters, form[action*='validateCaptcha']"))
          || bodyText.includes("enter the characters you see below")
          || bodyText.includes("sorry, we just need to make sure you're not a robot"),
        hasProductContainer: Boolean(document.querySelector("#productTitle, #ppd, #desktop_buybox, #apex_desktop, input[name='items[0.base][asin]'], input#ASIN")),
        asin: clean(asinInput?.value || asinInput?.getAttribute("value") || document.querySelector("#dp[data-asin], #ppd[data-asin]")?.getAttribute("data-asin")),
        sellerName,
        sellerHref: seller?.getAttribute("href") ?? "",
        merchantId,
        responseBytes: body.byteLength,
        fetchMs: Math.max(0, Math.round(performance.now() - started)),
      };
    } finally {
      clearTimeout(timer);
    }
  }, { target: url, timeout: timeoutMs, byteLimit: maxResponseBytes });
  return snapshot;
}

export async function fetchStoreSnapshot(page: Page, url: string, timeoutMs: number, maxResponseBytes: number): Promise<StoreDocumentSnapshot> {
  const snapshot = await page.evaluate(async ({ target, timeout, byteLimit, reviewCountSelector }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = performance.now();
    try {
      const response = await fetch(target, { credentials: "include", signal: controller.signal, redirect: "follow" });
      const contentType = response.headers.get("content-type") ?? "";
      if (!/\btext\/html\b/i.test(contentType)) throw new Error(`Unexpected Content-Type: ${contentType || "missing"}`);
      const declaredLengthText = response.headers.get("content-length") ?? "";
      const declaredLength = declaredLengthText ? Number(declaredLengthText) : null;
      if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0)) throw new Error(`Invalid Content-Length: ${declaredLengthText}`);
      if (declaredLength !== null && declaredLength > byteLimit) throw new Error(`Response exceeds ${byteLimit} bytes (declared ${declaredLength})`);
      const body = await response.arrayBuffer();
      if (body.byteLength > byteLimit) throw new Error(`Response exceeds ${byteLimit} bytes (actual ${body.byteLength})`);
      const html = new TextDecoder().decode(body);
      const document = new DOMParser().parseFromString(html, "text/html");
      const clean = Function(
        "value",
        "return (value ?? '').replace(/[\\u200e\\u200f\\u202a-\\u202e]/g, '').replace(/\\s+/g, ' ').trim();",
      ) as (value: string | null | undefined) => string;
      const bodyText = clean(document.body?.textContent).toLocaleLowerCase("de-DE");
      const search = document.querySelector("#search");
      const resultSummaryText = search ? [...search.querySelectorAll("span, h1, h2")]
        .map((node) => clean(node.textContent))
        .filter((text) => (/\b(?:of\s+)?\d[\d,]*\s+results?\b/i.test(text) || /\bvon\s+\d[\d.]*\s+Ergebnissen?\b/i.test(text)) && text.length <= 300)
        .slice(0, 10)
        .join(" ") : "";
      return {
        status: response.status,
        url: response.url,
        blocked: response.status === 429 || response.status === 503
          || Boolean(document.querySelector("#captchacharacters, form[action*='validateCaptcha']"))
          || bodyText.includes("enter the characters you see below")
          || bodyText.includes("sorry, we just need to make sure you're not a robot"),
        hasSearch: Boolean(search),
        zeroResults: Boolean(search) && /(?:\b(?:no|0)\s+(?:matching\s+)?results?\b|\b(?:keine|0)\s+(?:passenden\s+)?Ergebnisse?\b)/i.test(clean(search?.textContent)),
        displayedName: clean(document.querySelector("[data-testid='store-name'], [data-store-name], .store-name, #seller-name")?.textContent),
        resultSummaryText,
        nextHref: document.querySelector("a.s-pagination-next:not(.s-pagination-disabled)")?.getAttribute("href") ?? "",
        paginationTexts: [...document.querySelectorAll(".s-pagination-strip .s-pagination-item")].map((node) => clean(node.textContent)),
        cards: [...document.querySelectorAll<HTMLElement>("[data-component-type='s-search-result'][data-asin]")].map((card) => {
          const image = card.querySelector("img.s-image, img[data-image-latency]");
          return {
            asin: card.dataset.asin ?? "",
            title: clean(card.querySelector("h2 span, h2")?.textContent),
            listingHref: card.querySelector("h2 a, a.a-link-normal.s-no-outline")?.getAttribute("href") ?? "",
            imageUrl: clean(image?.getAttribute("src") || image?.getAttribute("data-src")),
            reviewText: clean(card.querySelector(reviewCountSelector)?.textContent),
            ratingText: clean(card.querySelector("i.a-icon-star-small span.a-icon-alt, span.a-icon-alt")?.textContent),
            priceText: [...card.querySelectorAll(".a-price .a-offscreen")].map((node) => clean(node.textContent)).find((value) => /(?:EUR\s*\d|\d[\d.,]*\s*€)/i.test(value)) ?? "",
          };
        }), responseBytes: body.byteLength, fetchMs: Math.max(0, Math.round(performance.now() - started)), contentType, declaredLength,
      };
    } finally {
      clearTimeout(timer);
    }
  }, { target: url, timeout: timeoutMs, byteLimit: maxResponseBytes, reviewCountSelector: REVIEW_COUNT_SELECTOR });
  validateStoreResponseEnvelope(snapshot.contentType, snapshot.declaredLength, snapshot.responseBytes, maxResponseBytes);
  return snapshot;
}
