// Minimal JSON POST for the fetch-based provider clients (#204). OpenAI and Google ship no SDK
// in the worker, so their clients call the REST API directly. Like AnthropicProvider's pinned
// baseURL (#222), the host is a fixed literal at each call site here — never tenant-influenced —
// so a managed key can only ever leave our infra to the real provider host.

/** Thrown on a non-2xx provider response, carrying the status + body for diagnosis. */
export class ProviderHttpError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number,
    body: string,
  ) {
    super(`${provider} API returned HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "ProviderHttpError";
  }
}

export async function postJson<T>(opts: {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}): Promise<T> {
  const res = await fetch(opts.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    body: JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderHttpError(opts.provider, res.status, text);
  }
  return (await res.json()) as T;
}
