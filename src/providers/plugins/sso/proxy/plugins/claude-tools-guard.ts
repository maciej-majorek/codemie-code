/**
 * Temporary mitigation (EPMCDME-16965): LiteLLM Bedrock Converse rejects a request
 * that carries tool_use/tool_result history (or tool_choice auto/none) but no
 * `tools`. Claude Code's /compact sends exactly that shape. We add a placeholder
 * tool so the request is accepted. Remove when EPMCDME-13808 lands.
 */

import { logger } from '../../../../../utils/logger.js';

export const UNAVAILABLE_TOOL_PLACEHOLDER: {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, never> };
} = {
  name: 'unavailable_tool_placeholder',
  description: 'This tool is unavailable and must never be called. It exists only to satisfy API validation.',
  input_schema: { type: 'object', properties: {} },
};

export interface ToolShapeSummary {
  hasTools: boolean;
  toolCount: number;
  hasToolHistory: boolean;
  toolChoice: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasToolHistory(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some(
    (message) =>
      isRecord(message) &&
      Array.isArray(message.content) &&
      message.content.some(
        (block) => isRecord(block) && (block.type === 'tool_use' || block.type === 'tool_result')
      )
  );
}

function toolChoiceType(body: Record<string, unknown>): string | null {
  const choice = body.tool_choice;
  return isRecord(choice) && typeof choice.type === 'string' ? choice.type : null;
}

/** Body-free shape summary: counts and tool_choice type only, never message content. */
export function summarizeToolShape(body: Record<string, unknown>): ToolShapeSummary {
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  return {
    hasTools: toolCount > 0,
    toolCount,
    hasToolHistory: hasToolHistory(body),
    toolChoice: toolChoiceType(body),
  };
}

/** Injects the placeholder tool when needed. Returns true only when the body was mutated. */
export function ensureToolsForToolHistory(body: Record<string, unknown>): boolean {
  const shape = summarizeToolShape(body);
  if (shape.hasTools) return false;

  if (shape.toolChoice === 'any' || shape.toolChoice === 'tool') {
    logger.debug('[claude-tools-guard] tool_choice requires a tool but none present; passing through', shape);
    return false;
  }

  if (!shape.hasToolHistory && shape.toolChoice !== 'auto' && shape.toolChoice !== 'none') {
    return false;
  }

  body.tools = [UNAVAILABLE_TOOL_PLACEHOLDER];
  logger.debug('[claude-tools-guard] Injected placeholder tool', shape);
  return true;
}
