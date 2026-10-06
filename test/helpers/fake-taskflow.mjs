// In-process stand-in for the TaskFlow client: the same interface as createTaskflowClient,
// backed by a SyncStore in a temp dir. `failures` injects TaskflowUnavailable per method.
import { buildQueue } from '../../js/agent.js';
import { TaskflowRejected, TaskflowUnavailable } from '../../agent/lib/taskflow-client.mjs';

export function fakeTaskflow(store, { failures = {}, legacy = false } = {}) {   // legacy: старый сервер без journals/journalStored
  const guard = (m) => { if (failures[m]?.()) throw new TaskflowUnavailable(`injected ${m}`); };
  const trans = async (req) => {
    const r = await store.agentTransition(req);
    if (!r.ok) throw new TaskflowRejected(r.reason);
    return r;
  };
  const calls = [];
  return {
    calls,
    queue: async ({ today, taskId } = {}) => {
      calls.push(['queue', taskId ? 'task' : 'list']);
      guard('queue');
      const tasks = store.snapshot().tasks;
      const { queue, stale } = buildQueue(tasks, { today, now: Date.now() });
      const out = {
        today,
        queue: queue.map((t) => ({ id: t.id, title: t.title, notes: t.notes, due: t.due, priority: t.priority, delegatedAt: t.agent.at })),
        stale: stale.map((t) => ({ id: t.id, claimedAt: t.agent.claimedAt })),
      };
      if (taskId !== undefined) {
        const t = tasks.find((x) => x.id === taskId);
        out.task = t ? { id: t.id, exists: true, done: t.done, status: t.agent?.status ?? null, claimToken: t.agent?.claimToken ?? null } : { id: taskId, exists: false };
      }
      return out;
    },
    claim: async ({ id, today }) => {
      calls.push(['claim', id]); guard('claim');
      const r = await trans({ op: 'claim', id, today });
      return { ok: true, claimToken: r.agent.claimToken, claimedAt: r.agent.claimedAt, task: r.task, ...(!legacy && Array.isArray(r.journals) ? { journals: r.journals } : {}) };
    },
    finish: async ({ id, claimToken, status, text, journal }) => {
      calls.push(['finish', id, journal]); guard('finish');
      const r = await trans({ op: 'finish', id, claimToken, status, text, ...(journal !== undefined ? { journal } : {}) });
      return { ok: true, status: r.agent.status, ...(!legacy && r.journalStored === true ? { journalStored: true } : {}) };
    },
    reap: async ({ id, journal }) => {
      calls.push(['reap', id, journal]); guard('reap');
      const r = await trans({ op: 'reap', id, ...(journal !== undefined ? { journal } : {}) });
      return { ok: true, status: r.agent.status, ...(!legacy && r.journalStored === true ? { journalStored: true } : {}) };
    },
  };
}
