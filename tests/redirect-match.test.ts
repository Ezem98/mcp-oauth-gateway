import { describe, it, expect } from "vitest";
import { redirectUriMatches } from "../src/oauth/redirect-match.js";

describe("RFC 8252 §7.3 loopback redirect URI matching", () => {
  it("exact match: matches identical non-loopback and loopback URIs", () => {
    expect(
      redirectUriMatches(
        ["https://example.com/oauth/callback"],
        "https://example.com/oauth/callback"
      )
    ).toBe(true);

    expect(
      redirectUriMatches(
        ["http://127.0.0.1:4000/callback"],
        "http://127.0.0.1:4000/callback"
      )
    ).toBe(true);

    expect(
      redirectUriMatches(
        ["http://localhost:3000/callback"],
        "http://localhost:3000/callback"
      )
    ).toBe(true);
  });

  it("loopback different port ok: matches when only the port differs on 127.0.0.1, localhost, [::1]", () => {
    // 127.0.0.1
    expect(
      redirectUriMatches(
        ["http://127.0.0.1:8080/callback"],
        "http://127.0.0.1:9090/callback"
      )
    ).toBe(true);

    // localhost
    expect(
      redirectUriMatches(
        ["http://localhost:8080/callback"],
        "http://localhost:9090/callback"
      )
    ).toBe(true);

    // [::1] (IPv6 loopback)
    expect(
      redirectUriMatches(
        ["http://[::1]:8080/callback"],
        "http://[::1]:9090/callback"
      )
    ).toBe(true);
  });

  it("loopback registered without port + requested with port ok (and vice-versa)", () => {
    // Registered without port, requested with port
    expect(
      redirectUriMatches(
        ["http://127.0.0.1/callback"],
        "http://127.0.0.1:54321/callback"
      )
    ).toBe(true);

    expect(
      redirectUriMatches(
        ["http://localhost/callback"],
        "http://localhost:54321/callback"
      )
    ).toBe(true);

    expect(
      redirectUriMatches(
        ["http://[::1]/callback"],
        "http://[::1]:54321/callback"
      )
    ).toBe(true);

    // Registered with port, requested without port
    expect(
      redirectUriMatches(
        ["http://127.0.0.1:54321/callback"],
        "http://127.0.0.1/callback"
      )
    ).toBe(true);

    expect(
      redirectUriMatches(
        ["http://localhost:54321/callback"],
        "http://localhost/callback"
      )
    ).toBe(true);
  });

  it("different path rejected: path components must match exactly", () => {
    expect(
      redirectUriMatches(
        ["http://127.0.0.1:8080/callback"],
        "http://127.0.0.1:8080/different"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["http://127.0.0.1:8080/callback"],
        "http://127.0.0.1:9090/callback/subpath"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["http://localhost/callback"],
        "http://localhost:3000/callback/"
      )
    ).toBe(false);
  });

  it("different host rejected: loopback hosts cannot be substituted for each other", () => {
    expect(
      redirectUriMatches(
        ["http://localhost/callback"],
        "http://127.0.0.1/callback"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["http://localhost/callback"],
        "http://127.0.0.1:8080/callback"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["http://127.0.0.1/callback"],
        "http://[::1]:8080/callback"
      )
    ).toBe(false);
  });

  it("non-loopback different port rejected: port relaxation applies only to loopback hosts", () => {
    expect(
      redirectUriMatches(
        ["http://example.com:8080/callback"],
        "http://example.com:9090/callback"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["https://example.com/callback"],
        "https://example.com:8443/callback"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["http://192.168.1.100/callback"],
        "http://192.168.1.100:8080/callback"
      )
    ).toBe(false);
  });

  it("https loopback is NOT special-cased: allow both http and https loopback, but never non-loopback hosts", () => {
    // https loopback port variation allowed
    expect(
      redirectUriMatches(
        ["https://127.0.0.1:8443/callback"],
        "https://127.0.0.1:9443/callback"
      )
    ).toBe(true);

    expect(
      redirectUriMatches(
        ["https://localhost/callback"],
        "https://localhost:8443/callback"
      )
    ).toBe(true);

    expect(
      redirectUriMatches(
        ["https://[::1]:8443/callback"],
        "https://[::1]:9443/callback"
      )
    ).toBe(true);

    // Scheme mismatch rejected (http vs https)
    expect(
      redirectUriMatches(
        ["http://127.0.0.1/callback"],
        "https://127.0.0.1:8443/callback"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["https://localhost:8443/callback"],
        "http://localhost:8443/callback"
      )
    ).toBe(false);

    // Non-loopback https host with different port rejected
    expect(
      redirectUriMatches(
        ["https://example.com/callback"],
        "https://example.com:8443/callback"
      )
    ).toBe(false);
  });

  it("'localhost.evil.com' rejected: domain suffix attacks must not match loopback", () => {
    expect(
      redirectUriMatches(
        ["http://localhost/callback"],
        "http://localhost.evil.com/callback"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["http://localhost.evil.com/callback"],
        "http://localhost.evil.com:8080/callback"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["http://127.0.0.1/callback"],
        "http://127.0.0.1.nip.io:8080/callback"
      )
    ).toBe(false);
  });

  it("userinfo tricks like http://127.0.0.1@evil.com rejected", () => {
    // Host is actually evil.com, userinfo is 127.0.0.1
    expect(
      redirectUriMatches(
        ["http://127.0.0.1/callback"],
        "http://127.0.0.1@evil.com/callback"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["http://127.0.0.1:8080/callback"],
        "http://127.0.0.1@evil.com:8080/callback"
      )
    ).toBe(false);

    // Userinfo injected on loopback
    expect(
      redirectUriMatches(
        ["http://127.0.0.1/callback"],
        "http://user:pass@127.0.0.1:8080/callback"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["http://user:pass@127.0.0.1/callback"],
        "http://127.0.0.1:8080/callback"
      )
    ).toBe(false);
  });

  it("query parameters: must match exactly when present", () => {
    expect(
      redirectUriMatches(
        ["http://127.0.0.1/callback?client=1"],
        "http://127.0.0.1:8080/callback?client=1"
      )
    ).toBe(true);

    expect(
      redirectUriMatches(
        ["http://127.0.0.1/callback?client=1"],
        "http://127.0.0.1:8080/callback?client=2"
      )
    ).toBe(false);

    expect(
      redirectUriMatches(
        ["http://127.0.0.1/callback?client=1"],
        "http://127.0.0.1:8080/callback"
      )
    ).toBe(false);
  });

  it("handles invalid or malformed URL strings gracefully", () => {
    expect(redirectUriMatches(["http://localhost/callback"], "not-a-valid-url")).toBe(false);
    expect(redirectUriMatches(["not-a-valid-url"], "http://localhost/callback")).toBe(false);
    expect(redirectUriMatches([], "http://localhost/callback")).toBe(false);
  });
});
