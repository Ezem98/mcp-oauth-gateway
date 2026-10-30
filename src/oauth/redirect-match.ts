const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Validates whether a requested OAuth redirect_uri matches any of the client's
 * registered redirect_uris according to RFC 8252 §7.3 (Loopback Interface Redirection).
 *
 * Rules:
 * 1. If requested exactly equals any registered URI, it matches.
 * 2. If the registered URI is a loopback URI (scheme http/https, host 127.0.0.1, [::1],
 *    or localhost), the requested redirect_uri must match it ignoring ONLY the port.
 *    The scheme, host, path, and query components must match exactly.
 *    Neither registered nor requested URI may contain userinfo.
 * 3. Non-loopback redirect URIs require exact string matching.
 */
export function redirectUriMatches(
  registered: string[],
  requested: string
): boolean {
  if (registered.includes(requested)) {
    return true;
  }

  let reqUrl: URL;
  try {
    reqUrl = new URL(requested);
  } catch {
    return false;
  }

  // Scheme must be http: or https:
  if (reqUrl.protocol !== "http:" && reqUrl.protocol !== "https:") {
    return false;
  }

  // Requested host must be a loopback host
  if (!LOOPBACK_HOSTS.has(reqUrl.hostname)) {
    return false;
  }

  // Reject any userinfo in requested URI (e.g. http://127.0.0.1@evil.com or http://user:pass@127.0.0.1)
  if (reqUrl.username || reqUrl.password) {
    return false;
  }

  for (const reg of registered) {
    let regUrl: URL;
    try {
      regUrl = new URL(reg);
    } catch {
      continue;
    }

    if (regUrl.protocol !== "http:" && regUrl.protocol !== "https:") {
      continue;
    }

    if (!LOOPBACK_HOSTS.has(regUrl.hostname)) {
      continue;
    }

    if (regUrl.username || regUrl.password) {
      continue;
    }

    // Must match scheme, host, path, query, and hash (ignoring only the port)
    if (
      regUrl.protocol === reqUrl.protocol &&
      regUrl.hostname === reqUrl.hostname &&
      regUrl.pathname === reqUrl.pathname &&
      regUrl.search === reqUrl.search &&
      regUrl.hash === reqUrl.hash
    ) {
      return true;
    }
  }

  return false;
}
