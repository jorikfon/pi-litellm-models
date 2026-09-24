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

/**
 * Один деплоймент из `GET /model/info`. Из `litellm_params` читаем только reasoning-поля:
 * остальное там — ссылки на ключи провайдеров, его не логируем и не храним.
 */
export type LiteLLMDeployment = {
  model_name: string
  litellm_params?: {
    reasoning_effort?: unknown
    enable_thinking?: unknown
    thinking?: { type?: unknown } | null
  } | null
  model_info?: {
    cache_read_input_token_cost?: number | null
    cache_creation_input_token_cost?: number | null
  } | null
}

export type KeyModel = { cacheRead: number; cacheWrite: number; noReasoning: boolean }

/** Reasoning выключен на самом деплойменте — уровни от клиента он всё равно не примет. */
export function reasoningPinnedOff(d: LiteLLMDeployment): boolean {
  const p = d.litellm_params ?? {}
  return p.reasoning_effort === "none" || p.enable_thinking === false || p.thinking?.type === "disabled"
}

/**
 * Модели, доступные ключу, с ценой кэша и признаком выключенного reasoning.
 * Цена — от первого деплоймента имени; reasoning выключен, только если выключен у всех.
 * ponytail: при нескольких деплойментах с разной ценой берётся первая, не максимум.
 */
export function keyModels(deployments: LiteLLMDeployment[]): Map<string, KeyModel> {
  const out = new Map<string, KeyModel>()
  for (const d of deployments) {
    const seen = out.get(d.model_name)
    if (seen) {
      seen.noReasoning &&= reasoningPinnedOff(d)
      continue
    }
    out.set(d.model_name, {
      cacheRead: perMillion(d.model_info?.cache_read_input_token_cost),
      cacheWrite: perMillion(d.model_info?.cache_creation_input_token_cost),
      noReasoning: reasoningPinnedOff(d),
    })
  }
  return out
}

/** Чат-группы, которые ключ может вызвать. Без списка ключа (`undefined`) — все чат-группы. */
export function pickGroups(groups: LiteLLMGroup[], allowed?: Map<string, KeyModel>): LiteLLMGroup[] {
  return groups.filter((g) => isChatGroup(g) && (!allowed || allowed.has(g.model_group)))
}

/** Модель в формате `registerProvider(...).models[]` pi. */
export function toModel(group: LiteLLMGroup, cache?: KeyModel) {
  // У `*-no-reasoning` LiteLLM объявляет supports_reasoning, но деплоймент его выключает: меню уровней не нужно.
  const reasoning = group.supports_reasoning === true && !cache?.noReasoning
  return {
    id: group.model_group,
    name: group.model_group,
    reasoning,
    thinkingLevelMap: reasoning ? thinkingLevelMap(group.supported_reasoning_efforts) : undefined,
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
export async function fetchKeyModels(baseURL: string, apiKey?: string): Promise<Map<string, KeyModel> | undefined> {
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
