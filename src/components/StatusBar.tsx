import { useBonsai } from '../state/store';

function Leaf() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 21c0-5 0-8 3-11 2-2 5-2.5 6-2.5-.2 3-1 5.5-3 7.5-2.2 2.2-4.5 2.5-6 2.5Z"
        fill="#5aa85c"
      />
      <path
        d="M12 21c0-4-1-6.5-3.5-9C6.7 10.2 4 9.8 3 9.6c.2 2.6 1 4.7 2.8 6.4C7.7 17.7 10.2 18 12 18Z"
        fill="#468a49"
      />
      <path d="M12 22v-8" stroke="#7cc47a" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export default function StatusBar() {
  const ready = useBonsai((s) => s.ready);
  const statusMsg = useBonsai((s) => s.statusMsg);
  const model = useBonsai((s) => s.model);
  const ctx = useBonsai((s) => s.ctx);
  const ownsServer = useBonsai((s) => s.ownsServer);
  const initError = useBonsai((s) => s.initError);
  const streaming = useBonsai((s) => s.streaming);
  const newChat = useBonsai((s) => s.newChat);
  const toggleSettings = useBonsai((s) => s.toggleSettings);

  const dotColor = initError ? '#d9534f' : ready ? '#5aa85c' : '#d8b45a';
  const label = initError ? 'Error' : ready ? 'Ready' : 'Loading…';

  return (
    <header className="flex items-center gap-3 px-4 py-2.5 border-b border-bark-700 bg-bark-900/80 backdrop-blur">
      <Leaf />
      <div className="flex flex-col leading-tight">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-[15px] text-[#eaf1e4]">Bonsai</span>
          <span className="text-[11px] text-leaf-400/80 font-mono">27B · 1-bit</span>
        </div>
        <span className="text-[11px] text-[#8aa07f] font-mono truncate max-w-[420px]">
          {model || 'Bonsai-27B-Q1_0.gguf'}
          {ctx ? ` · ctx ${(ctx / 1024).toFixed(0)}k` : ''}
          {ready ? (ownsServer ? ' · local server' : ' · attached') : ''}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-[12px] text-[#a9bd9f]">
          <span
            className={`inline-block w-2 h-2 rounded-full ${!ready && !initError ? 'pulse' : ''}`}
            style={{ background: dotColor }}
          />
          <span className="max-w-[220px] truncate" title={statusMsg}>
            {label}
          </span>
        </div>

        <button
          onClick={() => newChat()}
          disabled={streaming}
          className="text-[12px] px-2.5 py-1 rounded-md border border-bark-700 text-[#c3d4b9] hover:bg-bark-800 disabled:opacity-40 disabled:cursor-not-allowed transition"
          title="New chat"
        >
          + New
        </button>
        <button
          onClick={() => toggleSettings()}
          className="text-[12px] px-2.5 py-1 rounded-md border border-bark-700 text-[#c3d4b9] hover:bg-bark-800 transition"
          title="Settings"
        >
          ⚙ Settings
        </button>
      </div>
    </header>
  );
}
