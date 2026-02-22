import * as vscode from "vscode";
import type { StreamTransport } from "./transport/interface";

interface VsCodeChatResponse {
  text: AsyncIterable<unknown>;
}

interface VsCodeChatModel {
  id?: string;
  name?: string;
  vendor?: string;
  family?: string;
  version?: string;
  sendRequest(
    messages: unknown[],
    options?: unknown,
    token?: vscode.CancellationToken
  ): Promise<VsCodeChatResponse>;
}

interface VsCodeLmApi {
  selectChatModels(selector?: Record<string, unknown>): Promise<VsCodeChatModel[]>;
}

export interface ChatModelSummary {
  id: string;
  name: string;
  vendor?: string;
  family?: string;
  version?: string;
}

interface StreamPromptArgs {
  prompt: string;
  modelId?: string;
  transport: StreamTransport;
  token?: vscode.CancellationToken;
}

function getLmApi(): VsCodeLmApi {
  const maybeApi = (vscode as unknown as { lm?: VsCodeLmApi }).lm;
  if (!maybeApi) {
    throw new Error("VS Code Language Model API is unavailable in this environment.");
  }

  return maybeApi;
}

function toModelId(model: VsCodeChatModel, fallback: string): string {
  if (typeof model.id === "string" && model.id.length > 0) {
    return model.id;
  }

  const parts = [model.vendor, model.family, model.version, model.name].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );

  if (parts.length > 0) {
    return parts.join(":");
  }

  return fallback;
}

function toModelSummary(model: VsCodeChatModel, index: number): ChatModelSummary {
  const fallbackName = model.name ?? `Model ${index + 1}`;
  return {
    id: toModelId(model, `model-${index + 1}`),
    name: fallbackName,
    vendor: model.vendor,
    family: model.family,
    version: model.version,
  };
}

async function listRawModels(): Promise<VsCodeChatModel[]> {
  const lmApi = getLmApi();
  return lmApi.selectChatModels();
}

function createUserMessage(prompt: string): unknown {
  const messageFactory = (
    vscode as unknown as {
      LanguageModelChatMessage?: { User?: (content: string) => unknown };
    }
  ).LanguageModelChatMessage;

  if (messageFactory?.User) {
    return messageFactory.User(prompt);
  }

  return {
    role: "user",
    content: prompt,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function resolveModel(modelId?: string): Promise<VsCodeChatModel> {
  const models = await listRawModels();
  if (models.length === 0) {
    throw new Error(
      "No language models are available. Install/sign in to an LLM extension that supports vscode.lm."
    );
  }

  if (!modelId) {
    return models[0];
  }

  const found = models.find((model, index) => {
    const normalized = toModelSummary(model, index);
    return normalized.id === modelId;
  });

  if (!found) {
    throw new Error(`Model not found: ${modelId}`);
  }

  return found;
}

export async function listModels(): Promise<ChatModelSummary[]> {
  const models = await listRawModels();
  return models.map((model, index) => toModelSummary(model, index));
}

export async function streamPromptToTransport(args: StreamPromptArgs): Promise<void> {
  const { prompt, modelId, transport, token } = args;

  try {
    const model = await resolveModel(modelId);
    const response = await model.sendRequest([createUserMessage(prompt)], {}, token);

    for await (const chunk of response.text) {
      if (token?.isCancellationRequested) {
        transport.send(JSON.stringify({ delta: "", done: true }));
        return;
      }

      transport.send(
        JSON.stringify({
          delta: String(chunk ?? ""),
          done: false,
        })
      );
    }

    transport.send(JSON.stringify({ delta: "", done: true }));
  } catch (error) {
    if (token?.isCancellationRequested) {
      transport.send(JSON.stringify({ delta: "", done: true }));
      return;
    }

    transport.send(
      JSON.stringify({
        error: toErrorMessage(error),
        done: true,
      })
    );
  }
}
