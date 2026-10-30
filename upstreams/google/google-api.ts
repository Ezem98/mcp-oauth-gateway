export class GoogleApiError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "GoogleApiError";
    this.status = status;
  }
}

export async function googleFetch(
  url: string,
  accessToken: string,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  const res = await fetch(url, {
    ...init,
    headers,
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: { message?: string } | string;
      };
      if (
        typeof body?.error === "object" &&
        typeof body.error?.message === "string"
      ) {
        message = body.error.message;
      } else if (typeof body?.error === "string") {
        message = body.error;
      }
    } catch {
      // Body was not JSON
    }
    throw new GoogleApiError(res.status, message);
  }

  return res;
}
