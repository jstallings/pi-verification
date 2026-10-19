# Pi Verification

A TypeScript Pi extension for independent, automation-first acceptance-criteria
verification. It stores an AC snapshot, many-to-many verification criteria,
per-criterion evidence, and derived coverage/status outside the working repository.
Tested against `@earendil-works/pi-coding-agent` 1.3.0 and `typebox` 1.3.27.
Requires Node.js 22.19 or newer; no build step or runtime dependencies beyond the
host-supplied peers. Wildcard peer ranges follow Pi's host-dependency convention;
they do not guarantee compatibility with every Pi or TypeBox version. Development
and CI pin the tested host versions separately.

## Install And Load

With Pi installed, install from
[the public GitHub repository](https://github.com/jstallings/pi-verification):

```sh
pi install git:github.com/jstallings/pi-verification
```

This managed git installation installs package dependencies and changes Pi's
package settings. A git tag or commit may be appended with `@<ref>` to pin the
source once that ref exists. This package is not currently published on npm.

From a local checkout, load this package for one invocation:

```sh
pi --extension /absolute/path/to/pi-verification
```

For persistent installation, `pi install /absolute/path/to/pi-verification` uses
Pi's package manager and changes its package settings. Local packages are loaded
in place; Pi does not install their dependencies. Loading alone needs no settings
changes. Extensions execute code: review package source before installing and
review project package declarations before granting project trust. The factory
only registers tools and a command: it does not create storage directories, start
processes, or request a model response.

Only give these tools and their records to the intended verification context.
Keep hidden QA scripts and artifacts outside the coding repository/context.
External storage is not an operating-system security boundary.

## Workflow

All five tools require explicit `project` and `ticket` keys; there is no selected
ticket or implicit checkout. Keys use 1-100 ASCII letters, digits, hyphens or
underscores, beginning with a letter or digit. Project/ticket keys are stored in
lowercase; AC and criterion IDs follow the same grammar but are case-sensitive.
Definitions and evidence are trimmed and must contain non-whitespace text.

1. Use `verification_create` to snapshot at least one `{ id, text }` AC.
2. Author checks with normal tools, then register each with `verification_add`.
3. Inspect `verification_read` for coverage. The surrounding process reviews the
   plan and handles coding separately without exposing the verification plan.
4. In the independent verification context and correct implementation directory,
   invoke `/verify <project> <ticket>`, for example `/verify accounts AUTH-123`.
5. The **current agent** performs checks using its existing tools and records each
   result with `verification_record_result`. Read the record for final status.

Example `verification_add` input (after creating both referenced ACs):

```json
{
  "project": "accounts",
  "ticket": "AUTH-123",
  "id": "V-1",
  "acIds": ["AC-1", "AC-2"],
  "instructions": "Attempt an expired reset, then check the original password.",
  "expectedOutcome": "Reset rejected; original password still authenticates.",
  "command": "python3 \"$HOME/qa/expired-reset.py\""
}
```

`command` is optional and only a reference; registration neither executes it nor
checks its existence. Relative command paths are relative to the implementation
working directory, not the JSON record. Scripts, dependencies, screenshots and
other artifacts are not created, copied, versioned or managed by this extension.

| Tool | Input Beyond Project/Ticket |
| --- | --- |
| `verification_create` | Nonempty `acceptanceCriteria: [{ id, text }]`; never overwrites |
| `verification_add` | `id`, nonempty distinct `acIds`, `instructions`, `expectedOutcome`, optional `command` |
| `verification_read` | None; returns the complete record and derived summary without starting work |
| `verification_edit` | One tagged `change`, described next |
| `verification_record_result` | `criterionId`, `state`, and evidence as required by that state |

Edit operations are `add_ac`/`update_ac` (`id`, `text`), `remove_ac` (`id`),
`update_criterion` (the complete criterion definition), and `remove_criterion`
(`id`). IDs cannot be renamed. Removing an AC requires no links and must leave
at least one AC. Omitting `command` in a criterion update removes it. Every
criterion update clears its result, even if unchanged; changing AC text clears
all linked results, including shared criteria. Unchanged trimmed AC text is a
no-op. Other results are retained.

States are `not run`, `passed`, `failed`, and `blocked`. The last three require
textual evidence; `not run` requires omitted or null evidence and clears previous
evidence. Include commands, exit status and relevant output when checks execute.
A shared criterion has one result and must establish its whole expected outcome
across all linked ACs before passing. Verified means every AC is covered and
every criterion passed, not that the plan is sufficient or code remains unchanged.

Each successful tool result exposes `{ ok: true, record, summary }` through
`structuredContent`, matching `outputSchema`, plus readable text and structured
`details`. Summaries include coverage, uncovered AC IDs, all four state counts,
and `verified`; shared criteria count only once. Extension-owned failures return
`{ ok: false, error: { code, message } }` with `isError: true`. Pi's own argument
validation can reject malformed calls before the tool executes. Command failures
throw a code-prefixed error so callers do not need a terminal UI.

## Fresh Passes And Human Assistance

`/verify` requires exactly two valid keys and an idle agent with no pending
messages. Missing, empty, corrupt or unsupported plans and busy agents stop
without a reset. A successful invocation atomically saves **all criteria as
`not run` with null evidence**, then calls `pi.sendUserMessage()` with the plan,
current working directory and verification instructions. It does not run a shell
executor or create another agent. Uncovered ACs remain uncovered; checks still run.

Returning from `/verify` means the request was submitted, not that execution began
or completed. In Pi 1.3.0, `sendUserMessage()` returns `void` and reports asynchronous
submission failures through Pi's runtime error channel. Only synchronous throws
can be translated to `START_FAILED` here. In either case, the saved reset stays;
old passes are never restored. An interrupted pass keeps newly recorded results
and leaves unfinished criteria `not run` or explicitly `blocked`.

Automate by default. A missing script, dependency/access problem, or pending human
judgment is `blocked`; an observed mismatch or explicit human rejection is
`failed`. Artifact capture alone is not human approval. Show fresh artifacts,
request an explicit decision, and record it with supporting observations. A human
response may complete a blocked criterion through the result tool without
restarting `/verify`. Each new pass requires fresh approvals; approval must not
override a failure. The extension records agent claims, not authenticated proof.

## Storage And Boundaries

Records are human-readable JSON at:

```text
~/.pi/agent/verification/<lowercase-project>/<lowercase-ticket>.json
```

The extension uses this fixed location, not a repository fallback or Pi's
configurable agent-directory setting. Every operation rereads and validates the
record. Temporary-file writes followed by same-directory atomic replacement keep
the destination complete; failed pre-replacement writes preserve the previous
file. Normal failures attempt temporary-file cleanup; process interruption may
leave an unused temporary file. Summaries are not stored. Complete local
read-modify-write operations use Pi's per-file mutation queue.

The caller owns same-ticket coordination across agents/processes, context
isolation, checkout selection, approval authenticity, and reruns after code or QA
source changes. There are no roles/auth, locks, orchestration, approval gates,
run history, attachment storage, source management or automatic freshness checks.
Return actionable AC-level defects to the coding loop, not the hidden checklist
or full verification record. See [SPEC.md](SPEC.md) for the complete v1 contract.

## Development And Checks

Bootstrap a contributor checkout with Node.js 22.19 or newer:

```sh
git clone https://github.com/jstallings/pi-verification.git
cd pi-verification
npm ci --ignore-scripts
npm run check
```

The committed lockfile supplies local development dependencies, including Pi
1.3.0, TypeBox 1.3.27, TypeScript 5.8.3, and Node types 22.19.19. No existing Pi
installation or fallback environment variables are required for these checks.
Dependency lifecycle scripts are disabled during installation. CI runs the same
checks on Node.js 22.19.0 and 24; it does not publish releases.

Individual checks and a preview of the npm payload are also available:

```sh
npm test
npm run typecheck
npm run smoke
npm pack --dry-run --ignore-scripts
```

Tests use Node's test runner, real temporary-directory persistence, and an
in-process extension boundary harness. Filesystem failures are injected only to
exercise failure decisions. The smoke script discovers the package through the
actual installed Pi loader, without a model request or settings changes.

For an existing Pi installation without installing dependencies here, set
`PI_VERIFICATION_HOST_ROOT` to the installation directory containing
`node_modules`, and `PI_VERIFICATION_TYPESCRIPT` to an existing TypeScript package
path for typechecking. These are check-script conveniences, not runtime storage
configuration. This optional fallback is not part of the normal contributor
setup. Neither the checks nor the extension initialize git or modify personal Pi
settings.

## License

[MIT](LICENSE). Copyright (c) 2026 John Stallings.
