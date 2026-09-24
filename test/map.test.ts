import { test } from "node:test"
import assert from "node:assert/strict"
import { isChatGroup, keyModels, pickGroups, thinkingLevelMap, toModel } from "../index.ts"

test("thinkingLevelMap follows supported_reasoning_efforts", () => {
  // deepseek-v4-*: none/low/high/max
  assert.deepEqual(thinkingLevelMap(["none", "low", "high", "max"]), {
    off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max",
  })
  // zai/glm-5.3: thinking cannot be switched off
  assert.deepEqual(thinkingLevelMap(["low", "high", "max"]), {
    off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max",
  })
  assert.equal(thinkingLevelMap(null), undefined)
  assert.equal(thinkingLevelMap([]), undefined)
})

test("toModel maps limits, costs and vision", () => {
  const m = toModel({
    model_group: "qwen3.8-max",
    max_input_tokens: 991808.0,
    input_cost_per_token: 1.2e-6,
    supports_vision: true,
  })
  assert.equal(m.contextWindow, 991808)
  assert.equal(m.maxTokens, 8192)
  assert.ok(Math.abs(m.cost.input - 1.2) < 1e-9)
  assert.deepEqual(m.input, ["text", "image"])
  assert.equal(m.reasoning, false)
})

test("embeddings are skipped, null mode is kept", () => {
  assert.equal(isChatGroup({ model_group: "ollama/bge-m3", mode: "embedding" }), false)
  assert.equal(isChatGroup({ model_group: "ollama/qwen2.5:7b", mode: null }), true)
})

test("only models the key may call, cache costs from /model/info", () => {
  const groups = [
    { model_group: "deepseek-v4-pro", mode: "chat" },
    { model_group: "zai/glm-5.3", mode: "chat" },
    { model_group: "ollama/bge-m3", mode: "embedding" },
  ]
  const allowed = keyModels([
    { model_name: "deepseek-v4-pro", model_info: { cache_read_input_token_cost: 4.4e-8 } },
    { model_name: "deepseek-v4-pro", model_info: { cache_read_input_token_cost: 9e-8 } },
    { model_name: "ollama/bge-m3" },
  ])
  assert.deepEqual(pickGroups(groups, allowed).map((g) => g.model_group), ["deepseek-v4-pro"])
  assert.ok(Math.abs(allowed.get("deepseek-v4-pro")!.cacheRead - 0.044) < 1e-9)
  assert.equal(allowed.get("deepseek-v4-pro")!.cacheWrite, 0)
  // /model/info unavailable → no filter, as before
  assert.deepEqual(pickGroups(groups, undefined).map((g) => g.model_group), ["deepseek-v4-pro", "zai/glm-5.3"])
  assert.equal(toModel(groups[0], allowed.get("deepseek-v4-pro")).cost.cacheRead, allowed.get("deepseek-v4-pro")!.cacheRead)
})

test("reasoning pinned off on every deployment hides the levels", () => {
  const km = keyModels([
    { model_name: "qwen3.8-flash-no-reasoning", litellm_params: { enable_thinking: false } },
    { model_name: "deepseek-v4-flash-no-reasoning", litellm_params: { reasoning_effort: "none" } },
    { model_name: "deepseek-v4-flash", litellm_params: {} },
    { model_name: "mixed", litellm_params: { reasoning_effort: "none" } },
    { model_name: "mixed", litellm_params: {} },
  ])
  const group = { model_group: "x", supports_reasoning: true, supported_reasoning_efforts: ["none", "low", "high"] }
  for (const id of ["qwen3.8-flash-no-reasoning", "deepseek-v4-flash-no-reasoning"]) {
    const m = toModel(group, km.get(id))
    assert.equal(m.reasoning, false, id)
    assert.equal(m.thinkingLevelMap, undefined, id)
  }
  assert.equal(toModel(group, km.get("deepseek-v4-flash")).reasoning, true)
  assert.equal(toModel(group, km.get("mixed")).reasoning, true)
})
