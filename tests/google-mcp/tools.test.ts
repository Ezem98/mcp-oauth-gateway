import { describe, it, expect, afterEach, vi } from "vitest";
import { callTool, type CallToolContext } from "../../upstreams/google/tools.js";

describe("Google MCP Tool Execution (tools.test.ts)", () => {
  const ctx: CallToolContext = {
    gatewayUrl: "http://gw.test",
    serverId: "google",
    userToken: "user-tok",
    gmailApiBase: "http://gmail.test",
    driveApiBase: "http://drive.test",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls gateway token URL with Authorization 'Bearer user-tok' and Google calls carry 'Bearer g-at'", async () => {
    const fetchCalls: Array<{ url: string; auth: string | null }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        const auth = headers.get("authorization");
        fetchCalls.push({ url, auth });

        if (url === "http://gw.test/google/credentials/google/token") {
          return new Response(JSON.stringify({ access_token: "g-at" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.startsWith("http://gmail.test/gmail/v1/users/me/messages")) {
          return new Response(JSON.stringify({ messages: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("Not Found", { status: 404 });
      })
    );

    const res = await callTool("gmail_search", { query: "test" }, ctx);
    expect(res.isError).toBeFalsy();

    const gwCall = fetchCalls.find((c) =>
      c.url.startsWith("http://gw.test/google/credentials/google/token")
    );
    expect(gwCall).toBeDefined();
    expect(gwCall?.auth).toBe("Bearer user-tok");

    const googleCall = fetchCalls.find((c) =>
      c.url.startsWith("http://gmail.test")
    );
    expect(googleCall).toBeDefined();
    expect(googleCall?.auth).toBe("Bearer g-at");
  });

  it("gmail_search: messages list + per-message metadata → result has id/threadId/from/to/subject/date/snippet; max_results 50 is clamped to 20 in the maxResults query param", async () => {
    let listUrlCalled = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url === "http://gw.test/google/credentials/google/token") {
          return new Response(JSON.stringify({ access_token: "g-at" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.startsWith("http://gmail.test/gmail/v1/users/me/messages?")) {
          listUrlCalled = url;
          return new Response(
            JSON.stringify({
              messages: [{ id: "m1", threadId: "t1" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url.startsWith("http://gmail.test/gmail/v1/users/me/messages/m1")) {
          return new Response(
            JSON.stringify({
              id: "m1",
              threadId: "t1",
              snippet: "Snippet text",
              payload: {
                headers: [
                  { name: "From", value: "alice@example.com" },
                  { name: "To", value: "bob@example.com" },
                  { name: "Subject", value: "Meeting details" },
                  { name: "Date", value: "Thu, 29 Oct 2026 12:00:00 GMT" },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not Found", { status: 404 });
      })
    );

    const res = await callTool(
      "gmail_search",
      { query: "meeting", max_results: 50 },
      ctx
    );
    expect(res.isError).toBeFalsy();

    const parsedListUrl = new URL(listUrlCalled);
    expect(parsedListUrl.searchParams.get("maxResults")).toBe("20");

    const results = JSON.parse(res.content[0].text);
    expect(results).toEqual([
      {
        id: "m1",
        threadId: "t1",
        from: "alice@example.com",
        to: "bob@example.com",
        subject: "Meeting details",
        date: "Thu, 29 Oct 2026 12:00:00 GMT",
        snippet: "Snippet text",
      },
    ]);
  });

  it("gmail_read: a message with only a text/html part of > 20000 chars → body has no tags, length 20000, body_truncated true; attachments listed with filename/mimeType/size and NO request to any attachments URL", async () => {
    const fetchUrls: string[] = [];
    const htmlOver20k =
      "<div>" + "<p>Contenido largo de correo con información</p> ".repeat(1000) + "</div>";
    expect(htmlOver20k.length).toBeGreaterThan(20000);
    const htmlB64 = Buffer.from(htmlOver20k, "utf-8").toString("base64url");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchUrls.push(url);

        if (url === "http://gw.test/google/credentials/google/token") {
          return new Response(JSON.stringify({ access_token: "g-at" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.startsWith("http://gmail.test/gmail/v1/users/me/messages/msg-big")) {
          return new Response(
            JSON.stringify({
              id: "msg-big",
              threadId: "t-big",
              payload: {
                headers: [
                  { name: "From", value: "alice@example.com" },
                  { name: "To", value: "bob@example.com" },
                  { name: "Subject", value: "Large HTML Email" },
                  { name: "Date", value: "Thu, 29 Oct 2026 12:00:00 GMT" },
                ],
                mimeType: "multipart/mixed",
                parts: [
                  {
                    mimeType: "text/html",
                    body: { data: htmlB64 },
                  },
                  {
                    filename: "report.pdf",
                    mimeType: "application/pdf",
                    body: { size: 45678, attachmentId: "att-pdf-1" },
                  },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not Found", { status: 404 });
      })
    );

    const res = await callTool("gmail_read", { message_id: "msg-big" }, ctx);
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);

    // Body has no tags
    expect(parsed.body).not.toContain("<p>");
    expect(parsed.body).not.toContain("</p>");
    expect(parsed.body).not.toContain("<div>");
    expect(parsed.body).not.toContain("</div>");

    // Length 20000, body_truncated true
    expect(parsed.body.length).toBe(20000);
    expect(parsed.body_truncated).toBe(true);

    // Attachments listed with filename/mimeType/size
    expect(parsed.attachments).toEqual([
      {
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 45678,
      },
    ]);

    // NO request to any attachments URL
    for (const url of fetchUrls) {
      expect(url.toLowerCase()).not.toContain("attachment");
    }
  });

  it("gmail_create_draft reply: metadata of the original returns threadId 't1', Message-ID '<orig@x>', References '<a@x>'; the POST to /gmail/v1/users/me/drafts has message.threadId 't1' and the decoded raw MIME contains 'In-Reply-To: <orig@x>' and 'References: <a@x> <orig@x>'; the result says sent false. Assert no request to any URL containing '/send'", async () => {
    const fetchUrls: string[] = [];
    let draftRequestBody: any = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetchUrls.push(url);

        if (url === "http://gw.test/google/credentials/google/token") {
          return new Response(JSON.stringify({ access_token: "g-at" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.startsWith("http://gmail.test/gmail/v1/users/me/messages/orig-1")) {
          return new Response(
            JSON.stringify({
              id: "orig-1",
              threadId: "t1",
              payload: {
                headers: [
                  { name: "Message-ID", value: "<orig@x>" },
                  { name: "References", value: "<a@x>" },
                  { name: "Subject", value: "Initial inquiry" },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        if (url === "http://gmail.test/gmail/v1/users/me/drafts") {
          draftRequestBody = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              id: "draft-xyz",
              message: { id: "m-draft", threadId: "t1" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not Found", { status: 404 });
      })
    );

    const res = await callTool(
      "gmail_create_draft",
      {
        to: "contact@example.com",
        subject: "Re: Initial inquiry",
        body: "Replying to your email.",
        reply_to_message_id: "orig-1",
      },
      ctx
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.sent).toBe(false);

    expect(draftRequestBody).toBeDefined();
    expect(draftRequestBody.message.threadId).toBe("t1");

    const decodedRaw = Buffer.from(
      draftRequestBody.message.raw,
      "base64url"
    ).toString("utf-8");
    expect(decodedRaw).toContain("In-Reply-To: <orig@x>");
    expect(decodedRaw).toContain("References: <a@x> <orig@x>");

    for (const url of fetchUrls) {
      expect(url).not.toContain("/send");
    }
  });

  it("drive_search: query \"it's\" → the q param equals \"fullText contains 'it\\'s' and trashed = false\" and fields is the narrow list", async () => {
    let driveSearchUrl = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url === "http://gw.test/google/credentials/google/token") {
          return new Response(JSON.stringify({ access_token: "g-at" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.startsWith("http://drive.test/drive/v3/files?")) {
          driveSearchUrl = url;
          return new Response(JSON.stringify({ files: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("Not Found", { status: 404 });
      })
    );

    const res = await callTool("drive_search", { query: "it's" }, ctx);
    expect(res.isError).toBeFalsy();

    const parsedUrl = new URL(driveSearchUrl);
    expect(parsedUrl.searchParams.get("q")).toBe(
      "fullText contains 'it\\'s' and trashed = false"
    );
    expect(parsedUrl.searchParams.get("fields")).toBe(
      "files(id,name,mimeType,modifiedTime,webViewLink)"
    );
  });

  it("drive_read: Google Doc → export?mimeType=text/plain used and content truncated to 50000 with content_truncated true; Sheet → text/csv; application/pdf → no content, has note", async () => {
    const longDocContent = "Google Doc exported text content... ".repeat(3000); // ~108,000 chars
    expect(longDocContent.length).toBeGreaterThan(50000);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url === "http://gw.test/google/credentials/google/token") {
          return new Response(JSON.stringify({ access_token: "g-at" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Google Doc
        if (url.startsWith("http://drive.test/drive/v3/files/doc-1?")) {
          return new Response(
            JSON.stringify({
              id: "doc-1",
              name: "My Document",
              mimeType: "application/vnd.google-apps.document",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (
          url ===
          "http://drive.test/drive/v3/files/doc-1/export?mimeType=text%2Fplain"
        ) {
          return new Response(longDocContent, {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }

        // Google Sheet
        if (url.startsWith("http://drive.test/drive/v3/files/sheet-1?")) {
          return new Response(
            JSON.stringify({
              id: "sheet-1",
              name: "My Spreadsheet",
              mimeType: "application/vnd.google-apps.spreadsheet",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (
          url ===
          "http://drive.test/drive/v3/files/sheet-1/export?mimeType=text%2Fcsv"
        ) {
          return new Response("header1,header2\nval1,val2", {
            status: 200,
            headers: { "Content-Type": "text/csv" },
          });
        }

        // PDF
        if (url.startsWith("http://drive.test/drive/v3/files/pdf-1?")) {
          return new Response(
            JSON.stringify({
              id: "pdf-1",
              name: "manual.pdf",
              mimeType: "application/pdf",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not Found", { status: 404 });
      })
    );

    // 1. Google Doc
    const docRes = await callTool("drive_read", { file_id: "doc-1" }, ctx);
    expect(docRes.isError).toBeFalsy();
    const docParsed = JSON.parse(docRes.content[0].text);
    expect(docParsed.content.length).toBe(50000);
    expect(docParsed.content_truncated).toBe(true);

    // 2. Sheet
    const sheetRes = await callTool("drive_read", { file_id: "sheet-1" }, ctx);
    expect(sheetRes.isError).toBeFalsy();
    const sheetParsed = JSON.parse(sheetRes.content[0].text);
    expect(sheetParsed.content).toBe("header1,header2\nval1,val2");

    // 3. PDF
    const pdfRes = await callTool("drive_read", { file_id: "pdf-1" }, ctx);
    expect(pdfRes.isError).toBeFalsy();
    const pdfParsed = JSON.parse(pdfRes.content[0].text);
    expect(pdfParsed.content).toBeUndefined();
    expect(pdfParsed.note).toBeDefined();
    expect(pdfParsed.note).toContain("application/pdf");
  });

  it("gateway 409 {error:\"reconnect_required\", connect_hint:\"npm run connect-url -- u1\"} → isError true and text exactly 'Hay que reconectar la cuenta de Google: npm run connect-url -- u1', and no Google API call was made", async () => {
    const fetchUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchUrls.push(url);

        if (url === "http://gw.test/google/credentials/google/token") {
          return new Response(
            JSON.stringify({
              error: "reconnect_required",
              connect_hint: "npm run connect-url -- u1",
            }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not Found", { status: 404 });
      })
    );

    const res = await callTool("gmail_search", { query: "test" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      "Hay que reconectar la cuenta de Google: npm run connect-url -- u1"
    );

    for (const url of fetchUrls) {
      expect(url).not.toContain("gmail.test");
      expect(url).not.toContain("drive.test");
    }
  });

  it("Google 403 {error:{message:\"Insufficient Permission\"}} → isError with 'Error de Google (403): Insufficient Permission'; the text must not contain 'g-at'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url === "http://gw.test/google/credentials/google/token") {
          return new Response(JSON.stringify({ access_token: "g-at" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.startsWith("http://gmail.test/")) {
          return new Response(
            JSON.stringify({ error: { message: "Insufficient Permission" } }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not Found", { status: 404 });
      })
    );

    const res = await callTool("gmail_search", { query: "test" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      "Error de Google (403): Insufficient Permission"
    );
    expect(res.content[0].text).not.toContain("g-at");
  });

  it("invalid args (gmail_read with message_id \"../x\") → isError, no fetch at all", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await callTool("gmail_read", { message_id: "../x" }, ctx);
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
