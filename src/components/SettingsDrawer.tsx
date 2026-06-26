/**
 * Right-hand drawer for app settings. Phase-1 controls: mode toggle (cloud
 * vs local), URLs. Phase 2 will add: API key store, sidecar diagnostics,
 * MCP server list. We deliberately keep this minimal — chat-side settings
 * live in the BioClaw web app and are configured from there.
 */
import { useState } from 'react';
import { useAppStore } from '../lib/store';
import { persistPrefs } from '../lib/init';
import { cn } from '../lib/utils';
import { ApiKeysPanel } from './ApiKeysPanel';

export function SettingsDrawer() {
  const mode = useAppStore((s) => s.mode);
  const remoteUrl = useAppStore((s) => s.remoteUrl);
  const localUrl = useAppStore((s) => s.localUrl);
  const setMode = useAppStore((s) => s.setMode);
  const setRemoteUrl = useAppStore((s) => s.setRemoteUrl);
  const setLocalUrl = useAppStore((s) => s.setLocalUrl);
  const toggleSettings = useAppStore((s) => s.toggleSettings);

  const [remoteDraft, setRemoteDraft] = useState(remoteUrl);
  const [localDraft, setLocalDraft] = useState(localUrl);

  async function save() {
    setRemoteUrl(remoteDraft);
    setLocalUrl(localDraft);
    await persistPrefs({ mode, remoteUrl: remoteDraft, localUrl: localDraft });
  }

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-80 flex-col border-l border-zinc-200 bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <h2 className="text-[13px] font-semibold text-zinc-800">设置</h2>
        <button
          type="button"
          onClick={toggleSettings}
          className="text-[12px] text-zinc-500 hover:text-zinc-800"
        >
          关闭
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <Section title="运行模式">
          <ModeOption
            active={mode === 'remote'}
            label="云端模式"
            desc="连接 chat.bioclaw.tech，无本地依赖。"
            onClick={() => setMode('remote')}
          />
          <ModeOption
            active={mode === 'local'}
            label="本地模式"
            desc="agent-runner 跑在本机；适合敏感数据 / 离线。"
            onClick={() => setMode('local')}
          />
        </Section>

        <Section title="API 密钥">
          <ApiKeysPanel />
        </Section>

        <Section title="远程地址">
          <input
            value={remoteDraft}
            onChange={(e) => setRemoteDraft(e.target.value)}
            className="w-full rounded border border-zinc-300 bg-white px-2.5 py-1.5 text-[12px] focus:border-zinc-500 focus:outline-none"
            placeholder="https://chat.bioclaw.tech"
          />
        </Section>

        <Section title="本地地址">
          <input
            value={localDraft}
            onChange={(e) => setLocalDraft(e.target.value)}
            className="w-full rounded border border-zinc-300 bg-white px-2.5 py-1.5 text-[12px] focus:border-zinc-500 focus:outline-none"
            placeholder="http://127.0.0.1:3000"
          />
        </Section>
      </div>

      <div className="border-t border-zinc-200 px-4 py-3">
        <button
          type="button"
          onClick={() => void save()}
          className="w-full rounded bg-zinc-900 px-3 py-2 text-[12px] font-semibold text-white hover:bg-zinc-800"
        >
          保存
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{title}</div>
      {children}
    </section>
  );
}

function ModeOption({
  active,
  label,
  desc,
  onClick,
  disabled,
}: {
  active: boolean;
  label: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        'w-full rounded border px-3 py-2 text-left transition',
        active
          ? 'border-zinc-900 bg-zinc-900 text-white'
          : 'border-zinc-200 bg-white text-zinc-800 hover:border-zinc-400',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <div className="text-[12px] font-semibold">{label}</div>
      <div className={cn('mt-0.5 text-[11px]', active ? 'text-zinc-300' : 'text-zinc-500')}>{desc}</div>
    </button>
  );
}
