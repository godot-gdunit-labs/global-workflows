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
    result[key] = key === "type" ? String(value).toUpperCase() : key === "properties" ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, geminiSchema(entry)])) : geminiSchema(value);
  }
  return result;
}

const PROVIDERS = {
  opencode: {
    baseUrl: "https://opencode.ai/zen/v1",
    request: ({ baseUrl, model, apiKey, prompt, name, schema }) => ({
      url: `${baseUrl}/responses`,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: { model, input: prompt, text: { format: { type: "json_schema", name, schema, strict: true } } },
    }),
    text: (result) => {
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
    },
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    request: ({ baseUrl, model, apiKey, prompt, schema }) => ({
      url: `${baseUrl}/models/${model}:generateContent`,
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: geminiSchema(schema) },
      },
    }),
    text: (result) => {
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error(`the LLM response has no text, finish reason ${result.candidates?.[0]?.finishReason}`);
      }
      return text;
    },
  },
};

export function llmRequest({ provider, baseUrl, model, apiKey, prompt, name, schema }) {
  const entry = PROVIDERS[provider];
  if (!entry) {
    throw new Error(`unknown LLM provider \`${provider}\`, use one of ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return entry.request({ baseUrl: (baseUrl || entry.baseUrl).replace(/\/+$/, ""), model, apiKey, prompt, name, schema });
}

export function llmAnswer(provider, result) {
  return JSON.parse(PROVIDERS[provider].text(result));
}
