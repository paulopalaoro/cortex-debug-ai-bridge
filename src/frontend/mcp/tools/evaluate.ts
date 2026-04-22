import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as dap from '../dapBridge';

export function registerEvaluate(server: McpServer) {
    server.tool(
        'evaluate',
        'Evaluates a C/C++ expression in the context of the current stack frame. Supports any valid GDB watch expression: variables, struct members, pointer dereferences, array indexing, casts, address-of (&), sizeof, etc. Examples: "pitch", "rxBuf[0]", "(float)adc_val / 4095.0 * 3.3", "&rxBuf[0]". Requires a paused target.',
        {
            expression: z.string().min(1)
                .describe('C/C++ expression to evaluate (GDB watch syntax)'),
            frameIndex: z.number().int().min(0).optional()
                .describe('Stack frame index — 0 is topmost (default: 0)')
        },
        async ({ expression, frameIndex = 0 }) => {
            try {
                const result = await dap.evaluate(expression, frameIndex);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            expression,
                            result: result.result,
                            type: result.type ?? 'unknown',
                            hasChildren: result.variablesReference > 0,
                            variablesReference: result.variablesReference
                        }, null, 2)
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
