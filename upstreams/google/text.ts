export function truncate(
  text: string,
  max: number
): { text: string; truncated: boolean } {
  if (text.length <= max) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, max), truncated: true };
}

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
