export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type ToolDecisionFn = (toolName: string) => "allow" | "deny";

export interface BlockedToolCall {
  tool: string;
}

export interface RequestPlan {
  forwardBody: unknown | null;
  blockedResponses: JsonRpcResponse[];
  toolsListIds: Set<string | number>;
  blockedCalls: BlockedToolCall[];
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

interface InspectedMessage {
  action: "forward" | "block";
  item?: unknown;
  toolsListId?: string | number;
  blockedCall?: BlockedToolCall;
  blockedResponse?: JsonRpcResponse | null;
}

function inspectMessage(
  msg: unknown,
  decide: ToolDecisionFn
): InspectedMessage {
  if (!isObject(msg)) {
    return { action: "forward", item: msg };
  }

  const method = msg.method;
  const hasId = msg.id !== undefined && msg.id !== null;

  if (method === "tools/call") {
    const params = isObject(msg.params) ? msg.params : null;
    const toolName =
      typeof params?.name === "string" && params.name.length > 0
        ? params.name
        : null;

    const isAllowed = toolName !== null && decide(toolName) === "allow";

    if (!isAllowed) {
      const displayName = toolName ?? "(sin nombre)";
      const blockedCall: BlockedToolCall = { tool: displayName };

      if (hasId) {
        const blockedResponse: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: msg.id as string | number,
          error: {
            code: -32001,
            message: `Herramienta bloqueada por la política del gateway: ${displayName}`,
          },
        };
        return { action: "block", blockedCall, blockedResponse };
      }

      // Blocked notification (no id) -> simply dropped
      return { action: "block", blockedCall, blockedResponse: null };
    }

    return { action: "forward", item: msg };
  }

  if (method === "tools/list") {
    if (hasId) {
      return {
        action: "forward",
        item: msg,
        toolsListId: msg.id as string | number,
      };
    }
    return { action: "forward", item: msg };
  }

  return { action: "forward", item: msg };
}

/**
 * Plan upstream forwarding for a parsed JSON-RPC request body (single object or batch array).
 */
export function planRequest(
  body: unknown,
  decide: ToolDecisionFn
): RequestPlan {
  if (Array.isArray(body)) {
    const forwardItems: unknown[] = [];
    const blockedResponses: JsonRpcResponse[] = [];
    const toolsListIds = new Set<string | number>();
    const blockedCalls: BlockedToolCall[] = [];

    for (const item of body) {
      const inspected = inspectMessage(item, decide);
      if (inspected.action === "forward") {
        forwardItems.push(inspected.item);
        if (inspected.toolsListId !== undefined) {
          toolsListIds.add(inspected.toolsListId);
        }
      } else {
        if (inspected.blockedCall) blockedCalls.push(inspected.blockedCall);
        if (inspected.blockedResponse)
          blockedResponses.push(inspected.blockedResponse);
      }
    }

    return {
      forwardBody: forwardItems.length > 0 ? forwardItems : null,
      blockedResponses,
      toolsListIds,
      blockedCalls,
    };
  }

  const inspected = inspectMessage(body, decide);
  if (inspected.action === "forward") {
    const toolsListIds = new Set<string | number>();
    if (inspected.toolsListId !== undefined) {
      toolsListIds.add(inspected.toolsListId);
    }
    return {
      forwardBody: body,
      blockedResponses: [],
      toolsListIds,
      blockedCalls: [],
    };
  }

  return {
    forwardBody: null,
    blockedResponses: inspected.blockedResponse
      ? [inspected.blockedResponse]
      : [],
    toolsListIds: new Set<string | number>(),
    blockedCalls: inspected.blockedCall ? [inspected.blockedCall] : [],
  };
}

/**
 * Filter tools in a JSON-RPC response message if it corresponds to a tools/list request.
 */
export function filterJsonRpcMessage(
  msg: unknown,
  toolsListIds: Set<string | number>,
  decide: ToolDecisionFn
): unknown {
  if (!isObject(msg)) return msg;
  const id = msg.id;
  if (
    id === undefined ||
    id === null ||
    !toolsListIds.has(id as string | number)
  ) {
    return msg;
  }

  const result = msg.result;
  if (!isObject(result) || !Array.isArray(result.tools)) {
    return msg;
  }

  const filteredTools = result.tools.filter((t) => {
    if (!isObject(t) || typeof t.name !== "string") return false;
    return decide(t.name) === "allow";
  });

  return {
    ...msg,
    result: {
      ...result,
      tools: filteredTools,
    },
  };
}

/**
 * Filter tools in a serialized JSON-RPC response body (object or array).
 */
export function filterJsonBody(
  text: string,
  toolsListIds: Set<string | number>,
  decide: ToolDecisionFn
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }

  if (Array.isArray(parsed)) {
    const filtered = parsed.map((item) =>
      filterJsonRpcMessage(item, toolsListIds, decide)
    );
    return JSON.stringify(filtered);
  }

  if (isObject(parsed)) {
    const filtered = filterJsonRpcMessage(parsed, toolsListIds, decide);
    return JSON.stringify(filtered);
  }

  return text;
}

function findEventBoundary(buf: string): { index: number; length: number } | null {
  const crlf = buf.indexOf("\r\n\r\n");
  const lf = buf.indexOf("\n\n");
  if (crlf === -1 && lf === -1) {
    return null;
  }
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

function processSseEvent(
  rawEvent: string,
  toolsListIds: Set<string | number>,
  decide: ToolDecisionFn
): string | null {
  if (rawEvent.trim().length === 0) {
    return null;
  }

  const lines = rawEvent.split(/\r?\n/);
  const nonDataLines: string[] = [];
  const dataLines: string[] = [];
  let hasData = false;

  for (const line of lines) {
    if (line.startsWith("data:")) {
      hasData = true;
      if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      } else {
        dataLines.push(line.slice(5));
      }
    } else if (line === "data") {
      hasData = true;
      dataLines.push("");
    } else {
      nonDataLines.push(line);
    }
  }

  if (!hasData) {
    return rawEvent + "\n\n";
  }

  const joinedData = dataLines.join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(joinedData);
  } catch {
    return rawEvent + "\n\n";
  }

  const filtered = filterJsonRpcMessage(parsed, toolsListIds, decide);
  const filteredJson = JSON.stringify(filtered);

  const outputLines = [...nonDataLines, `data: ${filteredJson}`];
  return outputLines.join("\n") + "\n\n";
}

/**
 * Creates an SSE TransformStream that filters tools/list responses and appends blocked errors.
 */
export function createSseFilter(
  toolsListIds: Set<string | number>,
  decide: ToolDecisionFn,
  blockedResponses: JsonRpcResponse[] = []
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      while (true) {
        const boundary = findEventBoundary(buffer);
        if (!boundary) break;

        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);

        const processed = processSseEvent(rawEvent, toolsListIds, decide);
        if (processed !== null) {
          controller.enqueue(encoder.encode(processed));
        }
      }
    },
    flush(controller) {
      buffer += decoder.decode();

      while (true) {
        const boundary = findEventBoundary(buffer);
        if (!boundary) break;

        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);

        const processed = processSseEvent(rawEvent, toolsListIds, decide);
        if (processed !== null) {
          controller.enqueue(encoder.encode(processed));
        }
      }

      if (buffer.trim().length > 0) {
        const processed = processSseEvent(buffer, toolsListIds, decide);
        if (processed !== null) {
          controller.enqueue(encoder.encode(processed));
        }
        buffer = "";
      }

      for (const resp of blockedResponses) {
        const sseMsg = `event: message\ndata: ${JSON.stringify(resp)}\n\n`;
        controller.enqueue(encoder.encode(sseMsg));
      }
    },
  });
}

/**
 * Merge blocked JSON-RPC responses into an upstream JSON response body.
 * If isBatch is true and upstream replied with a single object, wraps into an array.
 */
export function mergeBlockedJson(
  upstreamText: string,
  blockedResponses: JsonRpcResponse[],
  isBatch: boolean = false
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(upstreamText);
  } catch {
    return upstreamText;
  }

  if (Array.isArray(parsed)) {
    if (blockedResponses.length > 0) {
      return JSON.stringify([...parsed, ...blockedResponses]);
    }
    return upstreamText;
  }

  if (isObject(parsed)) {
    if (isBatch) {
      return JSON.stringify([parsed, ...blockedResponses]);
    }
    if (blockedResponses.length > 0) {
      return JSON.stringify([parsed, ...blockedResponses]);
    }
  }

  return upstreamText;
}

/**
 * Format blocked JSON-RPC responses as SSE events.
 */
export function formatBlockedSse(blockedResponses: JsonRpcResponse[]): string {
  return blockedResponses
    .map((resp) => `event: message\ndata: ${JSON.stringify(resp)}\n\n`)
    .join("");
}
