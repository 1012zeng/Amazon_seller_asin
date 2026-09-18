import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunStore } from "../database/run-store.js";

/** 事件类型到中文描述的映射 */
const EVENT_TYPE_MESSAGES: Record<string, string> = {
  // 运行初始化
  "run_initialized": "运行初始化完成",
  // 卖家发现阶段
  "seller_discovery_context_ready": "卖家发现浏览器就绪",
  "seller_discovery_product_completed": "成功发现卖家",
  "seller_discovery_product_failed": "未找到卖家",
  "seller_discovery_completed": "卖家发现阶段完成",
  "seller_discovery_paused": "卖家发现阶段暂停",
  // 店铺爬取阶段
  "store_context_ready": "店铺浏览器就绪",
  "store_discovery_context_ready": "店铺发现浏览器就绪",
  "store_pagination_boundary_detected": "检测到分页边界",
  "store_page_warning": "页面验证警告",
  "store_page_failure": "页面爬取失败",
  "store_page_peer_requeued": "页面重新入队",
  "store_concurrency_reduced": "并发数降低",
  "store_page_validation_warning": "页面验证警告",
  "store_page_reprobe_scheduled": "计划重新探测",
  "store_page_quarantined": "页面被隔离",
  "store_reprobe_context_restart_started": "开始重启上下文",
  "store_reprobe_context_ready": "重探上下文就绪",
  "store_reprobe_context_restart_failed": "重探上下文重启失败",
  "store_recovery_started": "开始恢复",
  "store_refresh_failed": "刷新失败",
  "store_restart_failed": "重启失败",
  "store_page_reprobe_started": "开始重探页面",
  "stores_completed": "店铺爬取完成",
  "stores_paused": "店铺爬取暂停",
  "stores_failed": "店铺爬取失败",
  // 销售数据阶段
  "sales_7d_completed": "7天销售数据查询完成",
  "sales_7d_stage_completed": "销售数据阶段完成",
  "sales_7d_paused": "销售数据阶段暂停",
  // 过滤阶段
  "prefilter_completed": "预过滤完成",
  "prefilter_failed": "预过滤失败",
  "history_filter_completed": "历史过滤完成",
  "history_filter_paused": "历史过滤暂停",
  "filter_completed": "过滤完成",
  "filter_failed": "过滤失败",
  // 详情阶段
  "asin_detail_completed": "ASIN详情获取完成",
  "asin_detail_stage_completed": "详情阶段完成",
  "asin_detail_paused": "详情阶段暂停",
  // 丰富化阶段
  "mcp_batch_started": "MCP批次开始",
  "mcp_batch_completed": "MCP批次完成",
  "mcp_round2_stopped": "MCP第二轮停止",
  "enrichment_completed": "数据丰富化完成",
  "enrichment_paused": "数据丰富化暂停",
  // 导出阶段
  "export_completed": "导出完成",
  "export_failed": "导出失败",
};

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function truncateError(error: unknown): string {
  return (error instanceof Error ? error.stack || error.message : String(error ?? "")).slice(0, 4_000);
}

export function appendEvent(runDir: string, type: string, payload: Record<string, unknown> = {}): void {
  mkdirSync(runDir, { recursive: true });
  const message = EVENT_TYPE_MESSAGES[type] ?? type;
  appendFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), type, message, ...payload })}\n`, "utf8");
}

export function writeSummary(store: RunStore): void {
  writeFileSync(path.join(store.runDir, "summary.json"), `${JSON.stringify(store.summary(), null, 2)}\n`, "utf8");
}

export function randomDelay(minimum: number, maximum: number): number {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}
