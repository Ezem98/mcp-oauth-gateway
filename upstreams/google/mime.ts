export function assertNoHeaderInjection(name: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Invalid header "${name}": newline characters are not allowed`
    );
  }
}

export function encodeHeaderValue(value: string): string {
  // If ASCII-only (characters 0-127), return as-is
  if (/^[\x00-\x7F]*$/.test(value)) {
    return value;
  }

  const words: string[] = [];
  let currentChunk = "";
  let currentBytes = 0;

  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (currentBytes + charBytes > 45) {
      if (currentChunk.length > 0) {
        const b64 = Buffer.from(currentChunk, "utf-8").toString("base64");
        words.push(`=?UTF-8?B?${b64}?=`);
      }
      currentChunk = char;
      currentBytes = charBytes;
    } else {
      currentChunk += char;
      currentBytes += charBytes;
    }
  }

  if (currentChunk.length > 0) {
    const b64 = Buffer.from(currentChunk, "utf-8").toString("base64");
    words.push(`=?UTF-8?B?${b64}?=`);
  }

  return words.join("\r\n ");
}

export interface BuildMimeMessageOptions {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
}

export function buildMimeMessage({
  to,
  subject,
  body,
  cc,
  inReplyTo,
  references,
}: BuildMimeMessageOptions): string {
  assertNoHeaderInjection("To", to);
  if (cc !== undefined) {
    assertNoHeaderInjection("Cc", cc);
  }
  assertNoHeaderInjection("Subject", subject);
  if (inReplyTo !== undefined) {
    assertNoHeaderInjection("In-Reply-To", inReplyTo);
  }
  if (references !== undefined) {
    assertNoHeaderInjection("References", references);
  }

  const headers: string[] = [`To: ${to}`];
  if (cc && cc.trim().length > 0) {
    headers.push(`Cc: ${cc}`);
  }
  headers.push(`Subject: ${encodeHeaderValue(subject)}`);
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");
  if (inReplyTo && inReplyTo.trim().length > 0) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
  }
  if (references && references.trim().length > 0) {
    headers.push(`References: ${references}`);
  }

  const b64Body = Buffer.from(body, "utf-8").toString("base64");
  const wrappedLines: string[] = [];
  for (let i = 0; i < b64Body.length; i += 76) {
    wrappedLines.push(b64Body.slice(i, i + 76));
  }
  const bodyText = wrappedLines.join("\r\n");

  return (
    headers.join("\r\n") + "\r\n\r\n" + (bodyText ? bodyText + "\r\n" : "")
  );
}

export function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf-8").toString("base64url").replace(/=/g, "");
}
