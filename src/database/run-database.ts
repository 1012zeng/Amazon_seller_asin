import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const SCHEMA_VERSION = 18;

export class RunDatabase {
  readonly runDir: string;
  readonly dbPath: string;
  readonly connection: Database.Database;
  readonly schemaVersion: number;

  constructor(runDir: string, options: { readonly?: boolean } = {}) {
    this.runDir = path.resolve(runDir);
    this.dbPath = path.join(this.runDir, "state.sqlite");
    const readonly = options.readonly === true;
    const existed = existsSync(this.dbPath);
    if (!readonly) mkdirSync(this.runDir, { recursive: true });
    this.connection = new Database(this.dbPath, readonly ? { readonly: true, fileMustExist: true } : undefined);
    this.connection.pragma("busy_timeout = 5000");
    this.connection.pragma("foreign_keys = ON");
    const version = this.connection.pragma("user_version", { simple: true }) as number;
    this.schemaVersion = existed ? version : SCHEMA_VERSION;
    if (existed && version !== SCHEMA_VERSION) {
      this.connection.close();
      throw new Error(`Run schema ${version} is incompatible with required schema ${SCHEMA_VERSION}; create a new run`);
    }
    if (!readonly && !existed) {
      this.connection.pragma("journal_mode = WAL");
      this.connection.pragma("synchronous = NORMAL");
      this.createSchema();
    }
  }

  private createSchema(): void {
    this.connection.exec(`
      CREATE TABLE run_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        run_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        current_stage TEXT NOT NULL,
        complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
        partial INTEGER NOT NULL DEFAULT 0 CHECK(partial IN (0,1)),
        config_path TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        config_json TEXT NOT NULL CHECK(json_valid(config_json)),
        contract_hash TEXT NOT NULL,
        workflow TEXT NOT NULL,
        code_fingerprint TEXT NOT NULL,
        effective_config_hash TEXT NOT NULL,
        release_json TEXT NOT NULL CHECK(json_valid(release_json)),
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_sheet TEXT NOT NULL,
        source_stats_json TEXT NOT NULL CHECK(json_valid(source_stats_json)),
        run_started_at TEXT NOT NULL,
        as_of_date TEXT NOT NULL,
        store_snapshot_sealed_at TEXT NOT NULL DEFAULT '',
        seller_discovery_runtime_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(seller_discovery_runtime_json)),
        store_runtime_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(store_runtime_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE run_stages (
        stage TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE source_seller_inputs (
        source_row INTEGER PRIMARY KEY,
        raw_name TEXT NOT NULL,
        raw_link TEXT NOT NULL,
        seller_id TEXT NOT NULL,
        status TEXT NOT NULL,
        first_source_row INTEGER,
        selected INTEGER NOT NULL CHECK(selected IN (0,1))
      );
      CREATE TABLE source_products (
        asin TEXT PRIMARY KEY,
        source_row INTEGER NOT NULL,
        source_url TEXT NOT NULL,
        input_kind TEXT NOT NULL DEFAULT 'product_link' CHECK(input_kind IN ('product_link','seller_link_verification')),
        expected_seller_id TEXT NOT NULL DEFAULT '',
        expected_seller_name TEXT NOT NULL DEFAULT '',
        expected_seller_profile_url TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        seller_id TEXT NOT NULL DEFAULT '',
        seller_name TEXT NOT NULL DEFAULT '',
        seller_profile_url TEXT NOT NULL DEFAULT '',
        store_url TEXT NOT NULL DEFAULT '',
        http_status INTEGER,
        response_bytes INTEGER,
        fetch_ms INTEGER,
        endpoint_port INTEGER,
        seller_match INTEGER CHECK(seller_match IS NULL OR seller_match IN (0,1)),
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT ''
      ) WITHOUT ROWID;
      CREATE INDEX idx_source_products_status ON source_products(status,source_row);
      CREATE TABLE source_stores (
        seller_id TEXT PRIMARY KEY,
        source_row INTEGER NOT NULL,
        source_name TEXT NOT NULL,
        source_profile_url TEXT NOT NULL,
        store_url TEXT NOT NULL,
        verified_source_asin TEXT NOT NULL,
        input_seller_id TEXT NOT NULL DEFAULT '',
        identity_status TEXT NOT NULL DEFAULT 'not_provided' CHECK(identity_status IN ('not_provided','matched','mismatched','direct_input')),
        live_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        crawl_round INTEGER NOT NULL DEFAULT 1 CHECK(crawl_round IN (1,2)),
        pagination_mode TEXT NOT NULL DEFAULT 'unknown' CHECK(pagination_mode IN ('unknown','fixed_total','next_fallback')),
        expected_last_page INTEGER CHECK(expected_last_page IS NULL OR expected_last_page >= 1),
        pagination_warning_count INTEGER NOT NULL DEFAULT 0 CHECK(pagination_warning_count >= 0),
        page_count INTEGER NOT NULL DEFAULT 0,
        first_pass_evidence TEXT NOT NULL DEFAULT '',
        completeness_evidence TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE store_pages (
        seller_id TEXT NOT NULL,
        crawl_round INTEGER NOT NULL CHECK(crawl_round IN (1,2)),
        page INTEGER NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        blocked_count INTEGER NOT NULL DEFAULT 0,
        result_count INTEGER NOT NULL DEFAULT 0,
        next_url TEXT NOT NULL DEFAULT '',
        page_signature TEXT NOT NULL DEFAULT '',
        http_status INTEGER,
        response_bytes INTEGER,
        fetch_ms INTEGER,
        reported_total INTEGER,
        visible_last_page INTEGER CHECK(visible_last_page IS NULL OR visible_last_page >= 1),
        warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
        endpoint_port INTEGER,
        available_at TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(seller_id,crawl_round,page),
        FOREIGN KEY(seller_id) REFERENCES source_stores(seller_id)
      ) WITHOUT ROWID;
      CREATE INDEX idx_store_pages_queue ON store_pages(status,available_at,seller_id,crawl_round,page);
      CREATE TABLE store_asin_occurrences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_id TEXT NOT NULL,
        asin TEXT NOT NULL,
        crawl_round INTEGER NOT NULL CHECK(crawl_round IN (1,2)),
        page INTEGER NOT NULL,
        position INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        listing_product_url TEXT NOT NULL DEFAULT '',
        product_url TEXT NOT NULL,
        image_url TEXT NOT NULL DEFAULT '',
        review_count INTEGER,
        rating REAL,
        price_text TEXT NOT NULL DEFAULT '',
        price_cents INTEGER,
        captured_at TEXT NOT NULL,
        UNIQUE(seller_id,crawl_round,page,position,asin),
        FOREIGN KEY(seller_id) REFERENCES source_stores(seller_id)
      );
      CREATE INDEX idx_occurrences_asin ON store_asin_occurrences(asin);
      CREATE TABLE asin_candidates (
        asin TEXT PRIMARY KEY,
        seller_id TEXT NOT NULL,
        occurrence_id INTEGER NOT NULL UNIQUE,
        state TEXT NOT NULL,
        filter_stage TEXT NOT NULL DEFAULT '',
        filter_reason TEXT NOT NULL DEFAULT '',
        age_days INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        store_name TEXT NOT NULL DEFAULT '',
        store_url TEXT NOT NULL DEFAULT '',
        seller_profile_url TEXT NOT NULL DEFAULT '',
        page INTEGER,
        position INTEGER,
        listing_title TEXT NOT NULL DEFAULT '',
        listing_product_url TEXT NOT NULL DEFAULT '',
        product_url TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        review_count INTEGER,
        rating REAL,
        price_text TEXT NOT NULL DEFAULT '',
        price_cents INTEGER,
        enriched_image_url TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        brand TEXT NOT NULL DEFAULT '',
        brand_url TEXT NOT NULL DEFAULT '',
        bsr_rank INTEGER,
        child_sales_30d INTEGER,
        available_date TEXT NOT NULL DEFAULT '',
        fulfillment TEXT NOT NULL DEFAULT '',
        variation_count INTEGER,
        buybox_seller_id TEXT NOT NULL DEFAULT '',
        buybox_seller_name TEXT NOT NULL DEFAULT '',
        sales_7d_minimum_met TEXT CHECK(sales_7d_minimum_met IS NULL OR sales_7d_minimum_met='yes'),
        sales_7d_result TEXT CHECK(sales_7d_result IS NULL OR sales_7d_result IN ('yes','No')),
        sales_7d_complete INTEGER CHECK(sales_7d_complete IS NULL OR sales_7d_complete IN (0,1)),
        sales_7d_daily_minimum INTEGER CHECK(sales_7d_daily_minimum IS NULL OR sales_7d_daily_minimum>=1),
        sales_window_start TEXT NOT NULL DEFAULT '',
        sales_window_end TEXT NOT NULL DEFAULT '',
        sales_7d_days_json TEXT CHECK(sales_7d_days_json IS NULL OR json_valid(sales_7d_days_json)),
        detail_state TEXT NOT NULL DEFAULT '',
        features_json TEXT CHECK(features_json IS NULL OR json_valid(features_json)),
        overviews TEXT,
        FOREIGN KEY(seller_id) REFERENCES source_stores(seller_id),
        FOREIGN KEY(occurrence_id) REFERENCES store_asin_occurrences(id)
      ) WITHOUT ROWID;
      CREATE INDEX idx_candidates_state ON asin_candidates(state,asin);
      CREATE INDEX idx_candidates_audit ON asin_candidates(state,child_sales_30d,available_date,asin);
      CREATE TABLE mcp_batches (
        round INTEGER NOT NULL CHECK(round IN (1,2)),
        batch_ordinal INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER,
        not_found_count INTEGER,
        error_count INTEGER,
        stop_reason TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(round,batch_ordinal)
      ) WITHOUT ROWID;
      CREATE TABLE mcp_batch_items (
        round INTEGER NOT NULL,
        batch_ordinal INTEGER NOT NULL,
        item_ordinal INTEGER NOT NULL,
        asin TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error_code TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(round,batch_ordinal,item_ordinal),
        UNIQUE(round,asin),
        FOREIGN KEY(round,batch_ordinal) REFERENCES mcp_batches(round,batch_ordinal),
        FOREIGN KEY(asin) REFERENCES asin_candidates(asin)
      ) WITHOUT ROWID;
      CREATE TABLE enrichments (
        asin TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        node_label_path TEXT NOT NULL DEFAULT '',
        brand TEXT NOT NULL DEFAULT '',
        brand_url TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        bsr_rank INTEGER,
        child_sales_30d INTEGER,
        available_date TEXT NOT NULL,
        fulfillment TEXT NOT NULL,
        variation_count INTEGER,
        buybox_seller_id TEXT NOT NULL DEFAULT '',
        buybox_seller_name TEXT NOT NULL DEFAULT '',
        enriched_at TEXT NOT NULL,
        FOREIGN KEY(asin) REFERENCES asin_candidates(asin)
      ) WITHOUT ROWID;
      CREATE TABLE sales_7d_tasks (
        asin TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        as_of_date TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        daily_sales_minimum INTEGER NOT NULL CHECK(daily_sales_minimum>=1),
        result TEXT CHECK(result IS NULL OR result IN ('yes','No')),
        days_json TEXT CHECK(days_json IS NULL OR json_valid(days_json)),
        filter_reason TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(asin) REFERENCES asin_candidates(asin)
      ) WITHOUT ROWID;
      CREATE INDEX idx_sales_tasks_state ON sales_7d_tasks(state,asin);
      CREATE TABLE cleaned_products (
        asin TEXT PRIMARY KEY,
        seller_id TEXT NOT NULL,
        occurrence_id INTEGER NOT NULL UNIQUE,
        site TEXT NOT NULL,
        image_url TEXT NOT NULL DEFAULT '',
        product_url TEXT NOT NULL,
        store_name TEXT NOT NULL,
        store_url TEXT NOT NULL,
        child_sales_30d INTEGER,
        sales_7d_minimum_met TEXT CHECK(sales_7d_minimum_met IS NULL OR sales_7d_minimum_met='yes'),
        unit_price_cents INTEGER NOT NULL,
        date_first_available TEXT NOT NULL,
        review_count INTEGER NOT NULL,
        rating REAL NOT NULL,
        fulfillment TEXT NOT NULL,
        variation_count INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        brand TEXT NOT NULL DEFAULT '',
        brand_url TEXT NOT NULL DEFAULT '',
        features_json TEXT CHECK(features_json IS NULL OR json_valid(features_json)),
        overviews TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(asin) REFERENCES asin_candidates(asin),
        FOREIGN KEY(occurrence_id) REFERENCES store_asin_occurrences(id)
      ) WITHOUT ROWID;
      CREATE TABLE asin_detail_tasks (
        asin TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','failed','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(asin) REFERENCES cleaned_products(asin) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX idx_detail_tasks_state ON asin_detail_tasks(state,asin);
      PRAGMA user_version = 18;
    `);
    this.connection.pragma("user_version = 18");
    this.createAuditView();
  }

  private createAuditView(): void {
    this.connection.exec(`
      CREATE VIEW IF NOT EXISTS asin_candidates_audit AS
      SELECT asin,state,filter_stage,filter_reason,seller_id,store_name,store_url,seller_profile_url,page,position,
        listing_title,listing_product_url,product_url,image_url,review_count,rating,price_text,price_cents,
        enriched_image_url,title,category,brand,brand_url,bsr_rank,child_sales_30d,available_date,fulfillment,variation_count,
        buybox_seller_id,buybox_seller_name,sales_7d_minimum_met,sales_7d_result,sales_7d_complete,sales_7d_daily_minimum,
        sales_window_start,sales_window_end,sales_7d_days_json,detail_state,features_json,overviews,age_days,created_at,updated_at
      FROM asin_candidates
    `);
  }

  integrityCheck(): string {
    return String(this.connection.pragma("integrity_check", { simple: true }));
  }

  close(): void {
    this.connection.close();
  }
}
