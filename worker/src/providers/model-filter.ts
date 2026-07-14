// Chat-capable model filter policy — shared by the model-intake detection script
// (scripts/detect-new-models.mts, #484) and the dynamic BYO model list (#485). Whichever lands
// first defines this policy ONCE in a shared, import-free module (the project's
// single-source-enums convention — see registry.ts / gepa/termination-reason.ts); the other
// consumes it rather than re-deriving its own id rules.
//
// A provider's list-models endpoint returns EVERYTHING it serves — embeddings, TTS, ASR,
// moderation, image generation, dated/deprecated snapshots — so a raw listing is never directly
// usable. This module is the one place that decides "does Baseline treat this listed model as a
// chat-capable text-generation model." It says nothing about whether Baseline actually SUPPORTS a
// given id (that's the registry's MODEL_PROVIDER map) or whether a human has dismissed it (the
// model-intake ignore list) — both are the caller's job.
//
// Deliberately ZERO relative imports (same convention as registry.ts / termination-reason.ts): it
// sidesteps the dataset-adapter subtree's extensionless-import sharp edge entirely, so a future
// app-reachable consumer (#485) can import it without caring about the worker's NodeNext
// specifier style. Provider ids are re-declared locally (IntakeProvider) rather than imported
// from registry.ts, on purpose — the four provider names are the one fact this module needs, and
// duplicating a 4-item literal union costs nothing next to keeping this file import-free.
//
// Two policy shapes, driven by what each provider's API actually exposes:
//   - Google and Mistral carry capability metadata on every listed model
//     (supportedGenerationMethods / capabilities.completion_chat) — trust it.
//   - Anthropic and OpenAI carry no such field, so the policy is a conservative id pattern:
//     Anthropic keeps anything starting "claude-"; OpenAI keeps "gpt-*"/"o<digit>*" MINUS the
//     known non-chat families (realtime, audio, transcription, embeddings, whisper, tts, image
//     generation, moderation, search).

export type IntakeProvider = "anthropic" | "openai" | "google" | "mistral";

/** Raw shapes as returned by each provider's list-models endpoint (only the fields we read). */
export interface AnthropicRawModel {
  id: string;
}
export interface AnthropicListModelsResponse {
  data: AnthropicRawModel[];
}

export interface OpenAIRawModel {
  id: string;
}
export interface OpenAIListModelsResponse {
  data: OpenAIRawModel[];
}

export interface GoogleRawModel {
  /** e.g. "models/gemini-2.5-pro" — path-prefixed, unlike the other three providers. */
  name: string;
  supportedGenerationMethods?: string[];
}
export interface GoogleListModelsResponse {
  models: GoogleRawModel[];
}

export interface MistralRawModel {
  id: string;
  capabilities?: {
    completion_chat?: boolean;
    [key: string]: unknown;
  };
}
export interface MistralListModelsResponse {
  data: MistralRawModel[];
}

// OpenAI id families that ARE "gpt-*"/"o<digit>*" shaped but are NOT chat-completion models.
const OPENAI_NON_CHAT_PATTERNS: RegExp[] = [
  /realtime/i,
  /audio/i,
  /transcribe/i,
  /embedding/i,
  /whisper/i,
  /-tts/i,
  /\btts\b/i,
  /dall-e/i,
  /moderation/i,
  /image/i,
  /search/i,
];

export function isChatCapableAnthropicId(id: string): boolean {
  return /^claude-/.test(id);
}

export function isChatCapableOpenAIId(id: string): boolean {
  const isGptOrOFamily = /^gpt-/.test(id) || /^o\d/.test(id);
  if (!isGptOrOFamily) return false;
  return !OPENAI_NON_CHAT_PATTERNS.some((re) => re.test(id));
}

export function isChatCapableGoogleModel(model: GoogleRawModel): boolean {
  return (model.supportedGenerationMethods ?? []).includes("generateContent");
}

export function isChatCapableMistralModel(model: MistralRawModel): boolean {
  return model.capabilities?.completion_chat === true;
}

/** Google list-models names are path-prefixed ("models/gemini-2.5-pro") — strip the prefix to
 *  match the bare id the registry stores (and the id every other provider already uses bare). */
export function bareGoogleModelId(name: string): string {
  const idx = name.lastIndexOf("/");
  return idx === -1 ? name : name.slice(idx + 1);
}

/**
 * Parse + filter a provider's raw list-models JSON payload down to chat-capable model ids
 * (deduped, sorted). The one place that knows each provider's response envelope shape, so both
 * the detection script and a future BYO model-list consumer (#485) parse it identically.
 */
export function extractChatCapableModelIds(provider: IntakeProvider, payload: unknown): string[] {
  const ids = new Set<string>();
  switch (provider) {
    case "anthropic": {
      const data = (payload as Partial<AnthropicListModelsResponse> | undefined)?.data ?? [];
      for (const m of data) {
        if (m?.id && isChatCapableAnthropicId(m.id)) ids.add(m.id);
      }
      break;
    }
    case "openai": {
      const data = (payload as Partial<OpenAIListModelsResponse> | undefined)?.data ?? [];
      for (const m of data) {
        if (m?.id && isChatCapableOpenAIId(m.id)) ids.add(m.id);
      }
      break;
    }
    case "google": {
      const models = (payload as Partial<GoogleListModelsResponse> | undefined)?.models ?? [];
      for (const m of models) {
        if (m?.name && isChatCapableGoogleModel(m)) ids.add(bareGoogleModelId(m.name));
      }
      break;
    }
    case "mistral": {
      const data = (payload as Partial<MistralListModelsResponse> | undefined)?.data ?? [];
      for (const m of data) {
        if (m?.id && isChatCapableMistralModel(m)) ids.add(m.id);
      }
      break;
    }
  }
  return [...ids].sort();
}
