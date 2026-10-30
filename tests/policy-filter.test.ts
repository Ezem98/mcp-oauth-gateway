import { describe, it, expect } from "vitest";
import {
  createSseFilter,
  filterJsonBody,
  filterJsonRpcMessage,
  mergeBlockedJson,
  planRequest,
  type JsonRpcResponse,
  type ToolDecisionFn,
} from "../src/gateway/policy-filter.js";

describe("policy-filter pure functions", () => {
  const decide: ToolDecisionFn = (toolName: string) => {
    if (toolName === "echo" || toolName === "whoami") return "allow";
    return "deny";
  };

  it("allowed call forwarded unchanged", () => {
    const req = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hello" } },
    };

    const plan = planRequest(req, decide);
    expect(plan.forwardBody).toEqual(req);
    expect(plan.blockedResponses).toHaveLength(0);
    expect(plan.toolsListIds.size).toBe(0);
  });

  it("denied call blocked with -32001 and the tool name in the message", () => {
    const req = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "delete_files", arguments: { path: "/etc" } },
    };

    const plan = planRequest(req, decide);
    expect(plan.forwardBody).toBeNull();
    expect(plan.blockedResponses).toHaveLength(1);
    expect(plan.blockedResponses[0]).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32001,
        message:
          "Herramienta bloqueada por la política del gateway: delete_files",
      },
    });
    expect(plan.toolsListIds.size).toBe(0);
  });

  it("unknown tool blocked", () => {
    const req = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "unknown_tool", arguments: {} },
    };

    const plan = planRequest(req, decide);
    expect(plan.forwardBody).toBeNull();
    expect(plan.blockedResponses).toHaveLength(1);
    expect(plan.blockedResponses[0].error?.code).toBe(-32001);
    expect(plan.blockedResponses[0].error?.message).toContain("unknown_tool");
  });

  it("missing name blocked", () => {
    const reqNoName = {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {},
    };

    const plan1 = planRequest(reqNoName, decide);
    expect(plan1.forwardBody).toBeNull();
    expect(plan1.blockedResponses).toHaveLength(1);
    expect(plan1.blockedResponses[0]).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: {
        code: -32001,
        message:
          "Herramienta bloqueada por la política del gateway: (sin nombre)",
      },
    });

    const reqNoParams = {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
    };
    const plan2 = planRequest(reqNoParams, decide);
    expect(plan2.forwardBody).toBeNull();
    expect(plan2.blockedResponses[0].error?.message).toContain("(sin nombre)");
  });

  it("blocked notification dropped", () => {
    const notification = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "delete_files" },
    };

    const plan = planRequest(notification, decide);
    expect(plan.forwardBody).toBeNull();
    expect(plan.blockedResponses).toHaveLength(0);
    expect(plan.toolsListIds.size).toBe(0);
  });

  it("mixed batch (allowed call + denied call + tools/list + notification) → forwardBody has allowed ones, blockedResponses has one error, toolsListIds has the tools/list id", () => {
    const batch = [
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "batch hi" } },
      },
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "denied_tool" },
      },
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/list",
      },
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progress: 50 },
      },
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "denied_tool_notification" },
      },
    ];

    const plan = planRequest(batch, decide);
    expect(Array.isArray(plan.forwardBody)).toBe(true);
    const forwarded = plan.forwardBody as any[];
    expect(forwarded).toHaveLength(3);
    expect(forwarded[0].id).toBe(10);
    expect(forwarded[1].id).toBe(12);
    expect(forwarded[2].method).toBe("notifications/progress");

    expect(plan.blockedResponses).toHaveLength(1);
    expect(plan.blockedResponses[0]).toEqual({
      jsonrpc: "2.0",
      id: 11,
      error: {
        code: -32001,
        message:
          "Herramienta bloqueada por la política del gateway: denied_tool",
      },
    });

    expect(plan.toolsListIds.has(12)).toBe(true);
    expect(plan.toolsListIds.size).toBe(1);
  });

  it("filterJsonRpcMessage returns copy with only allowed tools for matching tools/list id", () => {
    const toolsListIds = new Set<string | number>([12]);
    const response = {
      jsonrpc: "2.0",
      id: 12,
      result: {
        tools: [
          { name: "echo", description: "Echo tool" },
          { name: "delete_files", description: "Dangerous" },
          { name: "whoami", description: "User info" },
        ],
      },
    };

    const filtered = filterJsonRpcMessage(response, toolsListIds, decide) as any;
    expect(filtered).not.toBe(response);
    expect(filtered.result.tools).toEqual([
      { name: "echo", description: "Echo tool" },
      { name: "whoami", description: "User info" },
    ]);
  });

  it("filterJsonBody filters tools/list result in JSON string", () => {
    const toolsListIds = new Set<string | number>([12]);
    const json = JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      result: {
        tools: [
          { name: "echo" },
          { name: "secret" },
        ],
      },
    });

    const filteredText = filterJsonBody(json, toolsListIds, decide);
    const parsed = JSON.parse(filteredText);
    expect(parsed.result.tools).toEqual([{ name: "echo" }]);

    // Unparseable JSON returns unchanged
    expect(filterJsonBody("not-json", toolsListIds, decide)).toBe("not-json");
  });

  it("createSseFilter on a stream split into awkward chunks (an event split across chunks, CRLF line endings, an event: line and a non-JSON data event) filters tools and preserves the other lines", async () => {
    const toolsListIds = new Set<string | number>([100]);

    // Construct stream with 2 events:
    // Event 1 has CRLF line endings, event: header, id: header, and a tools/list response
    // Event 2 has an event: header and non-JSON data
    const chunk1 = new TextEncoder().encode(
      'event: mcp-response\r\nid: evt-1\r\ndata: {"jsonrpc":"2.0","id":100,"result":{"tools":[{"name":"echo"},{"na'
    );
    const chunk2 = new TextEncoder().encode(
      'me":"secret"}]}}\r\n\r\nevent: log-event\r\ndata: Hello world, plain text non-JSON data'
    );
    const chunk3 = new TextEncoder().encode("!\r\n\r\n");

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1);
        controller.enqueue(chunk2);
        controller.enqueue(chunk3);
        controller.close();
      },
    });

    const sseFilter = createSseFilter(toolsListIds, decide);
    const outputStream = readable.pipeThrough(sseFilter);

    const reader = outputStream.getReader();
    const decoder = new TextDecoder();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value);
    }

    // Verify Event 1:
    expect(result).toContain("event: mcp-response");
    expect(result).toContain("id: evt-1");
    expect(result).toContain('"name":"echo"');
    expect(result).not.toContain('"name":"secret"');

    // Verify Event 2:
    expect(result).toContain("event: log-event");
    expect(result).toContain("data: Hello world, plain text non-JSON data!");
  });

  it("mergeBlockedJson appends blocked responses to array and wraps single object if isBatch", () => {
    const blocked: JsonRpcResponse[] = [
      {
        jsonrpc: "2.0",
        id: 99,
        error: { code: -32001, message: "Blocked" },
      },
    ];

    // Array upstream response
    const arrayUpstream = JSON.stringify([{ jsonrpc: "2.0", id: 1, result: "ok" }]);
    const mergedArray = mergeBlockedJson(arrayUpstream, blocked, true);
    expect(JSON.parse(mergedArray)).toEqual([
      { jsonrpc: "2.0", id: 1, result: "ok" },
      { jsonrpc: "2.0", id: 99, error: { code: -32001, message: "Blocked" } },
    ]);

    // Single object response to batch request -> wrapped into array
    const singleUpstream = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" });
    const mergedSingle = mergeBlockedJson(singleUpstream, blocked, true);
    expect(JSON.parse(mergedSingle)).toEqual([
      { jsonrpc: "2.0", id: 1, result: "ok" },
      { jsonrpc: "2.0", id: 99, error: { code: -32001, message: "Blocked" } },
    ]);
  });
});
