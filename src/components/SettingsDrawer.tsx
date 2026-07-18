import { useBonsai, type Settings } from '../state/store';

function Slider({
  label,
  k,
  min,
  max,
  step,
  fmt,
}: {
  label: string;
  k: keyof Settings;
  min: number;
  max: number;
  step: number;
  fmt?: (n: number) => string;
}) {
  const value = useBonsai((s) => s.settings[k]) as number;
  const setSetting = useBonsai((s) => s.setSetting);
  return (
    <div className="mb-4">
      <div className="flex justify-between text-[12px] mb-1">
        <span className="text-[#b9cbaf]">{label}</span>
        <span className="font-mono text-leaf-400">{fmt ? fmt(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => setSetting(k, Number(e.target.value) as never)}
        className="w-full accent-leaf-500"
      />
    </div>
  );
}

export default function SettingsDrawer() {
  const open = useBonsai((s) => s.settingsOpen);
  const toggle = useBonsai((s) => s.toggleSettings);
  const thinking = useBonsai((s) => s.settings.thinking);
  const systemPrompt = useBonsai((s) => s.settings.systemPrompt);
  const setSetting = useBonsai((s) => s.setSetting);
  const reset = useBonsai((s) => s.resetSettings);

  return (
    <>
      <div
        onClick={() => toggle(false)}
        className={`fixed inset-0 bg-black/50 transition-opacity z-10 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />
      <aside
        className={`fixed top-0 right-0 h-full w-[340px] max-w-[86vw] bg-bark-900 border-l border-bark-700 z-20 shadow-2xl transition-transform duration-200 flex flex-col ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-bark-700">
          <span className="font-semibold text-[15px] text-[#e7f0e0]">Settings</span>
          <button
            onClick={() => toggle(false)}
            className="text-[#9bb28f] hover:text-white text-lg leading-none px-1"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <div className="text-[13px] text-[#dce7d3] font-medium">Thinking mode</div>
              <div className="text-[11px] text-[#7f9575]">Reason before answering (slower, smarter)</div>
            </div>
            <button
              onClick={() => setSetting('thinking', !thinking)}
              className={`relative w-11 h-6 rounded-full transition ${
                thinking ? 'bg-leaf-600' : 'bg-bark-700'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  thinking ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>

          <div className="text-[11px] uppercase tracking-wide text-[#6f8566] mb-2">Sampling</div>
          <Slider label="Temperature" k="temperature" min={0} max={2} step={0.05} fmt={(n) => n.toFixed(2)} />
          <Slider label="Top-p" k="top_p" min={0} max={1} step={0.01} fmt={(n) => n.toFixed(2)} />
          <Slider label="Top-k" k="top_k" min={0} max={100} step={1} />
          <Slider
            label="Max tokens"
            k="max_tokens"
            min={256}
            max={16384}
            step={256}
            fmt={(n) => String(n)}
          />

          <div className="text-[11px] uppercase tracking-wide text-[#6f8566] mb-2 mt-4">
            System prompt
          </div>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSetting('systemPrompt', e.target.value)}
            rows={4}
            className="w-full rounded-lg bg-bark-850 border border-bark-700 px-3 py-2 text-[13px] text-[#dce7d3] outline-none focus:border-leaf-600/70 resize-y"
            placeholder="You are a helpful assistant"
          />

          <button
            onClick={() => reset()}
            className="mt-5 w-full text-[12px] py-2 rounded-lg border border-bark-700 text-[#b7cbad] hover:bg-bark-800 transition"
          >
            Reset to defaults
          </button>

          <div className="mt-4 text-[11px] text-[#6f8566] leading-relaxed">
            Model card defaults: temp 0.7 · top-p 0.95 · top-k 20. Changes apply to your next
            message.
          </div>
        </div>
      </aside>
    </>
  );
}
