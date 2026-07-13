import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The module has `import "server-only"`, which throws outside a server bundle.
vi.mock("server-only", () => ({}));

// --- Mocks ---

const { mockMaybeSingle, mockRpc, mockLogWarn } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockRpc: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => {
  const builder = {
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: mockMaybeSingle,
    rpc: mockRpc,
  };
  builder.from.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  return { supabaseAdmin: builder };
});

vi.mock("@/lib/logging/server", () => ({
  log: { info: vi.fn(), warn: mockLogWarn, error: vi.fn(), debug: vi.fn() },
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
  listLiveModels,
  liveModelsByProviderForOrg,
  isModelAvailableForProvider,
  clearLiveModelsCache,
  LIVE_MODELS_SUCCESS_TTL_MS,
  LIVE_MODELS_FAILURE_TTL_MS,
} from "./live-models";

const ORG = "org-1";
const SECRET_ID = "sec-1";
const KEY = "sk-byo-key-abcdefghijklmnop";

/** A stored provider_keys row whose Vault secret decrypts to `secret`. */
function givenByoKey(secret: string | null) {
  mockMaybeSingle.mockResolvedValue({
    data: secret == null ? null : { secret_id: SECRET_ID },
    error: null,
  });
  mockRpc.mockResolvedValue({ data: secret, error: null });
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

const OPENAI_PAYLOAD = {
  data: [
    { id: "gpt-5" },
    { id: "gpt-5.3-preview" },
    { id: "whisper-1" }, // non-chat: filtered by the shared policy
    { id: "gpt-4o-audio-preview" }, // non-chat: filtered by the shared policy
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  clearLiveModelsCache();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("listLiveModels (#485)", () => {
  it("lists a BYO provider's chat-capable models via the shared filter policy", async () => {
    givenByoKey(KEY);
    fetchMock.mockResolvedValue(jsonResponse(OPENAI_PAYLOAD));

    const ids = await listLiveModels(ORG, "openai");
    expect(ids).toEqual(["gpt-5", "gpt-5.3-preview"]);

    // Fixed literal host + the Team's own key on the auth header.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
  });

  it("honors the operator-only *_API_BASE_OVERRIDE env vars", async () => {
    vi.stubEnv("OPENAI_API_BASE_OVERRIDE", "http://127.0.0.1:4311/openai/v1");
    givenByoKey(KEY);
    fetchMock.mockResolvedValue(jsonResponse(OPENAI_PAYLOAD));

    await listLiveModels(ORG, "openai");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:4311/openai/v1/models");
  });

  it("sends Anthropic's version header and key header, never a bearer token", async () => {
    givenByoKey(KEY);
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: "claude-fable-5" }, { id: "not-a-chat-model" }] }),
    );

    const ids = await listLiveModels(ORG, "anthropic");
    expect(ids).toEqual(["claude-fable-5"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(init.headers).toMatchObject({
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    });
  });

  it("keeps Google's key on a header (never the URL) and strips the models/ prefix", async () => {
    givenByoKey(KEY);
    fetchMock.mockResolvedValue(
      jsonResponse({
        models: [
          { name: "models/gemini-3.1-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        ],
      }),
    );

    const ids = await listLiveModels(ORG, "google");
    expect(ids).toEqual(["gemini-3.1-pro"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain(KEY);
    expect(init.headers).toMatchObject({ "x-goog-api-key": KEY });
  });

  it("filters Mistral by the completion_chat capability", async () => {
    givenByoKey(KEY);
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { id: "mistral-huge-latest", capabilities: { completion_chat: true } },
          { id: "mistral-embed", capabilities: { completion_chat: false } },
        ],
      }),
    );

    expect(await listLiveModels(ORG, "mistral")).toEqual(["mistral-huge-latest"]);
  });

  it("returns [] without ever fetching when the Team has no usable BYO key (never the managed key)", async () => {
    givenByoKey(null); // no provider_keys row at all
    expect(await listLiveModels(ORG, "openai")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a blank-secret row as no key (usability rule, #371)", async () => {
    givenByoKey("   ");
    expect(await listLiveModels(ORG, "openai")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] on an HTTP error", async () => {
    givenByoKey(KEY);
    fetchMock.mockResolvedValue(jsonResponse({ error: "nope" }, 500));
    expect(await listLiveModels(ORG, "openai")).toEqual([]);
  });

  it("returns [] on a network error / timeout, never throwing", async () => {
    givenByoKey(KEY);
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(listLiveModels(ORG, "openai")).resolves.toEqual([]);
  });

  it("returns [] on an unparseable payload", async () => {
    givenByoKey(KEY);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    });
    expect(await listLiveModels(ORG, "openai")).toEqual([]);
  });

  it("caches a successful listing per org+provider (no second fetch inside the TTL)", async () => {
    givenByoKey(KEY);
    fetchMock.mockResolvedValue(jsonResponse(OPENAI_PAYLOAD));

    await listLiveModels(ORG, "openai");
    await listLiveModels(ORG, "openai");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A different org (and a different provider) each get their own entry.
    await listLiveModels("org-2", "openai");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Past the success TTL the listing is re-fetched.
    vi.advanceTimersByTime(LIVE_MODELS_SUCCESS_TTL_MS + 1);
    await listLiveModels(ORG, "openai");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("caches a failure only briefly, so a recovered provider (or a fresh key) shows up fast", async () => {
    givenByoKey(KEY);
    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    expect(await listLiveModels(ORG, "openai")).toEqual([]);

    // Within the failure TTL: served from cache, no hammering.
    fetchMock.mockResolvedValue(jsonResponse(OPENAI_PAYLOAD));
    expect(await listLiveModels(ORG, "openai")).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past it: the fresh listing lands.
    vi.advanceTimersByTime(LIVE_MODELS_FAILURE_TTL_MS + 1);
    expect(await listLiveModels(ORG, "openai")).toEqual(["gpt-5", "gpt-5.3-preview"]);
  });
});

describe("liveModelsByProviderForOrg (#485)", () => {
  it("returns only providers with a non-empty live listing", async () => {
    givenByoKey(KEY);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("api.openai.com")) return jsonResponse(OPENAI_PAYLOAD);
      return jsonResponse({}, 500);
    });

    const map = await liveModelsByProviderForOrg(ORG, ["openai", "mistral"]);
    expect(map).toEqual({ openai: ["gpt-5", "gpt-5.3-preview"] });
  });
});

describe("isModelAvailableForProvider (#485)", () => {
  it("accepts a registry model for its own provider without fetching", async () => {
    expect(await isModelAvailableForProvider(ORG, "openai", "gpt-5")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a registry model claimed for another provider", async () => {
    givenByoKey(null);
    expect(await isModelAvailableForProvider(ORG, "anthropic", "gpt-5")).toBe(false);
  });

  it("accepts a model present in the provider's live list (BYO key)", async () => {
    givenByoKey(KEY);
    fetchMock.mockResolvedValue(jsonResponse(OPENAI_PAYLOAD));
    expect(await isModelAvailableForProvider(ORG, "openai", "gpt-5.3-preview")).toBe(true);
  });

  it("rejects a non-registry model when the provider has no BYO key (managed mode stays curated)", async () => {
    givenByoKey(null);
    expect(await isModelAvailableForProvider(ORG, "openai", "gpt-5.3-preview")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a live id that is a registry model of a DIFFERENT provider, without fetching (#8)", async () => {
    // Even if a provider's /models listing returned another vendor's id, the worker would reject
    // the pair (allowUnlistedReflectModel only admits ids the registry doesn't know) and silently
    // run its own default — so validation refuses it to keep the two in agreement.
    givenByoKey(KEY);
    expect(await isModelAvailableForProvider(ORG, "mistral", "gpt-5")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("admits a non-registry model on a network/timeout blip, never refusing a legit pick (#5)", async () => {
    givenByoKey(KEY);
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await isModelAvailableForProvider(ORG, "openai", "gpt-5.3-preview")).toBe(true);
  });

  it("admits a non-registry model when the provider answers with an HTTP error (couldn't reach, #5)", async () => {
    givenByoKey(KEY);
    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    expect(await isModelAvailableForProvider(ORG, "openai", "gpt-5.3-preview")).toBe(true);
  });

  it("re-reads the key FRESH each call, so a key deleted after a cached success refuses (#3)", async () => {
    // A prior wizard render cached the success list (5-min TTL)...
    givenByoKey(KEY);
    fetchMock.mockResolvedValue(jsonResponse(OPENAI_PAYLOAD));
    expect(await listLiveModels(ORG, "openai")).toEqual(["gpt-5", "gpt-5.3-preview"]);

    // ...then the Team deletes its OpenAI key. The authoritative gate bypasses that cache and
    // re-reads the key state, refusing rather than waving a run through on the stale success.
    givenByoKey(null);
    expect(await isModelAvailableForProvider(ORG, "openai", "gpt-5.3-preview")).toBe(false);
  });
});
