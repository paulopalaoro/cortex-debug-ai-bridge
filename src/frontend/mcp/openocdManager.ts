/**
 * OpenOcdManager — auto-starts OpenOCD when needed.
 *
 * Flow:
 *   1. Check if port 50002 is accepting connections (already running).
 *   2. If not, locate PlatformIO's openocd binary.
 *   3. Read workspace platformio.ini to choose the correct target .cfg.
 *   4. Spawn the process and wait until port 50002 is ready (max 8 s).
 *
 * If a Cortex-Debug or PlatformIO debug session already started OpenOCD,
 * isRunning() returns true immediately and no new process is spawned.
 */

import * as vscode from 'vscode';
import * as net from 'net';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as logger from './logger';

export const OPENOCD_TELNET_PORT = 50002;

// ─── board/mcu → OpenOCD target cfg ─────────────────────────────────────────

const TARGET_MAP: Array<[RegExp, string]> = [
    [/G0[3-9]\d|G030|G031|G041|G07|G08/i, 'stm32g0x.cfg'],
    [/G4/i, 'stm32g4x.cfg'],
    [/F0/i, 'stm32f0x.cfg'],
    [/F10[0-9]|F1[0-9][0-9]|STM32F1/i, 'stm32f1x.cfg'],
    [/F2/i, 'stm32f2x.cfg'],
    [/F3/i, 'stm32f3x.cfg'],
    [/F4/i, 'stm32f4x.cfg'],
    [/F7/i, 'stm32f7x.cfg'],
    [/H7/i, 'stm32h7x.cfg'],
    [/L0/i, 'stm32l0.cfg'],
    [/L4/i, 'stm32l4.cfg'],
];

function mcuToTargetCfg(text: string): string | null {
    for (const [re, cfg] of TARGET_MAP) {
        if (re.test(text)) return cfg;
    }
    return null;
}

// ─── manager ─────────────────────────────────────────────────────────────────

export class OpenOcdManager {
    static readonly instance = new OpenOcdManager();

    private _proc: child_process.ChildProcess | null = null;
    private _startPromise: Promise<void> | null = null;
    /** Cached positive result of isRunning() to avoid telnet-probe spam. */
    private _isRunningCachedAt = 0;
    /** Callbacks to notify callers of log lines (e.g. WebView status updates). */
    onLogLine?: (line: string) => void;

    private constructor() {}

    /**
   * True if port 50002 accepts TCP connections right now.
   *
   * Each probe opens+closes a telnet socket, which makes OpenOCD log
   * `accepting 'telnet' connection` + `Error: error during read: Bad file
   * descriptor`. We cache a positive result for a short window so back-to-back
   * panel operations don't spam the log; negatives are never cached so startup
   * remains responsive.
   */
    async isRunning(): Promise<boolean> {
        const ISRUNNING_CACHE_MS = 3000;
        if (Date.now() - this._isRunningCachedAt < ISRUNNING_CACHE_MS) return true;
        return new Promise((resolve) => {
            const s = new net.Socket();
            s.setTimeout(400);
            s.connect(OPENOCD_TELNET_PORT, '127.0.0.1', () => {
                this._isRunningCachedAt = Date.now();
                s.destroy();
                resolve(true);
            });
            s.on('error', () => { s.destroy(); resolve(false); });
            s.on('timeout', () => { s.destroy(); resolve(false); });
        });
    }

    /** Invalidate the isRunning cache (e.g. after stop). */
    private _invalidateRunningCache(): void {
        this._isRunningCachedAt = 0;
    }

    /**
   * Ensures OpenOCD is listening on port 50002.
   * If already running (by Cortex-Debug or previous call), returns immediately.
   * Otherwise locates PlatformIO OpenOCD, picks the right target, and starts it.
   * Resolves when port 50002 is ready; rejects on timeout or missing binary.
   */
    async ensureRunning(): Promise<void> {
        if (await this.isRunning()) return;
        // Deduplicate concurrent callers
        if (!this._startPromise) {
            this._startPromise = this._start().finally(() => { this._startPromise = null; });
        }
        return this._startPromise;
    }

    stop(): void {
        this._invalidateRunningCache();
        if (this._proc) {
            logger.info('OpenOcdManager: stopping OpenOCD process');
            this._proc.kill();
            this._proc = null;
        }
        // Also drop any cached telnet connection so next use reconnects cleanly.
        try {
            // Lazy-required to avoid circular import at load time.

            const { openocdResetConnection } = require('./peripherals/openocdLow');
            openocdResetConnection();
        } catch (_) { /* ignore */ }
    }

    // ─── private ───────────────────────────────────────────────────────────────

    private async _start(): Promise<void> {
        const exe = this._findExe();
        if (!exe) {
            throw new Error(
                'PlatformIO OpenOCD não encontrado em ~/.platformio. '
        + 'Instale o PlatformIO ou inicie uma sessão de debug (F5) para que o OpenOCD suba automaticamente.'
            );
        }

        const scriptsDir = path.join(path.dirname(path.dirname(exe)), 'openocd', 'scripts');
        const targetCfg = await this._pickTarget(scriptsDir);

        const args = [
            '-f', path.join(scriptsDir, 'interface', 'stlink.cfg'),
            '-f', path.join(scriptsDir, 'target', targetCfg),
            '-c', `telnet_port ${OPENOCD_TELNET_PORT}`,
            '-c', 'gdb_port 50003',
            '-c', 'tcl_port 50004',
            '-c', 'reset_config none',   // no physical SRST/TRST connected
            '-c', 'init',
        ];

        logger.info(`OpenOcdManager: starting — ${path.basename(exe)} ${targetCfg}`);
        this._emit(`Iniciando OpenOCD com ${targetCfg}…`);

        this._proc = child_process.spawn(exe, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });

        const fwd = (data: Buffer) => {
            data.toString().split(/\r?\n/).filter(Boolean).forEach((l) => {
                logger.debug(`[OpenOCD] ${l}`);
                this._emit(l);
            });
        };
        this._proc.stdout?.on('data', fwd);
        this._proc.stderr?.on('data', fwd);

        this._proc.on('error', (err) => logger.error(`OpenOCD spawn error: ${err.message}`));
        this._proc.on('exit', (code) => {
            logger.info(`OpenOCD exited (code ${code})`);
            this._proc = null;
        });

        await this._waitPort(8000);
        this._emit('OpenOCD pronto na porta 50002 ✓');
        logger.info('OpenOcdManager: ready');
    }

    private _findExe(): string | null {
        const home = os.homedir();
        const ext = process.platform === 'win32' ? '.exe' : '';
        const candidates = [
            path.join(home, '.platformio', 'packages', 'tool-openocd', 'bin', `openocd${ext}`),
            '/usr/bin/openocd',
            '/usr/local/bin/openocd',
        ];
        return candidates.find((c) => fs.existsSync(c)) ?? null;
    }

    private async _pickTarget(scriptsDir: string): Promise<string> {
    // 1 — read platformio.ini from all open workspace folders
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const iniPath = path.join(folder.uri.fsPath, 'platformio.ini');
            if (!fs.existsSync(iniPath)) continue;
            const ini = fs.readFileSync(iniPath, 'utf8');
            const board = ini.match(/^\s*board\s*=\s*(.+)$/m)?.[1] ?? '';
            const mcu = ini.match(/^\s*board_build\.mcu\s*=\s*(.+)$/m)?.[1] ?? '';
            const hit = mcuToTargetCfg(board + ' ' + mcu);
            if (hit) {
                logger.info(`OpenOcdManager: detected target ${hit} from platformio.ini (board=${board.trim()})`);
                return hit;
            }
        }

        // 2 — let user pick from available .cfg files in the target folder
        const targetDir = path.join(scriptsDir, 'target');
        let cfgFiles: string[] = [];
        try {
            cfgFiles = fs.readdirSync(targetDir)
                .filter((f) => /^stm32.+\.cfg$/.test(f))
                .sort();
        } catch { /* ignore */ }

        const items = cfgFiles.length
            ? cfgFiles
            : ['stm32g0x.cfg', 'stm32f4x.cfg', 'stm32f1x.cfg', 'stm32f0x.cfg', 'stm32h7x.cfg'];

        const pick = await vscode.window.showQuickPick(items, {
            title: 'OpenOCD: selecione o chip alvo',
            placeHolder: 'Família do microcontrolador conectado',
        });
        if (!pick) throw new Error('Nenhum chip selecionado — OpenOCD não iniciado.');
        return pick;
    }

    private _waitPort(timeoutMs: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const attempt = () => {
                const s = new net.Socket();
                s.setTimeout(300);
                s.connect(OPENOCD_TELNET_PORT, '127.0.0.1', () => { s.destroy(); resolve(); });
                s.on('error', () => { s.destroy(); schedule(); });
                s.on('timeout', () => { s.destroy(); schedule(); });
            };
            const schedule = () => {
                if (Date.now() + 400 > deadline) {
                    reject(new Error('OpenOCD não iniciou dentro de 8 s. Verifique se o ST-Link está conectado.'));
                } else {
                    setTimeout(attempt, 400);
                }
            };
            setTimeout(attempt, 1200); // give process time to fork + enumerate target
        });
    }

    private _emit(line: string): void {
        this.onLogLine?.(line);
    }
}
