/**
 * Upload a file into the user's SaaS workspace through the sidecar proxy and
 * return its workspace-relative path (the value GPU jobs reference in their
 * `inputs` map).
 *
 * Mirrors the web client's use of `POST /api/upload?defer=1` with the raw file
 * body + an `x-file-name` header; the SaaS responds with `{ workspacePath }`.
 * `defer=1` means "don't post a chat message for this upload".
 */
const SIDECAR_HOST = '127.0.0.1';

interface UploadResponse {
  ok?: boolean;
  workspacePath?: string;
  filename?: string;
  error?: string;
}

export async function uploadToWorkspace(port: number, file: File): Promise<string> {
  const url = `http://${SIDECAR_HOST}:${port}/saas/upload?defer=1`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
    },
    body: await file.arrayBuffer(),
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as UploadResponse;
      detail = body.error ?? detail;
    } catch {
      /* non-JSON error */
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as UploadResponse;
  if (!body.workspacePath) throw new Error('upload response missing workspacePath');
  return body.workspacePath;
}
