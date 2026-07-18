import { useBonsai } from './state/store';
import StatusBar from './components/StatusBar';
import Conversation from './components/Conversation';
import Composer from './components/Composer';
import SettingsDrawer from './components/SettingsDrawer';
import TreeView from './components/TreeView';

function InitErrorBanner() {
  const err = useBonsai((s) => s.initError);
  if (!err) return null;
  return (
    <div className="px-4 py-2 bg-red-950/60 border-b border-red-800/50 text-[12.5px] text-red-200">
      <span className="font-semibold">Model failed to start: </span>
      {err}
      <div className="text-[11px] text-red-300/70 mt-0.5">
        Check that <code className="font-mono">C:\llama.cpp-bonsai\llama-server.exe</code> and{' '}
        <code className="font-mono">C:\models\Bonsai-27B-Q1_0.gguf</code> exist.
      </div>
    </div>
  );
}

export default function App() {
  return (
    <div className="h-full flex flex-col bg-transparent">
      <StatusBar />
      <InitErrorBanner />
      <Conversation />
      <Composer />
      <SettingsDrawer />
      <TreeView />
    </div>
  );
}
