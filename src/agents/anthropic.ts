/**
 * Agent backend: Anthropic Claude API (raw fetch, no SDK dependency).
 */

import type { AgentBackend } from "./types.js";
import { sanitizeErrorMessage } from "./sanitize.js";

type Message = { role: "user" | "assistant"; content: string };

const FETCH_TIMEOUT_MS = 120_000; // 120s
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGES_BEFORE_COMPRESS = 20;

function compressHistory(history: Message[]): Message[] {
  if (history.length <= MAX_MESSAGES_BEFORE_COMPRESS) return history;
  // Anthropic has no system message in history, so keep first 5, summary, last 10
  const early = history.slice(0, 5);
  const recent = history.slice(-10);
  const summary: Message = {
    role: "assistant",
    content: "[earlier conversation summarized]",
  };
  return [...early, summary, ...recent];
}

export class AnthropicAgent implements AgentBackend {
  name: string;
  private apiKey: string;
  private apiBase: string;
  private model: string;
  private systemPrompt: string;
  private conversations = new Map<string, Message[]>();
  private lastActivity = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(opts: { apiKey: string; model: string; apiBase: string; systemPrompt?: string }) {
    this.apiKey = opts.apiKey;
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt || "你是一个有用的 AI 助手。回答简洁。";
    this.name = `Anthropic (${this.model})`;

    // Periodic cleanup of idle conversations
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [userId, ts] of this.lastActivity) {
        if (now - ts > IDLE_TIMEOUT_MS) {
          this.conversations.delete(userId);
          this.lastActivity.delete(userId);
          console.log(`[anthropic] 清理闲置会话: ${userId}`);
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }

  async ask(userId: string, message: string): Promise<string> {
    if (!this.apiKey) return "⚠️ 未设置 API Key。用 --api-key 或 ANTHROPIC_API_KEY 环境变量配置。";

    this.lastActivity.set(userId, Date.now());

    let history = this.conversations.get(userId);
    if (!history) {
      history = [];
      this.conversations.set(userId, history);
    }
    history.push({ role: "user", content: message });

    // Auto-compress conversation history
    if (history.length > MAX_MESSAGES_BEFORE_COMPRESS) {
      history = compressHistory(history);
      this.conversations.set(userId, history);
    }

    const startTime = Date.now();
    console.log(`[anthropic] 调用 ${this.model} (${history.length} msgs)`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.apiBase}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: this.systemPrompt,
          messages: history,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`${res.status}: ${err}`);
      }

      const data = await res.json() as {
        content: { type: string; text: string }[];
      };
      const reply = data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      history.push({ role: "assistant", content: reply });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[anthropic] 完成 (${elapsed}s, ${reply.length} chars)`);
      return reply || "[无回复]";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[anthropic] 错误:`, msg);
      return `⚠️ Anthropic 出错: ${sanitizeErrorMessage(msg)}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  async askStream(userId: string, message: string, onChunk: (text: string, done: boolean) => void): Promise<string> {
    if (!this.apiKey) return "⚠️ 未设置 API Key。用 --api-key 或 ANTHROPIC_API_KEY 环境变量配置。";

    this.lastActivity.set(userId, Date.now());

    let history = this.conversations.get(userId);
    if (!history) {
      history = [];
      this.conversations.set(userId, history);
    }
    history.push({ role: "user", content: message });

    if (history.length > MAX_MESSAGES_BEFORE_COMPRESS) {
      history = compressHistory(history);
      this.conversations.set(userId, history);
    }

    const startTime = Date.now();
    console.log(`[anthropic] 流式调用 ${this.model} (${history.length} msgs)`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(`${this.apiBase}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: this.systemPrompt,
          messages: history,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`${res.status}: ${err}`);
      }

      let accumulated = "";
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("event: ")) {
            currentEvent = trimmed.slice(7);
            continue;
          }
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);

          try {
            const parsed = JSON.parse(payload);
            if (currentEvent === "content_block_delta" && parsed.delta?.text) {
              accumulated += parsed.delta.text;
              onChunk(accumulated, false);
            } else if (currentEvent === "message_stop") {
              onChunk(accumulated, true);
            }
          } catch { /* skip malformed lines */ }
          currentEvent = "";
        }
      }

      // Ensure done is signalled
      if (accumulated) {
        onChunk(accumulated, true);
      }

      history.push({ role: "assistant", content: accumulated });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[anthropic] 流式完成 (${elapsed}s, ${accumulated.length} chars)`);
      return accumulated || "[无回复]";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[anthropic] 流式错误:`, msg);
      return `⚠️ Anthropic 出错: ${sanitizeErrorMessage(msg)}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  reset(userId: string): void {
    this.conversations.delete(userId);
    this.lastActivity.delete(userId);
  }
}
