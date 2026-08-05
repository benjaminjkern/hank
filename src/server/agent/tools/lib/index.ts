// The tools/lib entry — shared tool infra, NOT the tool registry. The callable
// tool set is one file per tool under `../registry/`, assembled by `hankTools()`
// (src/server/agent/hank/toolset.ts). This module exposes only the
// `toolAffectsViewedState` lookup (consumed by agentRunner to schedule mid-turn
// panel refetches), derived from that same live registry so there's a single
// source of truth — no hand-kept parallel array to drift.
import { hankTools } from "@/server/agent/hank/toolset";

// The default is opt-OUT, not opt-in: a tool whose def leaves `affectsViewedState`
// unset counts as affecting viewed state. A forgotten flag then errs toward a
// (cheap, redundant) mid-turn refetch rather than silently leaving stale data on
// screen. Only an explicit `affectsViewedState: false` suppresses the refetch —
// use it on pure reads / memory-only writes to avoid the pointless fetch.
const AFFECTS_VIEWED_STATE: ReadonlyMap<string, boolean> = (() => {
  const m = new Map<string, boolean>();
  for (const tool of hankTools()) {
    m.set(tool.name, tool.affectsViewedState ?? true);
  }
  return m;
})();

// Returns true when completing this tool may have changed entities the user is
// currently looking at (dashboard buckets / focused company / job / opportunity).
// The chat client uses this to schedule a debounced mid-turn refetch. Defaults to
// true (see the map above) — an unknown name also errs toward a refetch. See
// `affectsViewedState` on ToolDef in ./types.
export function toolAffectsViewedState(name: string): boolean {
  return AFFECTS_VIEWED_STATE.get(name) ?? true;
}
