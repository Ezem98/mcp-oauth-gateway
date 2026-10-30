export function truncate(
  text: string,
  max: number
): { text: string; truncated: boolean } {
  if (text.length <= max) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, max), truncated: true };
}

const NAMED_ENTITIES: Record<string, string> = {
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü",
  iexcl: "¡", iquest: "¿", apos: "'", euro: "€",
  laquo: "«", raquo: "»", ndash: "–", mdash: "—", hellip: "…",
};

export function stripHtml(html: string): string {
  // Drop <script> and <style> blocks (including multiline and attributes)
  let text = html
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\/\s*script\s*>/gi, "")
    .replace(/<\s*style\b[^>]*>[\s\S]*?<\/\s*style\s*>/gi, "");

  // Turn <br>, </p>, </div>, </li>, </tr> into newlines
  text = text.replace(/<\s*br\s*\/?>/gi, "\n");
  text = text.replace(/<\/\s*(?:p|div|li|tr)\s*>/gi, "\n");

  // Remove all other HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Named entities common in Spanish mail (&aacute; &ntilde; ...). &amp; is
  // left for the pass below so "&amp;aacute;" isn't double-decoded.
  text = text.replace(
    /&([a-zA-Z]+);/g,
    (match, name: string) => NAMED_ENTITIES[name] ?? match
  );

  // Decode &amp; &lt; &gt; &quot; &#39; &nbsp; and numeric entities (&#NNN; / &#xHH;)
  text = text.replace(
    /&(?:amp|lt|gt|quot|#39|nbsp|#\d+|#[xX][0-9a-fA-F]+);/g,
    (match) => {
      const lower = match.toLowerCase();
      if (lower === "&amp;") return "&";
      if (lower === "&lt;") return "<";
      if (lower === "&gt;") return ">";
      if (lower === "&quot;") return '"';
      if (lower === "&#39;") return "'";
      if (lower === "&nbsp;") return " ";
      if (lower.startsWith("&#x")) {
        const hex = lower.slice(3, -1);
        const code = parseInt(hex, 16);
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      if (lower.startsWith("&#")) {
        const dec = lower.slice(2, -1);
        const code = parseInt(dec, 10);
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
  );

  // Normalize line endings, collapse 3+ newlines into 2, and trim
  return text
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeBase64Url(data: string): string {
  const normalized = data.trim().replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

export function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
