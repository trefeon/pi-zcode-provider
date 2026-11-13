/**
 * ZCode Anthropic SSE → host AssistantEventStream translator.
 *
 * Full lifecycle support:
 *   - Thinking blocks (thinking_start / thinking_delta / thinking_end + signature_delta)
 *   - Text blocks (text_start / text_delta / text_end)
 *   - Tool use blocks (toolcall_start / toolcall_delta / toolcall_end with incremental JSON args)
 *   - Usage (input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
 *   - Stop reasons (end_turn → stop, max_tokens → length, tool_use → toolUse, refusal/sensitive → error)
 *   - HTTP 200 JSON error bodies (1005 quota exhausted, 1113 no resource package) & HTTP 4xx/5xx errors
 *   - Built-in retry on code 3009/3008 concurrency limits (up to 2 jittered retries before failing)
 */

import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
  ToolCall,
  Usage,
} from "@oh-my-pi/pi-ai";
import { setTimeout as delay } from "node:timers/promises";
import { ZCODE_START_URL, buildHeaders, buildRequestBody } from "./dress.ts";
import { createAssistantEventStream, type AssistantEventStream } from "./host/stream.ts";
import { asRecord } from "./json.ts";
import { isJwtExpired, type ZCodeCredentials } from "./keyring.ts";
const MAX_CONCURRENCY_RETRIES = 4;

export class ZCodeHttpError extends Error {
  readonly status: number;
  readonly code: number;

  constructor(message: string, status: number, code = 0) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
    case "sensitive":
      return "error";
    default:
      return "stop";
  }
}

function tryParseJsonObject(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    return asRecord(JSON.parse(json)) ?? {};
  } catch {
    return {};
  }
}

function classifyErrorPayload(status: number, text: string): ZCodeHttpError {
  let code = 0;
  let serverMsg = "";
  try {
    const parsed = asRecord(JSON.parse(text));
    if (parsed) {
      const c = parsed["code"] ?? asRecord(parsed["error"])?.["code"];
      if (typeof c === "number") code = c;
      else if (typeof c === "string" && /^\d+$/.test(c)) code = Number(c);
      const m = parsed["msg"] ?? asRecord(parsed["error"])?.["message"] ?? parsed["message"];
      if (typeof m === "string") serverMsg = m;
    }
  } catch { /* non-JSON body */ }

  if (code === 3012 || (status === 405 && !/html/i.test(text))) {
    return new ZCodeHttpError(
      `ZCode risk-control blocked request (405/3012): ${serverMsg || "check app version & spoof headers"}`,
      status || 405,
      3012,
    );
  }
  if (status === 405 && /html|errors\.aliyun/i.test(text)) {
    return new ZCodeHttpError(
      "ZCode edge firewall blocked requests from this IP (405). Wait a few minutes or change egress.",
      405,
      3012,
    );
  }
  if (code === 3009 || code === 3008) {
    return new ZCodeHttpError(
      `ZCode concurrency limit exceeded (${code}) — retry shortly.`,
      status || 429,
      code,
    );
  }
  if (code === 1005 || code === 1113) {
    return new ZCodeHttpError(
      `ZCode Start Plan quota exhausted (${code}) — run /zcode-balance or /zcode-claim to check free batches.`,
      429,
      code,
    );
  }
  if (code === 3006) {
    return new ZCodeHttpError(
      `Model not enabled on your active ZCode Start Plan (3006): ${serverMsg || "check /zcode-balance"}`,
      status || 400,
      3006,
    );
  }
  if (code === 1001 || status === 401) {
    return new ZCodeHttpError(
      "ZCode authentication failed (401/1001) — open ZCode Desktop to refresh your session or update ZCODE_JWT_TOKEN.",
      401,
      code || 1001,
    );
  }
  return new ZCodeHttpError(
    `ZCode API error ${status}${code ? ` (code ${code})` : ""}: ${serverMsg || text.slice(0, 200)}`,
    status,
    code,
  );
}

async function* parseSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let firstChunk = true;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      buf += chunkText;

      // ZCode sometimes answers HTTP 200 with a single JSON error envelope (e.g. code 1005 quota exhausted)
      if (firstChunk) {
        firstChunk = false;
        const trimmedStart = buf.trimStart();
        if (trimmedStart.startsWith("{")) {
          // Drain the rest of the small JSON body before throwing
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            buf += decoder.decode(next.value, { stream: true });
          }
          throw classifyErrorPayload(200, buf);
        }
      }

      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith("data:")) continue;
        const raw = trimmed.slice(5).trimStart();
        if (!raw || raw === "[DONE]") continue;
        try {
          const parsed = asRecord(JSON.parse(raw));
          if (parsed) yield parsed;
        } catch {
          // skip malformed SSE data frame
        }
      }
    }
    if (buf.trim().startsWith("data:")) {
      const raw = buf.trim().slice(5).trimStart();
      if (raw && raw !== "[DONE]") {
        try {
          const parsed = asRecord(JSON.parse(raw));
          if (parsed) yield parsed;
        } catch { /* ignore trailing fragment */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface StreamZCodeDeps {
  credentials: () => ZCodeCredentials;
  appVersion: () => string;
  sessionId: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Stream one ZCode Start Plan turn into a host-compatible AssistantEventStream. */
export function streamZCodeTurn(
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
  deps: StreamZCodeDeps,
): AssistantEventStream {
  const stream = createAssistantEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const startedAt = performance.now();
    let firstTokenAt: number | undefined;
    let committed = false;

    // Map Anthropic wire block index -> output.content index + active tool JSON accumulator
    const wireToContent = new Map<number, { index: number; type: "text" | "thinking" | "tool"; json: string }>();

    const pushStart = (): void => {
      if (committed) return;
      committed = true;
      stream.push({ type: "start", partial: output });
    };

    const closeWireBlock = (wireIdx: number): void => {
      const state = wireToContent.get(wireIdx);
      if (!state) return;
      wireToContent.delete(wireIdx);
      const block = output.content[state.index];
      if (!block) return;
      if (block.type === "text") {
        stream.push({ type: "text_end", contentIndex: state.index, content: block.text, partial: output });
      } else if (block.type === "thinking") {
        stream.push({ type: "thinking_end", contentIndex: state.index, content: block.thinking, partial: output });
      } else if (block.type === "toolCall") {
        block.arguments = tryParseJsonObject(state.json);
        stream.push({ type: "toolcall_end", contentIndex: state.index, toolCall: block, partial: output });
      }
    };

    const closeAllBlocks = (): void => {
      for (const idx of [...wireToContent.keys()]) closeWireBlock(idx);
    };

    try {
      const creds = deps.credentials();
      if (isJwtExpired(creds.jwt)) {
        throw new ZCodeHttpError(
          "ZCode session JWT has expired. Open ZCode Desktop to sign in again or update ZCODE_JWT_TOKEN.",
          401,
          1001,
        );
      }

      const appVersion = deps.appVersion();
      // Clamp max_tokens: ZCode caps at 128k; GLM-5.3-Flash's model max is 131072 (catalog clamp-output-to-model-max).
      // Use model.maxTokens as the ceiling when available (catalog already reflects the per-model cap).
      const modelCap = model.maxTokens ?? 128_000;
      const maxTokens = Math.min(Math.max(1, options.maxTokens ?? modelCap), modelCap);
      const body = buildRequestBody({
        model: model.id,
        maxTokens,
        context,
        supportsImages: model.input.includes("image"),
        options,
        deviceId: creds.deviceMid,
        sessionId: deps.sessionId,
      });

      const fetchFn = deps.fetchImpl ?? fetch;
      const fetchOnce = (): Promise<Response> =>
        fetchFn(ZCODE_START_URL, {
          method: "POST",
          headers: buildHeaders(creds.jwt, {
            appVersion,
            deviceMid: creds.deviceMid,
            sessionId: deps.sessionId,
          }),
          body,
          signal: options.signal,
        });
      const isConcurrencyCode = (code: number): boolean => code === 3008 || code === 3009;
      const concurrencyBackoff = (): Promise<void> =>
        delay(1200 * (attempt + 1) + Math.floor(Math.random() * 800), undefined, { signal: options.signal });

      // Concurrency limit (3008/3009): Start Plan allows ONE concurrent turn per account,
      // so the slot may be held by another live turn (OMP + Pi at once, desktop chat).
      // ZCode surfaces the limit three ways and all must retry:
      //   1. non-2xx HTTP status
      //   2. HTTP 200 with a JSON error envelope body
      //   3. mid-stream SSE `event: error` (or a first-frame JSON envelope)
      // Retrying is only safe while nothing has been emitted to the host stream
      // (`committed` false) — replaying mid-turn would duplicate blocks/events.
      let res: Response | null = null;
      let attempt = 0;
      let streamConsumed = false;
      let upstreamStop: StopReason = "stop";
      while (!streamConsumed) {
        if (options.signal?.aborted) break;
        res = await fetchOnce();

        const contentType = res.headers.get("content-type") ?? "";
        if (!res.ok || !res.body || contentType.includes("application/json")) {
          const errText = await res.text().catch(() => "");
          const classified = classifyErrorPayload(res.status, errText);
          if (isConcurrencyCode(classified.code) && !committed && attempt < MAX_CONCURRENCY_RETRIES) {
            attempt++;
            await concurrencyBackoff();
            continue;
          }
          throw classified;
        }

        try {
          for await (const ev of parseSseEvents(res.body)) {
        const type = ev["type"];

        if (type === "message_start") {
          const msgObj = asRecord(ev["message"]);
          const usage = asRecord(msgObj?.["usage"]);
          if (usage) {
            if (typeof usage["input_tokens"] === "number") output.usage.input = usage["input_tokens"];
            if (typeof usage["cache_read_input_tokens"] === "number") output.usage.cacheRead = usage["cache_read_input_tokens"];
            if (typeof usage["cache_creation_input_tokens"] === "number") output.usage.cacheWrite = usage["cache_creation_input_tokens"];
          }
          continue;
        }

        if (type === "content_block_start") {
          const wireIdx = typeof ev["index"] === "number" ? ev["index"] : 0;
          // Defensive: if the upstream reuses an index without a content_block_stop
          // (non-standard), flush the previous mapping so its block still gets an _end.
          closeWireBlock(wireIdx);
          const cb = asRecord(ev["content_block"]);
          const cbType = cb?.["type"];
          pushStart();
          if (cbType === "thinking") {
            output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
            const contentIndex = output.content.length - 1;
            wireToContent.set(wireIdx, { index: contentIndex, type: "thinking", json: "" });
            stream.push({ type: "thinking_start", contentIndex, partial: output });
          } else if (cbType === "text") {
            output.content.push({ type: "text", text: "" });
            const contentIndex = output.content.length - 1;
            wireToContent.set(wireIdx, { index: contentIndex, type: "text", json: "" });
            stream.push({ type: "text_start", contentIndex, partial: output });
          } else if (cbType === "tool_use") {
            const id = typeof cb?.["id"] === "string" ? cb["id"] : `zcode_${output.content.length}`;
            const name = typeof cb?.["name"] === "string" ? cb["name"] : "";
            const initialArgs = asRecord(cb?.["input"]) ?? {};
            const tc: ToolCall = { type: "toolCall", id, name, arguments: initialArgs };
            output.content.push(tc);
            const contentIndex = output.content.length - 1;
            wireToContent.set(wireIdx, { index: contentIndex, type: "tool", json: "" });
            stream.push({ type: "toolcall_start", contentIndex, partial: output });
          }
          continue;
        }

        if (type === "content_block_delta") {
          const wireIdx = typeof ev["index"] === "number" ? ev["index"] : 0;
          const state = wireToContent.get(wireIdx);
          const delta = asRecord(ev["delta"]);
          if (!state || !delta) continue;
          const dType = delta["type"];
          const block = output.content[state.index];
          if (!block) continue;

          if (dType === "text_delta" && typeof delta["text"] === "string" && block.type === "text") {
            block.text += delta["text"];
            firstTokenAt ??= performance.now();
            stream.push({ type: "text_delta", contentIndex: state.index, delta: delta["text"], partial: output });
          } else if (dType === "thinking_delta" && typeof delta["thinking"] === "string" && block.type === "thinking") {
            block.thinking += delta["thinking"];
            firstTokenAt ??= performance.now();
            stream.push({ type: "thinking_delta", contentIndex: state.index, delta: delta["thinking"], partial: output });
          } else if (dType === "signature_delta" && typeof delta["signature"] === "string" && block.type === "thinking") {
            block.thinkingSignature = (block.thinkingSignature ?? "") + delta["signature"];
          } else if (dType === "input_json_delta" && typeof delta["partial_json"] === "string" && block.type === "toolCall") {
            state.json += delta["partial_json"];
            block.arguments = tryParseJsonObject(state.json);
            firstTokenAt ??= performance.now();
            stream.push({ type: "toolcall_delta", contentIndex: state.index, delta: delta["partial_json"], partial: output });
          }
          continue;
        }

        if (type === "content_block_stop") {
          const wireIdx = typeof ev["index"] === "number" ? ev["index"] : 0;
          closeWireBlock(wireIdx);
          continue;
        }

        if (type === "message_delta") {
          const delta = asRecord(ev["delta"]);
          if (typeof delta?.["stop_reason"] === "string") {
            upstreamStop = mapStopReason(delta["stop_reason"]);
          }
          const usage = asRecord(ev["usage"]);
          if (usage) {
            if (typeof usage["input_tokens"] === "number") output.usage.input = usage["input_tokens"];
            if (typeof usage["output_tokens"] === "number") output.usage.output = usage["output_tokens"];
            if (typeof usage["cache_read_input_tokens"] === "number") output.usage.cacheRead = usage["cache_read_input_tokens"];
            if (typeof usage["cache_creation_input_tokens"] === "number") output.usage.cacheWrite = usage["cache_creation_input_tokens"];
          }
          continue;
        }

        if (type === "error") {
          const errObj = asRecord(ev["error"]);
          const code = typeof errObj?.["code"] === "number" ? errObj["code"] : 0;
          const msg = typeof errObj?.["message"] === "string" ? errObj["message"] : JSON.stringify(ev);
          throw new ZCodeHttpError(msg, 500, code);
        }
          } // for await (parseSseEvents)
          streamConsumed = true;
        } catch (err) {
          if (
            err instanceof ZCodeHttpError &&
            isConcurrencyCode(err.code) &&
            !committed &&
            attempt < MAX_CONCURRENCY_RETRIES
          ) {
            attempt++;
            await concurrencyBackoff();
            continue;
          }
          throw err;
        }
      } // while (retry window)

      closeAllBlocks();
      if (upstreamStop === "stop" && output.content.some((b) => b.type === "toolCall")) {
        upstreamStop = "toolUse";
      }
      output.stopReason = upstreamStop;
      output.usage.totalTokens =
        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
      output.duration = performance.now() - startedAt;
      if (firstTokenAt !== undefined) output.ttft = firstTokenAt - startedAt;

      const doneReason =
        output.stopReason === "length" ? "length" : output.stopReason === "toolUse" ? "toolUse" : "stop";
      stream.push({ type: "done", reason: doneReason, message: output });
      stream.end(output);
    } catch (err) {
      closeAllBlocks();
      output.duration = performance.now() - startedAt;
      if (firstTokenAt !== undefined) output.ttft = firstTokenAt - startedAt;

      if (options.signal?.aborted) {
        output.stopReason = "aborted";
        output.errorMessage = "Turn aborted";
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        return;
      }

      output.stopReason = "error";
      output.errorMessage = err instanceof Error ? err.message : String(err);
      if (err instanceof ZCodeHttpError && err.status > 0) output.errorStatus = err.status;
      stream.push({ type: "error", reason: "error", error: output });
      stream.end();
    }
  })();

  return stream;
}
