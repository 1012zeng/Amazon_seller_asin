import { parseHTML } from "linkedom";
import type { ProductSellerResult } from "../shared/types.js";

export interface ProductSellerDocumentSnapshot {
  status: number;
  url: string;
  blocked: boolean;
  hasProductContainer: boolean;
  asin: string;
  sellerName: string;
  sellerHref: string;
  merchantId: string;
  responseBytes: number;
  fetchMs: number;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u200e\u200f\u202a-\u202e]/g, "").replace(/\s+/g, " ").trim();
}

export function extractSellerId(profileUrl: string, marketplace: string): string | null {
  try {
    const url = new URL(profileUrl, marketplace);
    const expectedHost = new URL(marketplace).hostname.toLowerCase().replace(/^www\./, "");
    const actualHost = url.hostname.toLowerCase().replace(/^www\./, "");
    if (actualHost !== expectedHost) return null;
    const sellerId = (url.searchParams.get("seller") ?? url.searchParams.get("me") ?? "").trim().toUpperCase();
    return /^[A-Z0-9]{10,20}$/.test(sellerId) ? sellerId : null;
  } catch {
    return null;
  }
}

export function canonicalSellerProfileUrl(marketplace: string, marketplaceId: string, sellerId: string): string {
  const url = new URL("/sp", marketplace);
  url.searchParams.set("marketplaceID", marketplaceId);
  url.searchParams.set("seller", sellerId);
  return url.toString();
}

export function canonicalStoreUrl(marketplace: string, marketplaceId: string, sellerId: string): string {
  const url = new URL("/s", marketplace);
  url.searchParams.set("me", sellerId);
  url.searchParams.set("marketplaceID", marketplaceId);
  return url.toString();
}

export function canonicalStorePageUrl(marketplace: string, marketplaceId: string, sellerId: string, page: number): string {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error(`Invalid store page: ${page}`);
  const url = new URL(canonicalStoreUrl(marketplace, marketplaceId, sellerId));
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

export function normalizeProductSellerSnapshot(
  snapshot: ProductSellerDocumentSnapshot,
  expectedAsin: string,
  marketplace: string,
  marketplaceId: string,
): ProductSellerResult {
  const base = {
    asin: expectedAsin,
    sellerId: "",
    sellerName: "",
    sellerProfileUrl: "",
    storeUrl: "",
    httpStatus: snapshot.status,
    responseBytes: snapshot.responseBytes,
    fetchMs: snapshot.fetchMs,
    endpointPort: 0,
  };
  if (snapshot.status === 404 || snapshot.status === 410) return { ...base, kind: "unavailable", error: `产品页面不可用 (HTTP ${snapshot.status})` };
  if (snapshot.blocked) return { ...base, kind: "blocked", error: `Amazon 拦截了产品页面 (HTTP ${snapshot.status})` };
  if (snapshot.status < 200 || snapshot.status >= 300) return { ...base, kind: "error", error: `产品页面返回异常 HTTP ${snapshot.status}` };
  if (!snapshot.hasProductContainer) return { ...base, kind: "error", error: "无法验证产品页面结构" };
  const actualAsin = snapshot.asin.trim().toUpperCase();
  if (!actualAsin) return { ...base, kind: "error", error: "无法验证产品页面 ASIN" };
  if (actualAsin && actualAsin !== expectedAsin) return { ...base, kind: "error", error: `产品页面 ASIN 不匹配: 期望 ${expectedAsin}, 实际 ${actualAsin}` };
  const merchantId = snapshot.merchantId.trim().toUpperCase();
  const sellerId = extractSellerId(snapshot.sellerHref, marketplace) ?? (/^[A-Z0-9]{10,20}$/.test(merchantId) ? merchantId : null);
  if (!sellerId) return { ...base, kind: "unavailable", error: "产品页面没有可验证的当前卖家" };
  return {
    ...base,
    kind: "success",
    error: "",
    sellerId,
    sellerName: cleanText(snapshot.sellerName) || sellerId,
    sellerProfileUrl: canonicalSellerProfileUrl(marketplace, marketplaceId, sellerId),
    storeUrl: canonicalStoreUrl(marketplace, marketplaceId, sellerId),
  };
}

export function parseProductSellerPage(
  html: string,
  status: number,
  requestUrl: string,
  expectedAsin: string,
  marketplace: string,
  marketplaceId: string,
): ProductSellerResult {
  const document = parseHTML(html).document as unknown as Document;
  const text = cleanText(document.body?.textContent).toLocaleLowerCase("de-DE");
  const seller = document.querySelector("#sellerProfileTriggerId, #merchant-info a[href*='seller='], #merchantInfoFeature_feature_div a[href*='seller='], #tabular-buybox a[href*='seller='], #desktop_buybox a[href*='seller='], #apex_desktop a[href*='seller='], a[href*='/sp?'][href*='seller=']");
  let sellerName = cleanText(seller?.textContent);
  if (/^learn more(?: about)?(?: the)? seller$/i.test(sellerName)) sellerName = "";
  const merchantFeature = document.querySelector("#merchantInfoFeature_feature_div");
  const merchantLabel = cleanText(merchantFeature?.querySelector(".offer-display-feature-label")?.textContent);
  if (!sellerName && /seller|sold by|verk[aä]ufer/i.test(merchantLabel)) {
    sellerName = [...(merchantFeature?.querySelectorAll(".offer-display-feature-text-message") ?? [])]
      .map((element) => cleanText(element.textContent))
      .filter((value) => value && !/^learn more(?: about)?(?: the)? seller$/i.test(value))
      .at(-1) ?? "";
  }
  let merchantId = "";
  for (const state of document.querySelectorAll("#desktop_buybox script[type='a-state'], #buybox script[type='a-state'], #apex_desktop script[type='a-state']")) {
    try {
      const payload = JSON.parse(state.textContent ?? "") as { asin?: unknown; merchantId?: unknown };
      const stateAsin = typeof payload.asin === "string" ? cleanText(payload.asin).toUpperCase() : "";
      const stateMerchantId = typeof payload.merchantId === "string" ? cleanText(payload.merchantId).toUpperCase() : "";
      if (stateMerchantId && (!stateAsin || stateAsin === expectedAsin)) { merchantId = stateMerchantId; break; }
    } catch { /* Ignore unrelated Amazon state blocks. */ }
  }
  if (!merchantId) merchantId = cleanText((document.querySelector("#merchantID") as HTMLInputElement | null)?.value).toUpperCase();
  return normalizeProductSellerSnapshot({
    status,
    url: requestUrl,
    blocked: status === 429 || status === 503 || Boolean(document.querySelector("#captchacharacters, form[action*='validateCaptcha']"))
      || text.includes("enter the characters you see below") || text.includes("sorry, we just need to make sure you're not a robot"),
    hasProductContainer: Boolean(document.querySelector("#productTitle, #ppd, #desktop_buybox, #apex_desktop, input[name='items[0.base][asin]'], input#ASIN")),
    asin: cleanText((document.querySelector("input[name='items[0.base][asin]'], input#ASIN") as HTMLInputElement | null)?.value
      || document.querySelector("#dp[data-asin], #ppd[data-asin]")?.getAttribute("data-asin")),
    sellerName,
    sellerHref: seller?.getAttribute("href") ?? "",
    merchantId,
    responseBytes: Buffer.byteLength(html, "utf8"),
    fetchMs: 0,
  }, expectedAsin, marketplace, marketplaceId);
}
