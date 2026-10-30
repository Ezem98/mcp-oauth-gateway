import { googleFetch } from "./google-api.js";
import { buildMimeMessage, toBase64Url } from "./mime.js";
import { decodeBase64Url, stripHtml, truncate } from "./text.js";

export interface GmailApiContext {
  base: string;
  token: string;
}

export interface GmailHeader {
  name?: string;
  value?: string;
}

export function getHeader(
  headers: GmailHeader[] | undefined,
  target: string
): string {
  if (!headers || !Array.isArray(headers)) return "";
  const lower = target.toLowerCase();
  const found = headers.find((h) => h.name?.toLowerCase() === lower);
  return found?.value ?? "";
}

export interface GmailSearchArgs {
  query: string;
  max_results?: number;
}

export interface GmailSearchResult {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function gmailSearch(
  api: GmailApiContext,
  args: GmailSearchArgs
): Promise<GmailSearchResult[]> {
  const base = api.base.replace(/\/+$/, "");
  const url = new URL(`${base}/gmail/v1/users/me/messages`);
  url.searchParams.set("q", args.query);
  if (args.max_results !== undefined) {
    url.searchParams.set("maxResults", String(args.max_results));
  }

  const res = await googleFetch(url.toString(), api.token);
  const data = (await res.json()) as {
    messages?: Array<{ id: string; threadId: string }>;
  };

  if (!data.messages || data.messages.length === 0) {
    return [];
  }

  const results = await mapConcurrent(data.messages, 5, async (msg) => {
    const msgUrl = new URL(
      `${base}/gmail/v1/users/me/messages/${encodeURIComponent(msg.id)}`
    );
    msgUrl.searchParams.set("format", "metadata");
    msgUrl.searchParams.append("metadataHeaders", "From");
    msgUrl.searchParams.append("metadataHeaders", "To");
    msgUrl.searchParams.append("metadataHeaders", "Subject");
    msgUrl.searchParams.append("metadataHeaders", "Date");

    const itemRes = await googleFetch(msgUrl.toString(), api.token);
    const itemData = (await itemRes.json()) as {
      id: string;
      threadId: string;
      snippet?: string;
      payload?: {
        headers?: GmailHeader[];
      };
    };

    return {
      id: itemData.id,
      threadId: itemData.threadId,
      from: getHeader(itemData.payload?.headers, "from"),
      to: getHeader(itemData.payload?.headers, "to"),
      subject: getHeader(itemData.payload?.headers, "subject"),
      date: getHeader(itemData.payload?.headers, "date"),
      snippet: itemData.snippet ?? "",
    };
  });

  return results;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: {
    data?: string;
    size?: number;
    attachmentId?: string;
  };
  parts?: GmailPart[];
}

export interface GmailAttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailReadArgs {
  message_id: string;
}

export interface GmailReadResult {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body: string;
  body_truncated: boolean;
  attachments: GmailAttachmentInfo[];
}

function collectAllParts(part: GmailPart | undefined): GmailPart[] {
  if (!part) return [];
  const list: GmailPart[] = [part];
  if (part.parts && Array.isArray(part.parts)) {
    for (const child of part.parts) {
      list.push(...collectAllParts(child));
    }
  }
  return list;
}

export async function gmailRead(
  api: GmailApiContext,
  args: GmailReadArgs
): Promise<GmailReadResult> {
  const base = api.base.replace(/\/+$/, "");
  const url = `${base}/gmail/v1/users/me/messages/${encodeURIComponent(args.message_id)}?format=full`;

  const res = await googleFetch(url, api.token);
  const data = (await res.json()) as {
    id: string;
    threadId: string;
    payload?: GmailPart;
  };

  const payload = data.payload;
  const headers = payload?.headers;
  const from = getHeader(headers, "from");
  const to = getHeader(headers, "to");
  const cc = getHeader(headers, "cc");
  const subject = getHeader(headers, "subject");
  const date = getHeader(headers, "date");

  const allParts = collectAllParts(payload);

  // Attachments = parts with a non-empty filename (do NOT download them)
  const attachments: GmailAttachmentInfo[] = [];
  for (const p of allParts) {
    if (typeof p.filename === "string" && p.filename.trim().length > 0) {
      attachments.push({
        filename: p.filename.trim(),
        mimeType: p.mimeType ?? "application/octet-stream",
        size: p.body?.size ?? 0,
      });
    }
  }

  // Walk payload parts recursively; body = first text/plain part decoded;
  // if none, first text/html part passed through stripHtml; truncate body to 20000 chars.
  let rawBody = "";
  const plainPart = allParts.find(
    (p) => p.mimeType === "text/plain" && typeof p.body?.data === "string"
  );
  if (plainPart && plainPart.body?.data) {
    rawBody = decodeBase64Url(plainPart.body.data);
  } else {
    const htmlPart = allParts.find(
      (p) => p.mimeType === "text/html" && typeof p.body?.data === "string"
    );
    if (htmlPart && htmlPart.body?.data) {
      rawBody = stripHtml(decodeBase64Url(htmlPart.body.data));
    }
  }

  const { text: body, truncated: body_truncated } = truncate(rawBody, 20000);

  return {
    id: data.id,
    threadId: data.threadId,
    from,
    to,
    cc,
    subject,
    date,
    body,
    body_truncated,
    attachments,
  };
}

export interface GmailCreateDraftArgs {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  reply_to_message_id?: string;
}

export interface GmailCreateDraftResult {
  draft_id: string;
  message_id: string;
  thread_id: string;
  sent: false;
  note: string;
}

export async function gmailCreateDraft(
  api: GmailApiContext,
  args: GmailCreateDraftArgs
): Promise<GmailCreateDraftResult> {
  const base = api.base.replace(/\/+$/, "");
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let subject = args.subject;

  if (args.reply_to_message_id) {
    const metaUrl = new URL(
      `${base}/gmail/v1/users/me/messages/${encodeURIComponent(args.reply_to_message_id)}`
    );
    metaUrl.searchParams.set("format", "metadata");
    metaUrl.searchParams.append("metadataHeaders", "Message-ID");
    metaUrl.searchParams.append("metadataHeaders", "References");
    metaUrl.searchParams.append("metadataHeaders", "Subject");

    const metaRes = await googleFetch(metaUrl.toString(), api.token);
    const metaData = (await metaRes.json()) as {
      id: string;
      threadId?: string;
      payload?: {
        headers?: GmailHeader[];
      };
    };

    threadId = metaData.threadId;
    const origHeaders = metaData.payload?.headers;
    const origMessageId = getHeader(origHeaders, "Message-ID");
    const origReferences = getHeader(origHeaders, "References");
    const origSubject = getHeader(origHeaders, "Subject");

    if (origMessageId) {
      inReplyTo = origMessageId;
      references = (
        origReferences ? `${origReferences} ${origMessageId}` : origMessageId
      ).trim();
    }

    if (!subject.trim()) {
      subject = `Re: ${origSubject}`.trim();
    }
  }

  const mime = buildMimeMessage({
    to: args.to,
    subject,
    body: args.body,
    cc: args.cc,
    inReplyTo,
    references,
  });

  const raw = toBase64Url(mime);
  const messageObj: { raw: string; threadId?: string } = { raw };
  if (threadId) {
    messageObj.threadId = threadId;
  }

  const postUrl = `${base}/gmail/v1/users/me/drafts`;
  const draftRes = await googleFetch(postUrl, api.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: messageObj }),
  });

  const draftData = (await draftRes.json()) as {
    id: string;
    message?: {
      id?: string;
      threadId?: string;
    };
  };

  return {
    draft_id: draftData.id,
    message_id: draftData.message?.id ?? "",
    thread_id: draftData.message?.threadId ?? threadId ?? "",
    sent: false,
    note: "Borrador creado. NO se envió: revisalo y envialo vos desde Gmail.",
  };
}
