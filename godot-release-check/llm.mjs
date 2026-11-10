// Builds the request of each LLM provider and reads its JSON answer. The schemas are written as
// strict JSON Schema: every property required and no additional properties.

function geminiSchema(schema) {
  if (Array.isArray(schema)) {
    return schema.map(geminiSchema);
  }
  if (schema === null || typeof schema !== "object") {
    return schema;
  }
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties") {
      continue;
    }
    if (key === "type") {
      result[key] = String(value).toUpperCase();
    } else if (key === "properties") {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, geminiSchema(entry)]));
    } else {
      result[key] = geminiSchema(value);
    }
  }
  return result;
}

// OpenCode routes a request only with a session ID, which stays the same for all requests of one run.
function responsesRequest({ baseUrl, model, apiKey, prompt, name, schema, sessionId, reasoning }) {
  return {
    url: `${baseUrl}/responses`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "user-agent": "godot-release-check",
      "x-opencode-session": sessionId,
    },
    body: {
      model,
      input: prompt,
      text: { format: { type: "json_schema", name, schema, strict: true } },
      ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
    },
  };
}

function responsesText(result) {
  if (typeof result.output_text === "string") {
    return result.output_text;
  }
  const message = (result.output ?? []).find((item) => item.type === "message");
  const part = (message?.content ?? []).find((entry) => entry.type === "output_text");
  if (!part) {
    const refusal = (message?.content ?? []).find((entry) => entry.type === "refusal");
    throw new Error(refusal ? `the LLM refused the request: ${refusal.refusal}` : `the LLM response has no text, status ${result.status}`);
  }
  return part.text;
}

function geminiRequest({ baseUrl, model, apiKey, prompt, schema }) {
  return {
    url: `${baseUrl}/models/${model}:generateContent`,
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: geminiSchema(schema) },
    },
  };
}

function geminiText(result) {
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`the LLM response has no text, finish reason ${result.candidates?.[0]?.finishReason}`);
  }
  return text;
}

const PROVIDERS = {
  "opencode-go": { baseUrl: "https://opencode.ai/inference/go/openai/v1", request: responsesRequest, text: responsesText },
  "opencode-zen": { baseUrl: "https://opencode.ai/inference/openai/v1", request: responsesRequest, text: responsesText },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", request: geminiRequest, text: geminiText },
};

export function llmRequest({ provider, baseUrl, ...options }) {
  const entry = PROVIDERS[provider];
  if (!entry) {
    throw new Error(`unknown LLM provider \`${provider}\`, use one of ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return entry.request({ ...options, baseUrl: (baseUrl || entry.baseUrl).replace(/\/+$/, "") });
}

export function llmAnswer(provider, result) {
  return JSON.parse(PROVIDERS[provider].text(result));
}
