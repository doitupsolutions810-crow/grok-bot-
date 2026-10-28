import OpenAI from "openai";

export function makeLLM() {
  const provider = process.env.LLM_PROVIDER || "ollama";
  if (provider === "ollama") {
    return {
      baseURL: `${process.env.OLLAMA_URL || "http://ollama:11434"}/v1`,
      model: process.env.LLM_MODEL || "llama3.1:8b",
      apiKey: "ollama"
    };
  }
  return {
    baseURL: process.env.OPENAI_COMPAT_URL,
    model: process.env.LLM_MODEL,
    apiKey: process.env.LLM_API_KEY || "none"
  };
}

export class LLM {
  constructor() {
    const cfg = makeLLM();
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
    this.model = cfg.model;
  }

  async chat(messages, { tools = [], temperature = 0.4 } = {}) {
    const params = {
      model: this.model,
      messages,
      temperature,
      stream: false
    };
    if (tools.length) params.tools = tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
    const res = await this.client.chat.completions.create(params);
    return res.choices[0].message;
  }
}
