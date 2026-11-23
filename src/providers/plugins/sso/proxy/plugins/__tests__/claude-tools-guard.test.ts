/**
 * Placeholder-tools guard for Claude requests carrying tool history (EPMCDME-16965).
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import {
  UNAVAILABLE_TOOL_PLACEHOLDER,
  ensureToolsForToolHistory,
  summarizeToolShape,
} from '../claude-tools-guard.js';

const toolResultMessages = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'secret text' }] },
];

describe('ensureToolsForToolHistory', () => {
  it('injects the placeholder when tool history exists and tools is missing', () => {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] }],
    };
    expect(ensureToolsForToolHistory(body)).toBe(true);
    expect(body.tools).toEqual([UNAVAILABLE_TOOL_PLACEHOLDER]);
  });

  it('injects when tools is an empty array', () => {
    const body: Record<string, unknown> = { tools: [], messages: toolResultMessages };
    expect(ensureToolsForToolHistory(body)).toBe(true);
    expect(body.tools).toEqual([UNAVAILABLE_TOOL_PLACEHOLDER]);
  });

  it.each(['auto', 'none'])('injects for tool_choice %s without tools', (type) => {
    const body: Record<string, unknown> = { tool_choice: { type }, messages: [{ role: 'user', content: 'hi' }] };
    expect(ensureToolsForToolHistory(body)).toBe(true);
    expect(body.tools).toEqual([UNAVAILABLE_TOOL_PLACEHOLDER]);
    expect(body.tool_choice).toEqual({ type });
  });

  it.each(['any', 'tool'])('does not inject for tool_choice %s without tools', (type) => {
    const body: Record<string, unknown> = { tool_choice: { type }, messages: toolResultMessages };
    expect(ensureToolsForToolHistory(body)).toBe(false);
    expect(body.tools).toBeUndefined();
  });

  it('leaves non-empty tools unchanged', () => {
    const tools = [{ name: 'a', description: 'd', input_schema: { type: 'object', properties: {} } }];
    const body: Record<string, unknown> = { tools, messages: toolResultMessages };
    expect(ensureToolsForToolHistory(body)).toBe(false);
    expect(body.tools).toBe(tools);
  });

  it('leaves a request with no history and no tool_choice unchanged', () => {
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hi' }] };
    expect(ensureToolsForToolHistory(body)).toBe(false);
    expect(body.tools).toBeUndefined();
  });
});

describe('summarizeToolShape', () => {
  it('reports counts and tool_choice type without message text', () => {
    const summary = summarizeToolShape({ tool_choice: { type: 'auto' }, messages: toolResultMessages });
    expect(summary).toEqual({ hasTools: false, toolCount: 0, hasToolHistory: true, toolChoice: 'auto' });
    expect(JSON.stringify(summary)).not.toContain('secret text');
  });
});
