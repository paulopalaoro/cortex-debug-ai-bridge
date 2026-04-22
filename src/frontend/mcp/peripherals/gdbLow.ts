/**
 * GDB-MI based replacement for openocdLow.ts.
 *
 * OpenOCD itself is still started by the existing OpenOcdManager. This module
 * only spawns the `arm-none-eabi-gdb` process and connects it to that OpenOCD
 * instance on the gdb-remote port (default 50003 as configured in
 * openocdManager.ts). Every mdw/mww/mmw goes through `monitor <cmd>` over the
 * persistent GDB stdin/stdout — no telnet churn, no "Bad file descriptor".
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { MI2, MIResult } from '../backend/mi2';
import * as logger from '../logger';

const OPENOCD_GDB_PORT = 50003;  // must match openocdManager.ts

/** Event bus — extension code can listen for backend log lines. */
import { EventEmitter } from 'events';
export const gdbEvents = new EventEmitter();

class GdbBackend {
    private gdb: MI2 | null = null;
    private startPromise: Promise<void> | null = null;

    private resolveGdbPath(): string {
        const home = os.homedir();
        const pkgsDir = path.join(home, '.platformio', 'packages');
        const gdbBin = process.platform === 'win32' ? 'arm-none-eabi-gdb.exe' : 'arm-none-eabi-gdb';

        // PlatformIO installs the toolchain as either:
        //   toolchain-gccarmnoneeabi/            (non-versioned)
        //   toolchain-gccarmnoneeabi@1.70201.0/  (versioned — common on newer PIO)
        // We pick whichever directory actually contains the gdb binary, preferring
        // a versioned one when present.
        const candidates: string[] = [];
        try {
            const entries = fs.readdirSync(pkgsDir, { withFileTypes: true });
            for (const e of entries) {
                if (e.isDirectory() && e.name.startsWith('toolchain-gccarmnoneeabi')) {
                    const p = path.join(pkgsDir, e.name, 'bin', gdbBin);
                    if (fs.existsSync(p)) candidates.push(p);
                }
            }
        } catch (err) {
            logger.debug(`resolveGdbPath: could not read ${pkgsDir}: ${(err as Error).message}`);
        }
        if (candidates.length === 0) {
            // Fallback to the non-versioned guess — will error downstream with a clear message.
            return path.join(pkgsDir, 'toolchain-gccarmnoneeabi', 'bin', gdbBin);
        }
        // Prefer versioned (longest name) entries.
        candidates.sort((a, b) => b.length - a.length);
        logger.debug(`resolveGdbPath: using ${candidates[0]}`);
        return candidates[0];
    }

    async ensureStarted(): Promise<void> {
    // Check startPromise FIRST — while it's pending, this.gdb may already be
    // assigned (local to the async IIFE) but MI2 isn't ready yet. Parallel
    // callers must wait for the same promise, not early-return.
        if (this.startPromise) return this.startPromise;
        if (this.gdb) return;
        this.startPromise = (async () => {
            const gdbPath = this.resolveGdbPath();

            const gdb = new MI2();
            try {
                await gdb.start(gdbPath);
                await gdb.send('-gdb-set mi-async on');
                await gdb.send('-gdb-set pagination off');
                // Connect to the OpenOCD gdb-remote port spawned by OpenOcdManager.
                await gdb.send(`-target-select extended-remote localhost:${OPENOCD_GDB_PORT}`, 15_000);
            } catch (err) {
                // Full cleanup so the next call retries from scratch.
                try { await gdb.stop(); } catch (_) { /* ignore */ }
                throw err;
            }
            gdb.on('exit', () => {
                gdbEvents.emit('log', '[gdb] gdb exited');
                this.gdb = null;
            });
            // Publish only after gdb is fully initialised and talking to the target.
            this.gdb = gdb;
            logger.info(`GdbBackend: gdb ready (remote :${OPENOCD_GDB_PORT})`);
        })();
        try {
            await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    async shutdown(): Promise<void> {
        try { if (this.gdb) await this.gdb.stop(); } catch (_) { /* ignore */ }
        this.gdb = null;
    }

    /** Run an OpenOCD command via `monitor <cmd>`. Returns the captured output. */
    async monitor(cmd: string, timeoutMs = 8000): Promise<string> {
        await this.ensureStarted();
        if (!this.gdb) throw new Error('gdb not running');
        const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const res: MIResult = await this.gdb.send(`-interpreter-exec console "monitor ${escaped}"`, timeoutMs);
        return res.output.join('');
    }

    isStarted(): boolean {
        return !!this.gdb;
    }
}

const backend = new GdbBackend();

/** Called by the extension when the server command is explicitly stopped. */
export async function gdbLowShutdown(): Promise<void> {
    await backend.shutdown();
}

/** Called by legacy code expecting an OpenOCD-like reset hook. */
export function openocdResetConnection(): void {
    // No-op with this backend — the gdb channel is persistent and self-healing.
}

// ─── Compat API (mirrors openocdLow.ts) ────────────────────────────────────

export async function openocdBatch(commands: string[], timeoutMs = 8000): Promise<string[]> {
    const responses: string[] = [];
    for (const cmd of commands) {
        responses.push(await backend.monitor(cmd, timeoutMs));
    }
    return responses;
}

export async function openocdSend(cmd: string, timeoutMs = 8000): Promise<string> {
    return backend.monitor(cmd, timeoutMs);
}

export async function mww(address: number | string, value: number | string): Promise<void> {
    await backend.monitor(`mww ${addrHex(address)} ${valHex(value)}`);
}

export async function mwb(address: number | string, value: number | string): Promise<void> {
    await backend.monitor(`mwb ${addrHex(address)} ${valHex(value)}`);
}

export async function mdw(address: number | string, count = 1): Promise<string[]> {
    const response = await backend.monitor(`mdw ${addrHex(address)} ${count}`);
    const words: string[] = [];
    for (const line of response.split(/\r?\n/)) {
        const m = line.match(/0x[0-9a-f]+:\s+([\da-f\s]+)/i);
        if (m) words.push(...m[1].trim().split(/\s+/).filter(Boolean));
    }
    return words;
}

export async function mdwOne(address: number | string): Promise<number> {
    const words = await mdw(address, 1);
    return words.length > 0 ? (parseInt(words[0], 16) >>> 0) : 0;
}

export async function mdb(address: number | string, count = 1): Promise<number[]> {
    const response = await backend.monitor(`mdb ${addrHex(address)} ${count}`);
    const bytes: number[] = [];
    for (const line of response.split(/\r?\n/)) {
        const m = line.match(/0x[0-9a-f]+:\s+([\da-f\s]+)/i);
        if (m) bytes.push(...m[1].trim().split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16)));
    }
    return bytes;
}

/**
 * Atomic bit set/clear via OpenOCD's `mmw`. Single monitor call through
 * the persistent GDB connection — no race, no connection churn.
 */
export async function setBits(
    address: number | string,
    mask: number,
    value: number
): Promise<number> {
    const addr = addrHex(address);
    const setBitsVal = (value & mask) >>> 0;
    const clearBitsVal = (mask & ~value) >>> 0;
    await backend.monitor(
        `mmw ${addr} 0x${setBitsVal.toString(16)} 0x${clearBitsVal.toString(16)}`
    );
    return 0;
}

export async function openocdSleep(ms: number): Promise<void> {
    await backend.monitor(`sleep ${ms}`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function addrHex(v: number | string): string {
    return typeof v === 'number' ? `0x${v.toString(16).padStart(8, '0')}` : v;
}

function valHex(v: number | string): string {
    if (typeof v === 'number') return `0x${(v >>> 0).toString(16)}`;
    return v;
}
