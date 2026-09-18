export interface ProductSeed {
  asin: string;
  sourceRow: number;
  sourceUrl: string;
  inputKind?: "product_link" | "seller_link_verification";
  expectedSellerId?: string;
  expectedSellerName?: string;
  expectedSellerProfileUrl?: string;
}

export type SourceFormat = "product_links" | "seller_links" | "seller_library";

export interface SourceInputStats {
  format: SourceFormat;
  sourceRows: number;
  duplicateRows: number;
  duplicateAsins: number;
  duplicateSellers: number;
  uniqueProducts: number;
  uniqueStores: number;
  appliedLimit: number;
}

export interface SourceInputResult {
  productSeeds: ProductSeed[];
  stats: SourceInputStats;
  sourceHash: string;
}

export interface ProductSellerResult {
  kind: "success" | "blocked" | "unavailable" | "error";
  error: string;
  asin: string;
  sellerId: string;
  sellerName: string;
  sellerProfileUrl: string;
  storeUrl: string;
  httpStatus: number;
  responseBytes: number;
  fetchMs: number;
  endpointPort: number;
}

export interface StoreAsinOccurrence {
  sellerId: string;
  asin: string;
  page: number;
  position: number;
  title: string;
  listingProductUrl: string;
  productUrl: string;
  imageUrl: string;
  reviewCount: number | null;
  rating: number | null;
  priceText: string;
  priceCents: number | null;
}

export type PageKind = "success" | "blocked" | "unavailable" | "error";

export interface StorePageWarning {
  code: string;
  message: string;
}

export interface StorePageParseResult {
  kind: PageKind;
  error: string;
  occurrences: StoreAsinOccurrence[];
  displayedName: string;
  nextUrl: string;
  signature: string;
  zeroResults: boolean;
  httpStatus: number;
  responseBytes: number;
  fetchMs: number;
  reportedTotal: number | null;
  visibleLastPage: number | null;
  endpointPort: number;
  completenessError: string;
}

export interface StoreRuntimeMetrics {
  browserContexts: number;
  browserPages: number;
  maxObservedConcurrency: number;
  p95FetchMs: number;
  refreshCount: number;
  restartCount: number;
  proxySwitchCount: number;
}

export interface AppConfig {
  projectRoot: string;
  configPath: string;
  configHash: string;
  source: { path: string; sheet: string; limit: number };
  amazon: { marketplace: string; site: string; marketplaceId: string; postcode: string; currency: "EUR" };
  browser: {
    headed: boolean;
    executablePath: string;
    controlPath: string;
    navigationTimeoutMs: number;
    requestTimeoutMs: number;
    wafWaitSeconds: number;
    pageRefreshAttempts: number;
    browserRestartAttempts: number;
    noResponseTimeoutMs: number;
    recoveryDelayMs: number;
  };
  stores: {
    concurrency: {
      initial: number;
      min: number;
      max: number;
      successWindowPages: number;
      cooldownMs: number;
    };
    requestsPerSecond: number;
    maxResponseBytes: number;
    maxRetries: number;
    maxBlockedAttempts: number;
    blockedDelayMs: number;
    maxPagesPerStore: number;
    fallbackMaxPagesPerStore: number;
    proxyPorts: number[];
  };
  sellerSprite: {
    serviceUrl: string;
    marketplace: string;
    batchSize: number;
    requestTimeoutMs: number;
  };
  filters: {
    maxReviewCountExclusive: number;
    minRatingInclusive: number;
    minPriceCentsInclusive: number;
    maxPriceCentsInclusive: number;
    maxVariations: number;
    maxAgeDays: number;
    sales7dDailySalesMinimum: number;
  };
  output: { root: string };
}

export const STAGES = ["import", "seller_discovery", "stores", "prefilter", "history_filter", "enrich", "filter", "sales_7d", "detail", "export"] as const;
export type StageName = (typeof STAGES)[number];
export type StageStatus = "pending" | "running" | "completed" | "partial" | "failed" | "paused" | "skipped";

export type LookupItemStatus = "ok" | "not_found" | "upstream_error";

export interface CompetitorLookupItem {
  asin: string;
  status: LookupItemStatus;
  title: string;
  nodeLabelPath: string;
  brand: string;
  brandUrl: string;
  imageUrl: string;
  bsrRank: number | null;
  childSales30d: number | null;
  availableDate: string;
  fulfillment: string;
  variationCount: number | null;
  buyboxSellerId: string;
  buyboxSellerName: string;
  errorCode: string;
  errorMessage: string;
}

export interface CompetitorLookupResult {
  marketplace: string;
  requested: number;
  succeeded: number;
  missing: number;
  errors: number;
  partial: boolean;
  items: CompetitorLookupItem[];
}

export type Sales7dThresholdResult = "yes" | "No";

export interface Sales7dResult {
  marketplace: string;
  asin: string;
  dataType: "prediction";
  asOfDate: string;
  windowStart: string;
  windowEnd: string;
  dailySalesMinimum: number;
  complete: boolean;
  result: Sales7dThresholdResult;
  days: Array<{ date: string; sales: number | null }>;
}

export interface AsinDetailResult {
  marketplace: string;
  asin: string;
  features: string[] | null;
  overviews: string | null;
}

export interface ExportRow {
  site: string;
  image_url: string;
  asin: string;
  product_url: string;
  store_name: string;
  store_url: string;
  child_sales_30d: number | null;
  sales_7d_minimum_met: "yes" | null;
  unit_price_cents: number;
  date_first_available: string;
  review_count: number | null;
  rating: number | null;
  fulfillment: string;
  variation_count: number;
  title: string;
  category: string;
  brand: string;
  brand_url: string;
  features_json: string | null;
  overviews: string | null;
}
