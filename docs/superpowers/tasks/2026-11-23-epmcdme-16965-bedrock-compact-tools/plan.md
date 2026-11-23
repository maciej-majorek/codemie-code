# EPMCDME-16965 Plan: placeholder `tools` guard for Claude requests with tool history

**Goal:** a Claude-client `/v1/messages` request that carries tool history (or `tool_choice` auto/none) but no usable `tools` leaves the proxy with a placeholder tool, so LiteLLM Bedrock Converse stops rejecting it. Temporary mitigation (removal when EPMCDME-13808 lands).

**Conventions:** ES modules, `.js` import suffix, no `any`, `logger.debug` only. Commit per task using the repository's existing convention.

**Planning decisions (deferred by spec):**
- Placement: a step inside `ClaudeRequestNormalizerInterceptor.onRequest` (`claude-request-normalizer.plugin.ts:233-280`), not a new plugin. It reuses the existing parse, the `clients` allow-list (`:191`, priority 14) and the `content-length` reset. The logic lives in a pure helper module so it is unit-testable and removable in one edit. Path gate: `context.url` must be `/v1/messages` (query string allowed). The normalizer already parses every JSON body, so a pre-`JSON.parse` string check saves nothing and is dropped (R4).
- 401 retry: confirmed. `sso-session-expiry.plugin.ts:301` calls `tools.retry(context.requestBody)` and `sso.proxy.ts:652-656` re-sends `context.headers`. Both are the post-`onRequest` values, so the rewritten body and the reset `content-length` are re-sent. No code change. Task 2 tests it.
- Placeholder: one exported constant `UNAVAILABLE_TOOL_PLACEHOLDER` in the helper module.

## Task 1: Guard helper and shape-summary log
**Files:** create `src/providers/plugins/sso/proxy/plugins/claude-tools-guard.ts`.
- Export `UNAVAILABLE_TOOL_PLACEHOLDER: { name; description; input_schema: { type: 'object'; properties: {} } }`. The description says the tool is unavailable and must never be called.
- Export `summarizeToolShape(body): { hasTools; toolCount; hasToolHistory; toolChoice: string | null }`. It is body-free: no content, only counts and the `tool_choice.type`.
- Export `ensureToolsForToolHistory(body: Record<string, unknown>): boolean`. It returns true only when it mutated the body.
  - Inject `[PLACEHOLDER]` when `tools` is missing or an empty array AND (some `messages[].content` array has a block of type `tool_use` or `tool_result`, OR `tool_choice.type` is `auto` or `none`).
  - When `tool_choice.type` is `any` or `tool` and `tools` is missing or empty: no change, `logger.debug` the pass-through.
  - When `tools` is non-empty, or there is no tool history and no `tool_choice`: no change.
  - `logger.debug` on injection (shape only). Never touch `model`, `tool_choice` or other fields.
- Test-first: yes — a new `claude-tools-guard.test.ts` calls `ensureToolsForToolHistory` with `{messages:[{role:'user',content:[{type:'tool_result',...}]}]}`. It expects `true` and `tools` equal to `[UNAVAILABLE_TOOL_PLACEHOLDER]`. It fails until the module exists.
- Add cases for `tools: []`, `tool_choice` auto/none without `tools`, `any`/`tool` without `tools` (unchanged), non-empty `tools` (unchanged), and no history/no `tool_choice` (unchanged). Also add a `summarizeToolShape` case that checks the output has no message text.

## Task 2: Wire the guard into the Claude normalizer
**Files:** modify `claude-request-normalizer.plugin.ts:233-280`; create `__tests__/claude-request-normalizer.tools-guard.test.ts` (copy the `pluginContext`/`proxyContext`/`run` harness from `__tests__/claude-request-normalizer.effort.test.ts:14-42`).
- In `onRequest`, after `handleThinkingField` (`:257`) and before the model-resolution block, run the step only when the URL path is `/v1/messages`. Call `logger.debug` with `summarizeToolShape(body)` (AC1), then `ensureToolsForToolHistory(body)`. Add its result as `modifiedByTools` to the OR at `:272`. Keep the existing rewrite and `content-length` reset.
- Test-first: yes — through `createInterceptor(ctx).onRequest`, a `/compact`-shaped body (tool history, no `tools`, model `claude-sonnet-5-5`) must end with a non-empty `tools`, the unchanged `model`, and `content-length` equal to the new body length. It fails before wiring.
- Add cases:
  - Passthrough is byte-identical (`Buffer.equals` with the original, `content-length` unchanged) for: no history and no `tool_choice`; non-empty `tools`.
  - Passthrough for `tool_choice: {type:'any'}` without `tools`.
  - Non-`/v1/messages` URL (e.g. `/v1/chat/completions`) is untouched.
  - A plugin with `clientType` `codemie-code` or `codex` is not in `clients` (assert `plugin.clients` excludes them).
  - A rewritten body is what `context.requestBody` holds, which the 401 retry (`sso-session-expiry.plugin.ts:301`) re-sends.
  - A later plugin (RequestSanitizer p15) reads the rewritten body. Assert only the shared `context.requestBody` here, with no extra plugin wiring.

## Not tasks (human steps, outside this list)
- AC1/AC8: capture one real `/compact` body (`CODEMIE_DEBUG=true`, shape only), read the 13808 outcome, and run a live Bedrock `/compact` plus the next message. If the capture shows `tools` already present, or another route, apply the spec's exit condition and do not ship this guard. Q1 and Q2 stay with the requester.
- AC9: the spec's Assumptions and Risks stay as the root-cause record.

## Negative-constraint pass
- No `/compact` or prompt-text detection, no Bedrock/Vertex branch: Tasks 1 and 2 key on body shape only.
- No inject on `tool_choice` any/tool: Task 1 passthrough and tests.
- Non-Claude clients and other paths untouched: Task 2 gate and tests.
- No backend, `logBedrockUpstreamError`, or Claude-builds-request changes: no task touches them.
- Ordinary requests byte-identical: only the existing modified-flag rewrite path is used.
