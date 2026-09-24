import { test } from "node:test"
import assert from "node:assert/strict"
import { isChatGroup, thinkingLevelMap, toModel } from "../index.ts"

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
