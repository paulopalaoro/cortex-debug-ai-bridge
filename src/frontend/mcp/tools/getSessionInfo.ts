import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as vscode from 'vscode';
import * as dap from '../dapBridge';

export function registerGetSessionInfo(server: McpServer) {
    server.tool(
        'get_session_info',
        'Returns information about the active debug session: session type, name, and whether the target is currently paused. Call this first to verify the debug session is ready.',
        {},
        async () => {
            const session = vscode.debug.activeDebugSession;
            if (!session) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            active: false,
                            message: 'No active debug session. Start a Cortex-Debug or PlatformIO debug session.'
                        }, null, 2)
                    }]
                };
            }

            const info: Record<string, unknown> = {
                active: true,
                sessionType: session.type,
                sessionName: session.name,
                sessionId: session.id,
                supported: dap.hasSession()
            };

            if (dap.hasSession()) {
                try {
                    const stack = await dap.getCallStack(1);
                    info.paused = stack.length > 0;
                    if (stack.length > 0) {
                        info.currentLocation = {
                            function: stack[0].name,
                            file: stack[0].source?.path ?? stack[0].source?.name ?? 'unknown',
                            line: stack[0].line
                        };
                    }
                } catch {
                    info.paused = false;
                    info.pausedMessage = 'Target may be running — pause it at a breakpoint to read state.';
                }
            }

            return {
                content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }]
            };
        }
    );
}
