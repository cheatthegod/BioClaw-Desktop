# Skills

Phase-3 of BioClaw Desktop wires the BioNeMo / biomed-research skills catalog
into the local chat sidecar so that an offline LLM (OpenRouter, OpenAI, or a
local Ollama via the OpenAI-compatible shim) can pick from the same playbooks
the cloud BioClaw-SaaS agent uses.

## TL;DR

* Sidecar reads `SKILL.md` files from `$BIOCLAW_SKILLS_DIR` (set by the Rust
  supervisor on spawn) and caches them in memory.
* A single OpenAI-style function tool, `invoke_skill(skill_id, args)`, is
  injected into every `/chat` request. The handler returns the SKILL.md
  body — no shell execution in phase 3.
* The user's last turn is keyword-ranked against the catalog; the top 6
  matches are listed in the system prompt so the LLM can pick a `skill_id`
  without having to load all 41+ tool schemas.
* Bundled phase-3 catalog is 6 offline + no-API-key skills (~80 KB).

## Architecture

```text
            ┌──────────────────────────────────────┐
            │ Tauri renderer  (React)              │
            │   sends POST /chat { messages, ... } │
            └───────────────────┬──────────────────┘
                                │ HTTP (127.0.0.1)
                                ▼
            ┌──────────────────────────────────────┐
            │ Sidecar (Node, Hono)                 │
            │  GET /skills      → registry catalog │
            │  POST /chat       → tool-call loop ──┼──┐
            │                                      │  │ stream provider events
            └───────────────────┬──────────────────┘  │
                                │                     ▼
                                │      ┌──────────────────────────┐
                                │      │ OpenAI-compat provider   │
                                │      │  (OpenRouter / OpenAI /  │
                                │      │   Ollama / Anthropic)    │
                                │      └──────────┬───────────────┘
                                │                 │
                                ▼                 ▼
            ┌──────────────────────────────────────┐
            │ sidecar/src/skills/                  │
            │   loader.ts   ← walks $BIOCLAW_SKILLS_DIR
            │   registry.ts ← listSkills / searchByKeywords / tool def
            │   runner.ts   ← invoke_skill handler (returns SKILL.md)
            └──────────────────────────────────────┘
```

### loader.ts

Walks the directory once at startup and caches the parsed result for the
lifetime of the sidecar process. The parser is a port of the SaaS
`community-skills.ts` parser — same YAML frontmatter handling (`>` and `|`
block scalars, scalar fields, allowed-tools comma list). On top of the SaaS
fields it derives two extra heuristics:

* `requiresApiKey = true` if the directory name ends `-nim` OR the body
  mentions `NVIDIA_API_KEY` / `NGC_API_KEY`.
* `requiresGpu = true` if the directory matches the `proteina-complexa`
  or `kermt` families OR the body mentions `nvidia-smi` / `cuda`.

The desktop UI surfaces both flags so users can see why a skill might not
run on their machine.

### registry.ts

Holds three primitives the rest of the sidecar uses:

* `listSkills()` — metadata-only projection (no body) for `GET /skills`.
* `getSkill(id)` — full record including markdown body for the runner.
* `searchByKeywords(text, limit)` — tokenized overlap ranking. Used to
  build the system-prompt addendum so the LLM sees only relevant skills
  per turn, not all 6 (or eventually 41).
* `buildSkillToolDefinition()` — assembles the OpenAI-style function tool
  description with a single string-typed `skill_id` plus a free-form
  `args` object.
* `composeSkillsSystemPrompt(lastUserText)` — produces the markdown block
  prepended to the user-supplied system prompt, including the top-K
  candidate skills with one-line descriptions and any `(needs GPU)` /
  `(needs API key)` flags.

### runner.ts

The `invoke_skill` tool handler. Phase-3 behavior:

1. Read `skill_id` from args; reject if missing.
2. Look up the skill in the registry; reject if unknown.
3. Clamp the markdown body to ~24 k chars (some BioNeMo Agent Toolkit
   skills run very long); break at the nearest paragraph boundary when
   possible.
4. Return a header (id, category, flags) + body + a HINT footer that
   reminds the LLM the sidecar did NOT run anything.

Errors return `output` strings the LLM can read and self-correct on, plus
a `metadata.ok = false` marker for the desktop transcript UI.

### main.ts (`/chat`)

Phase 2's `/chat` was a stateless forward — one provider stream, no tool
calls. Phase 3 lifts it into a bounded loop:

```text
turnMessages ← request.messages (minus system)
systemPrompt ← user system + composeSkillsSystemPrompt(lastUser)
for step in 0..CHAT_STEP_LIMIT:
    stream provider with (turnMessages, tools=[invoke_skill])
    collect text-delta → forward immediately
    collect tool-call → buffer
    on finish:
      append assistant turn (with tool calls) to turnMessages
      if no tool calls → forward finish, return
      else: execute each tool call locally, append tool-result message
            to turnMessages, continue to next step
```

`CHAT_STEP_LIMIT` is 8 in phase 3 (the in-app `SessionRunner` uses 24).
Eight is generous for a single-tool workflow; the cap exists to bound a
misbehaving model.

## Decision: meta-tool vs per-skill tools

We expose ONE meta-tool (`invoke_skill`) rather than N separate
`bioclaw_invoke_<skill>` tools. Why:

| Concern | Meta-tool | Per-skill tools |
|---|---|---|
| Tool-schema cost in context | ~150 tokens fixed | ~50 tokens × N |
| LLM "discovery" of skills | Reads system-prompt list | Reads tool list |
| Cost at 6 skills (today) | ~150 tokens | ~300 tokens |
| Cost at 41 skills (unlock) | ~150 tokens | ~2000+ tokens |
| LLM picks the right one | We rank by keywords first | LLM browses tool list |
| Add new skill | Drop a SKILL.md, restart | Drop a SKILL.md, restart |

At 6 skills the difference is small. At 41 the per-skill approach is a
permanent 2 k token tax on every chat turn. We chose the meta-tool route
for that scaling reason. The strategy is encapsulated in
`buildSkillToolDefinition()` — swap that one function to switch.

**Flag for review:** if the LLM keeps picking the wrong `skill_id` in
practice (and the meta-tool path turns out to be too vague), the cheapest
A/B test is to render the top-3 ranked skills as dedicated tools while
keeping `invoke_skill` as a fallback.

## The 6 vendored skills (phase 3)

All six are bundled because they (a) work without an NVIDIA NGC / NVAIE
API key, (b) work without a local GPU for at least the discovery /
config-edit paths, and (c) are useful for the desktop user persona — a
researcher running a single machine, no cluster.

| id | What it does | Why it's safe to bundle |
|---|---|---|
| `bionemo-nvmolkit` | Reference for nvMolKit's GPU-accelerated RDKit APIs | Reference text only; the LLM produces Python code, the user decides where to run it |
| `bionemo-cuequivariance` | Group theory / segmented polynomials playbook for cuEq | Same — explainer + code snippets |
| `bionemo-science-skills-uniprot-database` | Query UniProt over HTTP | Plain `requests`-style calls, no NGC |
| `bionemo-science-skills-alphafold-database-fetch-and-analyze` | Fetch AlphaFold predictions from the EBI database | Public REST endpoint, no auth |
| `bionemo-complexa-target` | Add / edit Proteina-Complexa design targets | Edits YAML files; phase-3 surfaces instructions only |
| `bionemo-complexa-sweep` | Configure Proteina-Complexa sweeps | Same — config edit, not execution |

Skills explicitly excluded from the phase-3 bundle:

* Every `*-nim` skill — requires NGC API key + a docker-run.
* `bionemo-kermt-*` — requires local GPU + model checkpoints.
* `bionemo-evo2-nim`, `bionemo-boltz2-nim`, `bionemo-openfold*-nim`, etc.
* `bionemo-parabricks` — requires NVIDIA Parabricks license.
* `bionemo-genomics-workflow-acceleration` — pipeline assumes the SaaS
  Slurm/k8s harness.

## Adding a new skill

1. Verify it's offline-safe (no API key, no required GPU). The loader's
   `requiresApiKey` / `requiresGpu` heuristics will catch most cases —
   double-check by reading the SKILL.md.
2. Append the directory name to the `SKILLS=(...)` array in
   `scripts/vendor-skills.sh`.
3. Document the choice in the table above.
4. Re-run `npm run vendor:skills` (or just `npm run tauri:build`, which
   chains the vendor step) — the loader auto-discovers new directories at
   sidecar restart.
5. No code changes required — registry + runner are generic.

## How the desktop UI consumes this

* `GET /skills` returns `{ skills: SkillSummary[], count }`. The Skills
  Center page renders one card per skill (id, name, description,
  category, requires-flags).
* `POST /chat` works without UI changes — the user types a question, the
  sidecar runs the tool-call loop, the SSE event stream now includes
  `tool-call-start`, `tool-call-result`, and `step-complete` events the
  transcript can render as collapsible blocks.

## Phase 4 preview: real shell execution

Phase 3 deliberately stops short of executing the bash recipes some
skills include (e.g. `bionemo-proteinmpnn-nim`'s `docker run`). Phase 4
will add:

* A Tauri-side permission prompt ("BioClaw wants to run `docker run ...`,
  Allow / Always Allow / Deny") backed by the existing tauri-plugin-fs /
  shell capability model.
* An allow-list of skills that the user has approved for auto-run.
* A `bioclaw_run_shell(command)` tool gated behind that prompt.
* Streaming of stdout/stderr into the transcript.

When that lands, the `runner.ts` hint string about "we did not execute
this" goes away, and the LLM gets to call shell commands directly.

## Files

* `sidecar/src/skills/loader.ts` — parser + cache
* `sidecar/src/skills/registry.ts` — list / get / search / tool def
* `sidecar/src/skills/runner.ts` — `invoke_skill` handler
* `sidecar/src/main.ts` — `GET /skills`, `/chat` tool loop
* `sidecar/src/providers-bridge.ts` — re-exports `ToolHandlerContext`
* `src-tauri/src/sidecar.rs` — sets `BIOCLAW_SKILLS_DIR` on spawn
* `src-tauri/tauri.conf.json` — `bundle.resources` ships `../skills`
* `scripts/vendor-skills.sh` — copies 6 skills from BioClaw-SaaS
* `skills/` — the vendored SKILL.md tree (committed into the desktop repo)
