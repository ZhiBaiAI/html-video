import type { AgentDef } from '../types.js';

export interface OpenAiCompatibleAgentConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function openAiChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

/** Build a Studio HTTP agent for DashScope, DeepSeek, or another compatible API. */
export function createOpenAiCompatibleAgent(config: OpenAiCompatibleAgentConfig): AgentDef {
  const endpoint = openAiChatCompletionsUrl(config.baseUrl);
  return {
    id: config.id,
    name: config.name,
    bin: 'openai-compatible-api',
    versionArgs: [],
    buildArgs: () => [],
    streamFormat: 'plain',
    kind: 'http',
    defaultModel: config.model,
    modelSelection: { mode: 'custom', placeholder: config.model },
    async httpProbe() {
      const configured = !!(config.apiKey.trim() && config.baseUrl.trim() && config.model.trim());
      return configured
        ? { available: true, version: `${config.model} via ${new URL(config.baseUrl).host}` }
        : { available: false, hint: 'API key, Base URL, and model are required.' };
    },
    async httpHandler(prompt, ctx, onEvent, signal) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          signal,
          body: JSON.stringify({
            model: ctx.model || config.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 16000,
            stream: true,
          }),
        });
      } catch (error) {
        onEvent({ type: 'error', message: `fetch failed: ${error instanceof Error ? error.message : String(error)}` });
        return { exitCode: -1 };
      }
      if (!response.ok || !response.body) {
        const body = await response.text().catch(() => '');
        onEvent({
          type: 'error',
          message: `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 400)}` : ''}`,
        });
        return { exitCode: -1 };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let emitted = false;
      const consumePayload = (raw: string): void => {
        const data = raw.startsWith('data:') ? raw.slice(5).trim() : raw.trim();
        if (!data || data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
            error?: { message?: string };
          };
          const text = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
          if (text) {
            emitted = true;
            onEvent({ type: 'text', chunk: text });
          } else if (parsed.error?.message) {
            onEvent({ type: 'error', message: parsed.error.message });
          }
        } catch {
          /* ignore keepalive and malformed lines */
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('data:')) consumePayload(line);
          }
        }
        if (buffer.trim()) consumePayload(buffer);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes('abort')) {
          onEvent({ type: 'error', message: `stream read failed: ${message}` });
        }
        return { exitCode: -1 };
      }
      if (!emitted) {
        onEvent({ type: 'error', message: 'API returned no text content.' });
        return { exitCode: -1 };
      }
      return { exitCode: 0 };
    },
  };
}
