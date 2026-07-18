import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

/** Mirrors the Rust `GenParams` struct — keys are snake_case to match serde. */
export interface GenParams {
  temperature: number;
  top_p: number;
  top_k: number;
  max_tokens: number;
  thinking: boolean;
}

export interface AssistantReply {
  content: string;
  reasoning: string;
  stopped: boolean;
  tps: number | null;
  tokens: number;
}

export interface StatusInfo {
  ready: boolean;
  status: string;
  model: string;
  ctx: number;
  owns_server: boolean;
}

export const ipc = {
  getStatus: () => invoke<StatusInfo>('get_status'),
  /** requestId (camelCase) maps to the Rust `request_id` param automatically. */
  sendMessage: (messages: ChatMessage[], params: GenParams, requestId: string) =>
    invoke<AssistantReply>('send_message', { messages, params, requestId }),
  stopGeneration: () => invoke<void>('stop_generation'),
};

export type Unlisten = UnlistenFn;

export const events = {
  onReasoning: (cb: (id: string, t: string) => void) =>
    listen<{ id: string; t: string }>('bonsai://reasoning', (e) => cb(e.payload.id, e.payload.t)),
  onToken: (cb: (id: string, t: string) => void) =>
    listen<{ id: string; t: string }>('bonsai://token', (e) => cb(e.payload.id, e.payload.t)),
  onDone: (cb: (id: string, stopped: boolean, tps: number | null, tokens: number) => void) =>
    listen<{ id: string; stopped: boolean; tps: number | null; tokens: number }>(
      'bonsai://done',
      (e) => cb(e.payload.id, e.payload.stopped, e.payload.tps, e.payload.tokens),
    ),
  onError: (cb: (id: string, error: string) => void) =>
    listen<{ id: string; error: string }>('bonsai://error', (e) =>
      cb(e.payload.id, e.payload.error),
    ),
  onReady: (cb: (model: string, owns: boolean, ctx: number) => void) =>
    listen<{ model: string; owns: boolean; ctx: number }>('bonsai://ready', (e) =>
      cb(e.payload.model, e.payload.owns, e.payload.ctx),
    ),
  onStatus: (cb: (msg: string) => void) =>
    listen<string>('bonsai://status', (e) => cb(e.payload)),
  onInitError: (cb: (msg: string) => void) =>
    listen<string>('bonsai://init-error', (e) => cb(e.payload)),
};
