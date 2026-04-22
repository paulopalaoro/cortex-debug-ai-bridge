import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dap from '../dapBridge';

export function registerGetVariables(server: McpServer) {
    server.tool(
        'get_variables',
        'Returns all local variables, function arguments, and static/global variables visible in the given stack frame. Variables are grouped by scope (Locals, Globals, Static, Registers). Requires the target to be paused.',
        {
            frameIndex: z.number().int().min(0).optional()
                .describe('Stack frame index — 0 is the topmost (current) frame (default: 0)')
        },
        async ({ frameIndex = 0 }) => {
            try {
                const stack = await dap.getCallStack();
                if (!stack.length) {
                    return {
                        content: [{ type: 'text' as const, text: 'Error: Call stack is empty. Is the target paused?' }],
                        isError: true
                    };
                }

                const frame = stack[frameIndex];
                if (!frame) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: `Error: No frame at index ${frameIndex}. Stack has ${stack.length} frames.`
                        }],
                        isError: true
                    };
                }

                const vars = await dap.getVariables(frameIndex);
                const output = {
                    frame: {
                        index: frameIndex,
                        function: frame.name,
                        file: frame.source?.path ?? frame.source?.name ?? 'unknown',
                        line: frame.line
                    },
                    scopes: vars
                };

                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }]
                };
            } catch (e: unknown) {
                return {
                    content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }],
                    isError: true
                };
            }
        }
    );
}
