import { useEffect, useMemo, useRef, useState } from 'react';
import { useBonsai } from '../state/store';
import { BonsaiScene, rampCss, type HoverInfo, type TreeToken } from '../lib/bonsaiScene';

export default function TreeView() {
  const open = useBonsai((s) => s.treeOpen);
  const toggle = useBonsai((s) => s.toggleTree);
  const messages = useBonsai((s) => s.messages);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<BonsaiScene | null>(null);
  const builtRef = useRef(0);
  const [tip, setTip] = useState<HoverInfo | null>(null);

  // The most recent assistant message that has per-token stats.
  const last = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'assistant' && (m.answerStats?.length ?? 0) > 0),
    [messages],
  );
  const tokens = (last?.answerStats ?? []) as TreeToken[];
  const streaming = !!last?.streaming;

  // Mount / unmount the WebGL scene with the overlay (render loop only runs while open).
  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new BonsaiScene(canvas, setTip);
    sceneRef.current = scene;
    const doResize = () => scene.resize(window.innerWidth, window.innerHeight);
    doResize();
    builtRef.current = tokens.length;
    scene.setTokens(tokens);
    scene.start();
    window.addEventListener('resize', doResize);
    return () => {
      window.removeEventListener('resize', doResize);
      scene.dispose();
      sceneRef.current = null;
      setTip(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Live growth: rebuild every few tokens while streaming, and once on completion.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    const n = tokens.length;
    if (!streaming || n < builtRef.current || n - builtRef.current >= 4) {
      builtRef.current = n;
      s.setTokens(tokens);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens.length, last?.id, streaming]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && toggle(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, toggle]);

  if (!open) return null;

  const peak = tokens.reduce((a, t) => Math.max(a, t.surprisal), 0);
  const mean = tokens.length ? tokens.reduce((a, t) => a + t.surprisal, 0) / tokens.length : 0;

  return (
    <div className="fixed inset-0 z-30" style={{ background: '#0a0d0b' }}>
      <canvas ref={canvasRef} className="w-full h-full block" />

      {/* header */}
      <div className="absolute top-4 left-5 max-w-[440px] select-none pointer-events-none">
        <div className="text-[15px] font-bold tracking-[0.16em] text-[#eaf1e4]">
          UNDERSTORY · <span className="text-leaf-400">surprisal bonsai</span>
        </div>
        <div className="mt-1 text-[11.5px] text-[#8aa07f] leading-relaxed">
          Grown from this answer's per-token uncertainty. The trunk smolders red and sprouts ember
          branches where the model was least certain — most likely confabulating.
        </div>
        <div className="mt-3 flex items-center gap-2 text-[11px] text-[#8aa07f]">
          <span>confident</span>
          <div
            className="w-[150px] h-[9px] rounded-full"
            style={{ background: 'linear-gradient(90deg,#4fa85c,#d8b357,#d94e46)' }}
          />
          <span>uncertain</span>
        </div>
        {tokens.length > 0 && (
          <div className="mt-2 text-[12px] font-mono text-[#a9bd9f]">
            peak surprisal {peak.toFixed(2)} nats · mean {mean.toFixed(2)}
            {streaming ? ' · growing…' : ''}
          </div>
        )}
      </div>

      {/* close */}
      <button
        onClick={() => toggle(false)}
        className="absolute top-4 right-5 z-40 text-[13px] px-3 py-1.5 rounded-md border border-bark-700 text-[#c3d4b9] hover:bg-bark-800 transition"
      >
        ✕ Close
      </button>

      {/* empty state */}
      {tokens.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center text-[#8aa07f]">
            <div className="text-4xl mb-3">🌱</div>
            <div className="text-[13px]">Ask Bonsai something, then reopen the tree —<br />it grows from the model's uncertainty as it answers.</div>
          </div>
        </div>
      )}

      {/* caption: the answer, colored by surprisal */}
      {tokens.length > 0 && (
        <div
          className="absolute bottom-6 left-1/2 -translate-x-1/2 max-w-[78vw] text-center text-[15px] leading-[1.9] px-4 py-2.5 rounded-xl border border-bark-800 pointer-events-none"
          style={{ background: 'rgba(8,11,9,0.55)', backdropFilter: 'blur(4px)' }}
        >
          {tokens.map((t, i) => (
            <span
              key={i}
              style={{
                color: t.surprisal > 0.8 ? rampCss(t.surprisal) : '#cdd9c3',
                fontWeight: t.surprisal > 1.5 ? 700 : 400,
                textShadow: t.surprisal > 1.5 ? `0 0 10px ${rampCss(t.surprisal)}` : undefined,
              }}
            >
              {t.token}
            </span>
          ))}
        </div>
      )}

      {/* hover tooltip */}
      {tip && (
        <div
          className="fixed z-50 pointer-events-none rounded-lg px-2.5 py-1.5 text-[12px] font-mono"
          style={{
            left: tip.x + 14,
            top: tip.y + 14,
            background: '#0d120b',
            border: '1px solid #38492c',
            boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
          }}
        >
          <span className="text-[#eaf1e4] font-semibold">{JSON.stringify(tip.token)}</span> ·{' '}
          surprisal {tip.surprisal.toFixed(2)}
          <div
            className="h-[5px] rounded mt-1.5"
            style={{ width: Math.min((tip.surprisal / 4) * 100, 100) + '%', background: rampCss(tip.surprisal) }}
          />
        </div>
      )}
    </div>
  );
}
