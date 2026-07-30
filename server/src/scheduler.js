import { sql } from './db.js';
import { runFullPipeline } from './pipeline.js';

// In-memory timers keyed by workflow id, rebuilt whenever schedules change.
const timers = new Map();

export async function reloadSchedules() {
  for (const t of timers.values()) clearInterval(t);
  timers.clear();

  const workflows = await sql`
    SELECT id, name, schedule_minutes FROM workflows
    WHERE enabled = true AND schedule_minutes IS NOT NULL AND schedule_minutes > 0`;

  for (const wf of workflows) {
    const ms = wf.schedule_minutes * 60 * 1000;
    timers.set(
      wf.id,
      setInterval(async () => {
        console.log(`[scheduler] running workflow "${wf.name}" (#${wf.id})`);
        try {
          const result = await runFullPipeline(wf.id);
          console.log(`[scheduler] workflow #${wf.id} finished: ${result.status}`);
        } catch (err) {
          console.error(`[scheduler] workflow #${wf.id} crashed:`, err.message);
        }
      }, ms)
    );
    console.log(`[scheduler] "${wf.name}" scheduled every ${wf.schedule_minutes} min`);
  }
}
