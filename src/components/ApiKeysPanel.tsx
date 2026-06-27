/**
 * Settings sub-panel for managing third-party API keys.
 *
 * All secret material is held in transient component state only while the
 * user is typing. On Save it's handed to the Rust side via the
 * `credentials` IPC and immediately cleared from the input. The "stored"
 * badge is derived from `credentials.list()` — we never read the value
 * back from the keychain just to render the UI.
 *
 * Strictly no `console.log` of values. Diagnostics use `console.warn` with
 * the account name only.
 */
import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Check, Trash2 } from 'lucide-react';
import { credentials, type CredentialAccount } from '../lib/credentials';
import { cn } from '../lib/utils';

interface Row {
  account: CredentialAccount;
  label: string;
  placeholder: string;
}

const ROWS: Row[] = [
  {
    account: 'openrouter_api_key',
    label: 'OpenRouter',
    placeholder: 'sk-or-v1-...',
  },
  {
    account: 'anthropic_api_key',
    label: 'Anthropic',
    placeholder: 'sk-ant-...',
  },
  {
    account: 'openai_api_key',
    label: 'OpenAI',
    placeholder: 'sk-...',
  },
];

export function ApiKeysPanel() {
  const [storedAccounts, setStoredAccounts] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CredentialAccount | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await credentials.list();
      setStoredAccounts(new Set(list));
      setError(null);
    } catch (e) {
      setError(`无法读取凭据索引: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
          {error}
        </div>
      )}
      {ROWS.map((row) => (
        <KeyRow
          key={row.account}
          row={row}
          stored={storedAccounts.has(row.account)}
          onSaved={() => void refresh()}
          onRequestDelete={() => setConfirmDelete(row.account)}
        />
      ))}
      {confirmDelete && (
        <ConfirmDeleteModal
          account={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            try {
              await credentials.delete(confirmDelete);
              setConfirmDelete(null);
              await refresh();
            } catch (e) {
              setError(`删除失败: ${String(e)}`);
              setConfirmDelete(null);
            }
          }}
        />
      )}
    </div>
  );
}

function KeyRow({
  row,
  stored,
  onSaved,
  onRequestDelete,
}: {
  row: Row;
  stored: boolean;
  onSaved: () => void;
  onRequestDelete: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await credentials.save(row.account, draft);
      setDraft(''); // clear sensitive material from React state immediately
      setReveal(false);
      setJustSaved(true);
      onSaved();
      setTimeout(() => setJustSaved(false), 1500);
    } catch (e) {
      // intentionally no value in the message
      console.warn(`save failed for ${row.account}`, String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded border border-line/40 bg-surface p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-semibold text-ink">{row.label}</span>
          {stored && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-success"
              title="已存入系统钥匙串"
            >
              <Check className="h-2.5 w-2.5" /> 已存
            </span>
          )}
        </div>
        {stored && (
          <button
            type="button"
            onClick={onRequestDelete}
            className="rounded p-1 text-muted-2 hover:bg-bg hover:text-danger"
            title="删除已存的密钥"
            aria-label={`delete ${row.label} key`}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <input
            type={reveal ? 'text' : 'password'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={stored ? '••••••  (输入新值以覆盖)' : row.placeholder}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded border border-line/60 bg-surface px-2 py-1 pr-7 text-[11px] focus:border-line focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-2 hover:bg-bg hover:text-ink-soft"
            aria-label={reveal ? 'hide value' : 'show value'}
            tabIndex={-1}
          >
            {reveal ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </button>
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!draft || saving}
          className={cn(
            'rounded px-2 py-1 text-[11px] font-semibold transition',
            !draft || saving
              ? 'cursor-not-allowed bg-accent-soft text-muted-2'
              : justSaved
                ? 'bg-success text-white'
                : 'bg-ink text-white hover:bg-ink',
          )}
        >
          {justSaved ? '已保存' : saving ? '...' : '保存'}
        </button>
      </div>
    </div>
  );
}

function ConfirmDeleteModal({
  account,
  onCancel,
  onConfirm,
}: {
  account: CredentialAccount;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30">
      <div className="w-72 rounded-lg bg-surface p-4 shadow-xl">
        <h3 className="text-[13px] font-semibold text-ink">删除该密钥?</h3>
        <p className="mt-1 text-[11px] text-ink-soft">
          将从系统钥匙串中永久移除 <span className="font-mono">{account}</span>，
          此操作不可撤销。
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-2.5 py-1 text-[11px] text-ink-soft hover:bg-bg"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-danger px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-danger/90"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
