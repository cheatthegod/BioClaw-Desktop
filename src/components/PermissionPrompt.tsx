/**
 * Permission prompt — appears whenever the sidecar emits a
 * `permission-needed` SSE event from inside an /chat request. The user
 * picks Allow always / Allow once / Deny, which we forward to
 * /permissions/decide on the sidecar so the script either runs or the
 * tool call returns a permission error.
 *
 * Three choices:
 *   * Allow always — adds (skillId, script) to the persisted always-allow
 *     list, also pushed to the sidecar's in-memory cache.
 *   * Allow once   — runs THIS one call without remembering.
 *   * Deny         — returns a permission-denied result to the model.
 *
 * Visual: centered modal with a subtle backdrop. We deliberately keep the
 * styling spare (no animations, no overlap with the chat composer) so the
 * user can't keyboard-confirm by accident.
 */
import { useChatStore } from '../lib/chat-state';

export function PermissionPrompt() {
  const pending = useChatStore((s) => s.pendingPermission);
  const resolve = useChatStore((s) => s.resolvePermission);
  if (!pending) return null;

  const argsLine = pending.args.length > 0 ? pending.args.join(' ') : '(no arguments)';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-lg rounded-xl border border-zinc-200 bg-white shadow-xl">
        <div className="border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">
            Allow this skill to run a script?
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            The AI is asking to execute code on your machine. Review the command, then choose.
          </p>
        </div>

        <div className="space-y-3 px-6 py-4 text-sm">
          <Field label="Skill" value={pending.skillId} />
          <Field label="Interpreter" value={pending.interpreter} />
          <Field label="Script" value={pending.script} mono />
          <Field label="Arguments" value={argsLine} mono />
        </div>

        <div className="flex flex-col gap-2 border-t border-zinc-200 px-6 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => void resolve('deny')}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => void resolve('allow_once')}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Allow once
          </button>
          <button
            type="button"
            onClick={() => void resolve('allow')}
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
          >
            Allow always
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div
        className={
          (mono ? 'font-mono text-xs ' : '') +
          'break-all rounded-md bg-zinc-50 px-2 py-1 text-zinc-800'
        }
      >
        {value}
      </div>
    </div>
  );
}
