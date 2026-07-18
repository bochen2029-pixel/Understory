import { useEffect, useRef } from 'react';
import { useBonsai } from '../state/store';
import Message from './Message';

function Welcome() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 select-none">
      <div className="text-5xl mb-4">🌱</div>
      <h1 className="text-xl font-semibold text-[#e7f0e0]">Bonsai 27B — 1-bit, local</h1>
      <p className="mt-2 text-[13px] text-[#8fa584] max-w-md leading-relaxed">
        A full 27B reasoning model in ~3.8 GB, running entirely on your GPU via the PrismML
        llama.cpp build. Nothing leaves this machine. Ask anything to begin.
      </p>
      <div className="mt-5 flex flex-wrap gap-2 justify-center max-w-md">
        {[
          'Explain how 1-bit quantization works.',
          'Write a Python function to debounce calls.',
          'Plan a weekend in Kyoto.',
        ].map((s) => (
          <Suggestion key={s} text={s} />
        ))}
      </div>
    </div>
  );
}

function Suggestion({ text }: { text: string }) {
  const send = useBonsai((s) => s.send);
  const ready = useBonsai((s) => s.ready);
  return (
    <button
      onClick={() => ready && send(text)}
      disabled={!ready}
      className="text-[12px] px-3 py-1.5 rounded-full border border-bark-700 text-[#b7cbad] hover:bg-bark-800 disabled:opacity-40 transition"
    >
      {text}
    </button>
  );
}

export default function Conversation() {
  const messages = useBonsai((s) => s.messages);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Track whether the user is pinned to the bottom; only autoscroll if so.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (stick.current) bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  });

  if (messages.length === 0) {
    return (
      <div className="flex-1 min-h-0">
        <Welcome />
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-5 flex flex-col gap-4">
        {messages.map((m) => (
          <Message key={m.id} msg={m} />
        ))}
        <div ref={bottomRef} className="h-1" />
      </div>
    </div>
  );
}
