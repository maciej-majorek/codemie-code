# Technical Research

**Task**: EPMCDME-16965 — Claude request normalizer / Bedrock `tools` / `/compact` / SSO proxy / `litellm.UnsupportedParamsError`
**Generated**: 2026-11-18 (product-owner run; adopted from the Jira attachment `sdlc-analysis-technical-analysis.md`, condensed on adoption; line numbers refer to codemie-code @ 608d79a1)
**Research path**: filesystem

---

## 1. Original Context

Bug (GitHub codemie-ai/codemie-code#283): `/compact` on a Bedrock-backed Claude model through `ai-run-sso` raises `litellm.UnsupportedParamsError: Bedrock doesn't support tool calling without 'tools=' param specified`; the session then fails every later message. Ticket claim: only Bedrock+compaction code is the diagnostic `logBedrockUpstreamError()` and no plugin injects/preserves `tools`.

---

## 2. Codebase Findings

### Repository Impact

| Repo | Verdict | Evidence |
|---|---|---|
| codemie-code | affected (named location) | `src/providers/plugins/sso/proxy/` holds normalizers and diagnostic |
| codemie | unknown (candidate origin) | `litellm_config.yaml:602` `modify_params: true` already set; backend relays body unchanged |
| codemie-ui | not_affected | no UnsupportedParams/modify_params//compact hits |
| codemie-sdk | not_affected | no request shaping hits |

### Existing Implementations

- Proxy path: `sso.proxy.ts:427-446` reads body into `context.requestBody`; plugins mutate; `:375` forwards as-is (retry `:652-655`). No `/compact` or summarization detection under `src/providers/plugins/sso/proxy`.
- `tools` is not dropped by the proxy. Only `codex-request-normalizer.plugin.ts:48,103` touches `tools`. `claude-request-normalizer.plugin.ts` touches only temperature/top_p/top_k, effort, thinking, model; `background-request-normalizer.plugin.ts:103-133` only `model` (rule `claude-code-title-gen`); `request-sanitizer.plugin.ts` strips reasoning params for codemie-code/opencode clients.
- Claude plugins registered in `plugins/index.ts` at priority 14, `clients = ['codemie-claude','codemie-copilot', CLAUDE_DESKTOP, VSCODE_CLAUDE_CODE]`. Normalizer pattern: `onRequest` parse JSON → edit → re-serialize → reset `content-length` only when changed (`claude-request-normalizer.plugin.ts:233-280`). Model capability decisions: regex table `MODEL_CAPABILITY_TABLE` (`:37-78`) keyed on requested model name; no provider field.
- `logBedrockUpstreamError` (`sso.proxy.ts:779-802`, called `:399-402` for status >= 400): diagnostic only; warns when model starts with `bedrock/` or includes `amazon`/`qwen`. Claude aliases (`claude-sonnet-5-5`, `claude-4-5-sonnet`) match none, so it does not fire for Claude. Introduced by a08abcc4 (EPMCDME-13136, #391).
- Prior fix for same error class (EPMCDME-13136, Qwen3 on OpenCode) chose the LiteLLM config layer (`modify_params: true`) plus CLI diagnostic only.
- Backend: `litellm_config.yaml:597-602` `litellm_settings: drop_params: true, modify_params: true` (commit 0847940cdc, EPMCDME-12762). LiteLLM image 1.99.4. LiteLLM Bedrock Converse source is not in the workspace. `proxy_router.py:657` forwards `/v1/messages` bytes unchanged (parsed only for attribution `:645-665`); no `tools`/`tool_choice` handling.

### Decisions Already in the Code

- Request-shaping convention: one plugin per client family, priority 14, `clients` allow-list, single regex capability table (EPMCDME-14035).
- Bedrock vs Vertex is invisible to the proxy: model names are CodeMie aliases; routing is decided in LiteLLM.
- Same error class already fixed at the LiteLLM layer (`modify_params`), CLI side kept diagnostic-only.
- Tests only on explicit request (AGENTS.md).

### Task Statements Checked Against the Code

| Statement | Verdict |
|---|---|
| `logBedrockUpstreamError()` diagnostic-only, never mutates body | holds |
| Located at ~752-770 | contradicted on line numbers only: now 779-802 |
| No plugin injects/preserves `tools` for Bedrock | holds for Claude (only Codex touches `tools`) |
| /compact request to Bedrock omits `tools` because plugins don't inject it | unverified as to cause: proxy has no code removing `tools`; client body shape not recorded anywhere |
| Error text from LiteLLM Bedrock Converse | holds as to source (same text in 12762 / 13136 docs) |
| /compact fails today on Bedrock Claude via ai-run-sso | unverified: `modify_params: true` already in checked-in config; deployed config, `/v1/messages` route behaviour or request shape unknown |
| Session permanently broken afterwards | unverified (Claude Code client behaviour) |
| Fix may live in claude-request-normalizer or a new Bedrock normalizer | keeps in place alternative: existing LiteLLM `modify_params` mechanism (global) |

### Consumers of Changed Contracts

- Later plugins reading `context.requestBody`: `RequestSanitizerPlugin` (p15), Codex/Copilot encrypted-content sanitizers (p16), LoggingPlugin, OTLP/session plugins, `logBedrockUpstreamError`. Upstream: `proxy_router.py`, LiteLLM.
- Shared `modify_params` consumed by all Bedrock Converse requests via the gateway; no CLI/UI consumers.
- `MODEL_CAPABILITY_TABLE`/`capabilitiesFor` consumed inside the normalizer file and its tests.

### Architecture and Layers Affected

codemie-code SSO proxy → plugin layer → upstream forward; backend: LiteLLM relay router → LiteLLM container configured by `litellm_config.yaml`.

### Integration Points

Claude Code client → local proxy → codemie backend `/v1/messages` relay → LiteLLM model entry → Bedrock. The `tools` requirement is enforced by LiteLLM's Bedrock transformation.

### Patterns and Conventions

`.js` import suffix, no `any` in new code, logging via `logger.debug`.

---

## 3. Documentation Findings

`.ai-run/guides/` present. `external-integrations.md` covers providers/LiteLLM/Bedrock but not `modify_params`. Prior task artifacts: `docs/superpowers/tasks/2026-06-24-epmcdme-13136-bedrock-qwen3-compaction/` (codemie-code) and `2026-08-10-epmcdme-12762-bedrock-modify-params/` (codemie). No ADR for request shaping at the proxy.

---

## 4. Testing Landscape

Existing: `plugins/__tests__/` — claude-request-normalizer (+effort), plugin-order, request-sanitizer, codex-request-normalizer (only suite with `tools` bodies); `proxy/__tests__/sso.proxy.*.test.ts`. No test references `logBedrockUpstreamError` or any Bedrock/compaction body for Claude. Pattern: Vitest, `@group unit`, `plugin.createInterceptor(ctx)` with a hand-built `ProxyContext`. Gaps: no captured `/compact` fixture, no Bedrock-specific request test, no proxy→backend→LiteLLM integration test.

---

## 5. Configuration and Environment

Env: `CODEMIE_DEBUG=true` for proxy logs; no env var controls `modify_params`. Config: `codemie:litellm_config.yaml` (`litellm_settings` :597-602), `docker-compose.yml:176` (LiteLLM 1.99.4). Deployed LiteLLM settings are outside the workspace.

---

## 6. Risk Indicators

- Root cause unverified: checked-in config already has `modify_params: true`; origin could be deployed config drift, LiteLLM behaviour on the Anthropic `/v1/messages` route, or a request shape (`tool_choice`/tool history) the setting does not cover. A CLI change before capturing the failing request may miss the cause.
- No code in the proxy removes `tools`; "where tools is dropped" has no code location.
- CLI cannot tell Bedrock from Vertex for shared aliases; any Bedrock-only rule has no field to key on. A `/compact` detection rule would rest on system-prompt heuristics (version-sensitive to Claude Code prompts).
- The LiteLLM `modify_params` mechanism has the same purpose and is global; adding a CLI mechanism duplicates it.
- `logBedrockUpstreamError` does not fire for Claude aliases, so Claude Bedrock failures give no CLI warning.
- No test coverage of the failing path at any layer.
- Any body rewrite re-serializes JSON and resets `content-length`; later plugins read the rewritten body.
- Ticket line numbers are stale.

---

## 7. Summary for Complexity Assessment

The named location is a single-file-per-plugin normalizer layer with a clear pattern, but the proxy has no `/compact` detection and no code touching `tools` for Claude. Backend relays bytes unchanged; error text comes from LiteLLM's Bedrock Converse transformation, whose source is outside the workspace. `litellm_config.yaml` already carries `modify_params: true`, so the cause of the current failure is unestablished. A CLI-side change would touch the proxy plugin layer plus registration (1-3 source files) and a new test file; no schema/migration/config surface. Novelty moderate: no Bedrock signal, no recorded request shape. Key risks: unverified root cause, no captured failing request, overlap with an existing global LiteLLM mechanism. codemie-ui and codemie-sdk not affected.

---

## 8. External References

None. a08abcc4 resolved in codemie-code (EPMCDME-13136, #391, 2026-06-24). LiteLLM `converse_transformation.py` not in the workspace.
