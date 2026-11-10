import assert from "node:assert/strict";
import { test } from "node:test";
import { llmAnswer, llmRequest } from "./llm.mjs";

const SCHEMA = {
  type: "object",
  properties: { versions: { type: "array", items: { type: "object", properties: { version: { type: "string" } }, required: ["version"], additionalProperties: false } } },
  required: ["versions"],
  additionalProperties: false,
};
const OPTIONS = { model: "gpt-6-luna", apiKey: "key", prompt: "List the versions.", name: "tested_versions", schema: SCHEMA };

test("llmRequest builds an OpenCode Zen responses request with a strict JSON schema", () => {
  const request = llmRequest({ ...OPTIONS, provider: "opencode" });
  assert.equal(request.url, "https://opencode.ai/zen/v1/responses");
  assert.equal(request.headers.authorization, "Bearer key");
  assert.deepEqual(request.body, {
    model: "gpt-6-luna",
    input: "List the versions.",
    text: { format: { type: "json_schema", name: "tested_versions", schema: SCHEMA, strict: true } },
  });
});

test("llmRequest uses a configured base URL", () => {
  assert.equal(llmRequest({ ...OPTIONS, provider: "opencode", baseUrl: "https://proxy.example/v1/" }).url, "https://proxy.example/v1/responses");
});

test("llmRequest converts the schema for Gemini", () => {
  const request = llmRequest({ ...OPTIONS, provider: "gemini", model: "gemini-3.5-flash" });
  assert.equal(request.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
  assert.equal(request.headers["x-goog-api-key"], "key");
  assert.deepEqual(request.body.generationConfig.responseSchema, {
    type: "OBJECT",
    properties: { versions: { type: "ARRAY", items: { type: "OBJECT", properties: { version: { type: "STRING" } }, required: ["version"] } } },
    required: ["versions"],
  });
});

test("llmRequest rejects an unknown provider", () => {
  assert.throws(() => llmRequest({ ...OPTIONS, provider: "other" }), /unknown LLM provider `other`/);
});

test("llmAnswer reads the JSON text of a responses answer", () => {
  const result = {
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: '{"versions":[{"version":"4.7"}]}' }] },
    ],
  };
  assert.deepEqual(llmAnswer("opencode", result), { versions: [{ version: "4.7" }] });
  assert.deepEqual(llmAnswer("opencode", { output_text: '{"versions":[]}' }), { versions: [] });
});

test("llmAnswer reports refusals and empty answers", () => {
  assert.throws(() => llmAnswer("opencode", { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }), /refused the request: no/);
  assert.throws(() => llmAnswer("opencode", { status: "incomplete", output: [] }), /no text, status incomplete/);
});

test("llmAnswer reads the JSON text of a Gemini answer", () => {
  assert.deepEqual(llmAnswer("gemini", { candidates: [{ content: { parts: [{ text: '{"versions":[]}' }] } }] }), { versions: [] });
  assert.throws(() => llmAnswer("gemini", { candidates: [{ finishReason: "SAFETY" }] }), /finish reason SAFETY/);
});
