/**
 * GPU Tools panel (goal M2.1).
 *
 * Native UI for the SaaS GPU tool registry (Boltz, ESMFold, AlphaFold2,
 * RFdiffusion, ProteinMPNN, Proteina-Complexa, nvMolKit, and the in-house
 * RNAGenesis + FoldMark models). Everything goes through the local sidecar's
 * authenticated SaaS proxy (`/saas/gpu/*`) via the M1.2 typed client + hooks.
 *
 * Flow: pick a tool → fill the dynamic param form (+ upload any file inputs to
 * the workspace) → submit → watch the job stream live → download results.
 */
import { useMemo, useState } from 'react';

import { useSaasQuery } from '../hooks/useSaasQuery';
import { useSaasStream } from '../hooks/useSaasStream';
import { saasPost } from '../lib/api/saas';
import { uploadToWorkspace } from '../lib/api/saas-upload';

// ── SaaS wire types (mirror BioClaw-SaaS/src/gpu/tools.ts) ───────────

type ParamType = 'string' | 'number' | 'boolean' | 'enum';

interface GpuParamSpec {
  name: string;
  type: ParamType;
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  enumValues?: string[];
  description: string;
}

interface GpuInputSpec {
  name: string;
  extensions: string[];
  required: boolean;
  description: string;
  maxBytes: number;
}

interface GpuTool {
  id: string;
  displayName: string;
  description: string;
  category: string;
  estimatedMinutes: number;
  estimatedGpuMemGB: number;
  inputs: GpuInputSpec[];
  params: GpuParamSpec[];
}

interface GpuJob {
  id: string;
  status: 'pending' | 'uploading' | 'running' | 'fetching' | 'done' | 'failed' | 'cancelled';
  exitCode?: number | null;
  error?: string | null;
  outputFiles?: string[];
  stdoutTail?: string | null;
  stderrTail?: string | null;
}

interface HostGpu {
  name: string;
  memFreeMB?: number;
  memTotalMB?: number;
}
interface HostStatus {
  reachable: boolean;
  selectedHostId?: string;
  gpu?: HostGpu[];
}

type ParamValue = string | number | boolean;

// ── component ────────────────────────────────────────────────────────

export function GpuToolsPanel({ port, onClose }: { port: number | null; onClose: () => void }) {
  const toolsQ = useSaasQuery<{ tools: GpuTool[] }>(port, '/gpu/tools');
  const hostQ = useSaasQuery<HostStatus>(port, '/gpu/host/status', { refetchIntervalMs: 15000 });

  const tools = useMemo(() => toolsQ.data?.tools ?? [], [toolsQ.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tools.find((t) => t.id === selectedId) ?? null;

  const grouped = useMemo(() => {
    const m = new Map<string, GpuTool[]>();
    for (const t of [...tools].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
      const arr = m.get(t.category) ?? [];
      arr.push(t);
      m.set(t.category, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tools]);

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg">
      <header className="flex items-center justify-between border-b border-line/40 px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-[13px] font-semibold text-ink">GPU 工具</h2>
          <HostBadge host={hostQ.data} needsAuth={hostQ.needsAuth} />
        </div>
        <button type="button" onClick={onClose} className="text-[12px] text-muted hover:text-ink">
          关闭
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* tool list */}
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-line/40 px-2 py-3">
          {toolsQ.loading && <p className="px-2 text-[12px] text-muted">加载工具…</p>}
          {toolsQ.needsAuth && (
            <p className="px-2 text-[12px] text-danger">未登录，请先在设置中重新登录。</p>
          )}
          {toolsQ.error && (
            <p className="px-2 text-[12px] text-danger">加载失败：{toolsQ.error.message}</p>
          )}
          {grouped.map(([cat, list]) => (
            <div key={cat} className="mb-3">
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                {cat}
              </div>
              {list.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  className={`block w-full rounded px-2 py-1.5 text-left text-[12px] ${
                    selectedId === t.id ? 'bg-accent/15 text-ink' : 'text-ink-soft hover:bg-line/20'
                  }`}
                >
                  {t.displayName}
                </button>
              ))}
            </div>
          ))}
        </aside>

        {/* detail / form / job */}
        <section className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {!selected ? (
            <p className="text-[13px] text-muted">从左侧选择一个 GPU 工具。</p>
          ) : (
            <ToolRunner key={selected.id} port={port} tool={selected} />
          )}
        </section>
      </div>
    </div>
  );
}

function HostBadge({ host, needsAuth }: { host: HostStatus | null; needsAuth: boolean }) {
  if (needsAuth) return <span className="text-[11px] text-danger">未登录</span>;
  if (!host) return <span className="text-[11px] text-muted">主机状态…</span>;
  const gpu = host.gpu?.[0];
  const free = gpu?.memFreeMB ? `${Math.round(gpu.memFreeMB / 1024)}GB 空闲` : '';
  return (
    <span className={`text-[11px] ${host.reachable ? 'text-success' : 'text-danger'}`}>
      {host.reachable ? `GPU 可用${gpu ? ` · ${gpu.name} ${free}` : ''}` : 'GPU 主机不可达'}
    </span>
  );
}

// ── per-tool runner ──────────────────────────────────────────────────

function ToolRunner({ port, tool }: { port: number | null; tool: GpuTool }) {
  const [params, setParams] = useState<Record<string, ParamValue>>(() => {
    const init: Record<string, ParamValue> = {};
    for (const p of tool.params) if (p.default !== undefined) init[p.name] = p.default;
    return init;
  });
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const missingRequired =
    tool.inputs.some((i) => i.required && !inputs[i.name]) ||
    tool.params.some((p) => p.required && params[p.name] === undefined);

  async function handleFile(spec: GpuInputSpec, file: File) {
    if (port == null) return;
    setUploadingName(spec.name);
    setSubmitError(null);
    try {
      const workspacePath = await uploadToWorkspace(port, file);
      setInputs((prev) => ({ ...prev, [spec.name]: workspacePath }));
    } catch (e) {
      setSubmitError(`上传失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploadingName(null);
    }
  }

  async function submit() {
    if (port == null) return;
    setSubmitError(null);
    try {
      const resp = await saasPost<{ ok?: boolean; job?: GpuJob; error?: string }>(
        port,
        '/gpu/jobs',
        { tool: tool.id, params, inputs },
      );
      if (resp.job?.id) setJobId(resp.job.id);
      else setSubmitError(resp.error ?? '提交失败');
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    }
  }

  if (jobId) {
    return <JobView port={port} jobId={jobId} toolName={tool.displayName} onBack={() => setJobId(null)} />;
  }

  return (
    <div className="max-w-2xl">
      <h3 className="text-[15px] font-semibold text-ink">{tool.displayName}</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">{tool.description}</p>
      <p className="mt-1 text-[11px] text-muted">
        约 {tool.estimatedMinutes} 分钟 · 约 {tool.estimatedGpuMemGB} GB 显存
      </p>

      {/* file inputs */}
      {tool.inputs.length > 0 && (
        <div className="mt-4 space-y-3">
          {tool.inputs.map((spec) => (
            <div key={spec.name}>
              <label className="block text-[12px] font-medium text-ink-soft">
                {spec.name}
                {spec.required && <span className="text-danger"> *</span>}
              </label>
              <p className="text-[11px] text-muted">{spec.description}</p>
              <input
                type="file"
                accept={spec.extensions.map((e) => `.${e}`).join(',')}
                onChange={(ev) => {
                  const f = ev.target.files?.[0];
                  if (f) void handleFile(spec, f);
                }}
                className="mt-1 block w-full text-[12px] text-ink-soft file:mr-3 file:rounded file:border-0 file:bg-line/30 file:px-3 file:py-1 file:text-[12px]"
              />
              {uploadingName === spec.name && (
                <p className="text-[11px] text-muted">上传中…</p>
              )}
              {inputs[spec.name] && (
                <p className="text-[11px] text-success">已上传：{inputs[spec.name]}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* params */}
      <div className="mt-4 space-y-3">
        {tool.params.map((p) => (
          <ParamField
            key={p.name}
            spec={p}
            value={params[p.name]}
            onChange={(v) => setParams((prev) => ({ ...prev, [p.name]: v }))}
          />
        ))}
      </div>

      {submitError && <p className="mt-3 text-[12px] text-danger">{submitError}</p>}

      <button
        type="button"
        disabled={missingRequired || uploadingName !== null || port == null}
        onClick={() => void submit()}
        className="mt-4 rounded bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        运行
      </button>
    </div>
  );
}

function ParamField({
  spec,
  value,
  onChange,
}: {
  spec: GpuParamSpec;
  value: ParamValue | undefined;
  onChange: (v: ParamValue) => void;
}) {
  const label = (
    <label className="block text-[12px] font-medium text-ink-soft">
      {spec.name}
      {spec.required && <span className="text-danger"> *</span>}
    </label>
  );
  return (
    <div>
      {label}
      {spec.description && <p className="text-[11px] text-muted">{spec.description}</p>}
      {spec.type === 'boolean' ? (
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 h-4 w-4 accent-accent"
        />
      ) : spec.type === 'enum' ? (
        <select
          value={value !== undefined ? String(value) : ''}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded border border-line/50 bg-surface px-2 py-1 text-[12px] text-ink"
        >
          {(spec.enumValues ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : spec.type === 'number' ? (
        <input
          type="number"
          value={value !== undefined ? String(value) : ''}
          min={spec.min}
          max={spec.max}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          className="mt-1 w-full rounded border border-line/50 bg-surface px-2 py-1 text-[12px] text-ink"
        />
      ) : (
        <input
          type="text"
          value={value !== undefined ? String(value) : ''}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded border border-line/50 bg-surface px-2 py-1 text-[12px] text-ink"
        />
      )}
    </div>
  );
}

// ── live job view ────────────────────────────────────────────────────

function JobView({
  port,
  jobId,
  toolName,
  onBack,
}: {
  port: number | null;
  jobId: string;
  toolName: string;
  onBack: () => void;
}) {
  const [job, setJob] = useState<GpuJob | null>(null);

  useSaasStream(port, `/gpu/jobs/${jobId}/log`, {
    onEvent: (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as { job?: GpuJob };
        if (parsed.job) setJob(parsed.job);
      } catch {
        /* ignore non-JSON keepalives */
      }
    },
  });

  const status = job?.status ?? 'pending';
  const terminal = status === 'done' || status === 'failed' || status === 'cancelled';
  const outputs = (job?.outputFiles ?? []).filter((f) => /\.(cif|pdb|fasta|fa|csv|tsv|sdf|json|txt)$/i.test(f));

  async function cancel() {
    if (port == null) return;
    await saasPost(port, `/gpu/jobs/${jobId}/cancel`).catch(() => undefined);
  }

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-semibold text-ink">{toolName}</h3>
        <button type="button" onClick={onBack} className="text-[12px] text-muted hover:text-ink">
          ← 返回
        </button>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <StatusPill status={status} />
        {!terminal && (
          <button type="button" onClick={() => void cancel()} className="text-[12px] text-danger hover:underline">
            取消
          </button>
        )}
      </div>

      {job?.error && <p className="mt-2 text-[12px] text-danger">{job.error}</p>}

      <LogBlock title="stdout" text={job?.stdoutTail} />
      <LogBlock title="stderr" text={job?.stderrTail} />

      {status === 'done' && (
        <div className="mt-4">
          <div className="text-[12px] font-semibold text-ink">结果文件（{outputs.length}）</div>
          {outputs.length === 0 ? (
            <p className="text-[12px] text-muted">无输出文件。</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {outputs.map((f) => (
                <li key={f} className="font-mono text-[11px] text-ink-soft">
                  {f.split('/').pop()}
                  <span className="ml-2 text-muted">（{f}）</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: GpuJob['status'] }) {
  const map: Record<GpuJob['status'], string> = {
    pending: 'bg-line/30 text-muted',
    uploading: 'bg-line/30 text-muted',
    running: 'bg-accent/20 text-ink',
    fetching: 'bg-accent/20 text-ink',
    done: 'bg-success/20 text-success',
    failed: 'bg-danger/20 text-danger',
    cancelled: 'bg-line/30 text-muted',
  };
  return (
    <span className={`rounded px-2 py-0.5 text-[11px] ${map[status]}`}>{status}</span>
  );
}

function LogBlock({ title, text }: { title: string; text?: string | null }) {
  if (!text) return null;
  return (
    <div className="mt-3">
      <div className="text-[11px] font-semibold text-muted">{title}</div>
      <pre className="mt-1 max-h-48 overflow-auto rounded bg-surface-alt/60 p-2 font-mono text-[11px] text-ink-soft">
        {text}
      </pre>
    </div>
  );
}
