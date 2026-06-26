/**
 * Tiny header dropdown that picks the model the local sidecar should use.
 *
 * Phase-2 contents are hard-coded — a richer picker (per-provider grouping,
 * pricing/context-window hints, "favourites") lands once we wire OpenRouter's
 * /models endpoint. Persistence goes through `persistPrefs` so the choice
 * survives reloads, same as `mode` / `remoteUrl`.
 */
import { ChevronDown } from 'lucide-react';
import { useAppStore } from '../lib/store';
import { persistPrefs } from '../lib/init';

interface ModelOption {
  readonly id: string;
  readonly label: string;
  /** Human-friendly provider tag shown after the model name. */
  readonly vendor: string;
}

export const MODEL_OPTIONS: ReadonlyArray<ModelOption> = [
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', vendor: 'OpenAI' },
  { id: 'openai/gpt-4o', label: 'GPT-4o', vendor: 'OpenAI' },
  { id: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6', vendor: 'Anthropic' },
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', vendor: 'Anthropic' },
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', vendor: 'DeepSeek' },
];

export function ModelPicker() {
  const selectedModel = useAppStore((s) => s.selectedModel);
  const setSelectedModel = useAppStore((s) => s.setSelectedModel);

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    setSelectedModel(id);
    void persistPrefs({ selectedModel: id });
  };

  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">Model</span>
      <select
        value={selectedModel}
        onChange={onChange}
        className="appearance-none rounded-md border border-zinc-200 bg-white py-1 pl-2.5 pr-7 text-[12px] font-medium text-zinc-700 hover:border-zinc-300 focus:border-zinc-500 focus:outline-none"
      >
        {MODEL_OPTIONS.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label} · {opt.vendor}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 text-zinc-400" />
    </label>
  );
}
