import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { REVIEW_COUNT_SELECTOR } from "./listing-selectors.js";
import type { StoreAsinOccurrence, StorePageParseResult } from "../shared/types.js";

export interface StoreCardSnapshot {
  asin: string;
  title: string;
  listingHref: string;
  imageUrl: string;
  reviewText: string;
  ratingText: string;
  priceText: string;
}

export interface StoreDocumentSnapshot {
  status: number;
  url: string;
  blocked: boolean;
  hasSearch: boolean;
  zeroResults: boolean;
  displayedName: string;
  resultSummaryText: string;
  nextHref: string;
  paginationTexts: string[];
  cards: StoreCardSnapshot[];
  responseBytes: number;
  fetchMs: number;
  contentType: string;
  declaredLength: number | null;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u200e\u200f\u202a-\u202e]/g, "").replace(/\s+/g, " ").trim();
}

export function parseCount(value: string | null | undefined): number | null {
  const text = cleanText(value).toUpperCase();
  if (!text) return null;
  const match = text.match(/(\d[\d,.]*)(?:\s*)([KM])?/);
  if (!match?.[1]) return null;
  const suffix = match[2] ?? "";
  const numericText = suffix ? match[1].replace(",", ".") : match[1].replace(/[,.]/g, "");
  const number = Number(numericText);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * (suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : 1));
}

export function parseRating(value: string | null | undefined): number | null {
  const match = cleanText(value).match(/(\d+(?:[.,]\d+)?)/);
  if (!match?.[1]) return null;
  const number = Number(match[1].replace(",", "."));
  return Number.isFinite(number) && number >= 0 && number <= 5 ? number : null;
}

export function parseFirstEurCents(value: string | null | undefined): number | null {
  const text = cleanText(value);
  const match = text.match(/EUR\s*(\d[\d.,]*(?:[.,]\d{1,2})?)/i) ?? text.match(/(\d[\d.,]*(?:[.,]\d{1,2})?)\s*€/i);
  if (!match?.[1]) return null;
  const amount = match[1];
  const normalized = amount.includes(",") ? amount.replaceAll(".", "").replace(",", ".") : amount.replace(/,(?=\d{3}(?:\D|$))/g, "");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

export function canonicalProductUrl(marketplace: string, asin: string): string {
  return new URL(`/dp/${asin}`, marketplace).toString();
}

export function validateNextStoreUrl(href: string, currentUrl: string, sellerId: string, currentPage: number, marketplace: string, marketplaceId: string): string {
  try {
    const next = new URL(href, currentUrl);
    const marketplaceHost = new URL(marketplace).hostname.toLowerCase().replace(/^www\./, "");
    const nextHost = next.hostname.toLowerCase().replace(/^www\./, "");
    const nextSeller = (next.searchParams.get("me") ?? "").toUpperCase();
    const nextPage = Number(next.searchParams.get("page") ?? "0");
    if (nextHost !== marketplaceHost || nextSeller !== sellerId.toUpperCase() || next.searchParams.get("marketplaceID") !== marketplaceId || !Number.isInteger(nextPage) || nextPage !== currentPage + 1) return "";
    next.hash = "";
    return next.toString();
  } catch { return ""; }
}

export function validateStorePageIdentity(urlValue: string, sellerId: string, page: number, marketplace: string, marketplaceId: string): boolean {
  try {
    const url = new URL(urlValue);
    const marketplaceHost = new URL(marketplace).hostname.toLowerCase().replace(/^www\./, "");
    const actualHost = url.hostname.toLowerCase().replace(/^www\./, "");
    const actualPage = Number(url.searchParams.get("page") ?? "1");
    return actualHost === marketplaceHost
      && (url.searchParams.get("me") ?? "").toUpperCase() === sellerId.toUpperCase()
      && url.searchParams.get("marketplaceID") === marketplaceId
      && Number.isSafeInteger(actualPage)
      && actualPage === page;
  } catch { return false; }
}

function blockedDocument(document: Document, status: number): boolean {
  const text = cleanText(document.body?.textContent).toLocaleLowerCase("de-DE");
  return status === 429 || status === 503 || Boolean(document.querySelector("#captchacharacters, form[action*='validateCaptcha']")) || text.includes("enter the characters you see below") || text.includes("sorry, we just need to make sure you're not a robot");
}

export function parseExactResultTotal(value: string | null | undefined): number | null {
  const text = cleanText(value);
  const match = text.match(/(?:\d[\d,]*\s*[-–]\s*\d[\d,]*\s+)?of\s+(\d[\d,]*)\s+results?\b/i)
    ?? text.match(/\b(\d[\d,]*)\s+results?\b/i)
    ?? text.match(/(?:\d[\d.]*\s*[-–]\s*\d[\d.]*\s+)?von\s+(\d[\d.]*)\s+Ergebnissen?\b/i)
    ?? text.match(/\b(\d[\d.]*)\s+Ergebnisse?\b/i);
  if (!match?.[1]) return null;
  const total = Number(match[1].replace(/[,.]/g, ""));
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

export function parseVisibleLastPage(values: readonly string[]): number | null {
  const pages = values
    .map((value) => cleanText(value))
    .filter((value) => /^\d{1,5}$/.test(value))
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value >= 1);
  return pages.length > 0 ? Math.max(...pages) : null;
}

function empty(kind: StorePageParseResult["kind"], error: string, snapshot: StoreDocumentSnapshot): StorePageParseResult {
  return {
    kind, error, occurrences: [], displayedName: "", nextUrl: "", signature: "", zeroResults: false,
    httpStatus: snapshot.status, responseBytes: snapshot.responseBytes, fetchMs: snapshot.fetchMs,
    reportedTotal: null, visibleLastPage: null, endpointPort: 0, completenessError: "",
  };
}

function cardText(card: Element, selectors: string): string { return cleanText(card.querySelector(selectors)?.textContent); }

function resultSummaryText(document: Document): string {
  const search = document.querySelector("#search");
  if (!search) return "";
  return [...search.querySelectorAll("span, h1, h2")]
    .map((node) => cleanText(node.textContent))
    .filter((text) => (/\b(?:of\s+)?\d[\d,]*\s+results?\b/i.test(text) || /\bvon\s+\d[\d.]*\s+Ergebnissen?\b/i.test(text)) && text.length <= 300)
    .slice(0, 10)
    .join(" ");
}

function firstEurPriceText(card: Element): string {
  for (const node of card.querySelectorAll(".a-price .a-offscreen")) {
    const value = cleanText(node.textContent);
    if (/(?:EUR\s*\d|\d[\d.,]*\s*€)/i.test(value)) return value;
  }
  return "";
}

export function normalizeStoreSnapshot(snapshot: StoreDocumentSnapshot, sellerId: string, page: number, marketplace: string, marketplaceId: string): StorePageParseResult {
  const occurrences: StoreAsinOccurrence[] = [];
  for (const card of snapshot.cards) {
    const asin = card.asin.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
    let listingProductUrl = "";
    try { listingProductUrl = card.listingHref ? new URL(card.listingHref, marketplace).toString() : ""; } catch { listingProductUrl = ""; }
    const priceText = cleanText(card.priceText);
    occurrences.push({
      sellerId, asin, page, position: occurrences.length + 1, title: cleanText(card.title), listingProductUrl,
      productUrl: canonicalProductUrl(marketplace, asin), imageUrl: cleanText(card.imageUrl), reviewCount: parseCount(card.reviewText),
      rating: parseRating(card.ratingText), priceText, priceCents: parseFirstEurCents(priceText),
    });
  }
  if (snapshot.status === 404 || snapshot.status === 410) return empty("unavailable", `Store page unavailable (HTTP ${snapshot.status})`, snapshot);
  if (snapshot.blocked) return empty("blocked", `Amazon blocked store page (HTTP ${snapshot.status})`, snapshot);
  if (snapshot.status >= 200 && snapshot.status < 300 && !validateStorePageIdentity(snapshot.url, sellerId, page, marketplace, marketplaceId)) {
    return empty("error", `Store page response identity mismatch for ${sellerId} page ${page}`, snapshot);
  }
  if (snapshot.status >= 200 && snapshot.status < 300 && (occurrences.length > 0 || (snapshot.hasSearch && snapshot.zeroResults))) {
    const nextUrl = snapshot.nextHref ? validateNextStoreUrl(snapshot.nextHref, snapshot.url, sellerId, page, marketplace, marketplaceId) : "";
    return {
      kind: "success", error: "", occurrences, displayedName: cleanText(snapshot.displayedName),
      nextUrl,
      signature: createHash("sha256").update(occurrences.map((row) => row.asin).join("\n")).digest("hex"), zeroResults: snapshot.zeroResults,
      httpStatus: snapshot.status, responseBytes: snapshot.responseBytes, fetchMs: snapshot.fetchMs,
      reportedTotal: snapshot.zeroResults ? 0 : parseExactResultTotal(snapshot.resultSummaryText),
      visibleLastPage: parseVisibleLastPage(snapshot.paginationTexts), endpointPort: 0,
      completenessError: snapshot.nextHref && !nextUrl ? "Invalid or non-sequential Next URL" : "",
    };
  }
  return empty("blocked", `Store page has no recognized result structure (HTTP ${snapshot.status})`, snapshot);
}

export function parseStorePage(html: string, status: number, requestUrl: string, sellerId: string, page: number, marketplace: string, marketplaceId: string): StorePageParseResult {
  const document = parseHTML(html).document as unknown as Document;
  const search = document.querySelector("#search");
  return normalizeStoreSnapshot({
    status, url: requestUrl, blocked: blockedDocument(document, status), hasSearch: Boolean(search),
    zeroResults: Boolean(search) && /(?:\b(?:no|0)\s+(?:matching\s+)?results?\b|\b(?:keine|0)\s+(?:passenden\s+)?Ergebnisse?\b)/i.test(cleanText(search?.textContent)),
    displayedName: cardText(document.documentElement, "[data-testid='store-name'], [data-store-name], .store-name, #seller-name"),
    resultSummaryText: resultSummaryText(document),
    nextHref: document.querySelector("a.s-pagination-next:not(.s-pagination-disabled)")?.getAttribute("href") ?? "",
    paginationTexts: [...document.querySelectorAll(".s-pagination-strip .s-pagination-item")].map((node) => cleanText(node.textContent)),
    cards: [...document.querySelectorAll<HTMLElement>("[data-component-type='s-search-result'][data-asin]")].map((card) => {
      const image = card.querySelector("img.s-image, img[data-image-latency]");
      return { asin: card.dataset.asin ?? "", title: cardText(card, "h2 span, h2"), listingHref: card.querySelector("h2 a, a.a-link-normal.s-no-outline")?.getAttribute("href") ?? "", imageUrl: cleanText(image?.getAttribute("src") || image?.getAttribute("data-src")), reviewText: cardText(card, REVIEW_COUNT_SELECTOR), ratingText: cardText(card, "i.a-icon-star-small span.a-icon-alt, span.a-icon-alt"), priceText: firstEurPriceText(card) };
    }), responseBytes: Buffer.byteLength(html, "utf8"), fetchMs: 0, contentType: "text/html", declaredLength: Buffer.byteLength(html, "utf8"),
  }, sellerId, page, marketplace, marketplaceId);
}
