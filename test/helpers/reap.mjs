// Test hygiene: a fake-claude in `hang` mode must never outlive its test. After every case the pid file
// (FAKE_CLAUDE_PIDFILE) is read and whatever is still alive gets kill -9 (process, its group, the grandchild).
import { readFileSync } from 'node:fs';

const kill = (pid, sig = 'SIGKILL') => { try { process.kill(pid, sig); return true; } catch { return false; } };

/** Kills the processes recorded in the pid file. Safe to call when the file is missing or the processes are gone. */
export function reapPidfile(file) {
  let rec;
  try { rec = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
  for (const pid of [rec.pid, rec.grandchild]) {
    if (!Number.isInteger(pid) || pid <= 1) continue;
    kill(-pid);        // the group, if the child was spawned detached (pgid = pid)
    kill(pid);
  }
}
