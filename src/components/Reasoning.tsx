import type { Msg } from '../state/store';
import { useBonsai } from '../state/store';

export default function Reasoning({ msg }: { msg: Msg }) {
  const toggle = useBonsai((s) => s.toggleThinking);
  const has = !!(msg.reasoning && msg.reasoning.length);
  if (!has) return null;

  const open = !!msg.thinkingOpen;
  const active = msg.streaming && (!msg.content || msg.content.length === 0);

  return (
    <div className="mb-2 rounded-lg border border-bark-700 bg-bark-900/60 overflow-hidden">
      <button
        onClick={() => toggle(msg.id)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#9bb28f] hover:bg-bark-800/60 transition"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <span className="font-medium">{active ? 'Thinking…' : 'Reasoning'}</span>
        {active && (
          <span className="dot-flashing ml-1">
            <span />
            <span />
            <span />
          </span>
        )}
        <span className="ml-auto text-[10px] text-[#6f8566]">
          {msg.reasoning!.length} chars
        </span>
      </button>
      {open && (
        <div className="selectable px-3 pb-2.5 pt-1 text-[12.5px] leading-relaxed text-[#8ea583] whitespace-pre-wrap border-t border-bark-800 max-h-[320px] overflow-y-auto font-mono">
          {msg.reasoning}
        </div>
      )}
    </div>
  );
}
