import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** Один элемент ответа LiteLLM `GET /model_group/info`. Всё, кроме имени, может быть null. */
export type LiteLLMGroup = {
  model_group: string
  mode?: string | null
  max_input_tokens?: number | null
  max_output_tokens?: number | null
  input_cost_per_token?: number | null
  output_cost_per_token?: number | null
  supports_vision?: boolean | null
  supports_reasoning?: boolean | null
  supported_reasoning_efforts?: string[] | null
}

type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

/** Режимы, которые в списке моделей чата не нужны. */
const SKIP_MODES = new Set([
  "embedding",
  "rerank",
  "moderation",
  "moderations",
  "image_generation",
  "audio_transcription",
  "audio_speech",
])

/** Уровень pi → значения LiteLLM, которыми его можно выразить, по порядку предпочтения. */
const LEVELS: [Level, string[]][] = [
  ["off", ["none", "off"]],
  ["minimal", ["minimal"]],
  ["low", ["low"]],
  ["medium", ["medium"]],
  ["high", ["high"]],
  ["xhigh", ["xhigh"]],
  ["max", ["max"]],
]

const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 8_192

/** LiteLLM отдаёт цену за токен, pi ждёт за миллион. */
const perMillion = (v: number | null | undefined) => (typeof v === "number" ? v * 1e6 : 0)

const toInt = (v: number | null | undefined, fallback: number) =>
  typeof v === "number" && v > 0 ? Math.floor(v) : fallback

export function isChatGroup(group: LiteLLMGroup): boolean {
  // mode у части рабочих моделей null — это не повод их прятать, отсекаем только явно не-чатовые.
  return !SKIP_MODES.has(String(group.mode ?? "").toLowerCase())
}

/**
 * Уровни reasoning, объявленные LiteLLM, → `thinkingLevelMap` pi. Непринятый уровень —
 * это 400 у провайдера, cooldown деплоймента и 429 всем на прокси, поэтому такие уровни
 * помечаем null: pi прячет их из меню и сдвигает запрос на ближайший разрешённый.
 * Без объявленного набора карты нет — pi шлёт уровни как есть.
 */
export function thinkingLevelMap(efforts: string[] | null | undefined) {
  if (!efforts || efforts.length === 0) return undefined
  return Object.fromEntries(
    LEVELS.map(([level, candidates]) => [level, candidates.find((c) => efforts.includes(c)) ?? null]),
  ) as Record<Level, string | null>
}

/** Модель в формате `registerProvider(...).models[]` pi. */
export function toModel(group: LiteLLMGroup) {
  return {
    id: group.model_group,
    name: group.model_group,
    reasoning: group.supports_reasoning === true,
    thinkingLevelMap: thinkingLevelMap(group.supported_reasoning_efforts),
    input: (group.supports_vision === true ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: {
      input: perMillion(group.input_cost_per_token),
      output: perMillion(group.output_cost_per_token),
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: toInt(group.max_input_tokens, DEFAULT_CONTEXT),
    maxTokens: toInt(group.max_output_tokens, DEFAULT_OUTPUT),
  }
}

/** `https://host/v1` → `https://host`: model_group/info живёт в корне прокси. */
export function proxyRoot(baseURL: string): string {
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/, "")
}

export async function fetchGroups(baseURL: string, apiKey?: string): Promise<LiteLLMGroup[]> {
  const res = await fetch(`${proxyRoot(baseURL)}/model_group/info`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    // pi ждёт фабрику до старта: недоступный прокси не должен вешать запуск.
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) {
    // Тело ответа LiteLLM отличает «ключ не передан» от «ключ не найден в базе»,
    // а сам ключ в нём уже маскирован — без этого 401 не диагностируется.
    const detail = (await res.text().catch(() => "")).trim().slice(0, 300)
    throw new Error(`model_group/info: HTTP ${res.status}${detail ? ` ${detail}` : ""}`)
  }
  const body = (await res.json()) as { data?: LiteLLMGroup[] }
  return body.data ?? []
}

export default async function (pi: ExtensionAPI) {
  const baseURL = process.env.LITELLM_BASE_URL
  if (!baseURL) {
    console.warn("[litellm] LITELLM_BASE_URL is not set; provider not registered")
    return
  }
  try {
    const groups = await fetchGroups(baseURL, process.env.LITELLM_API_KEY)
    pi.registerProvider("litellm", {
      name: "LiteLLM",
      baseUrl: baseURL,
      apiKey: "$LITELLM_API_KEY",
      api: "openai-completions",
      models: groups.filter(isChatGroup).map(toModel),
    })
  } catch (err) {
    // Бросать нельзя — pi не стартует. Молчать тоже: снаружи это выглядит как «нет моделей».
    console.warn(`[litellm] could not read the model list (${err}); provider not registered`)
  }
}
