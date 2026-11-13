/**
 * Deterministic tests for pi-zcode-provider request dressing, SSE stream translation,
 * and balance/claim parsing.
 */

import { describe, expect, test } from "bun:test";
import type { Context, Effort, Model } from "@oh-my-pi/pi-ai";
import { activeBalanceModels } from "../src/claims.ts";
import { buildHeaders, buildRequestBody } from "../src/dress.ts";
import { streamZCodeTurn } from "../src/stream.ts";

describe("dress.ts spoofing", () => {
  test("produces exact 3 cached system blocks, context prefix, user_id metadata, and tail-only cache_control", () => {
    const context: Context = {
      systemPrompt: ["Be concise."],
      messages: [
        { role: "user", content: [{ type: "text", text: "First" }], timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thought", thinkingSignature: "sig-abc" },
            { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
          ],
          api: "zcode-start-plan-api",
          provider: "zcode",
          model: "GLM-5.3-Flash",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "file-a" }],
          isError: false,
          timestamp: 3,
        },
        {
          role: "toolResult",
          toolCallId: "call_2",
          toolName: "read",
          content: [{ type: "text", text: "file-b" }],
          isError: false,
          timestamp: 4,
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    };

    const body = JSON.parse(
      buildRequestBody({
        model: "GLM-5.3-Flash",
        maxTokens: 4096,
        context,
        supportsImages: true,
        options: { reasoning: "low" as Effort, cwd: "D:/repo" },
        deviceId: "dev-123",
        sessionId: "sess-456",
      }),
    ) as Record<string, unknown>;

    // 1. Exactly 3 system blocks, CLI prefix first, owner system inside block 3
    const system = body["system"] as Array<{ text: string; cache_control?: { type: string } }>;
    const [sys0, sys1, sys2] = system;
    expect(system).toHaveLength(3);
    expect(sys0?.text).toBe("You are ZCode, an interactive agent");
    expect(sys1?.text).toContain("# ZCode Desktop Context");
    expect(sys2?.text).toContain("You are powered by the model named zai-api/GLM-5.3-Flash.");
    expect(sys2?.text).toContain("Be concise.");
    expect(sys2?.text).toContain("Primary working directory: D:/repo");

    // 2. Context prefix injected as first user message; consecutive toolResults merged into one user turn
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const [m0, m1, m2, m3] = messages;
    expect(m0?.role).toBe("user");
    expect(String(m0?.content[0]?.["text"])).toMatch(/^<system-reminder>Today's date is \d{4}-\d{2}-\d{2}\.<\/system-reminder>$/);

    // First msg (contextPrefix) + "First" + assistant + merged toolResult = 4 messages total
    expect(messages).toHaveLength(4);
    expect(m1?.content[0]?.["cache_control"]).toBeUndefined();
    expect(m2?.role).toBe("assistant");
    // thinking block (signed) replayed before tool_use
    expect(m2?.content).toEqual([
      { type: "thinking", thinking: "thought", signature: "sig-abc" },
      { type: "tool_use", id: "call_1", name: "read", input: { path: "a.ts" } },
    ]);

    // Merged tool results carry both id and tool_use_id, and ONLY the very last block has cache_control
    expect(m3?.role).toBe("user");
    expect(m3?.content).toHaveLength(2);
    expect(m3?.content[0]?.["id"]).toBe("call_1");
    expect(m3?.content[0]?.["tool_use_id"]).toBe("call_1");
    expect(m3?.content[0]?.["cache_control"]).toBeUndefined();
    expect(m3?.content[1]?.["id"]).toBe("call_2");
    expect(m3?.content[1]?.["cache_control"]).toEqual({ type: "ephemeral" });

    // 3. Tools never carry cache_control or defer_loading
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.["cache_control"]).toBeUndefined();

    // 4. metadata.user_id matches ZCode JSON structure
    const metadata = body["metadata"] as { user_id: string };
    expect(JSON.parse(metadata.user_id)).toEqual({
      device_id: "dev-123",
      account_uuid: "",
      session_id: "sess-456",
    });

    // 5. Reasoning effort mapped for GLM-5.3-Flash
    expect(body["thinking"]).toEqual({ type: "enabled" });
    expect(body["output_config"]).toEqual({ effort: "low" });
  });

  test("replays unsigned thinking blocks with signature:\"\" (replayUnsignedThinking=true per OMP source)", () => {
    // A thinking block with no signature (thinkingSignature: "") must still be replayed.
    // The Z.AI Start Plan endpoint is a non-signing endpoint and accepts unsigned thinking
    // as opaque continuation hints. Dropping them breaks multi-turn reasoning chains.
    const body = JSON.parse(
      buildRequestBody({
        model: "GLM-5.3-Flash",
        maxTokens: 4096,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "go" }],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should call noop.", signature: "" },
              { type: "tool_use", id: "call_1", name: "noop", input: { x: 1 } },
            ],
          },
        ],
        deviceId: "d1",
        sessionId: "s1",
        options: { reasoning: "high" as Effort },
      }),
    ) as Record<string, unknown>;

    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    // messages[0]=contextPrefix, [1]=user "go", [2]=assistant
    const assistantMsg = messages[2];
    expect(assistantMsg?.role).toBe("assistant");
    expect(assistantMsg?.content).toHaveLength(2);
    expect(assistantMsg?.content[0]).toMatchObject({
      type: "thinking",
      thinking: "I should call noop.",
      signature: "", // must be "" not omitted
    });
    expect(assistantMsg?.content[1]).toMatchObject({ type: "tool_use", id: "call_1" });
  });

  test("context_management sent when thinking is active, absent when not", () => {
    const makeBody = (model: string, reasoning?: Effort) =>
      JSON.parse(
        buildRequestBody({
          model,
          maxTokens: 1024,
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          deviceId: "d",
          sessionId: "s",
          options: { reasoning },
        }),
      ) as Record<string, unknown>;

    // GLM-5.3 always has thinking enabled → context_management present
    const b53 = makeBody("GLM-5.3", "high" as Effort);
    expect(b53["context_management"]).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });

    // GLM-5.3-Flash: mandatory thinking, always present even without effort
    const b53f = makeBody("GLM-5.3-Flash");
    expect(b53f["context_management"]).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });

    // GLM-4 (non-5): no thinking → no context_management
    const b4 = makeBody("glm-4-flash");
    expect(b4["context_management"]).toBeUndefined();
  });

  test("toWellFormedDeep sanitizes lone-surrogate chars in tool arguments", () => {
    // U+D800 is an unpaired surrogate that JSON.parse produces in some edge cases;
    // the Z.AI endpoint rejects it with 400. It must be replaced with U+FFFD.
    const badStr = "prefix\uD800suffix";
    const body = JSON.parse(
      buildRequestBody({
        model: "GLM-5.3-Flash",
        maxTokens: 1024,
        context: {
          messages: [
            { role: "user", content: [{ type: "text", text: "run" }], timestamp: 1 },
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: badStr, nested: { key: badStr } } },
              ],
              api: "zcode-start-plan-api" as const,
              provider: "zcode",
              model: "GLM-5.3-Flash",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "toolUse" as const,
              timestamp: 2,
            },
          ],
        },
        deviceId: "d",
        sessionId: "s",
        options: {},
      }),
    ) as Record<string, unknown>;

    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const assistantContent = messages[2]?.content ?? [];
    const toolUse = assistantContent[0] as Record<string, unknown>;
    const input = toolUse["input"] as Record<string, unknown>;
    expect(typeof input["cmd"]).toBe("string");
    // charCodeAt avoids bun's toContain quirk with lone-surrogate comparison.
    // U+D800 (55296) must be replaced by U+FFFD (65533) after sanitization.
    expect((input["cmd"] as string).charCodeAt(6)).toBe(65533);
    expect(((input["nested"] as Record<string, unknown>)["key"] as string).charCodeAt(6)).toBe(65533);
  });
  test("GLM-5.3-Flash disableReasoning runs at effort:low (cannot disable, zai.kdl thinking-requires-effort)", () => {
    const body = JSON.parse(
      buildRequestBody({
        model: "GLM-5.3-Flash",
        maxTokens: 1024,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        deviceId: "d",
        sessionId: "s",
        options: { disableReasoning: true },
      }),
    ) as Record<string, unknown>;
    // GLM-5.3 family: mandatory thinking — disable maps to lowest effort, not disabled
    expect(body["thinking"]).toEqual({ type: "enabled" });
    expect(body["output_config"]).toEqual({ effort: "low" });
  });

  test("GLM-5.2 effort ladder clamped to high/max on zai host", () => {
    const makeBody = (effort?: Effort) =>
      JSON.parse(
        buildRequestBody({
          model: "glm-5.2",
          maxTokens: 1024,
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          deviceId: "d",
          sessionId: "s",
          options: { reasoning: effort },
        }),
      ) as Record<string, unknown>;

    expect(makeBody()["output_config"]).toEqual({ effort: "high" });       // default
    expect(makeBody("low" as Effort)["output_config"]).toEqual({ effort: "high" }); // clamped up
    expect(makeBody("high" as Effort)["output_config"]).toEqual({ effort: "high" });
    expect(makeBody("max" as Effort)["output_config"]).toEqual({ effort: "max" });
    expect(makeBody("xhigh" as Effort)["output_config"]).toEqual({ effort: "max" });
  });

  test("empty tool_result content serializes as empty string not empty array", () => {
    const body = JSON.parse(
      buildRequestBody({
        model: "GLM-5.3-Flash",
        maxTokens: 1024,
        context: {
          messages: [
            { role: "user", content: [{ type: "text", text: "run" }], timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "t1", name: "noop", arguments: {} }],
              api: "zcode-start-plan-api",
              provider: "zcode",
              model: "GLM-5.3-Flash",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "toolUse",
              timestamp: 2,
            },
            { role: "toolResult", toolCallId: "t1", toolName: "noop", content: [], isError: false, timestamp: 3 },
          ],
        },
        deviceId: "d",
        sessionId: "s",
        options: {},
      }),
    ) as Record<string, unknown>;

    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    // contextPrefix + user + assistant + toolResult user = 4 messages
    const toolResultMsg = messages[3];
    expect(toolResultMsg?.role).toBe("user");
    const tr = toolResultMsg?.content[0];
    // content must be "" not [] — Z.AI rejects [] with 400 code 1213
    expect(tr?.["content"]).toBe("");
  });

  test("headers include all ZCode attribution fields and no forbidden agent headers", () => {
    const h = buildHeaders("jwt-token", { appVersion: "3.18.2", deviceMid: "dev-1", sessionId: "sess-1" });
    expect(h["Authorization"]).toBe("Bearer jwt-token");
    expect(h["User-Agent"]).toBe("ZCode/3.18.2 ai-sdk/anthropic/3.0.81");
    expect(h["X-ZCode-App-Version"]).toBe("3.18.2");
    expect(h["X-Title"]).toBe("Z Code@cli");
    expect(h["X-ZCode-Agent"]).toBe("glm");
    expect(h["X-Device-Mid"]).toBe("dev-1");
    expect(h["x-session-id"]).toBe("sess-1");
    expect(h["x-zcode-session-type"]).toBe("main");
    expect(h["x-zcode-query-source"]).toBe("main_turn");
    expect(h["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h["x-zcode-trace-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h["anthropic-beta"]).toBeUndefined();
  });
});

describe("claims.ts balance filtering", () => {
  test("extracts only active, non-expired, non-exhausted model capabilities", () => {
    const models = activeBalanceModels({
      serverTime: 1_794_596_278,
      plans: [
        { user_plan_id: "u1", plan_id: "p1", status: "active", starts_at: 1_794_569_000, ends_at: 1_794_790_800 },
        { user_plan_id: "u2", plan_id: "p2", status: "expired", starts_at: 1_794_000_000, ends_at: 1_794_100_000 },
      ],
      balances: [
        {
          user_plan_id: "u1",
          plan_id: "p1",
          show_name: "GLM-5.3-Flash",
          total_units: 500_000_000,
          used_units: 1_000,
          remaining_units: 499_999_000,
          expires_at: 1_794_790_800,
          capabilities: ["model:glm-5.3-flash"],
        },
        {
          user_plan_id: "u1",
          plan_id: "p1",
          show_name: "GLM-5.3",
          total_units: 100,
          used_units: 100,
          remaining_units: 0,
          expires_at: 1_794_790_800,
          capabilities: ["model:glm-5.3"],
        },
        {
          user_plan_id: "u2",
          plan_id: "p2",
          show_name: "GLM-5.2",
          total_units: 100,
          used_units: 0,
          remaining_units: 100,
          expires_at: 1_794_100_000,
          capabilities: ["model:glm-5.2"],
        },
      ],
    });
    expect(models).toEqual(["glm-5.3-flash"]);
  });
});

describe("stream.ts SSE & error handling", () => {
  const model = {
    id: "GLM-5.3-Flash",
    name: "GLM-5.3-Flash",
    api: "zcode-start-plan-api",
    provider: "zcode",
    baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } as unknown as Model;

  const validJwt = `hdr.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`;

  test("translates thinking, text, tool_use, usage, and resolves stream.result()", async () => {
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 20 } } })}`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "check" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "bash", input: {} } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"cmd":' } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"ls"}' } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 100, output_tokens: 42 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n\n") + "\n\n";

    const fakeFetch = async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

    const stream = streamZCodeTurn(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] },
      {},
      {
        credentials: () => ({ jwt: validJwt, deviceMid: "dev-1" }),
        appVersion: () => "3.18.2",
        sessionId: "sess-1",
        fetchImpl: fakeFetch,
      },
    );

    const events: string[] = [];
    for await (const ev of stream) events.push(ev.type);
    const result = await stream.result();

    expect(events).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(result.stopReason).toBe("toolUse");
    expect(result.usage.output).toBe(42);
    expect(result.usage.cacheRead).toBe(20);
    expect(result.content).toEqual([
      { type: "thinking", thinking: "check", thinkingSignature: "sig123" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } },
    ]);
  });

  test("closes the previous block when content_block_start reuses an index without a stop", async () => {
    // Non-standard upstream behavior: index 0 opened twice without content_block_stop.
    // The first (thinking) block must still receive thinking_end before text_start.
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "partial" } })}`,
      // Index reuse without stop:
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n\n") + "\n\n";

    const fakeFetch = async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

    const stream = streamZCodeTurn(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] },
      {},
      {
        credentials: () => ({ jwt: validJwt, deviceMid: "dev-1" }),
        appVersion: () => "3.18.2",
        sessionId: "sess-1",
        fetchImpl: fakeFetch,
      },
    );

    const events: string[] = [];
    for await (const ev of stream) events.push(ev.type);
    const result = await stream.result();

    // thinking block closed via reuse: thinking_end BEFORE text_start
    const thinkEnd = events.indexOf("thinking_end");
    const textStart = events.indexOf("text_start");
    expect(thinkEnd).toBeGreaterThanOrEqual(0);
    expect(textStart).toBeGreaterThan(thinkEnd);
    expect(result.content[0]).toMatchObject({ type: "thinking", thinking: "partial" });
    expect(result.content[1]).toMatchObject({ type: "text", text: "hi" });
    expect(result.stopReason).toBe("stop");
  });

  test("retries HTTP 200 JSON 3008 envelope then succeeds (single-account slot held by another turn)", async () => {
    // ZCode answers concurrency limits with HTTP 200 + JSON envelope — this shape
    // previously bypassed the retry loop entirely and surfaced as an error turn.
    let fetches = 0;
    const sse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10 } } })}`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n\n") + "\n\n";
    const fakeFetch = async () => {
      fetches++;
      if (fetches === 1) {
        return new Response(JSON.stringify({ code: 3008, msg: "concurrency limit" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    const stream = streamZCodeTurn(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] },
      {},
      {
        credentials: () => ({ jwt: validJwt, deviceMid: "dev-1" }),
        appVersion: () => "3.18.2",
        sessionId: "sess-1",
        fetchImpl: fakeFetch,
      },
    );
    const events: string[] = [];
    for await (const ev of stream) events.push(ev.type);
    const result = await stream.result();

    expect(fetches).toBe(2);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(events).toContain("done");
  });

  test("retries mid-stream SSE error 3008 before any content is emitted, then succeeds", async () => {
    let fetches = 0;
    const sse = [
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "recovered" } })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n\n") + "\n\n";
    const fakeFetch = async () => {
      fetches++;
      if (fetches === 1) {
        return new Response(
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { code: 3008, message: "concurrency" } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    const stream = streamZCodeTurn(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] },
      {},
      {
        credentials: () => ({ jwt: validJwt, deviceMid: "dev-1" }),
        appVersion: () => "3.18.2",
        sessionId: "sess-1",
        fetchImpl: fakeFetch,
      },
    );
    const events: string[] = [];
    for await (const ev of stream) events.push(ev.type);
    const result = await stream.result();

    expect(fetches).toBe(2);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
  });

  test("does NOT retry 3008 after content already streamed (would duplicate events)", async () => {
    let fetches = 0;
    const fakeFetch = async () => {
      fetches++;
      return new Response(
        [
          `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}`,
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { code: 3008, message: "concurrency" } })}\n\n`,
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const stream = streamZCodeTurn(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] },
      {},
      {
        credentials: () => ({ jwt: validJwt, deviceMid: "dev-1" }),
        appVersion: () => "3.18.2",
        sessionId: "sess-1",
        fetchImpl: fakeFetch,
      },
    );
    const events: string[] = [];
    for await (const ev of stream) events.push(ev.type);
    const result = await stream.result();

    expect(fetches).toBe(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("concurrency");
  });

  test("maps HTTP 200 JSON code 1005 envelope into error turn without throwing unhandled", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ code: 1005, msg: "exceed quota limit" }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const stream = streamZCodeTurn(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] },
      {},
      {
        credentials: () => ({ jwt: validJwt, deviceMid: "dev-1" }),
        appVersion: () => "3.18.2",
        sessionId: "sess-1",
        fetchImpl: fakeFetch,
      },
    );

    const events: string[] = [];
    for await (const ev of stream) events.push(ev.type);
    const result = await stream.result();

    expect(events).toEqual(["error"]);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("1005");
  });
});
