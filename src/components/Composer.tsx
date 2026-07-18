import { useRef, useState, useEffect } from 'react';
import { useBonsai } from '../state/store';

export default function Composer() {
  const [text, setText] = useState('');
  const streaming = useBonsai((s) => s.streaming);
  const ready = useBonsai((s) => s.ready);
  const thinking = useBonsai((s) => s.settings.thinking);
  const send = useBonsai((s) => s.send);
  const stop = useBonsai((s) => s.stop);
  const setSetting = useBonsai((s) => s.setSetting);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to a cap.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || streaming || !ready) return;
    setText('');
    void send(t);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-bark-700 bg-bark-900/80 backdrop-blur px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-end gap-2 rounded-2xl border border-bark-700 bg-bark-850 px-3 py-2 focus-within:border-leaf-600/70 transition">
          <button
            onClick={() => setSetting('thinking', !thinking)}
            title={thinking ? 'Thinking mode ON (model reasons first)' : 'Thinking mode OFF (direct answers)'}
            className={`shrink-0 mb-0.5 text-[11px] px-2 py-1 rounded-md border transition ${
              thinking
                ? 'border-leaf-600/70 text-leaf-400 bg-leaf-600/10'
                : 'border-bark-700 text-[#8aa07f] hover:bg-bark-800'
            }`}
          >
            🧠 {thinking ? 'Think' : 'Fast'}
          </button>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={ready ? 'Message Bonsai…  (Enter to send · Shift+Enter for newline)' : 'Loading model…'}
            className="flex-1 bg-transparent resize-none outline-none text-[14px] text-[#e3ecdb] placeholder:text-[#6f8566] max-h-[200px] leading-relaxed py-1"
          />
          {streaming ? (
            <button
              onClick={() => stop()}
              className="shrink-0 mb-0.5 px-3 py-1.5 rounded-lg bg-red-700/80 hover:bg-red-600 text-white text-[13px] font-medium transition"
            >
              ■ Stop
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!text.trim() || !ready}
              className="shrink-0 mb-0.5 px-3.5 py-1.5 rounded-lg bg-leaf-600 hover:bg-leaf-500 text-[#0b0f09] text-[13px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              Send ↩
            </button>
          )}
        </div>
        <div className="mt-1.5 text-center text-[10.5px] text-[#5f7457]">
          Runs 100% locally · Bonsai-27B-Q1_0 on your GPU · responses may be imperfect
        </div>
      </div>
    </div>
  );
}
