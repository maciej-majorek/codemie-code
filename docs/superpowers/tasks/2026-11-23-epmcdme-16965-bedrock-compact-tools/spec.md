# EPMCDME-16965: Keep `tools` present on Claude requests that carry tool history (Bedrock /compact)

## Problem

`/compact` and automatic compaction on a Bedrock-backed Claude model via `ai-run-sso` fail with `litellm.UnsupportedParamsError: Bedrock doesn't support tool calling without 'tools=' param specified`. The session then errors on later messages. The error comes from LiteLLM's Bedrock Converse transformation, which rejects a request whose messages contain `tool_use`/`tool_result` blocks (or a `tool_choice`) but no `tools` array. A compaction request is a plausible source: it replays the conversation, including tool history, as a summarization call that Claude Code may send without tool definitions.

## Assumptions (unverified, per technical-analysis.md sections 2 and 6)

- A1: The failing request has not been captured. We assume it has `tool_use`/`tool_result` history or `tool_choice` and an absent or empty `tools`. The proxy has no code that removes `tools` (`sso.proxy.ts:427-446`, `:375`), so the client is the likely source.
- A2: `modify_params: true` is set in the checked-in backend config (`litellm_config.yaml:597-602`). It did not prevent this on the observed path; why is unknown (deployed config drift, the `/v1/messages` route, or the request shape). EPMCDME-13808 (backend, repo `codemie`) is the rescoped gateway check of `modify_params`; it is complementary to this ticket, not a duplicate, and its outcome is not yet known.
- A3: The proxy cannot tell Bedrock from Vertex (aliases are shared), so the rule keys on request shape only.
- A4: Automatic compaction shares the `/compact` request shape. Unverified; the capture (AC1) should include one automatic compaction if reproducible.

## Approach

Stage 1 is verification, stage 2 is a conditional mitigation. The guard is a temporary mitigation, not the root fix: the root-cause owner is the gateway (13808).

1. **Capture.** Before the guard is relied on, log a body-free shape summary of each `/v1/messages` request seen by the guard (has tools, tool count, has tool history, `tool_choice` value) at `logger.debug`, and capture one real failing `/compact` with `CODEMIE_DEBUG=true`. Also read the 13808 outcome.
2. **Guard.** Add a CLI-side guard in the SSO proxy request path for the Claude client family, at priority 14 with the same `clients` allow-list as the Claude normalizer: a step in `claude-request-normalizer.plugin.ts` (shares its parse and `content-length` reset, `:233-280`) or a small new plugin, chosen at planning by plugin-order tests.

Guard behavior on `/v1/messages` JSON bodies:
- If `tools` is missing or empty AND the body has a `tool_use` or `tool_result` block in `messages`, or a `tool_choice` of absent-`tools` with value `auto` or `none`, add one placeholder tool (single named constant: name, description stating it is unavailable and must not be called, empty-object `input_schema`).
- If `tool_choice` is `any` or `tool` (forces a tool) and `tools` is absent, do not inject; pass through unchanged and `logger.debug` it. Injecting would force a call to the placeholder or reference an undefined tool.
- Otherwise leave `tool_choice` as sent.
- Every other request passes through byte-identical: no re-serialization, no `content-length` reset.
- Log `logger.debug` when the placeholder is injected (no body content).

**Exit condition.** If the capture shows `tools` already present (or the failing request arrives by another route, e.g. chat-completions, or 13808 shows `modify_params` was merely missing in the deployed config and a fix covers it), the guard adds nothing: do not ship it; record the finding and close this ticket as a diagnosis, handing the fix to 13808. The guard ships only if the capture shows tools missing and the gateway fix does not cover it.

**Removal trigger.** When 13808 delivers a gateway fix that makes the capture-shaped request succeed without the placeholder, the guard is removed in a follow-up ticket.

## Acceptance criteria

1. AC1 (verification): The shape-summary debug log exists, and one real `/compact` body (shape only, no content) is captured and attached to the task record, with the 13808 outcome noted. The requester names who captures it (open question Q1). Without the capture, AC2 to AC7 are not considered closed.
2. AC2: A `/compact`-shaped request (tool history, no or empty `tools`, `tool_choice` absent, `auto` or `none`) leaves the proxy with a non-empty `tools`.
3. AC3: A request with no tool history and no `tool_choice`, or with a non-empty `tools`, is forwarded unchanged: byte-identical body, unchanged `content-length`.
4. AC4: Automatic compaction is covered by the same rule, with no `/compact` or prompt-text detection (subject to A4).
5. AC5: The placeholder does not change the model alias or other fields, and later plugins (RequestSanitizer p15, logging, OTLP) see the rewritten body. The 401 retry (`sso.proxy.ts:652-655`) re-sends the rewritten body; planning confirms this.
6. AC6: Non-Claude clients (Codex, OpenCode, codemie-code) and non-`/v1/messages` paths are untouched.
7. AC7: A Vitest unit test builds the failing shape through `plugin.createInterceptor(ctx)` and asserts: placeholder injected; passthrough cases from AC3 and AC6 unchanged; empty `tools: []` handled; `tool_choice` `auto`/`none` without `tools` injects; `tool_choice` `any`/`tool` without `tools` passes through unchanged.
8. AC8 (closure): After release, a live `/compact` on a Bedrock Claude model succeeds and the next user message in that session also succeeds. If the capture instead triggers the exit condition, AC2 to AC7 are replaced by a recorded diagnosis.
9. AC9 (record): The task directory keeps this spec's Assumptions and Risks as the root-cause record: rejecting layer is LiteLLM Bedrock Converse, the owning repo is `codemie`, `modify_params` did not cover the case for a cause to be determined, the guard is a temporary mitigation.

## Non-goals

- Fixing the chat-completions route used by codemie-code and OpenCode on Bedrock. Those users likely hit the same error and nothing here helps them. Owner: not decided; 13808 asks whether it covers that route and is unanswered. Recorded as open question Q2; a follow-up ticket is needed unless 13808 takes it.
- Changing backend `litellm_config.yaml` or LiteLLM (owned by `codemie`, EPMCDME-13808).
- OpenCode/Qwen3 compaction (EPMCDME-13136 path) and any `codemie-ui` / `codemie-sdk` changes.
- Changing how Claude Code builds its compaction request.
- Detecting `/compact` by prompt text or detecting Bedrock vs Vertex.
- Extending `logBedrockUpstreamError` to Claude aliases. Bedrock Claude failures stay poorly diagnosed without it; a follow-up ticket is suggested.
- Adding a Bedrock-only normalizer or any provider-specific branch.

## Decisions

- Capture and gateway outcome first, guard as conditional temporary mitigation over shipping the guard unconditionally: the root cause is unverified and may be covered by 13808.
- CLI-side guard (if shipped) over relying only on `modify_params`: the setting is present and did not prevent the failure, and the CLI fix is within this repo's reach.
- Request-shape rule over `/compact` detection: the analysis finds no stable compaction marker.
- Placeholder injected only when needed over always injecting `tools`: keeps ordinary requests byte-identical.
- Provider-agnostic rule over a Bedrock-only normalizer: the proxy has no provider field (A3).
- Inject for `tool_choice` absent/`auto`/`none`, pass through `any`/`tool` over leaving `tool_choice` as sent in all cases: a forced tool with a placeholder is wrong either way.
- Cover automatic compaction by the same rule over a separate path: same request shape (A4).
- Removal of the guard when 13808 lands over keeping it permanently: it is a workaround for a gateway defect.
- Placement (normalizer step vs new plugin) deferred to planning over fixing it here.
- Tests added for AC7 although AGENTS.md says tests only on request: the task explicitly requires them.

## Risks

- R1: Root cause unverified; handled by AC1 and the exit condition. A model may also answer a tool-enabled compaction call with a `tool_use` instead of a summary; the placeholder description forbids calling it, but this is untested with a placeholder-only list.
- R2: The 13808 outcome and deployed `modify_params` value are unknown; if 13808 lands first, this ticket may end as a diagnosis only.
- R3: LiteLLM acceptance of the placeholder and of `tool_choice: none`, and Vertex/direct paths' acceptance of the placeholder, are untested against live providers.
- R4: Re-serialization on the rewrite path alters body bytes and requires `content-length` reset (as in the existing normalizer); parse cost on large bodies is unmeasured, so a cheap pre-check before `JSON.parse` is a planning item.
- R5: If shipped, released clients carry the workaround after the gateway fix; the removal trigger depends on a follow-up ticket.
- Prompt-cache impact is not a risk: a tool-less compaction already misses the cache.

## Open questions (requester)

- Q1: Who captures the real `/compact` body, and in which environment?
- Q2: Does 16965 cover only Claude Code `/v1/messages` traffic, with 13808 or a new ticket owning the chat-completions route (codemie-code, OpenCode)?
