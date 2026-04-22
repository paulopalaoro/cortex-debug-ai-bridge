import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dap from '../dapBridge';

export function registerRemoveBreakpoint(server: McpServer) {
    server.tool(
        'remove_breakpoint',
        'Removes a breakpoint previously set at a specific file and line. '
    + 'Use clear_all=true to remove all breakpoints in the file (or all files if no path given).',
        {
            file: z.string().optional()
                .describe('Absolute path to the source file. Required unless clear_all=true with no file.'),
            line: z.number().int().min(1).optional()
                .describe('Line number to remove (1-based). Omit when using clear_all=true.'),
            clear_all: z.boolean().optional()
                .describe('If true, removes all breakpoints in the file (or all files if no file given).')
        },
        async ({ file, line, clear_all }) => {
            try {
                if (clear_all) {
                    await dap.clearBreakpoints(file);
                    const msg = file
                        ? `All breakpoints removed from ${file}.`
                        : 'All breakpoints removed from all files.';
                    return { content: [{ type: 'text' as const, text: msg }] };
                }

                if (!file) {
                    return {
                        content: [{ type: 'text' as const, text: 'Error: file is required when clear_all is not set.' }],
                        isError: true
                    };
                }
                if (!line) {
                    return {
                        content: [{ type: 'text' as const, text: 'Error: line is required when clear_all is not set.' }],
                        isError: true
                    };
                }

                const result = await dap.removeBreakpoint(file, line);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ removed: { file, line }, result }, null, 2)
                    }]
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
