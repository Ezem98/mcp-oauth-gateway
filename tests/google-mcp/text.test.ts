import { describe, it, expect, afterEach, vi } from "vitest";
import {
  escapeDriveQuery,
  stripHtml,
  truncate,
} from "../../upstreams/google/text.js";

describe("Text utilities (text.test.ts)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("truncate", () => {
    it("at exactly max (not truncated)", () => {
      const input = "12345";
      const result = truncate(input, 5);
      expect(result).toEqual({ text: "12345", truncated: false });
    });

    it("at max + 1 (truncated)", () => {
      const input = "123456";
      const result = truncate(input, 5);
      expect(result).toEqual({ text: "12345", truncated: true });
    });
  });

  describe("stripHtml", () => {
    it("removes script and style tags and their contents", () => {
      const html =
        "<div>Hello <script type=\"text/javascript\">alert('xss');</script>" +
        "<style>body { background: red; }</style>world</div>";
      const cleaned = stripHtml(html);
      expect(cleaned).toBe("Hello world");
      expect(cleaned).not.toContain("alert");
      expect(cleaned).not.toContain("background");
    });

    it("converts <br> and </p> to newlines", () => {
      const html = "<p>First paragraph</p><p>Second paragraph<br>with line break</p>";
      const cleaned = stripHtml(html);
      expect(cleaned).toBe("First paragraph\nSecond paragraph\nwith line break");
    });

    it("decodes &amp; &lt; &#233; &#xE9;", () => {
      const html = "<span>&amp; &lt; &#233; &#xE9;</span>";
      const cleaned = stripHtml(html);
      expect(cleaned).toBe("& < é é");
    });

    it("decodes common Spanish named entities without double-decoding &amp;", () => {
      const html = "<p>Reuni&oacute;n de ma&ntilde;ana &iquest;ok? &amp;aacute;</p>";
      expect(stripHtml(html)).toBe("Reunión de mañana ¿ok? &aacute;");
    });
  });

  describe("escapeDriveQuery", () => {
    it("escapes single quotes and backslashes properly", () => {
      expect(escapeDriveQuery("it's a \\ test")).toBe("it\\'s a \\\\ test");
    });
  });
});
