/**
 * Low-level OpenOCD telnet client with a PERSISTENT connection.
 * A single TCP connection is reused across all calls; each request is
 * serialised via a command queue. This avoids the "first command response
 * lost", "Bad file descriptor" and connection-churn problems that plagued
 * the previous one-connection-per-call design.
 */

import * as net from 'net';
import * as logger from '../logger';

const OPENOCD_TELNET_PORT = 50002;
const DEFAULT_TIMEOUT_MS = 8000;

interface QueuedCmd {
    commands: string[];
    resolve: (r: string[]) => void;
    reject: (e: Error) => void;
    timeoutMs: number;
}

class OpenOcdTelnet {
    private sock: net.Socket | null = null;
    private connecting = false;
    private ready = false;
    private buf = '';
    private queue: QueuedCmd[] = [];
    private current: QueuedCmd | null = null;
    private cmdIndex = 0;
    private responses: string[] = [];
    private currentTimer: NodeJS.Timeout | null = null;

    /** Submit a batch and get back the per-command responses. */
    send(commands: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string[]> {
        return new Promise((resolve, reject) => {
            this.queue.push({ commands, resolve, reject, timeoutMs });
            this.pump();
        });
    }

    /** Force-close the connection; next send() reopens it. */
    close(): void {
        if (this.sock) {
            try { this.sock.destroy(); } catch (_) { /* ignore */ }
        }
        this.sock = null;
        this.ready = false;
        this.connecting = false;
        this.buf = '';
        this.current = null;
        this.cmdIndex = 0;
        this.responses = [];
        if (this.currentTimer) { clearTimeout(this.currentTimer); this.currentTimer = null; }
    }

    private pump(): void {
        if (this.current) return;                  // already processing one
        if (!this.ready) { this.ensureConnected(); return; }
        const next = this.queue.shift();
        if (!next) return;
        this.current = next;
        this.cmdIndex = 0;
        this.responses = [];
        this.currentTimer = setTimeout(() => {
            const c = this.current;
            if (!c) return;
            this.current = null;
            this.close();                             // connection is in unknown state
            c.reject(new Error(`OpenOCD telnet timeout after ${c.timeoutMs}ms`));
            this.pump();
        }, next.timeoutMs);
        this.sendNextCmd();
    }

    private ensureConnected(): void {
        if (this.sock || this.connecting) return;
        this.connecting = true;
        this.buf = '';
        const sock = net.createConnection(OPENOCD_TELNET_PORT, 'localhost');
        this.sock = sock;

        sock.on('data', (data: Buffer) => this.onData(data));
        sock.on('error', (err: Error) => this.onSocketError(err));
        sock.on('close', () => this.onSocketClose());
        sock.on('connect', () => logger.debug('openocd telnet: connected'));
    }

    private onData(data: Buffer): void {
        this.buf += data.toString('latin1').replace(/\x00/g, '');
        if (!this.ready) {
            if (this.buf.includes('> ')) {
                this.ready = true;
                this.connecting = false;
                this.buf = '';
                this.pump();
            }
            return;
        }
        // Ready — parse per-command responses delimited by the prompt `> `.
        while (this.current && this.buf.includes('> ')) {
            const idx = this.buf.indexOf('> ');
            const responseText = this.buf.slice(0, idx).trim();
            this.buf = this.buf.slice(idx + 2);

            // OpenOCD emits asynchronous logs (e.g. "accepting telnet connection", "target halted"
            // when idle) by sending `\b\b  \b\b` to erase the current prompt, printing the log,
            // and re-sending `> `. We must ignore these fake prompts.
            if (responseText.startsWith('\x08')) {
                logger.debug(`openocd telnet: skipping out-of-band log: ${JSON.stringify(responseText)}`);
                continue;
            }

            // Strip the command echo (first line matching what we sent)
            const cmd = this.current.commands[this.cmdIndex];
            const cleaned = this.stripEcho(responseText, cmd);
            this.responses[this.cmdIndex] = cleaned;
            this.cmdIndex++;
            if (this.cmdIndex < this.current.commands.length) {
                this.writeCurrent();
            } else {
                this.finishCurrent();
            }
        }
    }

    private stripEcho(resp: string, cmd: string): string {
        if (!cmd) return resp;
        const lines = resp.split(/\r?\n/);
        if (lines[0] === cmd) lines.shift();
        return lines.join('\n');
    }

    private onSocketError(err: Error): void {
        logger.debug(`openocd telnet error: ${err.message}`);
        const c = this.current;
        this.close();
        if (c) c.reject(new Error(`OpenOCD telnet error: ${err.message}`));
        this.pump();
    }

    private onSocketClose(): void {
        const c = this.current;
        this.sock = null;
        this.ready = false;
        this.connecting = false;
        if (c) {
            this.current = null;
            if (this.currentTimer) { clearTimeout(this.currentTimer); this.currentTimer = null; }
            c.reject(new Error('OpenOCD telnet closed mid-command'));
        }
        this.pump();
    }

    private sendNextCmd(): void {
        if (!this.current || !this.sock) return;
        const cmd = this.current.commands[this.cmdIndex];
        logger.debug(`openocd cmd[${this.cmdIndex}]: "${cmd}"`);
        this.writeCurrent(cmd);
    }

    private writeCurrent(explicit?: string): void {
        if (!this.current || !this.sock) return;
        const cmd = explicit ?? this.current.commands[this.cmdIndex];
        this.sock.write(cmd + '\n');
    }

    private finishCurrent(): void {
        const c = this.current;
        if (!c) return;
        if (this.currentTimer) { clearTimeout(this.currentTimer); this.currentTimer = null; }
        this.current = null;
        c.resolve(this.responses);
        this.pump();
    }
}

const telnet = new OpenOcdTelnet();

export function openocdResetConnection(): void {
    telnet.close();
}

/** Execute a batch of commands and return per-command responses. */
export async function openocdBatch(
    commands: string[],
    timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string[]> {
    return telnet.send(commands, timeoutMs);
}

/** Execute a single command, return the response string. */
export async function openocdSend(cmd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const res = await openocdBatch([cmd], timeoutMs);
    const r = res[0] ?? '';
    logger.debug(`ocd> ${cmd}  →  ${JSON.stringify(r)}`);
    return r;
}

/** Write a 32-bit word to address. */
export async function mww(address: number | string, value: number | string): Promise<void> {
    await openocdSend(`mww ${addrHex(address)} ${valHex(value)}`);
}

/** Write an 8-bit byte to address. */
export async function mwb(address: number | string, value: number | string): Promise<void> {
    await openocdSend(`mwb ${addrHex(address)} ${valHex(value)}`);
}

/**
 * Read `count` 32-bit words starting at address.
 * Returns an array of hex strings like ["aabbccdd", "11223344"].
 */
export async function mdw(address: number | string, count = 1): Promise<string[]> {
    const response = await openocdSend(`mdw ${addrHex(address)} ${count}`);
    const words: string[] = [];
    for (const line of response.split(/\r?\n/)) {
        const m = line.match(/0x[0-9a-f]+:\s+([\da-f\s]+)/i);
        if (m) words.push(...m[1].trim().split(/\s+/).filter(Boolean));
    }
    return words;
}

/** Read a single 32-bit word, returns the numeric value (unsigned). */
export async function mdwOne(address: number | string): Promise<number> {
    const words = await mdw(address, 1);
    return words.length > 0 ? (parseInt(words[0], 16) >>> 0) : 0;
}

/**
 * Read `count` bytes from address.
 * Returns an array of numeric byte values.
 */
export async function mdb(address: number | string, count = 1): Promise<number[]> {
    const response = await openocdSend(`mdb ${addrHex(address)} ${count}`);
    const bytes: number[] = [];
    for (const line of response.split(/\r?\n/)) {
        const m = line.match(/0x[0-9a-f]+:\s+([\da-f\s]+)/i);
        if (m) {
            bytes.push(...m[1].trim().split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16)));
        }
    }
    return bytes;
}

/**
 * Atomic read-modify-write using OpenOCD's built-in `mmw` over the persistent
 * connection. `mmw addr setbits clearbits` = (val & ~clearbits) | setbits.
 */
export async function setBits(
    address: number | string,
    mask: number,
    value: number
): Promise<number> {
    const addr = addrHex(address);
    const setBitsVal = (value & mask) >>> 0;
    const clearBitsVal = (mask & ~value) >>> 0;
    await openocdSend(
        `mmw ${addr} 0x${setBitsVal.toString(16)} 0x${clearBitsVal.toString(16)}`
    );
    logger.debug(
        `setBits ${addr}: set=0x${setBitsVal.toString(16)} clear=0x${clearBitsVal.toString(16)}`
    );
    return 0;
}

/** Execute an OpenOCD sleep (milliseconds). */
export async function openocdSleep(ms: number): Promise<void> {
    await openocdSend(`sleep ${ms}`);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function addrHex(v: number | string): string {
    return typeof v === 'number' ? `0x${v.toString(16).padStart(8, '0')}` : v;
}

function valHex(v: number | string): string {
    if (typeof v === 'number') return `0x${(v >>> 0).toString(16)}`;
    return v;
}
