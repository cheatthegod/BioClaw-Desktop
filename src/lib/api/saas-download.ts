/**
 * Download a workspace file (e.g. a GPU job's FASTA/CIF output) through the
 * sidecar's `/saas-files` proxy, which forwards to the SaaS top-level
 * `/files/chat/<chatJid>/<relPath>` route with the device-code session cookie
 * attached (GPU outputs live outside `/api/…`, so the keystone proxy can't
 * reach them — see sidecar `proxy_files`).
 *
 * `outputFiles` paths are workspace-root-relative (e.g.
 * `uploads/gpu-<id>/output/x.fasta`); each segment is URL-encoded.
 *
 * Saving uses a blob + anchor download — WKWebView (macOS) and WebView2
 * (Windows) both surface a native save dialog for blob: downloads, and the
 * browser does the same in `vite dev`. No fs-capability widening needed.
 */
const SIDECAR_HOST = '127.0.0.1';

export function workspaceFileUrl(port: number, chatJid: string, relPath: string): string {
  const encChat = encodeURIComponent(chatJid);
  const encPath = relPath
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `http://${SIDECAR_HOST}:${port}/saas-files/chat/${encChat}/${encPath}`;
}

export async function downloadWorkspaceFile(
  port: number,
  chatJid: string,
  relPath: string,
): Promise<void> {
  const res = await fetch(workspaceFileUrl(port, chatJid, relPath));
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = relPath.split('/').pop() ?? 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the click has a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
