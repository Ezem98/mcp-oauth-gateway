export class ReconnectRequiredError extends Error {
  readonly connectHint: string;

  constructor(connectHint: string) {
    super(`Reconnect required: ${connectHint}`);
    this.name = "ReconnectRequiredError";
    this.connectHint = connectHint;
  }
}

export class GatewayTokenError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Gateway token error (HTTP ${status})`);
    this.name = "GatewayTokenError";
    this.status = status;
  }
}

export interface FetchGoogleAccessTokenOptions {
  gatewayUrl: string;
  serverId: string;
  userToken: string;
}

export async function fetchGoogleAccessToken({
  gatewayUrl,
  serverId,
  userToken,
}: FetchGoogleAccessTokenOptions): Promise<string> {
  const normalizedGateway = gatewayUrl.replace(/\/+$/, "");
  const url = `${normalizedGateway}/${encodeURIComponent(serverId)}/credentials/google/token`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${userToken}`,
    },
  });

  if (res.status === 409) {
    let connectHint = "";
    try {
      const data = (await res.json()) as {
        error?: string;
        connect_hint?: string;
      };
      if (data?.error === "reconnect_required") {
        connectHint = data.connect_hint ?? "";
        throw new ReconnectRequiredError(connectHint);
      }
    } catch (err) {
      if (err instanceof ReconnectRequiredError) {
        throw err;
      }
    }
    throw new GatewayTokenError(409);
  }

  if (!res.ok) {
    throw new GatewayTokenError(res.status);
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data?.access_token || typeof data.access_token !== "string") {
    throw new GatewayTokenError(
      res.status,
      "Malformed gateway token response"
    );
  }

  return data.access_token;
}
