import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ipc, events, type ChatMessage, type GenParams } from '../lib/ipc';

export interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  streaming?: boolean;
  stopped?: boolean;
  error?: string;
  tps?: number | null;
  tokens?: number;
  thinkingOpen?: boolean;
}

export interface Settings {
  temperature: number;
  top_p: number;
  top_k: number;
  max_tokens: number;
  thinking: boolean;
  systemPrompt: string;
}

const DEFAULT_SETTINGS: Settings = {
  temperature: 0.7,
  top_p: 0.95,
  top_k: 20,
  max_tokens: 4096,
  thinking: true,
  systemPrompt: 'You are a helpful assistant',
};

interface BonsaiState {
  ready: boolean;
  statusMsg: string;
  model: string;
  ctx: number;
  ownsServer: boolean;
  initError: string | null;

  messages: Msg[];
  streaming: boolean;
  currentReqId: string | null;

  settings: Settings;
  settingsOpen: boolean;

  init: () => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => Promise<void>;
  newChat: () => void;
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  resetSettings: () => void;
  toggleSettings: (open?: boolean) => void;
  toggleThinking: (id: string) => void;

  _patch: (id: string, patch: Partial<Msg>) => void;
  _append: (id: string, field: 'content' | 'reasoning', text: string) => void;
}

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

let listenersBound = false;

export const useBonsai = create<BonsaiState>()(
  persist(
    (set, get) => ({
      ready: false,
      statusMsg: 'Starting…',
      model: '',
      ctx: 0,
      ownsServer: false,
      initError: null,

      messages: [],
      streaming: false,
      currentReqId: null,

      settings: DEFAULT_SETTINGS,
      settingsOpen: false,

      _patch: (id, patch) =>
        set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),

      _append: (id, field, text) =>
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === id ? { ...m, [field]: (m[field] ?? '') + text } : m,
          ),
        })),

      init: async () => {
        if (!listenersBound) {
          listenersBound = true;
          const { _patch, _append } = get();
          events.onReasoning((id, t) => {
            const m = get().messages.find((x) => x.id === id);
            if (m && !m.thinkingOpen) _patch(id, { thinkingOpen: true });
            _append(id, 'reasoning', t);
          });
          events.onToken((id, t) => _append(id, 'content', t));
          events.onDone((id, stopped, tps, tokens) =>
            _patch(id, { streaming: false, stopped, tps, tokens, thinkingOpen: false }),
          );
          events.onError((id, error) => _patch(id, { streaming: false, error }));
          events.onReady((model, owns, ctx) =>
            set({ ready: true, ownsServer: owns, ctx, model, statusMsg: 'Ready', initError: null }),
          );
          events.onStatus((msg) => set({ statusMsg: msg }));
          events.onInitError((msg) => set({ initError: msg, statusMsg: msg }));
        }

        // Any assistant message left mid-stream by a previous session is stale.
        set((s) => ({
          streaming: false,
          currentReqId: null,
          messages: s.messages.map((m) =>
            m.streaming ? { ...m, streaming: false, thinkingOpen: false } : m,
          ),
        }));

        try {
          const st = await ipc.getStatus();
          set({
            ready: st.ready,
            statusMsg: st.status,
            model: st.model,
            ctx: st.ctx,
            ownsServer: st.owns_server,
          });
        } catch {
          /* backend not up yet; events will fill in */
        }
      },

      send: async (text) => {
        const t = text.trim();
        const s = get();
        if (!t || s.streaming) return;
        if (!s.ready) {
          set({ statusMsg: 'Model still loading — hang on…' });
          return;
        }

        const userMsg: Msg = { id: uid(), role: 'user', content: t };
        const reqId = uid();
        const assistant: Msg = {
          id: reqId,
          role: 'assistant',
          content: '',
          reasoning: '',
          streaming: true,
          thinkingOpen: s.settings.thinking,
        };

        set((prev) => ({
          messages: [...prev.messages, userMsg, assistant],
          streaming: true,
          currentReqId: reqId,
        }));

        // Build the API message list: system prompt + prior turns + new user.
        // Assistant turns are sent as their *answer* only (no reasoning).
        const history = get().messages.filter((m) => m.id !== reqId);
        const api: ChatMessage[] = [];
        if (s.settings.systemPrompt.trim()) {
          api.push({ role: 'system', content: s.settings.systemPrompt.trim() });
        }
        for (const m of history) {
          if (m.error) continue;
          if (!m.content && m.role === 'assistant') continue;
          api.push({ role: m.role, content: m.content });
        }

        const params: GenParams = {
          temperature: s.settings.temperature,
          top_p: s.settings.top_p,
          top_k: s.settings.top_k,
          max_tokens: s.settings.max_tokens,
          thinking: s.settings.thinking,
        };

        try {
          const reply = await ipc.sendMessage(api, params, reqId);
          get()._patch(reqId, {
            content: reply.content || get().messages.find((m) => m.id === reqId)?.content || '',
            reasoning: reply.reasoning,
            streaming: false,
            stopped: reply.stopped,
            tps: reply.tps,
            tokens: reply.tokens,
            thinkingOpen: false,
          });
        } catch (e) {
          get()._patch(reqId, { streaming: false, error: String(e) });
        } finally {
          set({ streaming: false, currentReqId: null });
        }
      },

      stop: async () => {
        try {
          await ipc.stopGeneration();
        } catch {
          /* ignore */
        }
        const id = get().currentReqId;
        if (id) get()._patch(id, { streaming: false, stopped: true, thinkingOpen: false });
        set({ streaming: false, currentReqId: null });
      },

      newChat: () => {
        if (get().streaming) return;
        set({ messages: [], currentReqId: null });
      },

      setSetting: (k, v) => set((s) => ({ settings: { ...s.settings, [k]: v } })),
      resetSettings: () => set({ settings: DEFAULT_SETTINGS }),
      toggleSettings: (open) =>
        set((s) => ({ settingsOpen: open === undefined ? !s.settingsOpen : open })),
      toggleThinking: (id) =>
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === id ? { ...m, thinkingOpen: !m.thinkingOpen } : m,
          ),
        })),
    }),
    {
      name: 'bonsai-store',
      version: 1,
      partialize: (s) => ({
        settings: s.settings,
        messages: s.messages
          .filter((m) => !m.error && (m.content || m.reasoning))
          .map((m) => ({ ...m, streaming: false, thinkingOpen: false })),
      }),
    },
  ),
);
