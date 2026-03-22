/**
 * Long-poll message monitor: receives WeChat messages and dispatches to AI agent.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getUpdates,
  sendMessage,
  sendMessageStreaming,
  sendTyping,
  getConfig,
  extractTextBody,
  type ApiConfig,
  type GetUpdatesResp,
  type WeixinMessage,
} from "./weixin-api.js";
import { DATA_DIR } from "./auth.js";
import type { AgentBackend } from "./agents/types.js";

const SYNC_BUF_FILE = path.join(DATA_DIR, "sync-buf.txt");
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const MAX_CHUNK_LEN = 4000;
const STREAM_THROTTLE_MS = 800;
const SESSION_EXPIRY_CODE = -14;
const SESSION_EXPIRY_INITIAL_WAIT_MS = 60_000;

const contextTokens = new Map<string, string>();

function loadSyncBuf(): string {
  try {
    if (fs.existsSync(SYNC_BUF_FILE)) {
      return fs.readFileSync(SYNC_BUF_FILE, "utf-8").trim();
    }
  } catch { /* ignore */ }
  return "";
}

function saveSyncBuf(buf: string): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SYNC_BUF_FILE, buf, "utf-8");
}

function chunkText(text: string): string[] {
  if (text.length <= MAX_CHUNK_LEN) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK_LEN) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX_CHUNK_LEN);
    if (splitAt < MAX_CHUNK_LEN / 2) splitAt = MAX_CHUNK_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function stripMarkdown(text: string): string {
  let result = text;
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");
  result = result.replace(/^#{1,6}\s+/gm, "");
  return result;
}

async function processMessage(
  cfg: ApiConfig,
  agent: AgentBackend,
  msg: WeixinMessage,
): Promise<void> {
  const userId = msg.from_user_id ?? "";
  const contextToken = msg.context_token ?? "";
  const textBody = extractTextBody(msg);

  if (!userId || !textBody) return;

  if (contextToken) {
    contextTokens.set(userId, contextToken);
  }

  const ct = contextTokens.get(userId);
  if (!ct) {
    console.log(`[monitor] 无 contextToken, 跳过 from=${userId}`);
    return;
  }

  console.log(`[monitor] 收到消息 from=${userId}: ${textBody.slice(0, 80)}${textBody.length > 80 ? "..." : ""}`);

  // Handle special commands
  if (textBody === "/reset" || textBody === "/清除") {
    agent.reset(userId);
    await sendMessage(cfg, userId, "✅ 对话已重置", ct);
    return;
  }

  if (textBody === "/help" || textBody === "/帮助") {
    await sendMessage(cfg, userId, [
      `🤖 微信 × ${agent.name}`,
      "",
      `直接发消息即可与 ${agent.name} 对话。`,
      "",
      "命令:",
      "/reset 或 /清除 — 重置对话",
      "/help 或 /帮助 — 显示帮助",
    ].join("\n"), ct);
    return;
  }

  // Send typing indicator
  let typingTicket: string | undefined;
  try {
    const config = await getConfig(cfg, userId, ct);
    typingTicket = config.typing_ticket;
    if (typingTicket) {
      await sendTyping(cfg, userId, typingTicket, 1);
    }
  } catch { /* best-effort */ }

  try {
    // Use streaming if agent supports it
    if (agent.askStream) {
      await processMessageStreaming(cfg, agent, userId, textBody, ct, typingTicket);
    } else {
      // Fallback: non-streaming path
      const response = await agent.ask(userId, textBody);

      // Strip markdown and send response in chunks
      const cleaned = stripMarkdown(response);
      const chunks = chunkText(cleaned);

      for (const chunk of chunks) {
        const latestCt = contextTokens.get(userId) ?? ct;
        await sendMessage(cfg, userId, chunk, latestCt);
      }

      console.log(`[monitor] 已回复 to=${userId} (${cleaned.length} chars)`);
    }
  } finally {
    // Always cancel typing indicator
    try {
      if (typingTicket) {
        await sendTyping(cfg, userId, typingTicket, 2);
      } else {
        const config = await getConfig(cfg, userId, ct);
        if (config.typing_ticket) {
          await sendTyping(cfg, userId, config.typing_ticket, 2);
        }
      }
    } catch { /* best-effort */ }
  }
}

async function processMessageStreaming(
  cfg: ApiConfig,
  agent: AgentBackend,
  userId: string,
  textBody: string,
  ct: string,
  typingTicket: string | undefined,
): Promise<void> {
  // Generate ONE client_id reused for all streaming updates to the same bubble
  const clientId = crypto.randomUUID();
  let lastSendTime = 0;
  let lastSentText = "";
  let pendingSend: ReturnType<typeof setTimeout> | null = null;
  let streamDone = false;
  let latestText = "";

  const sendUpdate = async (text: string, done: boolean) => {
    const cleaned = stripMarkdown(text);
    // Don't send if text hasn't changed
    if (cleaned === lastSentText && !done) return;

    const latestCt = contextTokens.get(userId) ?? ct;
    try {
      await sendMessageStreaming(cfg, userId, cleaned, latestCt, clientId, done);
      lastSentText = cleaned;
      lastSendTime = Date.now();
    } catch (err) {
      console.error(`[monitor] 流式发送出错:`, err);
    }

    // Refresh typing indicator during streaming
    if (!done && typingTicket) {
      try {
        await sendTyping(cfg, userId, typingTicket, 1);
      } catch { /* best-effort */ }
    }
  };

  const onChunk = (text: string, done: boolean) => {
    latestText = text;

    if (done) {
      streamDone = true;
      // Cancel any pending throttled send
      if (pendingSend) {
        clearTimeout(pendingSend);
        pendingSend = null;
      }
      return;
    }

    // Throttle: send at most once per STREAM_THROTTLE_MS
    const now = Date.now();
    const elapsed = now - lastSendTime;

    if (elapsed >= STREAM_THROTTLE_MS) {
      // Can send immediately
      if (pendingSend) {
        clearTimeout(pendingSend);
        pendingSend = null;
      }
      sendUpdate(text, false).catch(() => {});
    } else if (!pendingSend) {
      // Schedule a send after remaining throttle time
      const remaining = STREAM_THROTTLE_MS - elapsed;
      pendingSend = setTimeout(() => {
        pendingSend = null;
        sendUpdate(latestText, false).catch(() => {});
      }, remaining);
    }
    // If pendingSend already exists, the scheduled send will pick up latestText
  };

  console.log(`[monitor] 开始流式回复 to=${userId}`);

  const response = await agent.askStream!(userId, textBody, onChunk);

  // Cancel any pending throttled send
  if (pendingSend) {
    clearTimeout(pendingSend);
    pendingSend = null;
  }

  // Send final message with FINISH state
  const finalText = stripMarkdown(response || latestText);
  if (finalText) {
    const latestCt = contextTokens.get(userId) ?? ct;
    await sendMessageStreaming(cfg, userId, finalText, latestCt, clientId, true);
  }

  console.log(`[monitor] 流式回复完成 to=${userId} (${finalText.length} chars)`);
}

export async function startMonitor(
  cfg: ApiConfig,
  agent: AgentBackend,
  abortSignal?: AbortSignal,
): Promise<void> {
  console.log(`[monitor] 微信消息监听已启动 (agent: ${agent.name})`);
  console.log(`[monitor] API: ${cfg.baseUrl}`);

  let getUpdatesBuf = loadSyncBuf();
  let nextTimeoutMs = 35_000;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp: GetUpdatesResp = await getUpdates(cfg, getUpdatesBuf, nextTimeoutMs);

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isError = (resp.ret !== undefined && resp.ret !== 0) ||
                      (resp.errcode !== undefined && resp.errcode !== 0);
      if (isError) {
        // Detect WeChat session expiry (error code -14)
        if (resp.errcode === SESSION_EXPIRY_CODE || resp.ret === SESSION_EXPIRY_CODE) {
          console.error(`[monitor] ⚠️ 微信会话已过期 (code=${SESSION_EXPIRY_CODE})，需要重新登录!`);
          console.error(`[monitor] 请重新运行 weixin-ai-bridge 进行二维码扫码登录。`);
          console.error(`[monitor] 暂停所有 API 调用，等待重试...`);
          let sessionRetryWait = SESSION_EXPIRY_INITIAL_WAIT_MS;
          const maxSessionRetryWait = 10 * 60_000; // max 10 minutes
          while (!abortSignal?.aborted) {
            await sleep(sessionRetryWait, abortSignal);
            if (abortSignal?.aborted) break;
            console.log(`[monitor] 尝试重新连接微信...`);
            try {
              const retryResp = await getUpdates(cfg, getUpdatesBuf, 5000);
              const retryIsExpired = retryResp.errcode === SESSION_EXPIRY_CODE || retryResp.ret === SESSION_EXPIRY_CODE;
              if (!retryIsExpired) {
                console.log(`[monitor] 微信会话已恢复!`);
                if (retryResp.get_updates_buf) {
                  saveSyncBuf(retryResp.get_updates_buf);
                  getUpdatesBuf = retryResp.get_updates_buf;
                }
                break;
              }
            } catch { /* retry again */ }
            sessionRetryWait = Math.min(sessionRetryWait * 2, maxSessionRetryWait);
            console.error(`[monitor] 微信仍未恢复，${Math.round(sessionRetryWait / 1000)}s 后重试...`);
          }
          consecutiveFailures = 0;
          continue;
        }

        consecutiveFailures++;
        console.error(`[monitor] getUpdates 错误: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[monitor] 连续失败 ${MAX_CONSECUTIVE_FAILURES} 次, 等待 30s...`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf) {
        saveSyncBuf(resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        try {
          await processMessage(cfg, agent, msg);
        } catch (err) {
          console.error(`[monitor] 处理消息出错:`, err);
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) break;
      consecutiveFailures++;
      console.error(`[monitor] 轮询出错 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }

  console.log("[monitor] 监听已停止");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
