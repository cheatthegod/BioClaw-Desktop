/**
 * Native-style title bar. Tauri 2 gives us a borderless window via
 * `decorations: false` in tauri.conf.json; we then own the drag region
 * and the minimize / maximize / close affordances. The `data-tauri-drag-region`
 * attribute is recognized by Tauri 2 and turns that element into the OS-level
 * drag handle.
 */
import { Window } from '@tauri-apps/api/window';
import { Minus, Square, X, Settings } from 'lucide-react';
import { useAppStore } from '../lib/store';
import { cn } from '../lib/utils';

export function TitleBar() {
  const toggleSettings = useAppStore((s) => s.toggleSettings);

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center justify-between border-b border-line/40 bg-bg/95 px-2 backdrop-blur"
    >
      <div className="flex items-center gap-2 pl-2" data-tauri-drag-region>
        <span
          className="text-[12px] font-semibold tracking-tight text-ink-soft"
          data-tauri-drag-region
        >
          BioClaw
        </span>
      </div>

      <div className="flex items-center gap-1">
        <TitleBarButton onClick={toggleSettings} title="Settings">
          <Settings className="h-3.5 w-3.5" />
        </TitleBarButton>
        <TitleBarButton onClick={() => Window.getCurrent().minimize()} title="Minimize">
          <Minus className="h-3.5 w-3.5" />
        </TitleBarButton>
        <TitleBarButton onClick={() => Window.getCurrent().toggleMaximize()} title="Maximize">
          <Square className="h-3 w-3" />
        </TitleBarButton>
        <TitleBarButton onClick={() => Window.getCurrent().close()} title="Close" danger>
          <X className="h-3.5 w-3.5" />
        </TitleBarButton>
      </div>
    </div>
  );
}

function TitleBarButton({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-6 w-7 items-center justify-center rounded text-muted transition',
        danger ? 'hover:bg-danger hover:text-white' : 'hover:bg-accent-soft hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
