import assert from "node:assert/strict";
import { test } from "node:test";
import { llmAnswer, llmRequest } from "./llm.mjs";

const SCHEMA = {
  type: "object",
  properties: { versions: { type: "array", items: { type: "object", properties: { version: { type: "string" } }, required: ["version"], additionalProperties: false } } },
  required: ["versions"],
  additionalProperties: false,
};
const OPTIONS = { model: "gpt-6-luna", apiKey: "key", prompt: "List the versions.", name: "tested_versions", schema: SCHEMA, sessionId: "run-1", reasoning: "low" };

test("llmRequest builds an OpenCode Go responses request with a strict JSON schema and a session", () => {
  const request = llmRequest({ ...OPTIONS, provider: "opencode-go" });
  assert.equal(request.url, "https://opencode.ai/inference/go/openai/v1/responses");
  assert.equal(request.headers.authorization, "Bearer key");
  assert.equal(request.headers["x-opencode-session"], "run-1");
  assert.equal(request.headers["user-agent"], "godot-release-check");
  assert.deepEqual(request.body, {
    model: "gpt-6-luna",
    input: "List the versions.",
    text: { format: { type: "json_schema", name: "tested_versions", schema: SCHEMA, strict: true } },
    reasoning: { effort: "low" },
  });
});

test("llmRequest uses the OpenCode Zen endpoint and leaves the reasoning effort out when it is empty", () => {
  const request = llmRequest({ ...OPTIONS, provider: "opencode-zen", reasoning: "" });
  assert.equal(request.url, "https://opencode.ai/inference/openai/v1/responses");
  assert.equal(request.body.reasoning, undefined);
});

test("llmRequest uses a configured base URL", () => {
  assert.equal(llmRequest({ ...OPTIONS, provider: "opencode-go", baseUrl: "https://proxy.example/v1/" }).url, "https://proxy.example/v1/responses");
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
  assert.deepEqual(llmAnswer("opencode-go", result), { versions: [{ version: "4.7" }] });
  assert.deepEqual(llmAnswer("opencode-go", { output_text: '{"versions":[]}' }), { versions: [] });
});

test("llmAnswer reports refusals and empty answers", () => {
  assert.throws(() => llmAnswer("opencode-go", { output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }), /refused the request: no/);
  assert.throws(() => llmAnswer("opencode-go", { status: "incomplete", output: [] }), /no text, status incomplete/);
});

test("llmAnswer reads the JSON text of a Gemini answer", () => {
  assert.deepEqual(llmAnswer("gemini", { candidates: [{ content: { parts: [{ text: '{"versions":[]}' }] } }] }), { versions: [] });
  assert.throws(() => llmAnswer("gemini", { candidates: [{ finishReason: "SAFETY" }] }), /finish reason SAFETY/);
});
