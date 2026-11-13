/**
 * Host context normalization and tool schema conversion for both OMP and PI.
 *
 * OMP passes Context.systemPrompt: string[] and Context.tools: Tool[].
 * PI passes transcript messages with role: "system", sections, toolsAdded/toolsRemoved.
 */

import type { Context, Tool } from "@oh-my-pi/pi-ai";
import { asRecord, type UnknownRecord } from "../json.ts";
export interface HostContext {
  /** System prompt texts, in order. */
  system: string[];
  /** Non-system messages (user, developer, assistant, toolResult). */
  messages: Context["messages"];
  /** Current active tool definitions. */
  tools: Tool[];
}


function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const rec = asRecord(block);
      return rec && rec["type"] === "text" && typeof rec["text"] === "string" ? rec["text"] : "";
    })
    .filter((t) => t.length > 0)
    .join("\n");
}

function replayTools(messages: readonly UnknownRecord[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (message["role"] !== "system") continue;
    const removed = message["toolsRemoved"];
    if (Array.isArray(removed)) {
      for (const tool of removed) {
        const rec = asRecord(tool);
        if (rec && typeof rec["name"] === "string") tools.delete(rec["name"]);
      }
    }
    const added = message["toolsAdded"];
    if (Array.isArray(added)) {
      for (const tool of added) {
        const rec = asRecord(tool);
        if (rec && typeof rec["name"] === "string") tools.set(rec["name"], tool as Tool);
      }
    }
  }
  return [...tools.values()];
}

export function normalizeHostContext(context: Context | undefined): HostContext {
  const rawMessages: unknown[] = Array.isArray(context?.messages) ? context.messages : [];
  const records = rawMessages.map(asRecord).filter((r): r is UnknownRecord => r !== null);

  const system: string[] = [];
  const declared: unknown = context?.systemPrompt;
  if (Array.isArray(declared)) {
    for (const t of declared) if (typeof t === "string" && t.length > 0) system.push(t);
  } else if (typeof declared === "string" && declared.length > 0) {
    system.push(declared);
  }

  if (system.length === 0) {
    for (const message of records) {
      if (message["role"] !== "system") continue;
      const text = contentText(message["content"]);
      if (text.length > 0) system.push(text);
      const sections = asRecord(message["sections"]);
      if (sections) {
        for (const value of Object.values(sections)) {
          if (typeof value === "string" && value.length > 0) system.push(value);
        }
      }
    }
  }

  const declaredTools: unknown = context?.tools;
  const tools = Array.isArray(declaredTools) ? (declaredTools as Tool[]) : replayTools(records);
  const messages = (context?.messages ?? []).filter((m) => (m as { role: string }).role !== "system");

  return { system, messages, tools };
}

/** Convert an ArkType / TypeBox / plain JSON-Schema tool parameters object into JSON Schema. */
export function toolInputSchema(tool: Tool): Record<string, unknown> {
  const raw: unknown = tool.parameters;
  if (raw !== null && typeof raw === "object" && "toJsonSchema" in raw && typeof raw.toJsonSchema === "function") {
    try {
      const converted: unknown = (raw.toJsonSchema as () => unknown)();
      const rec = asRecord(converted);
      if (rec) {
        return {
          ...rec,
          type: "object",
          properties: asRecord(rec["properties"]) ?? {},
          required: Array.isArray(rec["required"]) ? rec["required"] : [],
        };
      }
    } catch {
      // fall through to direct object handling
    }
  }
  const rec = asRecord(raw);
  if (rec) {
    return {
      ...rec,
      type: typeof rec["type"] === "string" ? rec["type"] : "object",
      properties: asRecord(rec["properties"]) ?? {},
      required: Array.isArray(rec["required"]) ? rec["required"] : [],
    };
  }
  return { type: "object", properties: {}, required: [] };
}
