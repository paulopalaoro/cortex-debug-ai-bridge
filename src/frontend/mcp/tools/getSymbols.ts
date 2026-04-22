import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ── nm binary candidates ───────────────────────────────────────────────────────

const NM_CANDIDATES = [
    // PlatformIO toolchain (most common for embedded)
    'C:/Users/paulo/.platformio/packages/toolchain-gccarmnoneeabi/bin/arm-none-eabi-nm.exe',
    // ARM GNU Toolchain system install
    'C:/Program Files (x86)/Arm GNU Toolchain arm-none-eabi/11.3 rel1/bin/arm-none-eabi-nm.exe',
    'C:/Program Files/Arm GNU Toolchain arm-none-eabi/11.3 rel1/bin/arm-none-eabi-nm.exe',
    // System PATH fallback
    'arm-none-eabi-nm',
    'nm',
];

function findNm(): string | undefined {
    for (const candidate of NM_CANDIDATES) {
        if (!path.isAbsolute(candidate)) return candidate; // let shell resolve
        if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

// ── ELF file discovery ────────────────────────────────────────────────────────

async function findElf(explicitPath?: string): Promise<string | undefined> {
    if (explicitPath) {
        return fs.existsSync(explicitPath) ? explicitPath : undefined;
    }

    // Try to get from active debug session configuration
    const session = vscode.debug.activeDebugSession;
    if (session) {
        const cfg = session.configuration;
        const exe: string | undefined
      = cfg['executable'] ?? cfg['program'] ?? cfg['elfPath'];
        if (exe && fs.existsSync(exe)) return exe;
    }

    // Search workspace for *.elf files
    const elfFiles = await vscode.workspace.findFiles('**/*.elf', '**/node_modules/**', 5);
    if (elfFiles.length > 0) {
    // Prefer build/firmware.elf patterns
        const preferred = elfFiles.find((f) =>
            f.fsPath.includes('firmware.elf') || f.fsPath.includes('build')
        );
        return (preferred ?? elfFiles[0]).fsPath;
    }

    return undefined;
}

// ── nm output parser ──────────────────────────────────────────────────────────

interface Symbol {
    address: string;
    size?: string;
    type: string;
    name: string;
    section: 'ram' | 'flash' | 'other';
}

// nm output line: "20000218 00000004 B roll" or "20000218 B roll"
function parseNmOutput(output: string): Symbol[] {
    const symbols: Symbol[] = [];
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parts = trimmed.split(/\s+/);
        let address: string, size: string | undefined, type: string, name: string;

        if (parts.length >= 4) {
            [address, size, type, name] = parts;
        } else if (parts.length === 3) {
            [address, type, name] = parts;
        } else {
            continue;
        }

        if (!/^[0-9a-f]+$/i.test(address)) continue;

        const addrNum = parseInt(address, 16);
        let section: Symbol['section'] = 'other';
        if (addrNum >= 0x20000000 && addrNum < 0x30000000) section = 'ram';
        else if (addrNum >= 0x08000000 && addrNum < 0x10000000) section = 'flash';

        symbols.push({ address: `0x${address.toLowerCase()}`, size, type, name, section });
    }
    return symbols;
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerGetSymbols(server: McpServer) {
    server.tool(
        'get_symbols',
        'Reads the firmware ELF file and returns the symbol table — all global variables with their RAM addresses, sizes, and types. '
    + 'Use this to discover variable addresses automatically before calling read_live_memory. '
    + 'Works without pausing the target. Finds the ELF file automatically from the active debug session or workspace.',
        {
            elfPath: z.string().optional()
                .describe('Explicit path to the .elf file. If omitted, auto-detected from the debug session or workspace.'),
            filter: z.string().optional()
                .describe('Optional name filter (case-insensitive substring match). E.g. "pitch" to find pitch-related symbols.'),
            section: z.enum(['ram', 'flash', 'all']).optional()
                .describe('"ram" = global variables (default), "flash" = functions/const, "all" = everything')
        },
        async ({ elfPath, filter, section = 'ram' }) => {
            try {
                // Find ELF
                const elf = await findElf(elfPath);
                if (!elf) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: 'Error: Could not find a .elf file. Start a debug session or provide elfPath explicitly.'
                        }],
                        isError: true
                    };
                }

                // Find nm binary
                const nm = findNm();
                if (!nm) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: 'Error: arm-none-eabi-nm not found. Install ARM GNU Toolchain or PlatformIO.'
                        }],
                        isError: true
                    };
                }

                // Run nm
                const output = await new Promise<string>((resolve, reject) => {
                    cp.execFile(
                        nm,
                        ['--defined-only', '-S', '-p', elf],
                        { timeout: 10000 },
                        (err, stdout, stderr) => {
                            if (err && !stdout) reject(new Error(stderr || err.message));
                            else resolve(stdout);
                        }
                    );
                });

                // Parse and filter
                let symbols = parseNmOutput(output);

                if (section !== 'all') {
                    symbols = symbols.filter((s) => s.section === section);
                }

                if (filter) {
                    const f = filter.toLowerCase();
                    symbols = symbols.filter((s) => s.name.toLowerCase().includes(f));
                }

                // Sort by address
                symbols.sort((a, b) =>
                    parseInt(a.address, 16) - parseInt(b.address, 16)
                );

                const output_obj = {
                    elfFile: elf,
                    nmBinary: nm,
                    symbolCount: symbols.length,
                    section,
                    filter: filter ?? null,
                    symbols: symbols.map((s) => ({
                        name: s.name,
                        address: s.address,
                        size: s.size ? parseInt(s.size, 16) : undefined,
                        type: s.type,
                    }))
                };

                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(output_obj, null, 2) }]
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
