/**
 * Minimal GDB/MI2 client.
 *
 * Spawns arm-none-eabi-gdb as a child process, sends MI2 commands over
 * stdin/stdout, and parses the responses. Used to drive OpenOCD through GDB
 * instead of opening multiple raw telnet connections to OpenOCD.
 *
 * Scope: memory read/write, monitor commands, connect/disconnect. Breakpoints,
 * variables and stack traces are NOT in scope — those are handled by the
 * existing MCP bridge through the user's active Cortex-Debug session.
 *
 * Inspired by (and lightly adapted from) Cortex-Debug's MI2 class by
 * Jacob Lippert and contributors (MIT licence). See NOTICE.
 */

import * as child_process from 'child_process';
import { EventEmitter } from 'events';
import * as logger from '../logger';

const GDB_RESPONSE_TIMEOUT_MS = 10_000;

interface PendingCommand {
    token: number;
    command: string;
    resolve: (result: MIResult) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

/** Parsed response from a single MI command. */
export interface MIResult {
    /** 'done' | 'error' | 'running' | 'connected' | 'exit' */
    resultClass: string;
    /** Raw response line for diagnostics. */
    raw: string;
    /** Plain console output collected while the command ran. */
    output: string[];
    /** Parsed key/value fields from the result record. */
    fields: Record<string, string>;
}

export class MI2 extends EventEmitter {
    private proc: child_process.ChildProcess | null = null;
    private buffer = '';
    private errBuffer = '';
    private token = 1;
    private pending = new Map<number, PendingCommand>();
    private collectedOutput: string[] = [];
    private ready = false;
    private startResolve?: () => void;
    private startReject?: (err: Error) => void;
    private startTimer?: NodeJS.Timeout;

    /** Spawn the gdb process. Returns when gdb is ready to accept commands. */
    start(gdbPath: string, args: string[] = [], cwd?: string, timeoutMs = 12_000): Promise<void> {
        return new Promise((resolve, reject) => {
            this.startResolve = resolve;
            this.startReject = reject;

            // Safety net: reject if gdb never produces the (gdb) prompt.
            this.startTimer = setTimeout(() => {
                if (!this.startReject) return;
                this.startReject(new Error(`MI2: gdb did not produce a prompt within ${timeoutMs}ms`));
                this.startReject = undefined;
                this.startResolve = undefined;
                try { this.proc?.kill(); } catch (_) { /* ignore */ }
            }, timeoutMs);

            const finalArgs = ['--interpreter=mi2', '--quiet', '--nx', '--nh', ...args];
            logger.debug(`MI2: spawn ${gdbPath} ${finalArgs.join(' ')}`);

            this.proc = child_process.spawn(gdbPath, finalArgs, {
                cwd,
                env: process.env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            this.proc.stdout?.on('data', (d: Buffer) => this.onStdout(d.toString('utf8')));
            this.proc.stderr?.on('data', (d: Buffer) => this.onStderr(d.toString('utf8')));
            this.proc.on('error', (err) => {
                logger.error(`MI2: spawn error: ${err.message}`);
                clearTimeout(this.startTimer);
                if (this.startReject) {
                    this.startReject(err);
                    this.startReject = undefined;
                    this.startResolve = undefined;
                }
            });
            this.proc.on('exit', (code) => {
                logger.info(`MI2: gdb exited with code ${code}`);
                clearTimeout(this.startTimer);
                // If start() hasn't resolved yet, reject it now.
                if (this.startReject) {
                    this.startReject(new Error(`MI2: gdb exited with code ${code} before producing a prompt`));
                    this.startReject = undefined;
                    this.startResolve = undefined;
                }
                this.proc = null;
                for (const pending of this.pending.values()) {
                    clearTimeout(pending.timer);
                    pending.reject(new Error('gdb exited'));
                }
                this.pending.clear();
                this.emit('exit');
            });
        });
    }

    /** Cleanly terminate gdb. */
    stop(): Promise<void> {
        if (!this.proc) return Promise.resolve();
        return new Promise((resolve) => {
            const proc = this.proc;
            const killTimeout = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
            }, 2000);
            proc.once('exit', () => {
                clearTimeout(killTimeout);
                resolve();
            });
            try {
                this.sendRaw('-gdb-exit');
            } catch (_) {
                proc.kill();
            }
        });
    }

    /** Send a raw MI command string without waiting for a response. */
    sendRaw(cmd: string): void {
        if (!this.proc?.stdin?.writable) throw new Error('MI2: gdb not running');
        this.proc.stdin.write(cmd + '\n');
    }

    /** Send an MI command (e.g. "-data-read-memory-bytes 0x20000000 4") and await the result. */
    send(command: string, timeoutMs = GDB_RESPONSE_TIMEOUT_MS): Promise<MIResult> {
        if (!this.ready) return Promise.reject(new Error('MI2: not ready yet'));
        const token = this.token++;
        const full = `${token}${command}`;
        return new Promise<MIResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(token);
                reject(new Error(`MI2 timeout after ${timeoutMs}ms: ${command}`));
            }, timeoutMs);
            this.pending.set(token, { token, command, resolve, reject, timer });
            this.proc?.stdin?.write(full + '\n');
        });
    }

    /** Send a plain CLI command via `-interpreter-exec console`. */
    sendCli(cmd: string, timeoutMs = GDB_RESPONSE_TIMEOUT_MS): Promise<MIResult> {
        const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return this.send(`-interpreter-exec console "${escaped}"`, timeoutMs);
    }

    // ─── stdio parsing ────────────────────────────────────────────────────────

    private onStdout(chunk: string): void {
        this.buffer += chunk;
        let idx: number;

        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, idx).replace(/\r$/, '');
            this.buffer = this.buffer.slice(idx + 1);
            this.handleLine(line);
        }
    }

    private onStderr(chunk: string): void {
        this.errBuffer += chunk;
        logger.debug(`MI2 stderr: ${chunk.trim()}`);
    }

    private handleLine(line: string): void {
        if (!line) return;

        // gdb ready prompt
        if (line === '(gdb)') {
            if (!this.ready) {
                this.ready = true;
                clearTimeout(this.startTimer);
                if (this.startResolve) {
                    this.startResolve();
                    this.startResolve = undefined;
                    this.startReject = undefined;
                }
            }
            return;
        }

        // Console/target output: ~"..."  @"..."  &"..."
        const ioPrefix = line.charAt(0);
        if (ioPrefix === '~' || ioPrefix === '@' || ioPrefix === '&') {
            const txt = this.unquoteConsoleString(line.slice(1));
            this.collectedOutput.push(txt);
            return;
        }

        // Async notify / exec / status: '*' '+' '='
        if (ioPrefix === '*' || ioPrefix === '+' || ioPrefix === '=') {
            // Not needed for memory ops — ignore.
            return;
        }

        // Result record: "<token>^<class>,<fields...>"
        const resultMatch = line.match(/^(\d+)\^([a-z-]+)(?:,(.*))?$/);
        if (resultMatch) {
            const token = parseInt(resultMatch[1], 10);
            const resultClass = resultMatch[2];
            const fieldsStr = resultMatch[3] ?? '';
            const pending = this.pending.get(token);
            if (!pending) return;
            this.pending.delete(token);
            clearTimeout(pending.timer);
            const result: MIResult = {
                resultClass,
                raw: line,
                output: this.collectedOutput.splice(0),
                fields: this.parseFields(fieldsStr),
            };
            if (resultClass === 'error') {
                pending.reject(new Error(result.fields.msg || line));
            } else {
                pending.resolve(result);
            }
            return;
        }

        // Unknown — log for diagnostics.
        logger.debug(`MI2 unknown line: ${line}`);
    }

    private unquoteConsoleString(s: string): string {
        if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
        return s
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }

    /**
   * Parse a shallow MI result-field list: `key1="v1",key2="v2",key3={...}`.
   * Nested structures are returned as raw strings; callers that need deeper
   * parsing can handle them separately.
   */
    private parseFields(str: string): Record<string, string> {
        const out: Record<string, string> = {};
        let i = 0;
        while (i < str.length) {
            const keyMatch = /^([a-zA-Z_][a-zA-Z0-9_-]*)=/.exec(str.slice(i));
            if (!keyMatch) break;
            const key = keyMatch[1];
            i += keyMatch[0].length;
            const { value, next } = this.parseValue(str, i);
            out[key] = value;
            i = next;
            if (str[i] === ',') i++;
        }
        return out;
    }

    private parseValue(str: string, i: number): { value: string; next: number } {
        const ch = str[i];
        if (ch === '"') {
            // Quoted string — handle escapes.
            let j = i + 1;
            let out = '';
            while (j < str.length) {
                const c = str[j];
                if (c === '\\' && j + 1 < str.length) {
                    const esc = str[j + 1];
                    if (esc === 'n') out += '\n';
                    else if (esc === 'r') out += '\r';
                    else if (esc === 't') out += '\t';
                    else out += esc;
                    j += 2;
                } else if (c === '"') {
                    return { value: out, next: j + 1 };
                } else {
                    out += c;
                    j++;
                }
            }
            return { value: out, next: j };
        }
        if (ch === '{' || ch === '[') {
            // Nested — grab to matching bracket.
            const open = ch;
            const close = ch === '{' ? '}' : ']';
            let depth = 1;
            let j = i + 1;
            while (j < str.length && depth > 0) {
                const c = str[j];
                if (c === '"') {
                    // Skip quoted string.
                    j++;
                    while (j < str.length && str[j] !== '"') {
                        if (str[j] === '\\') j++;
                        j++;
                    }
                    j++;
                } else if (c === open) { depth++; j++; } else if (c === close) { depth--; j++; } else { j++; }
            }
            return { value: str.slice(i, j), next: j };
        }
        // Bare token up to comma/end.
        let j = i;
        while (j < str.length && str[j] !== ',') j++;
        return { value: str.slice(i, j), next: j };
    }
}
