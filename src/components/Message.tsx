import { useCallback } from 'react';
import type { Msg } from '../state/store';
import { renderMarkdown } from '../lib/markdown';
import Reasoning from './Reasoning';

function Stats({ msg }: { msg: Msg }) {
  const bits: string[] = [];
  if (msg.tokens) bits.push(`${msg.tokens} tok`);
  if (msg.tps) bits.push(`${msg.tps.toFixed(1)} tok/s`);
  if (msg.stopped) bits.push('stopped');
  if (!bits.length) return null;
  return <div className="mt-1.5 text-[10.5px] text-[#6f8566] font-mono">{bits.join(' · ')}</div>;
}

export default function Message({ msg }: { msg: Msg }) {
  const isUser = msg.role === 'user';

  // Delegated copy-button handler for rendered code blocks.
  const onClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('copy-btn')) {
      const pre = target.closest('.code-wrap')?.querySelector('pre code');
      const text = pre?.textContent ?? '';
      navigator.clipboard.writeText(text).then(() => {
        const btn = target as HTMLButtonElement;
        const old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.textContent = old;
        }, 1200);
      });
    }
  }, []);

  if (isUser) {
    return (
      <div className="fade-in flex justify-end">
        <div className="selectable max-w-[80%] rounded-2xl rounded-br-md bg-leaf-600/90 text-[#0c1109] px-3.5 py-2 text-[14px] whitespace-pre-wrap break-words shadow">
          {msg.content}
        </div>
      </div>
    );
  }

  const showTyping = msg.streaming && !msg.content && !(msg.reasoning && msg.reasoning.length);

  return (
    <div className="fade-in flex justify-start">
      <div className="max-w-[86%] w-full">
        <Reasoning msg={msg} />
        {msg.error ? (
          <div className="selectable rounded-2xl rounded-bl-md border border-red-800/60 bg-red-950/40 text-red-200 px-3.5 py-2 text-[13px]">
            ⚠ {msg.error}
          </div>
        ) : (
          <div
            className="selectable rounded-2xl rounded-bl-md bg-bark-850 border border-bark-700 px-3.5 py-2 text-[14px] text-[#dce7d3]"
            onClick={onClick}
          >
            {showTyping ? (
              <span className="dot-flashing">
                <span />
                <span />
                <span />
              </span>
            ) : (
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content || '') }} />
            )}
            {msg.streaming && msg.content ? (
              <span className="inline-block w-1.5 h-4 -mb-0.5 ml-0.5 bg-leaf-400 animate-pulse" />
            ) : null}
          </div>
        )}
        <Stats msg={msg} />
      </div>
    </div>
  );
}
