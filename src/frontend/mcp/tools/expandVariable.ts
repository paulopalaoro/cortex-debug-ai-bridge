import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dap from '../dapBridge';

export function registerExpandVariable(server: McpServer) {
    server.tool(
        'expand_variable',
        'Expands a structured variable (struct, array, pointer) to show its children. Use the variablesReference value from get_variables output. Returns 0 children if the variable is a primitive.',
        {
            variablesReference: z.number().int().min(1)
                .describe('The variablesReference number from a previous get_variables result')
        },
        async ({ variablesReference }) => {
            try {
                const children = await dap.expandVariable(variablesReference);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(children, null, 2) }]
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
