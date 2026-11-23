/**
 * Wiring of the placeholder-tools guard into the Claude request normalizer (EPMCDME-16965).
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { ClaudeRequestNormalizerPlugin } from '../claude-request-normalizer.plugin.js';
import { UNAVAILABLE_TOOL_PLACEHOLDER } from '../claude-tools-guard.js';
import { logger } from '../../../../../../utils/logger.js';
import type { PluginContext } from '../types.js';
import type { ProxyContext } from '../../proxy-types.js';

function pluginContext(clientType: string, model?: string): PluginContext {
  return {
    config: { targetApiUrl: 'https://api.anthropic.com', provider: 'test', sessionId: 's', clientType, model },
    logger,
  } as PluginContext;
}

function proxyContext(body: Record<string, unknown>, url = '/v1/messages'): ProxyContext {
  const requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
  return {
    requestId: 'r',
    sessionId: 's',
    agentName: 'a',
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'content-length': String(requestBody.length) },
    requestBody,
    requestStartTime: Date.now(),
    metadata: {},
  } as ProxyContext;
}

async function run(body: Record<string, unknown>, url?: string): Promise<{ ctx: ProxyContext; original: Buffer }> {
  const plugin = new ClaudeRequestNormalizerPlugin();
  const interceptor = await plugin.createInterceptor(pluginContext('codemie-claude', 'claude-sonnet-5-5'));
  const ctx = proxyContext(body, url);
  const original = ctx.requestBody!;
  await interceptor.onRequest(ctx);
  return { ctx, original };
}

const history = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
];

describe('ClaudeRequestNormalizer — placeholder tools guard', () => {
  it('adds a placeholder tool to a /compact-shaped body and resets content-length', async () => {
    const { ctx } = await run({ model: 'claude-sonnet-5-5', messages: history });
    const out = JSON.parse(ctx.requestBody!.toString('utf-8'));
    expect(out.tools).toEqual([UNAVAILABLE_TOOL_PLACEHOLDER]);
    expect(out.model).toBe('claude-sonnet-5-5');
    expect(ctx.headers['content-length']).toBe(String(ctx.requestBody!.length));
  });

  it('passes a request without history or tool_choice through byte-identically', async () => {
    const { ctx, original } = await run({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(Buffer.compare(ctx.requestBody!, original)).toBe(0);
    expect(ctx.headers['content-length']).toBe(String(original.length));
  });

  it('passes a request with non-empty tools through byte-identically', async () => {
    const tools = [{ name: 'a', description: 'd', input_schema: { type: 'object', properties: {} } }];
    const { ctx, original } = await run({ model: 'claude-sonnet-5-5', tools, messages: history });
    expect(Buffer.compare(ctx.requestBody!, original)).toBe(0);
  });

  it('passes tool_choice any without tools through unchanged', async () => {
    const { ctx, original } = await run({ model: 'claude-sonnet-5-5', tool_choice: { type: 'any' }, messages: history });
    expect(Buffer.compare(ctx.requestBody!, original)).toBe(0);
  });

  it('leaves non-/v1/messages URLs untouched', async () => {
    const { ctx, original } = await run({ model: 'claude-sonnet-5-5', messages: history }, '/v1/chat/completions');
    expect(Buffer.compare(ctx.requestBody!, original)).toBe(0);
  });

  it('applies to /v1/messages URLs with a query string', async () => {
    const { ctx } = await run({ model: 'claude-sonnet-5-5', messages: history }, '/v1/messages?beta=true');
    expect(JSON.parse(ctx.requestBody!.toString('utf-8')).tools).toEqual([UNAVAILABLE_TOOL_PLACEHOLDER]);
  });

  it('still guards a /v1/messages body when no model is requested or configured', async () => {
    const plugin = new ClaudeRequestNormalizerPlugin();
    const interceptor = await plugin.createInterceptor(pluginContext('codemie-claude'));
    const ctx = proxyContext({ messages: history });
    await interceptor.onRequest(ctx);
    expect(JSON.parse(ctx.requestBody!.toString('utf-8')).tools).toEqual([UNAVAILABLE_TOOL_PLACEHOLDER]);
  });

  it('is not registered for codemie-code or codex clients', () => {
    const plugin = new ClaudeRequestNormalizerPlugin();
    expect(plugin.clients).not.toContain('codemie-code');
    expect(plugin.clients).not.toContain('codex');
  });

  it('exposes the rewritten body via context.requestBody for retries and later plugins', async () => {
    const { ctx, original } = await run({ model: 'claude-sonnet-5-5', messages: history });
    expect(Buffer.compare(ctx.requestBody!, original)).not.toBe(0);
    expect(JSON.parse(ctx.requestBody!.toString('utf-8')).tools).toHaveLength(1);
  });
});
