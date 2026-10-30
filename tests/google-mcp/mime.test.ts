import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildMimeMessage,
  encodeHeaderValue,
  toBase64Url,
} from "../../upstreams/google/mime.js";

function decodeRfc2047(encoded: string): string {
  const matches = [...encoded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
  return matches
    .map((m) => Buffer.from(m[1], "base64").toString("utf-8"))
    .join("");
}

describe("MIME encoding utilities (mime.test.ts)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("encodeHeaderValue", () => {
    it("leaves ASCII unchanged", () => {
      const ascii = "Simple ASCII subject line with symbols 123!@#$%^&*()_+";
      expect(encodeHeaderValue(ascii)).toBe(ascii);
      expect(encodeHeaderValue("")).toBe("");
    });

    it("'Reunión de mañana ✅' becomes RFC 2047 words that decode back to original", () => {
      const original = "Reunión de mañana ✅";
      const encoded = encodeHeaderValue(original);

      expect(encoded).toContain("=?UTF-8?B?");
      expect(decodeRfc2047(encoded)).toBe(original);
    });

    it("long accented subject (200 chars) produces several words, each encoding ≤ 45 bytes, never splitting a multi-byte char", () => {
      // Create a 200-character accented string
      // "árbol niño café canción pingüino " is 33 characters.
      const subject200 = "árbol niño café canción pingüino "
        .repeat(7)
        .slice(0, 200);
      expect(subject200).toHaveLength(200);

      const encoded = encodeHeaderValue(subject200);
      const words = encoded.split("\r\n ");

      expect(words.length).toBeGreaterThan(1);

      for (const word of words) {
        const match = /^=\?UTF-8\?B\?([^?]+)\?=$/.exec(word);
        expect(match, `Word should match RFC 2047 word pattern: ${word}`).not.toBeNull();

        const rawBytes = Buffer.from(match![1], "base64");
        // Each encoding at most 45 bytes
        expect(rawBytes.length).toBeLessThanOrEqual(45);

        // Never splits a multi-byte char: every word decodes to valid UTF-8 without U+FFFD
        const decodedWord = rawBytes.toString("utf-8");
        expect(decodedWord).not.toContain("\uFFFD");
      }

      // Decodes back to the original string
      expect(decodeRfc2047(encoded)).toBe(subject200);
    });
  });

  describe("buildMimeMessage", () => {
    it("uses CRLF line endings, sets Content-Type text/plain; charset=\"UTF-8\", includes In-Reply-To and References when given", () => {
      const mime = buildMimeMessage({
        to: "recipient@example.com",
        subject: "Hello there",
        body: "First line\nSecond line",
        cc: "copy@example.com",
        inReplyTo: "<orig-id@x>",
        references: "<ref-id@x>",
      });

      // CRLF line endings
      expect(mime).toContain("\r\n");
      expect(mime.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);

      // Content-Type text/plain; charset="UTF-8"
      expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');

      // In-Reply-To and References present when given
      expect(mime).toContain("In-Reply-To: <orig-id@x>");
      expect(mime).toContain("References: <ref-id@x>");
      expect(mime).toContain("Cc: copy@example.com");
    });

    it("omits In-Reply-To and References when not provided", () => {
      const mime = buildMimeMessage({
        to: "recipient@example.com",
        subject: "Hello there",
        body: "Test body",
      });

      expect(mime).not.toContain("In-Reply-To");
      expect(mime).not.toContain("References");
    });

    it("body base64 decodes to original UTF-8 body, lines of body ≤ 76 chars", () => {
      const longBody =
        "This is a longer body text that contains accented characters like ñ, á, é, í, ó, ú, " +
        "and emojis like 🎉, and is repeated multiple times to ensure multiple lines of base64 wrap properly. \n" +
        "Line 2: Continuing with more details about the project and ensuring that RFC wrapping works as expected.\n";
      const fullBody = longBody.repeat(5);

      const mime = buildMimeMessage({
        to: "recipient@example.com",
        subject: "Body wrapping test",
        body: fullBody,
      });

      const parts = mime.split("\r\n\r\n");
      expect(parts.length).toBeGreaterThanOrEqual(2);
      const bodySection = parts.slice(1).join("\r\n\r\n").trimEnd();
      const bodyLines = bodySection.split("\r\n");

      expect(bodyLines.length).toBeGreaterThan(1);
      for (const line of bodyLines) {
        expect(line.length).toBeLessThanOrEqual(76);
      }

      const decodedBody = Buffer.from(bodyLines.join(""), "base64").toString(
        "utf-8"
      );
      expect(decodedBody).toBe(fullBody);
    });

    it("throws if subject or to contains '\\r\\n'", () => {
      expect(() =>
        buildMimeMessage({
          to: "recipient@example.com\r\nBcc: evil@example.com",
          subject: "Valid subject",
          body: "Hello",
        })
      ).toThrow(/newline characters are not allowed/);

      expect(() =>
        buildMimeMessage({
          to: "recipient@example.com",
          subject: "Subject\r\nInjected: Header",
          body: "Hello",
        })
      ).toThrow(/newline characters are not allowed/);
    });
  });

  describe("toBase64Url", () => {
    it("has no +, / or =", () => {
      const input = "\xff\xfe\x00\x01\xfd\xfa Subject with binary bytes +++ /// === >>> ???";
      const result = toBase64Url(input);

      expect(result).not.toContain("+");
      expect(result).not.toContain("/");
      expect(result).not.toContain("=");
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
