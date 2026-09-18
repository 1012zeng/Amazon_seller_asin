import { normalizeStoreSnapshot, parseCount, parseExactResultTotal, parseFirstEurCents, parseRating, parseStorePage, validateNextStoreUrl } from "../../src/amazon/parsing.js";
import { parseProductSellerPage } from "../../src/amazon/product-seller.js";
import { fetchProductSellerSnapshot } from "../../src/browser/fetch.js";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

const MARKETPLACE = "https://www.amazon.de";
const MARKETPLACE_ID = "A1PA6795UKMFR9";

describe("Amazon DE parsing", () => {
  it.each([["6,71 €", 671], ["EUR 60.00", 6000], ["ab 9,40 € (2,00 €/Stück)", 940], ["£9.99", null], ["", null]])(
    "parses the first EUR amount in %s",
    (text, expected) => expect(parseFirstEurCents(text)).toBe(expected),
  );

  it("parses German localized counts, ratings, and exact totals", () => {
    expect(parseCount("(1.234)")).toBe(1234);
    expect(parseCount("(299)")).toBe(299);
    expect(parseRating("4,6 von 5 Sternen")).toBe(4.6);
    expect(parseExactResultTotal("1–16 von 34 Ergebnissen")).toBe(34);
  });

  it("keeps raw EUR text and exact cents on each occurrence", () => {
    const result = normalizeStoreSnapshot({
      status: 200, url: `${MARKETPLACE}/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}`, blocked: false, hasSearch: true, zeroResults: false,
      displayedName: "Store", resultSummaryText: "1–1 von 1 Ergebnis", nextHref: "", paginationTexts: [],
      cards: [{ asin: "B012345678", title: "P", listingHref: "/dp/B012345678", imageUrl: "i", reviewText: "(299)", ratingText: "3,6 von 5 Sternen", priceText: "8,00 €" }],
      responseBytes: 1000, fetchMs: 50, contentType: "text/html", declaredLength: 1000,
    }, "A123456789", 1, MARKETPLACE, MARKETPLACE_ID);
    expect(result.occurrences[0]).toMatchObject({ priceText: "8,00 €", priceCents: 800, reviewCount: 299, rating: 3.6, productUrl: "https://www.amazon.de/dp/B012345678" });
  });

  it("accepts only the next page for the same German seller and marketplace", () => {
    const current = `${MARKETPLACE}/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=1`;
    expect(validateNextStoreUrl(`/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=2`, current, "A123456789", 1, MARKETPLACE, MARKETPLACE_ID)).toContain("page=2");
    expect(validateNextStoreUrl(`https://www.amazon.co.uk/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=2`, current, "A123456789", 1, MARKETPLACE, MARKETPLACE_ID)).toBe("");
  });

  it("rejects a store response redirected to a different page identity", () => {
    const html = `<html><body><div id="search"><div data-component-type="s-search-result" data-asin="B012345678"><h2><span>P</span></h2></div></div></body></html>`;
    expect(parseStorePage(html, 200, `${MARKETPLACE}/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=1`, "A123456789", 2, MARKETPLACE, MARKETPLACE_ID)).toMatchObject({
      kind: "error", error: "Store page response identity mismatch for A123456789 page 2",
    });
  });

  it("extracts the visible numeric last page from the German pagination strip", () => {
    const current = `${MARKETPLACE}/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=1`;
    const html = `<html><body><div id="search"><span>1-1 von 98 Ergebnissen</span><div data-component-type="s-search-result" data-asin="B012345678"><h2><a href="/dp/B012345678"><span>P</span></a></h2></div><span class="s-pagination-strip"><span class="s-pagination-item s-pagination-selected">1</span><a class="s-pagination-item">2</a><span class="s-pagination-item">...</span><a class="s-pagination-item">98</a><a class="s-pagination-item s-pagination-next" href="/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=2">Weiter</a></span></div></body></html>`;
    expect(parseStorePage(html, 200, current, "A123456789", 1, MARKETPLACE, MARKETPLACE_ID)).toMatchObject({
      kind: "success",
      visibleLastPage: 98,
      reportedTotal: 98,
      nextUrl: expect.stringContaining("page=2"),
    });
  });
});

describe("Amazon DE product seller parsing", () => {
  it("serializes the browser snapshot callback without Node-only transform helpers", async () => {
    let serialized = "";
    const page = {
      evaluate: async (callback: unknown) => {
        serialized = String(callback);
        return {
          status: 200, url: `${MARKETPLACE}/dp/B0G6SK167C`, blocked: false, asin: "B0G6SK167C",
          hasProductContainer: true, sellerName: "DoocliB DE", sellerHref: "/sp?seller=A209KL3OI8XITW",
          merchantId: "A209KL3OI8XITW", responseBytes: 1000, fetchMs: 10,
        };
      },
    } as unknown as Page;

    await expect(fetchProductSellerSnapshot(page, `${MARKETPLACE}/dp/B0G6SK167C`, 30_000, 5_242_880)).resolves.toMatchObject({ sellerName: "DoocliB DE" });
    expect(serialized).not.toContain("__name");
  });

  it("extracts and canonicalizes the independent seller", () => {
    const html = `<html><body><input id="ASIN" value="B0G6SK167C"><a id="sellerProfileTriggerId" href="/gp/help/seller/at-a-glance.html?seller=A209KL3OI8XITW&asin=B0G6SK167C">DoocliB DE</a></body></html>`;
    expect(parseProductSellerPage(html, 200, `${MARKETPLACE}/dp/B0G6SK167C`, "B0G6SK167C", MARKETPLACE, MARKETPLACE_ID)).toMatchObject({
      kind: "success",
      sellerId: "A209KL3OI8XITW",
      sellerName: "DoocliB DE",
      sellerProfileUrl: "https://www.amazon.de/sp?marketplaceID=A1PA6795UKMFR9&seller=A209KL3OI8XITW",
      storeUrl: "https://www.amazon.de/s?me=A209KL3OI8XITW&marketplaceID=A1PA6795UKMFR9",
    });
  });

  it("does not invent a seller when the page has no independent seller link", () => {
    const html = `<html><body><input id="ASIN" value="B000000001"><div>Verkauf und Versand durch Amazon</div></body></html>`;
    expect(parseProductSellerPage(html, 200, `${MARKETPLACE}/dp/B000000001`, "B000000001", MARKETPLACE, MARKETPLACE_ID).kind).toBe("unavailable");
  });

  it("uses the current buybox merchant identity when Amazon omits the seller link", () => {
    const html = `<html><body><div id="desktop_buybox"><input id="ASIN" value="B000000002"><script type="a-state">{"asin":"B000000002","merchantId":"A1234567890"}</script><div id="merchantInfoFeature_feature_div"><span class="offer-display-feature-label">Verkäufer</span><span class="offer-display-feature-text-message">Verified Shop</span></div></div></body></html>`;
    expect(parseProductSellerPage(html, 200, `${MARKETPLACE}/dp/B000000002`, "B000000002", MARKETPLACE, MARKETPLACE_ID)).toMatchObject({
      kind: "success", sellerId: "A1234567890", sellerName: "Verified Shop",
    });
  });

  it("rejects a nominal HTTP 200 page without a verifiable product structure", () => {
    const html = `<html><body><div>generic Amazon response</div></body></html>`;
    expect(parseProductSellerPage(html, 200, `${MARKETPLACE}/dp/B000000003`, "B000000003", MARKETPLACE, MARKETPLACE_ID)).toMatchObject({
      kind: "error", error: "无法验证产品页面结构",
    });
  });
});
