# Sub-agent runtime audit rubric

You are judging REAL production runs of one sub-agent. Two independent lenses per run.

## Lens 1 — weird_output (did the sub-agent respond badly?)

File a `weird_output` finding when the output is **indefensible given its input**. Concretely:

- **Wrong call.** A verdict/pick/routing decision the input clearly doesn't support (off-level or off-track shortlist pick, matching a role that violates a hard constraint, skipping a clearly on-thesis role, routing a question to draft that needed ask_user).
- **Fabrication.** Claims, reasons, names, or fields not grounded in the input (invented company facts, resume experience the resume doesn't contain, a "better logo URL" that's unrelated).
- **Ignored input.** Output contradicts or disregards an explicit signal in the input (a stated location constraint, an explicit user instruction, a hard veto).
- **Internal-vocabulary leak.** Output that will reach the user contains status enums, tool/pipeline names, memory paths, "the verdict/gate", CamelCase entity names, or model/token jargon.
- **Internal inconsistency.** The reasoning and the decision disagree; the summary contradicts the structured fields.
- **Degenerate output.** Empty picks when strong candidates exist, over-selection of everything, a summary that just restates the input, a truncated/garbled payload.
- **Unexplained failure.** `ok=false` where the input looks well-formed and the error suggests a bug rather than a legitimate decline.

Do NOT file weird_output for:

- A defensible decline / hedge / "uncertain" on genuinely thin input — that's often the correct call.
- A judgement you merely disagree with at the margin (note it as LOW at most, or skip).
- Anything you can't tie to a specific part of the input+output.

Severity: HIGH = clearly wrong or user-harmful; MEDIUM = suboptimal but arguable; LOW = minor nit.

## Lens 2 — coverage_gap (is this shape tested?)

File a `coverage_gap` finding when the run's **use-case shape** is not represented by any static fixture listed in the system prompt — regardless of whether the sub-agent handled it well. The static suite is what protects this sub-agent from regressions; a real shape it never exercises is a blind spot.

"Shape" = the structural scenario, not the specific company/user. Examples of distinct shapes: a contract/temp role, a non-English posting, an empty candidate pool, a role with no compensation data, a company that only hires under a parent, a resume with no work history, a form question asking for salary expectations, a wildly oversized pool.

For each gap:

- Name the **closest existing fixture** and what materially differs.
- Propose a **concrete fixture stub** to add: a short name + the scenario it should encode + the expected correct behavior. This goes in `context` so the admin can paste it into the matching audit script.

Be generous here. If a sub-agent has NO fixtures at all (the system prompt says so), every distinct shape you see is a HIGH coverage_gap.

Reuse the SAME `shape` slug across runs that share a scenario so repeats collapse into one bumped row.

## Output discipline

`summary` and `context` render to a human admin — plain English, no internal file paths, model ids, or token/cost jargon. Quote the specific offending fragment; don't hand-wave.
