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

/** Один деплоймент из `GET /model/info`. `litellm_params` не читаем: там ссылки на ключи провайдеров. */
export type LiteLLMDeployment = {
  model_name: string
  model_info?: {
    cache_read_input_token_cost?: number | null
    cache_creation_input_token_cost?: number | null
  } | null
}

export type CacheCost = { cacheRead: number; cacheWrite: number }

/**
 * Модели, доступные ключу, с ценой кэша. Первый деплоймент имени выигрывает.
 * ponytail: при нескольких деплойментах с разной ценой берётся первая, не максимум.
 */
export function keyModels(deployments: LiteLLMDeployment[]): Map<string, CacheCost> {
  const out = new Map<string, CacheCost>()
  for (const d of deployments) {
    if (out.has(d.model_name)) continue
    out.set(d.model_name, {
      cacheRead: perMillion(d.model_info?.cache_read_input_token_cost),
      cacheWrite: perMillion(d.model_info?.cache_creation_input_token_cost),
    })
  }
  return out
}

/** Чат-группы, которые ключ может вызвать. Без списка ключа (`undefined`) — все чат-группы. */
export function pickGroups(groups: LiteLLMGroup[], allowed?: Map<string, CacheCost>): LiteLLMGroup[] {
  return groups.filter((g) => isChatGroup(g) && (!allowed || allowed.has(g.model_group)))
}

/** Модель в формате `registerProvider(...).models[]` pi. */
export function toModel(group: LiteLLMGroup, cache?: CacheCost) {
  return {
    id: group.model_group,
    name: group.model_group,
    reasoning: group.supports_reasoning === true,
    thinkingLevelMap: thinkingLevelMap(group.supported_reasoning_efforts),
    input: (group.supports_vision === true ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    cost: {
      input: perMillion(group.input_cost_per_token),
      output: perMillion(group.output_cost_per_token),
      cacheRead: cache?.cacheRead ?? 0,
      cacheWrite: cache?.cacheWrite ?? 0,
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

/**
 * `/model_group/info` отдаёт все публичные группы, в том числе чужие для ключа (запрос к ним — 403),
 * а `/model/info` — только деплойменты, доступные ключу, но без уровней reasoning. Берём пересечение.
 * Если `/model/info` не отвечает или пуст — фильтра нет, как раньше.
 */
export async function fetchKeyModels(baseURL: string, apiKey?: string): Promise<Map<string, CacheCost> | undefined> {
  try {
    const res = await fetch(`${proxyRoot(baseURL)}/model/info`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { data?: LiteLLMDeployment[] }
    const models = keyModels(body.data ?? [])
    if (models.size > 0) return models
    throw new Error("empty list")
  } catch (err) {
    console.warn(`[litellm] model/info: ${err}; showing every model group, some may answer 403`)
    return undefined
  }
}

export default async function (pi: ExtensionAPI) {
  const baseURL = process.env.LITELLM_BASE_URL
  if (!baseURL) {
    console.warn("[litellm] LITELLM_BASE_URL is not set; provider not registered")
    return
  }
  try {
    const apiKey = process.env.LITELLM_API_KEY
    const [groups, allowed] = await Promise.all([fetchGroups(baseURL, apiKey), fetchKeyModels(baseURL, apiKey)])
    pi.registerProvider("litellm", {
      name: "LiteLLM",
      baseUrl: baseURL,
      apiKey: "$LITELLM_API_KEY",
      api: "openai-completions",
      models: pickGroups(groups, allowed).map((g) => toModel(g, allowed?.get(g.model_group))),
    })
  } catch (err) {
    // Бросать нельзя — pi не стартует. Молчать тоже: снаружи это выглядит как «нет моделей».
    console.warn(`[litellm] could not read the model list (${err}); provider not registered`)
  }
}
