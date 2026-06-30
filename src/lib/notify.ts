/**
 * Native OS notifications (goal M3.3) via @tauri-apps/plugin-notification.
 *
 * Degrades gracefully: outside a Tauri window (e.g. `vite dev` in a browser)
 * the dynamic import resolves to a module whose calls throw, so every entry
 * point is wrapped in try/catch and silently no-ops. Permission is requested
 * lazily on first send.
 */

let permissionChecked = false;
let permissionGranted = false;

async function ensurePermission(): Promise<boolean> {
  if (permissionChecked) return permissionGranted;
  permissionChecked = true;
  try {
    const { isPermissionGranted, requestPermission } =
      await import('@tauri-apps/plugin-notification');
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const res = await requestPermission();
      permissionGranted = res === 'granted';
    }
  } catch {
    permissionGranted = false;
  }
  return permissionGranted;
}

/**
 * Fire a native notification. No-op (never throws) when not running under
 * Tauri or when the user has denied notification permission.
 */
export async function notify(title: string, body: string): Promise<void> {
  try {
    if (!(await ensurePermission())) return;
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    sendNotification({ title, body });
  } catch {
    /* not in Tauri, or notifications unavailable — ignore */
  }
}
