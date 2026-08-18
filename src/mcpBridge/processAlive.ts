/**
 * Is the process that wrote the discovery file still running?
 *
 * A crashed extension host leaves its file behind pointing at a dead port. The
 * PID check turns that from "hang trying to connect" into "treat as absent",
 * which is what lets the bridge fall through to its offline mode immediately.
 */

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — alive for our purposes.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
