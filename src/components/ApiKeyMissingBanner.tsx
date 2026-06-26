/**
 * Inline banner shown above the local chat when no OpenRouter key is
 * configured. Clicking the action opens the settings drawer where the user
 * can paste a key (UI for that lives in `SettingsDrawer.tsx`).
 */
import { KeyRound } from 'lucide-react';
import { useAppStore } from '../lib/store';

export function ApiKeyMissingBanner() {
  const toggleSettings = useAppStore((s) => s.toggleSettings);

  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-900">
      <div className="flex items-center gap-2">
        <KeyRound className="h-3.5 w-3.5 shrink-0 text-amber-700" />
        <span>
          No API key configured. Open{' '}
          <button
            type="button"
            onClick={toggleSettings}
            className="font-semibold underline-offset-2 hover:underline"
          >
            settings → API keys
          </button>{' '}
          to add one.
        </span>
      </div>
    </div>
  );
}
