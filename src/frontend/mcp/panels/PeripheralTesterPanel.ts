/**
 * PeripheralTesterPanel — VS Code WebView panel for interactive STM32 peripheral testing.
 *
 * Provides a graphical interface to:
 *   • Detect connected chip via OpenOCD
 *   • Configure and toggle GPIO pins
 *   • Initialize and transfer SPI data
 *   • Initialize and execute I2C transactions
 *   • Read/write peripheral registers by name
 *   • Configure PWM timers
 *
 * All operations call OpenOCD directly via the existing openocdLow / stm32Init helpers.
 * No MCP client needed — this is a direct VS Code UI.
 */

import * as vscode from 'vscode';
import { openocdSend, mww, mdwOne as mdw1, openocdBatch } from '../peripherals/openocdLow';
import { ChipDef, getChip, listChips, gpioBase, GPIO, GPIO_F1, parsePin, lookupAF, validPinsForSignal, USART_REG, USART_REG_LEGACY, CAN_REG, RTC_REG } from '../peripherals/chipMap';
import {
    configPin, enablePeriphClock,
    initSpi, spiTransferBytes,
    initI2c, i2cTransaction as i2cTx,
    initPwm,
} from '../peripherals/stm32Init';
import { OpenOcdManager } from '../openocdManager';

// ─── panel singleton ──────────────────────────────────────────────────────────

export class PeripheralTesterPanel {
    public static currentPanel: PeripheralTesterPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _disposables: vscode.Disposable[] = [];

    /** Last detected chip family, cached for quick reuse across operations. */
    private _chipFamily = 'stm32g0';

    // ─── public static factory ────────────────────────────────────────────────

    public static createOrShow(_context: vscode.ExtensionContext): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (PeripheralTesterPanel.currentPanel) {
            PeripheralTesterPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'cortexPeripheralTester',
            'Peripheral Tester',
            column ?? vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        PeripheralTesterPanel.currentPanel = new PeripheralTesterPanel(panel);
    }

    // ─── constructor ──────────────────────────────────────────────────────────

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._panel.webview.html = this._buildHtml();

        // Forward OpenOCD log lines to the WebView log area
        OpenOcdManager.instance.onLogLine = (line) => {
            this._panel.webview.postMessage({ type: 'ocdLog', data: line });
        };

        // Dispose when the user closes the panel
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the WebView
        this._panel.webview.onDidReceiveMessage(
            (msg) => this._handleMessage(msg),
            null,
            this._disposables
        );
    }

    public dispose(): void {
        PeripheralTesterPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }

    // ─── OpenOCD guard ────────────────────────────────────────────────────────

    /** Ensures OpenOCD is running before any hardware operation. */
    private async _ensureOpenOcd(): Promise<void> {
        const running = await OpenOcdManager.instance.isRunning();
        if (!running) {
            this._panel.webview.postMessage({ type: 'ocdLog', data: '⏳ OpenOCD não está rodando — iniciando automaticamente…' });
            this._panel.webview.postMessage({ type: 'ocdLog', data: '   (buscando binário em ~/.platformio/packages/tool-openocd)' });
        }
        await OpenOcdManager.instance.ensureRunning();
        if (!running) {
            this._panel.webview.postMessage({ type: 'ocdLog', data: '✓ OpenOCD iniciado na porta 50002' });
        }
    }

    // ─── message router ───────────────────────────────────────────────────────

    private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
        const op = msg.command as string;
        try {
            // All operations need OpenOCD running.
            // detectChip also auto-starts it if not running.
            // halt/resume/reset/erase require it already running (no auto-start).
            const needsRunning = op === 'haltTarget' || op === 'resumeTarget'
                        || op === 'resetTarget' || op === 'eraseFlash';
            if (needsRunning) {
                const running = await OpenOcdManager.instance.isRunning();
                if (!running) {
                    this._send('error', op, 'OpenOCD não está rodando. Use "Detect chip" primeiro para iniciá-lo.');
                    return;
                }
            } else {
                await this._ensureOpenOcd();
            }
            switch (op) {
                case 'detectChip': await this._detectChip(); break;
                case 'initGpio': await this._initGpio(msg); break;
                case 'setGpio': await this._setGpio(msg); break;
                case 'readGpio': await this._readGpio(msg); break;
                case 'diagnoseGpio':await this._diagnoseGpio(msg); break;
                case 'initSpi': await this._initSpi(msg); break;
                case 'spiTransfer': await this._spiTransfer(msg); break;
                case 'initI2c': await this._initI2c(msg); break;
                case 'i2cTx': await this._i2cTx(msg); break;
                case 'readReg': await this._readReg(msg); break;
                case 'writeReg': await this._writeReg(msg); break;
                case 'getValidPwmPins': this._getValidPwmPins(msg); break;
                case 'initPwm': await this._initPwm(msg); break;
                case 'initUsart': await this._initUsart(msg); break;
                case 'usartTx': await this._usartTx(msg); break;
                case 'initCan': await this._initCan(msg); break;
                case 'setCanFilter': await this._setCanFilter(msg); break;
                case 'canStatus': await this._canStatus(msg); break;
                case 'rtcRead': await this._rtcRead(msg); break;
                case 'rtcReadSsr': await this._rtcReadSsr(msg); break;
                case 'rtcBkpRead': await this._rtcBkpRead(msg); break;
                case 'rtcBkpWrite': await this._rtcBkpWrite(msg); break;
                case 'rtcSet': await this._rtcSet(msg); break;
                case 'haltTarget': await this._haltTarget(); break;
                case 'resumeTarget': await this._resumeTarget(); break;
                case 'resetTarget': await this._resetTarget(); break;
                case 'eraseFlash': await this._eraseFlash(); break;
                default:
                    this._send('error', op, `Unknown command: ${op}`);
            }
        } catch (e: unknown) {
            this._send('error', op, (e as Error).message);
        }
    }

    // ─── helpers ──────────────────────────────────────────────────────────────

    /** Post a result message back to the WebView. */
    private _send(type: 'result' | 'error' | 'chipInfo', op: string, data: unknown): void {
        this._panel.webview.postMessage({ type, op, data });
    }

    private _chip(family?: string): ChipDef {
        const f = family ?? this._chipFamily;
        const c = getChip(f);
        if (!c) throw new Error(`Unknown chip family: ${f}`);
        return c;
    }

    /**
   * Enable PWR clock + set DBP so backup-domain writes (RTC_BDCR/RTC registers) are allowed.
   * Retries once with reset halt when bits do not latch on the first attempt.
   *
   * Verification reads use individual mdwOne() calls (one telnet round-trip each)
   * instead of openocdBatch, because the multi-line out-of-band output from
   * "reset halt" (speed warnings, halt notifications) confuses the batch prompt
   * parser and shifts responses to wrong indices.
   */
    private async _unlockBackupDomain(chip: ChipDef, pwrCrAddr = 0x40007000): Promise<{ apb1: number; pwrCr: number }> {
        const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;

        // Bit masks
        const pwrEnMask = 1 << 28; // RCC_APB1ENR.PWREN
        const dbpMask = 1 << 8;  // PWR_CR.DBP

        const ocdLog = (msg: string) =>
            this._panel.webview.postMessage({ type: 'ocdLog', data: '[unlockBD] ' + msg });

        for (let attempt = 0; attempt < 2; attempt++) {
            const resetCmd = attempt === 0 ? 'halt' : 'reset halt';
            const writeCmds = [
                resetCmd,                                                         // [0]
                'sleep 10',                                                       // [1]
                `mmw ${hex(chip.rcc.apb1EnReg)} ${hex(pwrEnMask)} 0`,           // [2] PWREN=1
                'sleep 5',                                                        // [3]
                `mmw ${hex(pwrCrAddr)} ${hex(dbpMask)} 0`,                      // [4] DBP=1
                'sleep 5',                                                        // [5]
            ];

            ocdLog(`attempt=${attempt} writeCmds=${JSON.stringify(writeCmds)}`);
            const wR = await openocdBatch(writeCmds, 15_000);
            wR.forEach((resp, i) => ocdLog(`  w[${i}] = ${JSON.stringify(resp)}`));

            // Sync delay: let OpenOCD flush any remaining out-of-band messages
            // (speed warnings, halt notifications) before issuing verification reads.
            await openocdBatch(['sleep 100'], 5_000);

            // Verification reads use individual mdwOne() calls — each gets its own
            // clean telnet round-trip, immune to prompt mis-alignment.
            ocdLog(`  reading APB1ENR @ ${hex(chip.rcc.apb1EnReg)} …`);
            const lastApb1 = await mdw1(chip.rcc.apb1EnReg);
            ocdLog(`  reading PWR_CR  @ ${hex(pwrCrAddr)} …`);
            const lastPwrCr = await mdw1(pwrCrAddr);

            ocdLog(`  parsed: APB1ENR=0x${lastApb1.toString(16).padStart(8, '0')} PWR_CR=0x${lastPwrCr.toString(16).padStart(8, '0')}`);

            const pwrEn = (lastApb1 & pwrEnMask) !== 0;
            const dbp = (lastPwrCr & dbpMask) !== 0;
            ocdLog(`  pwrEn=${pwrEn} dbp=${dbp}`);

            if (pwrEn && dbp) return { apb1: lastApb1, pwrCr: lastPwrCr };

            if (attempt === 1) {
                throw new Error(
                    `Falha ao desbloquear backup domain. `
          + `APB1ENR=0x${lastApb1.toString(16).padStart(8, '0')} `
          + `PWR_CR=0x${lastPwrCr.toString(16).padStart(8, '0')} (DBP=0).`
                );
            }
        }
        throw new Error('Falha ao desbloquear backup domain.');
    }

    // ─── chip detection ───────────────────────────────────────────────────────

    private async _detectChip(): Promise<void> {
    // ── Step 1: query targets for name + state ───────────────────────────────
        let targetsOutput = '';
        try {
            targetsOutput = await openocdSend('targets');
        } catch (err) {
            // Surface the actual error instead of silently falling through to "unknown".
            this._panel.webview.postMessage({
                type: 'ocdLog',
                data: '[backend error] ' + (err as Error).message,
            });
        }

        // Log raw output to help diagnose parse failures
        this._panel.webview.postMessage({ type: 'ocdLog', data: '[targets raw] ' + targetsOutput.replace(/\r?\n/g, ' | ') });

        let targetName = 'unknown', state = 'unknown';

        for (const line of targetsOutput.split(/\r?\n/)) {
            // OpenOCD formats: "  0* stm32f4x.cpu  cortex_m  little  stm32f4x.cpu  running"
            // or:              "  0  stm32g0x.cpu  cortex_m  little  stm32g0x.cpu  halted"
            // Capture: index(optional*) name type endian tapname state
            const m = line.match(/^\s*\d+\*?\s+(\S+)\s+\S+\s+\S+\s+\S+\s+(\S+)/);
            if (m) { targetName = m[1]; state = m[2]; break; }

            // Fallback: shorter format without endian column
            const m2 = line.match(/^\s*\d+\*?\s+(\S+)\s+\S+\s+(\S+)/);
            if (m2 && !m2[1].startsWith('-')) { targetName = m2[1]; state = m2[2]; break; }
        }

        // ── Auto-halt target if STM32 is detected (Connect Under Reset) ────────
        if (targetName.toLowerCase().includes('stm32') && state !== 'halted') {
            this._panel.webview.postMessage({ type: 'ocdLog', data: '⏳ STM32 detectado. Forçando halt imediatamente (Connect Under Reset)...' });
            try {
                await openocdBatch([
                    'mmw 0xE0042008 0x1800 0',  // freeze IWDG + WWDG on halt
                    'reset halt',               // Halt processor safely natively
                ]);
                state = 'halted';
                this._panel.webview.postMessage({ type: 'ocdLog', data: '✓ Alvo contido via reset halt.' });
            } catch (err) {
                this._panel.webview.postMessage({ type: 'ocdLog', data: '[auto-halt error] ' + (err as Error).message });
            }
        }

        // ── Step 2: read DBGMCU DEV_ID (most reliable family source) ────────────
        const DEV_ID_MAP: Record<number, { name: string; family: string }> = {
            0x467: { name: 'STM32G030/G031/G041', family: 'stm32g0' },
            0x460: { name: 'STM32G070/G071/G081', family: 'stm32g0' },
            0x456: { name: 'STM32G050/G051/G061', family: 'stm32g0' },
            0x440: { name: 'STM32F030x8/F05x', family: 'stm32f0' },
            0x442: { name: 'STM32F030xC/F09x', family: 'stm32f0' },
            0x445: { name: 'STM32F042', family: 'stm32f0' },
            0x448: { name: 'STM32F072/F078', family: 'stm32f0' },
            0x413: { name: 'STM32F407/F417', family: 'stm32f4' },
            0x419: { name: 'STM32F427/F437/F429/F439', family: 'stm32f4' },
            0x423: { name: 'STM32F401xB/C', family: 'stm32f4' },
            0x431: { name: 'STM32F411', family: 'stm32f4' },
            0x421: { name: 'STM32F446', family: 'stm32f4' },
            0x434: { name: 'STM32F469/F479', family: 'stm32f4' },
            0x432: { name: 'STM32F373/F378', family: 'stm32f3' },
            0x422: { name: 'STM32F302/F303', family: 'stm32f3' },
            0x438: { name: 'STM32F303x6/x8', family: 'stm32f3' },
            0x446: { name: 'STM32F303xD/xE', family: 'stm32f3' },
            0x449: { name: 'STM32F746/F756', family: 'stm32f7' },
            0x451: { name: 'STM32F76x/F77x', family: 'stm32f7' },
            0x452: { name: 'STM32F72x/F73x', family: 'stm32f7' },
            0x410: { name: 'STM32F101/F102/F103 LD/MD', family: 'stm32f1' },
            0x412: { name: 'STM32F101/F103 MD+', family: 'stm32f1' },
            0x414: { name: 'STM32F103 HD', family: 'stm32f1' },
            0x418: { name: 'STM32F105/F107', family: 'stm32f1' },
            0x420: { name: 'STM32F100 VL', family: 'stm32f1' },
            0x428: { name: 'STM32F100 HD VL', family: 'stm32f1' },
            0x430: { name: 'STM32F101/F103 XL', family: 'stm32f1' },
            0x416: { name: 'STM32L151/L152', family: 'stm32l1' },
            0x436: { name: 'STM32L151/L152 HD', family: 'stm32l1' },
            0x415: { name: 'STM32L476/L485/L496', family: 'stm32l4' },
            0x461: { name: 'STM32L496/L4A6', family: 'stm32l4' },
            0x462: { name: 'STM32L45x/L46x', family: 'stm32l4' },
            0x464: { name: 'STM32L412/L422', family: 'stm32l4' },
            0x470: { name: 'STM32G4 Cat2', family: 'stm32g4' },
            0x468: { name: 'STM32G431/G441', family: 'stm32g4' },
            0x469: { name: 'STM32G473/G483/G474/G484', family: 'stm32g4' },
            0x479: { name: 'STM32G491/G4A1', family: 'stm32g4' },
            0x450: { name: 'STM32H742/H743/H750', family: 'stm32h7' },
            0x480: { name: 'STM32H7A3/H7B3/H7B0', family: 'stm32h7' },
        };

        let devId = 'unknown', devIdCode: string | null = null;
        let familyFromDevId = 'unknown';

        // DBGMCU_IDCODE is at 0xE0042000 on most Cortex-M (0x5C001000 on H7)
        for (const dbgAddr of [0xE0042000, 0x5C001000]) {
            try {
                const raw = await mdw1(dbgAddr);
                if (raw === 0 || raw === 0xFFFFFFFF) continue;  // bus error / not mapped
                const num = raw & 0xFFF;
                devIdCode = `0x${raw.toString(16).padStart(8, '0')}`;
                const entry = DEV_ID_MAP[num];
                devId = `0x${num.toString(16).padStart(3, '0')}${entry ? ` — ${entry.name}` : ''}`;
                if (entry) { familyFromDevId = entry.family; }
                break;
            } catch { /* not accessible at this address */ }
        }

        // ── Step 3: pick family — prefer DBGMCU, fall back to target name ────────
        let family = familyFromDevId;
        if (family === 'unknown') {
            const t = targetName.toLowerCase();
            if (t.includes('stm32g0')) family = 'stm32g0';
            else if (t.includes('stm32g4')) family = 'stm32g4';
            else if (t.includes('stm32f0')) family = 'stm32f0';
            else if (t.includes('stm32f1')) family = 'stm32f1';
            else if (t.includes('stm32f2')) family = 'stm32f2';
            else if (t.includes('stm32f3')) family = 'stm32f3';
            else if (t.includes('stm32f4')) family = 'stm32f4';
            else if (t.includes('stm32f7')) family = 'stm32f7';
            else if (t.includes('stm32h7')) family = 'stm32h7';
            else if (t.includes('stm32l0')) family = 'stm32l0';
            else if (t.includes('stm32l4')) family = 'stm32l4';
        }

        if (family !== 'unknown') this._chipFamily = family;

        this._send('chipInfo', 'detectChip', {
            targetName, family, state, devIdCode, devId,
            supportedFamilies: listChips(),
        });
    }

    // ─── GPIO ─────────────────────────────────────────────────────────────────

    private async _initGpio(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const pinStrs = (msg.pin as string).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
        const mode = (msg.mode as string) ?? 'output';
        const pull = (msg.pull as string) ?? 'none';

        for (const pinStr of pinStrs) {
            if (!pinStr.startsWith('P') || pinStr.length < 3) continue;
            const port = pinStr.slice(1, 2);
            const pinNum = parseInt(pinStr.slice(2));

            await configPin(chip, port, pinNum, mode as never, pull as never, 'medium', 'push-pull', 0);

            const base = gpioBase(chip, port);
            if (base === null) continue; // Skip invalid
            const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
            const parseWord = (r: string): number => {
                const m = r.match(/0x[0-9a-f]+:\s+([0-9a-f]+)/i);
                return m ? (parseInt(m[1], 16) >>> 0) : 0;
            };

            if (chip.gpioModel === 'f1') {
                // F1: read CRL or CRH (4 bits per pin) + ODR (pull dir) + IDR (pin level)
                const crReg = pinNum < 8 ? base + GPIO_F1.CRL : base + GPIO_F1.CRH;
                const [crResp, odrResp, idrResp] = await openocdBatch([
                    `mdw ${hex(crReg)} 1`,
                    `mdw ${hex(base + GPIO_F1.ODR)} 1`,
                    `mdw ${hex(base + GPIO_F1.IDR)} 1`,
                ]);
                const cr = parseWord(crResp);
                const odr = parseWord(odrResp);
                const idr = parseWord(idrResp);
                const shift = (pinNum < 8 ? pinNum : pinNum - 8) * 4;
                const modeBits = (cr >> shift) & 0x3;       // MODE[1:0]
                const cnfBits = (cr >> (shift + 2)) & 0x3; // CNF[1:0]
                const pinState = (idr >> pinNum) & 0x1;

                // Decode mode: MODE=00 → input; MODE!=00 → output (speed)
                let modeStr: string;
                let pullStr = 'n/a';
                if (modeBits === 0) {
                    // Input: CNF 00=analog, 01=floating, 10=pull (ODR bit selects up/down)
                    modeStr = cnfBits === 0 ? 'analog' : 'input';
                    if (cnfBits === 2) pullStr = (odr >> pinNum) & 1 ? 'up' : 'down';  // ODR, not IDR!
                    else if (cnfBits === 1) pullStr = 'none';
                } else {
                    // Output: CNF 00=GP-PP, 01=GP-OD, 10=AF-PP, 11=AF-OD
                    modeStr = cnfBits >= 2 ? 'af' : 'output';
                    pullStr = 'none';
                }

                this._send('result', 'initGpio', {
                    ok: true, pin: pinStr, requested: { mode, pull },
                    readback: { mode: modeStr, pull: pullStr, pinState: pinState ? 'HIGH' : 'LOW' },
                    match: modeStr === mode && (pullStr === pull || pullStr === 'n/a') ? 'OK' : 'MISMATCH',
                });
            } else {
                // New GPIO model (F0/F4/G0/G4/H7): read MODER, PUPDR, IDR
                const [moderResp, pupdrResp, idrResp] = await openocdBatch([
                    `mdw ${hex(base + GPIO.MODER)} 1`,
                    `mdw ${hex(base + GPIO.PUPDR)} 1`,
                    `mdw ${hex(base + GPIO.IDR)} 1`,
                ]);
                const moder = parseWord(moderResp);
                const pupdr = parseWord(pupdrResp);
                const idr = parseWord(idrResp);
                const modeBits = (moder >> (pinNum * 2)) & 0x3;
                const pullBits = (pupdr >> (pinNum * 2)) & 0x3;
                const pinState = (idr >> pinNum) & 0x1;
                const modeStr = ['input', 'output', 'af', 'analog'][modeBits];
                const pullStr = ['none', 'up', 'down', 'reserved'][pullBits];

                this._send('result', 'initGpio', {
                    ok: true, pin: pinStr, requested: { mode, pull },
                    readback: { mode: modeStr, pull: pullStr, pinState: pinState ? 'HIGH' : 'LOW' },
                    match: modeStr === mode && pullStr === pull ? 'OK' : 'MISMATCH',
                });
            }
        }
    }

    private async _setGpio(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const pinStr = (msg.pin as string).toUpperCase();
        const port = pinStr.slice(1, 2);
        const pinNum = parseInt(pinStr.slice(2));
        const high = (msg.value as string) === 'high';

        const base = gpioBase(chip, port);
        if (base === null) throw new Error(`Unknown GPIO port: ${port}`);

        const bsrr = chip.gpioModel === 'f1' ? GPIO_F1.BSRR : GPIO.BSRR;
        const bit = high ? (1 << pinNum) : (1 << (pinNum + 16));
        await mww(base + bsrr, bit);

        this._send('result', 'setGpio', { ok: true, pin: pinStr, value: high ? 'HIGH' : 'LOW' });
    }

    private async _diagnoseGpio(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const pinStr = (msg.pin as string).toUpperCase();          // e.g. 'PF3'
        const port = pinStr.slice(1, 2);
        const pinNum = parseInt(pinStr.slice(2));
        const base = gpioBase(chip, port);
        if (base === null) throw new Error(`Unknown port: ${port}`);

        const gpioBit = chip.rcc.gpioEnBit[port];
        const gpioEnReg = chip.rcc.gpioEnReg;
        const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;

        // ── STEP 0: Enable GPIO clock (required for register reads to return real data) ──
        if (gpioBit !== undefined) {
            await openocdBatch([`mmw ${hex(gpioEnReg)} ${hex(1 << gpioBit)} 0`]);
        }

        if (chip.gpioModel === 'f1') {
            // ── STM32F1: CRL/CRH register model ──────────────────────────────────
            // Warmup read
            await mdw1(base + GPIO_F1.CRL);
            const gpioEnVal = await mdw1(gpioEnReg);
            const crl = await mdw1(base + GPIO_F1.CRL);
            const crh = await mdw1(base + GPIO_F1.CRH);
            const odr = await mdw1(base + GPIO_F1.ODR);
            const idr = await mdw1(base + GPIO_F1.IDR);

            const cr = pinNum < 8 ? crl : crh;
            const shift = (pinNum < 8 ? pinNum : pinNum - 8) * 4;
            const modeBits = (cr >> shift) & 0x3;        // MODE[1:0]
            const cnfBits = (cr >> (shift + 2)) & 0x3;  // CNF[1:0]
            const odrBit = (odr >> pinNum) & 1;
            const idrBit = (idr >> pinNum) & 1;
            const clockOn = gpioBit !== undefined ? !!((gpioEnVal >> gpioBit) & 1) : false;

            let modeStr: string;
            let pullStr: string;
            let otypeStr: string;
            let speedStr: string;

            if (modeBits === 0) {
                // Input mode
                speedStr = 'n/a';
                if (cnfBits === 0) { modeStr = 'analog'; pullStr = 'n/a'; otypeStr = 'n/a'; } else if (cnfBits === 1) { modeStr = 'input'; pullStr = 'floating'; otypeStr = 'n/a'; } else { modeStr = 'input'; pullStr = odrBit ? 'up' : 'down'; otypeStr = 'n/a'; }
            } else {
                // Output mode: MODE = speed (1=10MHz, 2=2MHz, 3=50MHz)
                speedStr = ['n/a', '10MHz', '2MHz', '50MHz'][modeBits];
                if (cnfBits === 0) { modeStr = 'output'; otypeStr = 'push-pull'; pullStr = 'none'; } else if (cnfBits === 1) { modeStr = 'output'; otypeStr = 'open-drain'; pullStr = 'none'; } else if (cnfBits === 2) { modeStr = 'af'; otypeStr = 'push-pull'; pullStr = 'none'; } else { modeStr = 'af'; otypeStr = 'open-drain'; pullStr = 'none'; }
            }

            this._send('result', 'diagnoseGpio', {
                ok: true,
                pin: pinStr,
                clockOn: clockOn ? 'YES' : 'NO (GPIO clock disabled!)',
                mode: modeStr,
                pull: pullStr,
                otype: otypeStr,
                speed: speedStr,
                af: 'n/a (F1: no AFRL/AFRH)',
                ODR: odrBit,
                IDR: idrBit,
                gpioEnReg: hex(gpioEnVal),
                raw_CRL: hex(crl),
                raw_CRH: hex(crh),
                raw_IDR: hex(idr),
                raw_ODR: hex(odr),
            });
        } else {
            // ── New GPIO model (F0/F4/G0/G4/H7) ──────────────────────────────────
            const afReg = pinNum < 8 ? base + GPIO.AFRL : base + GPIO.AFRH;
            const moderAddr = base + GPIO.MODER;

            // Warmup read
            await mdw1(moderAddr);
            const gpioEnVal = await mdw1(gpioEnReg);
            const moder = await mdw1(moderAddr);
            const otyper = await mdw1(base + GPIO.OTYPER);
            const ospeedr = await mdw1(base + GPIO.OSPEEDR);
            const pupdr = await mdw1(base + GPIO.PUPDR);
            const afr = await mdw1(afReg);
            const odr = await mdw1(base + GPIO.ODR);

            // Decode the original mode for the target pin
            const modeBits = (moder >> (pinNum * 2)) & 0x3;
            const modeStr = ['input', 'output', 'af', 'analog'][modeBits];
            const pullStr = ['none', 'up', 'down', 'reserved'][(pupdr >> (pinNum * 2)) & 0x3];
            const otypeStr = ((otyper >> pinNum) & 1) ? 'open-drain' : 'push-pull';
            const speedStr = ['low', 'medium', 'high', 'very-high'][(ospeedr >> (pinNum * 2)) & 0x3];
            const afVal = (afr >> ((pinNum < 8 ? pinNum : pinNum - 8) * 4)) & 0xF;
            const odrBit = (odr >> pinNum) & 1;
            const clockOn = !!((gpioEnVal >> gpioBit) & 1);

            // ── Read IDR — if pin is analog, temporarily switch to input ────────
            // In analog mode (MODER=11) the digital input buffer is disconnected,
            // IDR always reads 0 regardless of the actual pin level.
            // Temporarily clear the MODER bits for this pin → input (00),
            // wait for the digital buffer to settle, read IDR, then restore.
            let idr: number;
            let analogBypass = false;

            if (modeBits === 0x3) {
                // Pin is in analog mode — temporarily switch to input
                analogBypass = true;
                const pinMask = 0x3 << (pinNum * 2);  // bits to clear
                const parseWord = (r: string): number => {
                    const m = r.match(/0x[0-9a-f]+:\s+([0-9a-f]+)/i);
                    return m ? (parseInt(m[1], 16) >>> 0) : 0;
                };
                const step = await openocdBatch([
                    `mmw ${hex(moderAddr)} 0 ${hex(pinMask)}`,  // clear analog → input
                    'sleep 1',                                    // digital buffer settle time
                    `mdw ${hex(base + GPIO.IDR)} 1`,             // read IDR
                    `mww ${hex(moderAddr)} ${hex(moder)}`,       // restore original MODER
                ]);
                idr = parseWord(step[2]);
            } else {
                idr = await mdw1(base + GPIO.IDR);
            }

            const idrBit = (idr >> pinNum) & 1;

            this._send('result', 'diagnoseGpio', {
                ok: true,
                pin: pinStr,
                clockOn: clockOn ? 'YES' : 'NO (GPIO clock disabled!)',
                mode: modeStr,
                pull: pullStr,
                otype: otypeStr,
                speed: speedStr,
                af: `AF${afVal}`,
                ODR: odrBit,
                IDR: idrBit,
                analogBypass: analogBypass ? 'YES — pin was analog, temporarily switched to input for IDR read' : 'no',
                gpioEnReg: hex(gpioEnVal),
                raw_MODER: hex(moder),
                raw_OTYPER: hex(otyper),
                raw_OSPEEDR: hex(ospeedr),
                raw_PUPDR: hex(pupdr),
                raw_AFR: hex(afr),
                raw_ODR: hex(odr),
                raw_IDR: hex(idr),
            });
        }
    }

    private async _readGpio(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const port = (msg.port as string).toUpperCase();
        const base = gpioBase(chip, port);
        if (base === null) throw new Error(`Unknown GPIO port: GPIO${port}`);

        const gpioBit = chip.rcc.gpioEnBit[port];
        if (gpioBit === undefined) throw new Error(`No RCC bit for GPIO${port}`);

        const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
        const parseWord = (resp: string): number => {
            const m = resp.match(/0x[0-9a-f]+:\s+([0-9a-f]+)/i);
            return m ? (parseInt(m[1], 16) >>> 0) : 0;
        };
        // Enable GPIO clock (required for blank/erased chips)
        await openocdBatch([
            `mmw ${hex(chip.rcc.gpioEnReg)} ${hex(1 << gpioBit)} 0`,
        ]);

        let idr: number;
        let clockOn: boolean;
        let analogDetected = false;
        let activeMask = 0;

        if (chip.gpioModel === 'new') {
            // ── New GPIO model (G0/F0/F4/G4/H7) ───────────────────────────────
            // On STM32G0/F0, all pins reset to analog mode (MODER=0xFFFFFFFF).
            // In analog mode the digital input buffer is disconnected, so IDR
            // always reads 0 regardless of the actual pin level.
            // Fix: detect analog pins, temporarily switch to input (00), wait
            // for the digital buffer to stabilize, read IDR, then restore.
            //
            // IMPORTANT: We must NOT touch PA13/PA14 bits — those are SWD pins
            // (AF mode). We only clear bits that are currently set to 11 (analog).

            const moderAddr = base + GPIO.MODER;
            const idrAddr = base + GPIO.IDR;

            // Read MODER + RCC + PUPDR in one batch
            const step1 = await openocdBatch([
                `mdw ${hex(moderAddr)} 1`,
                `mdw ${hex(chip.rcc.gpioEnReg)} 1`,
                `mdw ${hex(base + GPIO.PUPDR)} 1`,
            ]);
            const moder = parseWord(step1[0]);
            const rccVal = parseWord(step1[1]);
            const pupdr = parseWord(step1[2]);
            clockOn = ((rccVal >> gpioBit) & 1) === 1;

            // Build mask of analog-mode pin pairs and compute active pins.
            // active means NOT Analog (0x3) AND NOT Floating Input (MODER=0, PUPDR=0).
            let analogMask = 0;
            for (let i = 0; i < 16; i++) {
                const bits = (moder >> (i * 2)) & 0x3;
                const pull = (pupdr >> (i * 2)) & 0x3;

                if (bits === 0x3) {
                    // Analog is the reset state for most pins on modern STM32s; treat as inactive
                    analogMask |= (0x3 << (i * 2));
                } else if (!(bits === 0x0 && pull === 0x0)) {
                    // Automatic filter: Ignore default SWD/JTAG pins if they are in their reset AF mode
                    const isPA13 = port === 'A' && i === 13;
                    const isPA14 = port === 'A' && i === 14;
                    const isPA15 = port === 'A' && i === 15;
                    const isPB3 = port === 'B' && i === 3;
                    const isPB4 = port === 'B' && i === 4;
                    if ((isPA13 || isPA14 || isPA15 || isPB3 || isPB4) && bits === 0x2) {
                        // Treat SWD/JTAG default Alternate Function as inactive in the UI
                    } else {
                        activeMask |= (1 << i);
                    }
                }
            }

            if (analogMask !== 0) {
                analogDetected = true;
                // Temporarily clear analog bits → input mode, wait 1ms, read IDR, restore
                const step2 = await openocdBatch([
                    `mmw ${hex(moderAddr)} 0 ${hex(analogMask)}`,  // clear analog bits → input
                    'sleep 1',                                      // wait for digital input buffer
                    `mdw ${hex(idrAddr)} 1`,                        // read IDR
                    `mww ${hex(moderAddr)} ${hex(moder)}`,          // restore original MODER
                ]);
                idr = parseWord(step2[2]);
            } else {
                // No analog pins — just read IDR directly
                const step2 = await openocdBatch([
                    `mdw ${hex(idrAddr)} 1`,
                ]);
                idr = parseWord(step2[0]);
            }
        } else {
            // F1 pins default to floating input, IDR always works.
            const step1 = await openocdBatch([
                `mdw ${hex(chip.rcc.gpioEnReg)} 1`,
                `mdw ${hex(base + GPIO_F1.IDR)} 1`,
                `mdw ${hex(base + GPIO_F1.CRL)} 1`,
                `mdw ${hex(base + GPIO_F1.CRH)} 1`,
            ]);
            const rccVal = parseWord(step1[0]);
            idr = parseWord(step1[1]);
            const crl = parseWord(step1[2]);
            const crh = parseWord(step1[3]);
            clockOn = ((rccVal >> gpioBit) & 1) === 1;

            for (let i = 0; i < 16; i++) {
                const shift = (i % 8) * 4;
                const reg = i < 8 ? crl : crh;
                const config = (reg >> shift) & 0xF;
                // 0x4 is Floating Input (reset state), 0x0 is Analog Input.
                // We consider these "inactive" / uninitialized.
                if (config !== 0x4 && config !== 0x0) {
                    const isPA13 = port === 'A' && i === 13;
                    const isPA14 = port === 'A' && i === 14;
                    const isPA15 = port === 'A' && i === 15;
                    const isPB3 = port === 'B' && i === 3;
                    const isPB4 = port === 'B' && i === 4;
                    // In F1, JTAG/SWD pins default to pull-up (0x8) or pull-down (0x8), PB3 defaults to floating/AF.
                    if ((isPA13 || isPA14 || isPA15 || isPB4) && config === 0x8) {
                        // Treat JTAG/SWD default as inactive
                    } else if (isPB3 && ((config & 0xC) === 0x8 || config === 0x4 || config === 0xB)) {
                        // Treat JTDO default as inactive
                    } else {
                        activeMask |= (1 << i);
                    }
                }
            }
        }

        const pins: Record<string, { state: string; active: boolean; isWarn?: boolean; warnMsg?: string }> = {};
        for (let i = 0; i < 16; i++) {
        // Tag SWD debug pins
            const isPA13 = port === 'A' && i === 13;
            const isPA14 = port === 'A' && i === 14;
            const isWarn = isPA13 || isPA14;
            let active = ((activeMask >> i) & 1) === 1;

            // Force them active so they are rendered, but flagged as warn
            if (isWarn) {
                active = true;
            }

            pins[`P${port}${i}`] = {
                state: (idr >> i) & 1 ? 'HIGH' : 'LOW',
                active: active,
                isWarn,
                warnMsg: isPA13 ? 'SWDIO (Pino nativo de Debug)' : (isPA14 ? 'SWCLK (Pino nativo de Debug)' : undefined)
            };
        }
        this._send('result', 'readGpio', {
            ok: true,
            port: `GPIO${port}`,
            idr: `0x${(idr & 0xFFFF).toString(16).padStart(4, '0')}`,
            clockEnabled: clockOn,
            analogDetected,
            pins,
        });
    }

    // ─── SPI ──────────────────────────────────────────────────────────────────

    private async _initSpi(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        await initSpi(chip, msg.peripheral as string, {
            sck: msg.sck as string,
            miso: msg.miso as string,
            mosi: msg.mosi as string,
            cs: msg.cs as string | undefined,
            speedHz: msg.speed ? parseInt(msg.speed as string) : 4_000_000,
            mode: ((msg.mode as number) ?? 0) as 0 | 1 | 2 | 3,
        });
        this._send('result', 'initSpi', { ok: true, peripheral: msg.peripheral, speed: msg.speed ?? 4000000 });
    }

    private async _spiTransfer(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const dataStr = (msg.data as string).trim();
        const data = dataStr.split(/[\s,]+/).map((s) => parseInt(s.startsWith('0x') ? s : `0x${s}`, 16));
        if (data.some(isNaN)) throw new Error('Invalid data bytes — use hex values like: 0x9F 0x00');

        const rx = await spiTransferBytes(chip, msg.peripheral as string, (msg.cs as string) || null, data);

        this._send('result', 'spiTransfer', {
            ok: true,
            tx: data.map((b) => `0x${b.toString(16).padStart(2, '0')}`),
            rx: rx.map((b) => `0x${b.toString(16).padStart(2, '0')}`),
            rx_dec: rx,
        });
    }

    // ─── I2C ──────────────────────────────────────────────────────────────────

    private async _initI2c(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        await initI2c(chip, msg.peripheral as string, {
            scl: msg.scl as string,
            sda: msg.sda as string,
            speedHz: (msg.speed ? parseInt(msg.speed as string) : 100_000) as 100000 | 400000,
        });
        this._send('result', 'initI2c', { ok: true, peripheral: msg.peripheral });
    }

    private async _i2cTx(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const addr = parseInt(msg.address as string, 16);
        const writeStr = (msg.write as string).trim();
        const writeBytes = writeStr
            ? writeStr.split(/[\s,]+/).map((s) => parseInt(s.startsWith('0x') ? s : `0x${s}`, 16))
            : [];
        const readCount = parseInt((msg.readCount as string) ?? '0');

        const rx = await i2cTx(chip, msg.peripheral as string, addr, writeBytes, readCount);

        const result: Record<string, unknown> = { ok: true, address: `0x${addr.toString(16).padStart(2, '0')}` };
        if (writeBytes.length) result['written'] = writeBytes.map((b) => `0x${b.toString(16).padStart(2, '0')}`);
        if (readCount > 0) {
            result['read_hex'] = rx.map((b) => `0x${b.toString(16).padStart(2, '0')}`);
            result['read_dec'] = rx;
            if (rx.every((b) => b === 0xFF)) result['warning'] = 'All 0xFF — possible NACK or missing device';
        }
        this._send('result', 'i2cTx', result);
    }

    // ─── Register ────────────────────────────────────────────────────────────

    private async _readReg(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const periph = (msg.peripheral as string).toUpperCase();
        const reg = (msg.register as string).toUpperCase();

        const base = this._resolveBase(chip, periph);
        const offset = this._resolveOffset(periph, reg);

        const addr = base + offset;
        const val = await mdw1(addr);

        this._send('result', 'readReg', {
            ok: true, peripheral: periph, register: reg,
            address: `0x${addr.toString(16).padStart(8, '0')}`,
            hex: `0x${val.toString(16).padStart(8, '0')}`,
            dec: val,
            bin: `0b${val.toString(2).padStart(32, '0')}`,
        });
    }

    private async _writeReg(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const periph = (msg.peripheral as string).toUpperCase();
        const reg = (msg.register as string).toUpperCase();

        const base = this._resolveBase(chip, periph);
        const offset = this._resolveOffset(periph, reg);
        const addr = base + offset;

        const prev = await mdw1(addr);
        let next: number;

        if (msg.setMask || msg.clearMask) {
            const set = msg.setMask ? parseInt(msg.setMask as string, 16) : 0;
            const clear = msg.clearMask ? parseInt(msg.clearMask as string, 16) : 0;
            next = (prev | set) & ~clear;
        } else {
            next = parseInt(msg.value as string, 16);
        }

        await mww(addr, next);
        this._send('result', 'writeReg', {
            ok: true, peripheral: periph, register: reg,
            address: `0x${addr.toString(16).padStart(8, '0')}`,
            prev: `0x${prev.toString(16).padStart(8, '0')}`,
            written: `0x${(next >>> 0).toString(16).padStart(8, '0')}`,
        });
    }

    private _resolveBase(chip: ChipDef, periph: string): number {
        const gpioMatch = periph.match(/^GPIO([A-F])$/);
        if (gpioMatch) {
            const b = gpioBase(chip, gpioMatch[1]);
            if (b === null) throw new Error(`Unknown GPIO port: ${periph}`);
            return b;
        }
        const b = chip.peripherals[periph];
        if (b === undefined) throw new Error(`Unknown peripheral: ${periph}`);
        return b;
    }

    private _resolveOffset(periph: string, reg: string): number {
    // Normalize: strip trailing port letter for GPIO (GPIOA → GPIO, GPIOB → GPIO)
    // and strip trailing digits for numbered peripherals (SPI1 → SPI, TIM2 → TIM).
    // Must handle GPIO first because GPIOA ends in a letter, not a digit.
        const prefix = /^GPIO[A-Z]$/.test(periph)
            ? 'GPIO'
            : periph.replace(/\d+$/, '');

        const maps: Record<string, Record<string, number>> = {
            // New GPIO model (F0/F4/G0/G4/H7) — MODER/OTYPER/OSPEEDR/PUPDR/IDR/ODR/BSRR/AFRL/AFRH/BRR
            GPIO: {
                ...GPIO,
                // F1 aliases — allow readReg on F1 GPIO ports using the same key 'GPIO'
                CRL: GPIO_F1.CRL, CRH: GPIO_F1.CRH,
                BRR: GPIO_F1.BRR, LCKR: GPIO_F1.LCKR,
            },
            SPI: { CR1: 0x00, CR2: 0x04, SR: 0x08, DR: 0x0C, CRCPR: 0x10, RXCRCR: 0x14, TXCRCR: 0x18, I2SCFGR: 0x1C, I2SPR: 0x20 },
            I2C: { CR1: 0x00, CR2: 0x04, OAR1: 0x08, OAR2: 0x0C, TIMINGR: 0x10, TIMEOUTR: 0x14, ISR: 0x18, ICR: 0x1C, PECR: 0x20, RXDR: 0x24, TXDR: 0x28 },
            TIM: { CR1: 0x00, CR2: 0x04, SMCR: 0x08, DIER: 0x0C, SR: 0x10, EGR: 0x14, CCMR1: 0x18, CCMR2: 0x1C, CCER: 0x20, CNT: 0x24, PSC: 0x28, ARR: 0x2C, RCR: 0x30, CCR1: 0x34, CCR2: 0x38, CCR3: 0x3C, CCR4: 0x40, BDTR: 0x44, DCR: 0x48, DMAR: 0x4C },
            CAN: { MCR: 0x00, MSR: 0x04, TSR: 0x08, RF0R: 0x0C, RF1R: 0x10, IER: 0x14, ESR: 0x18, BTR: 0x1C },
            RTC: { TR: 0x00, DR: 0x04, CR: 0x08, ISR: 0x0C, PRER: 0x10, WUTR: 0x14, ALRMAR: 0x1C, ALRMBR: 0x20, WPR: 0x24, SSR: 0x28, BKP0R: 0x50 },
            USART: { CR1: 0x00, CR2: 0x04, CR3: 0x08, BRR: 0x0C, GTPR: 0x10, RTOR: 0x14, RQR: 0x18, ISR: 0x1C, ICR: 0x20, RDR: 0x24, TDR: 0x28, SR: 0x00, DR: 0x04 },
            UART: { CR1: 0x00, CR2: 0x04, CR3: 0x08, BRR: 0x0C, GTPR: 0x10, RTOR: 0x14, RQR: 0x18, ISR: 0x1C, ICR: 0x20, RDR: 0x24, TDR: 0x28, SR: 0x00, DR: 0x04 },
            RCC: {},
        };
        const map = maps[prefix] ?? maps[periph] ?? {};
        const off = map[reg];
        if (off === undefined) throw new Error(`Unknown register: ${periph}.${reg}`);
        return off;
    }

    // ─── PWM ──────────────────────────────────────────────────────────────────

    private _getValidPwmPins(msg: Record<string, unknown>): void {
        const chip = this._chip(msg.chip as string);
        const timer = msg.timer as string;
        const channel = parseInt(msg.channel as string);
        const signal = `CH${channel}`;
        const pins = validPinsForSignal(chip, timer, signal);
        this._panel.webview.postMessage({ type: 'validPwmPins', data: { pins } });
    }

    private async _initPwm(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const timer = msg.timer as string;
        const channel = parseInt(msg.channel as string) as 1 | 2 | 3 | 4;
        const pin = (msg.pin as string).toUpperCase();
        const signal = `CH${channel}`;

        const af = lookupAF(chip, timer, signal, pin);
        if (af === null) {
            const valid = validPinsForSignal(chip, timer, signal);
            const hint = valid.length > 0
                ? `Valid pins for ${timer}_${signal} on ${chip.family}: ${valid.join(', ')}`
                : `${timer}_${signal} has no mapped pins for ${chip.family}`;
            throw new Error(`No AF for ${timer}_${signal} on ${pin} — ${hint}`);
        }

        await initPwm(chip, timer, {
            pin,
            channel,
            frequencyHz: parseInt(msg.frequency as string),
            dutyPercent: parseInt(msg.duty as string),
        });
        this._send('result', 'initPwm', { ok: true, timer, pin, frequency: msg.frequency, duty: msg.duty });
    }

    // ─── USART ────────────────────────────────────────────────────────────────────

    private async _initUsart(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const periphName = (msg.peripheral as string).toUpperCase();
        const txPin = (msg.tx as string).toUpperCase();
        const rxPin = (msg.rx as string).toUpperCase();
        const baud = parseInt(msg.baud as string);

        const base = chip.peripherals[periphName];
        if (!base) throw new Error(`Unknown USART: ${periphName} — not available on ${chip.family}`);

        const txP = parsePin(txPin);
        const rxP = parsePin(rxPin);
        if (!txP) throw new Error(`Invalid TX pin: ${txPin}`);
        if (!rxP) throw new Error(`Invalid RX pin: ${rxPin}`);

        // For legacy chips (F1/F4), UART4/5/USART6 use AF8; others AF7.
        // For new-model chips (G0/F0), most USART use AF1.
        const isLegacy = chip.i2cModel === 'legacy';
        const fallbackAf = isLegacy
            ? (periphName === 'UART4' || periphName === 'UART5' || periphName === 'USART6' ? 8 : 7)
            : 1;

        const txAf = lookupAF(chip, periphName, 'TX', txPin) ?? fallbackAf;
        const rxAf = lookupAF(chip, periphName, 'RX', rxPin) ?? fallbackAf;

        await configPin(chip, txP.port, txP.pin, 'af', 'none', 'high', 'push-pull', txAf);
        await configPin(chip, rxP.port, rxP.pin, 'af', 'up', 'high', 'push-pull', rxAf);

        await enablePeriphClock(chip, periphName);

        // BRR = fPCLK / baud  (oversampling by 16, the reset-state default)
        const brr = Math.round(chip.defaultClockHz / baud);

        if (isLegacy) {
            // F1/F4 USART: SR at 0x00, DR at 0x04, BRR at 0x08, CR1 at 0x0C
            // CR1: UE=bit13, TE=bit3, RE=bit2  → 0x200C
            await mww(base + USART_REG_LEGACY.CR1, 0);
            await mww(base + USART_REG_LEGACY.BRR, brr);
            await mww(base + USART_REG_LEGACY.CR1, 0x200C);
        } else {
            // G0/F0 USART: CR1 at 0x00, BRR at 0x0C
            // CR1: UE=bit0, RE=bit2, TE=bit3  → 0x000D
            await mww(base + USART_REG.CR1, 0);
            await mww(base + USART_REG.BRR, brr);
            await mww(base + USART_REG.CR1, 0x000D);
        }

        this._send('result', 'initUsart', {
            ok: true, peripheral: periphName, baud,
            brr: `0x${brr.toString(16)}`,
            model: isLegacy ? 'legacy (F1/F4)' : 'new (G0/F0)',
        });
    }

    private async _usartTx(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const periphName = (msg.peripheral as string).toUpperCase();
        const dataStr = (msg.data as string).trim();
        const bytes = dataStr.split(/[\s,]+/).map((s) => parseInt(s.startsWith('0x') ? s : `0x${s}`, 16));
        if (bytes.some(isNaN)) throw new Error('Invalid data bytes — use hex values like: 0x48 0x65 0x6C');

        const base = chip.peripherals[periphName];
        if (!base) throw new Error(`Unknown USART: ${periphName}`);

        const isLegacy = chip.i2cModel === 'legacy';
        const dataReg = isLegacy ? (base + USART_REG_LEGACY.DR) : (base + USART_REG.TDR);

        // Write each byte with 2 ms gap (safe at any common baud rate)
        const cmds: string[] = [];
        for (const byte of bytes) {
            cmds.push(`mww 0x${dataReg.toString(16)} 0x${byte.toString(16)}`);
            cmds.push('sleep 2');
        }
        await openocdBatch(cmds);

        this._send('result', 'usartTx', {
            ok: true, peripheral: periphName, count: bytes.length,
            bytes: bytes.map((b) => `0x${b.toString(16).padStart(2, '0')}`),
        });
    }

    // ─── CAN ──────────────────────────────────────────────────────────────────────

    private async _initCan(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const periphName = (msg.peripheral as string).toUpperCase();
        const txPin = (msg.tx as string).toUpperCase();
        const rxPin = (msg.rx as string).toUpperCase();
        const psc = Math.max(1, parseInt(msg.psc as string));
        const bs1 = Math.max(1, parseInt(msg.bs1 as string));
        const bs2 = Math.max(1, parseInt(msg.bs2 as string));

        const base = chip.peripherals[periphName];
        if (!base) throw new Error(`${periphName} not available on ${chip.family}`);

        // Configure GPIO pins
        const txP = parsePin(txPin);
        const rxP = parsePin(rxPin);
        if (!txP) throw new Error(`Invalid CAN TX pin: ${txPin}`);
        if (!rxP) throw new Error(`Invalid CAN RX pin: ${rxPin}`);

        // F4 uses AF9 for CAN; F1 uses implicit AF via CRL/CRH (AF=0 sentinel)
        const canAf = chip.gpioModel === 'new' ? (lookupAF(chip, periphName, 'TX', txPin) ?? 9) : 0;
        const rxAf = chip.gpioModel === 'new' ? (lookupAF(chip, periphName, 'RX', rxPin) ?? 9) : 0;
        await configPin(chip, txP.port, txP.pin, 'af', 'none', 'high', 'push-pull', canAf);
        await configPin(chip, rxP.port, rxP.pin, 'af', 'up', 'high', 'push-pull', rxAf);

        await enablePeriphClock(chip, periphName);

        const MCR = base + CAN_REG.MCR;
        const BTR = base + CAN_REG.BTR;
        const MSR = base + CAN_REG.MSR;
        const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;

        // BTR[9:0]=prescaler-1, [19:16]=BS1-1, [22:20]=BS2-1, [25:24]=SJW-1(=0)
        const btr = ((psc - 1) & 0x3FF)
              | (((bs1 - 1) & 0xF) << 16)
              | (((bs2 - 1) & 0x7) << 20);

        // Single batch: enter init mode → wait → write BTR → exit init → wait → read MSR
        // mmw(MCR, INRQ=1, SLEEP=0) uses atomic set/clear so we don't need to read MCR first.
        const results = await openocdBatch([
            `mmw ${hex(MCR)} 0x1 0x2`,   // INRQ=1, SLEEP=0
            'sleep 5',
            `mww ${hex(BTR)} ${hex(btr)}`,
            `mmw ${hex(MCR)} 0 0x3`,     // clear INRQ + SLEEP (leave init mode)
            'sleep 5',
            `mdw ${hex(MSR)} 1`,
        ]);
        const msrMatch = results[5].match(/0x[0-9a-f]+:\s+([0-9a-f]+)/i);
        const msr = msrMatch ? (parseInt(msrMatch[1], 16) >>> 0) : 0;
        this._send('result', 'initCan', {
            ok: true, peripheral: periphName,
            BTR: `0x${btr.toString(16).padStart(8, '0')}`,
            MSR: `0x${msr.toString(16).padStart(8, '0')}`,
            mode: (msr & 1) ? 'init' : 'normal',
        });
    }

    private async _setCanFilter(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const periphName = (msg.peripheral as string).toUpperCase();
        const base = chip.peripherals[periphName];
        if (!base) throw new Error(`${periphName} not available on ${chip.family}`);

        // bxCAN filter banks are always controlled via CAN1 base address
        const can1Base = chip.peripherals['CAN1'] ?? base;
        const bank = Math.min(13, Math.max(0, parseInt(msg.bank as string) || 0));
        const mode = (msg.mode as string) === 'list' ? 1 : 0;   // 0=mask, 1=list
        const scale = (msg.scale as string) === '16' ? 0 : 1;    // 1=32-bit, 0=16-bit
        const fifo = (msg.fifo as string) === '1' ? 1 : 0;
        const id = (parseInt(msg.id as string, 16) >>> 0);
        const mask = (parseInt(msg.mask as string, 16) >>> 0);
        const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;

        const FMR = can1Base + CAN_REG.FMR;
        const FM1R = can1Base + CAN_REG.FM1R;
        const FS1R = can1Base + CAN_REG.FS1R;
        const FFA1R = can1Base + CAN_REG.FFA1R;
        const FA1R = can1Base + CAN_REG.FA1R;
        const FR1 = can1Base + CAN_REG.F0R1 + bank * 8;
        const FR2 = can1Base + CAN_REG.F0R2 + bank * 8;
        const bit = 1 << bank;

        await openocdBatch([
            `mmw ${hex(FMR)} 0x1 0`,           // FINIT=1 (filter init mode)
            `mmw ${hex(FA1R)} 0 ${hex(bit)}`,   // deactivate bank
            mode ? `mmw ${hex(FM1R)} ${hex(bit)} 0` : `mmw ${hex(FM1R)} 0 ${hex(bit)}`,
            scale ? `mmw ${hex(FS1R)} ${hex(bit)} 0` : `mmw ${hex(FS1R)} 0 ${hex(bit)}`,
            fifo ? `mmw ${hex(FFA1R)} ${hex(bit)} 0` : `mmw ${hex(FFA1R)} 0 ${hex(bit)}`,
            `mww ${hex(FR1)} ${hex(id)}`,
            `mww ${hex(FR2)} ${hex(mask)}`,
            `mmw ${hex(FA1R)} ${hex(bit)} 0`,   // activate bank
            `mmw ${hex(FMR)} 0 0x1`,            // FINIT=0 (leave filter init)
        ]);

        const modeStr = mode ? 'list' : 'mask';
        const scaleStr = scale ? '32-bit' : '16-bit';
        this._send('result', 'setCanFilter', {
            ok: true, bank, mode: modeStr, scale: scaleStr, fifo,
            id: hex(id), mask: hex(mask),
        });
    }

    private async _canStatus(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const periphName = (msg.peripheral as string).toUpperCase();

        const base = chip.peripherals[periphName];
        if (!base) throw new Error(`${periphName} not available on ${chip.family}`);

        const [mcr, msr, esr] = await Promise.all([
            mdw1(base + CAN_REG.MCR),
            mdw1(base + CAN_REG.MSR),
            mdw1(base + CAN_REG.ESR),
        ]);

        const txec = (esr >> 16) & 0xFF;
        const rxec = (esr >> 24) & 0xFF;
        const lec = (esr >> 4) & 0x7;
        const lecNames = ['no error', 'stuff error', 'form error', 'ack error', 'bit recessive', 'bit dominant', 'CRC error', 'set by sw'];

        this._send('result', 'canStatus', {
            ok: true, peripheral: periphName,
            MCR: `0x${mcr.toString(16).padStart(8, '0')}`,
            MSR: `0x${msr.toString(16).padStart(8, '0')}`,
            ESR: `0x${esr.toString(16).padStart(8, '0')}`,
            mode: (msr & 0x1) ? 'INIT' : (msr & 0x2) ? 'SLEEP' : 'NORMAL',
            BOFF: esr & 0x4 ? 'BUS-OFF' : 'ok',
            EPVF: esr & 0x2 ? 'error-passive' : 'ok',
            EWGF: esr & 0x1 ? 'error-warning' : 'ok',
            TxErrors: txec,
            RxErrors: rxec,
            LEC: `${lec} — ${lecNames[lec]}`,
        });
    }

    // ─── RTC ──────────────────────────────────────────────────────────────────────

    private async _rtcRead(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const base = chip.peripherals['RTC'];
        if (!base) throw new Error(`RTC not in peripheral map for ${chip.family}`);

        const CR = base + RTC_REG.CR;
        const ISR = base + RTC_REG.ISR;
        const WPR = base + RTC_REG.WPR;
        const TR = base + RTC_REG.TR;
        const DR = base + RTC_REG.DR;
        const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
        const parseWord = (resp: string): number => {
            const m = resp.match(/0x[0-9a-f]+:\s+([0-9a-f]+)/i);
            return m ? (parseInt(m[1], 16) >>> 0) : 0;
        };

        // ── Batch 1: read current state (PWR_CR, APB1EN, CR, ISR) in one connection ──
        const apb1En = chip.rcc.apb1EnReg;
        const [apb1Resp, pwrCrResp, crResp] = await openocdBatch([
            `mdw ${hex(apb1En)} 1`,
            `mdw ${hex(0x40007000)} 1`,
            `mdw ${hex(CR)} 1`,
        ]);
        const apb1EnVal = parseWord(apb1Resp);
        const pwrCrVal = parseWord(pwrCrResp);
        const cr0 = parseWord(crResp);
        const usedBypsshad = !(cr0 & (1 << 5));

        // ── Batch 2: enable PWR clock, DBP, unlock WPR, set BYPSHAD, clear RSF ──
        const setupCmds: string[] = [
            `mww ${hex(apb1En)} ${hex(apb1EnVal | (1 << 28))}`,
            `mww ${hex(0x40007000)} ${hex(pwrCrVal | (1 << 8))}`,
            `mww ${hex(WPR)} 0xCA`,
            `mww ${hex(WPR)} 0x53`,
        ];
        if (usedBypsshad) setupCmds.push(`mww ${hex(CR)} ${hex(cr0 | (1 << 5))}`);
        setupCmds.push(`mww ${hex(ISR)} 0`);  // clear RSF (write 0 clears all clearable bits)
        setupCmds.push(`sleep 200`);          // wait for shadow sync (much longer than 20× polling)
        setupCmds.push(`mdw ${hex(ISR)} 1`);
        setupCmds.push(`mdw ${hex(TR)} 1`);
        setupCmds.push(`mdw ${hex(DR)} 1`);
        if (usedBypsshad) setupCmds.push(`mww ${hex(CR)} ${hex(cr0)}`);
        setupCmds.push(`mww ${hex(WPR)} 0xFF`);

        const results = await openocdBatch(setupCmds);
        // Responses of interest are the last mdw ones — find them by position
        const isrResp = results[usedBypsshad ? 7 : 6];
        const trResp = results[usedBypsshad ? 8 : 7];
        const drResp = results[usedBypsshad ? 9 : 8];
        const rsfOk = (parseWord(isrResp) & (1 << 5)) !== 0;
        const tr = parseWord(trResp);
        const dr = parseWord(drResp);

        // TR: [3:0]=sec units, [6:4]=sec tens, [11:8]=min units, [14:12]=min tens,
        //     [19:16]=hour units, [21:20]=hour tens, [22]=PM (12h mode)
        const seconds = ((tr >> 4) & 0x7) * 10 + (tr & 0xF);
        const minutes = ((tr >> 12) & 0x7) * 10 + ((tr >> 8) & 0xF);
        const hours = ((tr >> 20) & 0x3) * 10 + ((tr >> 16) & 0xF);
        const pm = (tr >> 22) & 0x1;

        // DR: [3:0]=day units, [5:4]=day tens, [8]=week day bit0, [10:8]=weekday,
        //     [11:8]=month units, [12]=month tens, [23:16]=year (BCD)
        const day = ((dr >> 4) & 0x3) * 10 + (dr & 0xF);
        const month = ((dr >> 12) & 0x1) * 10 + ((dr >> 8) & 0xF);
        const year = 2000 + ((dr >> 20) & 0xF) * 10 + ((dr >> 16) & 0xF);
        const wday = (dr >> 13) & 0x7;
        const weekDays = ['—', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

        const pad = (n: number) => String(n).padStart(2, '0');
        const timeStr = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${pm ? ' PM' : ''}`;
        const dateStr = `${pad(day)}/${pad(month)}/${year} (${weekDays[wday] ?? '?'})`;

        this._send('result', 'rtcRead', {
            ok: true, time: timeStr, date: dateStr,
            TR: `0x${tr.toString(16).padStart(8, '0')}`,
            DR: `0x${dr.toString(16).padStart(8, '0')}`,
            rsf: rsfOk ? 'synced' : 'timeout (shadow reg may be stale)',
            bypshad: usedBypsshad ? 'used' : 'already active',
        });
    }

    private async _rtcReadSsr(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const base = chip.peripherals['RTC'];
        if (!base) throw new Error(`RTC not in peripheral map for ${chip.family}`);

        const ssr = await mdw1(base + RTC_REG.SSR);
        const prer = await mdw1(base + RTC_REG.PRER);
        const predivS = prer & 0x7FFF;

        this._send('result', 'rtcReadSsr', {
            ok: true,
            SSR: `0x${ssr.toString(16).padStart(8, '0')}`,
            PRER: `0x${prer.toString(16).padStart(8, '0')}`,
            PREDIV_S: predivS,
            subseconds: ssr,
            note: `fraction = (PREDIV_S − SSR) / (PREDIV_S + 1)`,
        });
    }

    private async _rtcBkpRead(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const base = chip.peripherals['RTC'];
        if (!base) throw new Error(`RTC not in peripheral map for ${chip.family}`);

        const index = parseInt(msg.index as string);
        if (index < 0 || index > 19) throw new Error('BKP index must be 0–19');

        const addr = base + RTC_REG.BKP0R + index * 4;
        const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;

        // Single batch: enable PWR clock, set DBP, read BKP register
        const results = await openocdBatch([
            `mmw ${hex(chip.rcc.apb1EnReg)} 0x10000000 0`,  // set bit 28 (PWREN)
            `mmw ${hex(0x40007000)} 0x100 0`,               // set bit 8 (DBP)
            `mdw ${hex(addr)} 1`,
        ]);
        const m = results[2].match(/0x[0-9a-f]+:\s+([0-9a-f]+)/i);
        const val = m ? (parseInt(m[1], 16) >>> 0) : 0;

        this._send('result', 'rtcBkpRead', {
            ok: true, index,
            address: `0x${addr.toString(16).padStart(8, '0')}`,
            value: `0x${val.toString(16).padStart(8, '0')}`,
            dec: val,
        });
    }

    private async _rtcBkpWrite(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const base = chip.peripherals['RTC'];
        if (!base) throw new Error(`RTC not in peripheral map for ${chip.family}`);

        const index = parseInt(msg.index as string);
        const valStr = (msg.value as string ?? '').trim();
        if (index < 0 || index > 19) throw new Error('BKP index must be 0–19');
        if (!valStr) throw new Error('Value required for BKP write');
        const value = parseInt(valStr.startsWith('0x') ? valStr : `0x${valStr}`, 16);
        if (isNaN(value)) throw new Error(`Invalid value: ${valStr}`);

        const addr = base + RTC_REG.BKP0R + index * 4;
        const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;

        // Single batch: enable PWR + DBP, read previous, write new
        const results = await openocdBatch([
            `mmw ${hex(chip.rcc.apb1EnReg)} 0x10000000 0`,  // PWREN
            `mmw ${hex(0x40007000)} 0x100 0`,               // DBP
            `mdw ${hex(addr)} 1`,
            `mww ${hex(addr)} ${hex(value)}`,
        ]);
        const m = results[2].match(/0x[0-9a-f]+:\s+([0-9a-f]+)/i);
        const prev = m ? (parseInt(m[1], 16) >>> 0) : 0;

        this._send('result', 'rtcBkpWrite', {
            ok: true, index,
            address: `0x${addr.toString(16).padStart(8, '0')}`,
            prev: `0x${prev.toString(16).padStart(8, '0')}`,
            written: `0x${(value >>> 0).toString(16).padStart(8, '0')}`,
        });
    }

    private async _rtcSet(msg: Record<string, unknown>): Promise<void> {
        const chip = this._chip(msg.chip as string);
        const base = chip.peripherals['RTC'];
        if (!base) throw new Error(`RTC not in peripheral map for ${chip.family}`);

        const hour = parseInt(msg.hour as string);
        const min = parseInt(msg.min as string);
        const sec = parseInt(msg.sec as string);
        const day = parseInt(msg.day as string);
        const month = parseInt(msg.month as string);
        const year = parseInt(msg.year as string);
        const wday = parseInt(msg.wday as string);

        if (hour > 23 || min > 59 || sec > 59) throw new Error('Hora inválida');
        if (day < 1 || day > 31 || month < 1 || month > 12) throw new Error('Data inválida');
        if (year < 0 || year > 99) throw new Error('Ano deve ser 0–99');

        const bcd = (n: number) => ((Math.floor(n / 10) << 4) | (n % 10));
        const tr = (bcd(sec) & 0x7F) | ((bcd(min) & 0x7F) << 8) | ((bcd(hour) & 0x3F) << 16);
        const dr = (bcd(day) & 0x3F) | ((bcd(month) & 0x1F) << 8) | ((wday & 0x7) << 13) | ((bcd(year) & 0xFF) << 16);

        const bdcrOff = chip.rcc.base === 0x40023800 ? 0x70 : 0x20;
        const csrOff = chip.rcc.base === 0x40023800 ? 0x74 : 0x24;
        const cfgrOff = chip.rcc.base === 0x40023800 ? 0x08 : 0x04;  // RCC_CFGR (for RTCPRE on F4)
        const crOff = chip.rcc.base === 0x40023800 ? 0x00 : 0x00;  // RCC_CR (for HSEON/HSERDY)
        const RCC_BDCR = chip.rcc.base + bdcrOff;
        const RCC_CSR = chip.rcc.base + csrOff;
        const RCC_CFGR = chip.rcc.base + cfgrOff;
        const RCC_CR = chip.rcc.base + crOff;
        const PWR_CR = 0x40007000;
        const WPR = base + RTC_REG.WPR;
        const ISR = base + RTC_REG.ISR;
        const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
        const parseWord = (resp: string): number => {
            const m = resp.match(/0x[0-9a-f]+:\s+([0-9a-f]+)/i);
            return m ? (parseInt(m[1], 16) >>> 0) : 0;
        };

        // ── Clock source configuration ──────────────────────────────────────────
        // RTCSEL[9:8]: 00=no clock, 01=LSE, 10=LSI, 11=HSE_RTC
        // For accurate 1Hz:
        //   LSE  (32768 Hz):    PREDIV_A=127, PREDIV_S=255  → 32768/(128*256)=1Hz exactly
        //   LSI  (~32000 Hz):   PREDIV_A=127, PREDIV_S=249  → 32000/(128*250)=1Hz nominal
        //   HSE/25 (1 MHz):     PREDIV_A=99,  PREDIV_S=9999 → 1000000/(100*10000)=1Hz exactly
        const clockSrc = (msg.clockSrc as string) || 'LSE';
        // If the board has no 32.768 kHz crystal, LSE never becomes ready.
        // In this case we can retry with LSI to keep RTC setup usable.
        const autoFallbackLsi = msg.autoFallbackLsi !== false;
        let rtcSelBits: number;
        let predivA: number;
        let predivS: number;
        const clockSetupCmds: string[] = [];

        if (clockSrc === 'LSE') {
            rtcSelBits = 0x1 << 8;
            predivA = 127;
            predivS = 255;
            // LSE setup is handled below in a dedicated poll loop
        } else if (clockSrc === 'HSE_DIV25') {
            rtcSelBits = 0x3 << 8;
            predivA = 99;
            predivS = 9999;
            // Enable HSE (HSEON=bit16 of RCC_CR), wait for HSERDY (bit17)
            clockSetupCmds.push(`mmw ${hex(RCC_CR)} 0x10000 0`);  // HSEON=1
            clockSetupCmds.push('sleep 100');
            // RCC_CFGR RTCPRE = bits [20:16], divides HSE down to ≤1 MHz before RTC
            // For 25 MHz HSE: RTCPRE=25 → 1 MHz
            clockSetupCmds.push(`mmw ${hex(RCC_CFGR)} 0x190000 0x1F0000`);  // RTCPRE = 25 (0x19)
        } else {
            // LSI
            rtcSelBits = 0x2 << 8;
            predivA = 127;
            predivS = 249;
            clockSetupCmds.push(`mmw ${hex(RCC_CSR)} 1 0`);  // LSION=1
            clockSetupCmds.push('sleep 50');
        }
        const bdcrVal = rtcSelBits | (1 << 15);  // RTCSEL + RTCEN

        // ── Batch 1a: halt + unlock backup domain (PWREN + DBP with readback) ─────
        await this._unlockBackupDomain(chip, PWR_CR);

        // ── Batch 1b: backup-domain reset ──────────────────────────────────────────
        // After BDRST the entire BDCR goes to 0. We must re-assert DBP because the
        // write-path to BDCR can be momentarily gated after a backup-domain reset.
        await openocdBatch([
            `mmw ${hex(RCC_BDCR)} 0x10000 0`,               // BDRST=1
            'sleep 10',
            `mmw ${hex(RCC_BDCR)} 0 0x10000`,               // BDRST=0
            'sleep 5',
            // Re-assert PWREN + DBP after BDRST (essential on many STM32 families)
            `mmw ${hex(chip.rcc.apb1EnReg)} 0x10000000 0`,  // PWREN=1
            `mmw ${hex(PWR_CR)} 0x100 0`,                   // DBP=1
            'sleep 5',
        ]);

        // ── Batch 1c: clock setup + RTCSEL+RTCEN ───────────────────────────────────
        if (clockSrc === 'LSE') {
            // Set LSE drive to HIGH for reliable crystal startup (LSEDRV bits [4:3])
            // Then enable LSEON and poll LSERDY in short intervals to avoid telnet timeout.
            await openocdBatch([
                `mmw ${hex(RCC_BDCR)} 0x18 0`,   // LSEDRV=HIGH (bits 4:3 = 11)
                `mmw ${hex(RCC_BDCR)} 0x1 0`,    // LSEON=1
            ]);

            // Poll LSERDY in short intervals — LSE can take up to 2 s to stabilize.
            // Using multiple short batches avoids telnet timeout/connection-drop.
            let lserdy = false;
            const MAX_LSE_POLLS = 8;           // 8 × 500 ms = 4 s max
            for (let i = 0; i < MAX_LSE_POLLS && !lserdy; i++) {
                const pollResults = await openocdBatch([
                    'sleep 500',
                    `mdw ${hex(RCC_BDCR)} 1`,
                ]);
                // pollResults[0] = sleep echo (empty), pollResults[1] = mdw response
                const bdcrNow = parseWord(pollResults[1] || pollResults[0] || '');
                lserdy = ((bdcrNow >> 1) & 1) === 1;
                if (!lserdy) {
                    this._panel.webview.postMessage({
                        type: 'ocdLog',
                        data: `[rtcSet] LSE poll ${i + 1}/${MAX_LSE_POLLS}: BDCR=0x${bdcrNow.toString(16).padStart(8, '0')} (LSERDY=0, aguardando…)`,
                    });
                }
            }

            if (!lserdy) {
                // Final readback for diagnostics
                const [pwrCrResp, bdcrResp2] = await openocdBatch([
                    `mdw ${hex(PWR_CR)} 1`,
                    `mdw ${hex(RCC_BDCR)} 1`,
                ]);
                const pwrCrCheck = parseWord(pwrCrResp);
                const bdcrCheck = parseWord(bdcrResp2);
                const dbp = (pwrCrCheck >> 8) & 1;
                const lseon = bdcrCheck & 1;

                if (autoFallbackLsi) {
                    this._panel.webview.postMessage({
                        type: 'ocdLog',
                        data:
              `⚠ rtcSet: LSE não iniciou (LSERDY=0, BDCR=0x${bdcrCheck.toString(16).padStart(8, '0')}, `
              + `DBP=${dbp}, LSEON=${lseon}). Tentando fallback automático para LSI…`,
                    });
                    await openocdBatch([`mww ${hex(WPR)} 0xFF`]).catch(() => {});
                    return this._rtcSet({ ...msg, clockSrc: 'LSI', autoFallbackLsi: false });
                }
                await openocdBatch([`mww ${hex(WPR)} 0xFF`]).catch(() => {});
                throw new Error(
                    `LSE não iniciou (LSERDY=0). `
          + `DBP=${dbp} LSEON=${lseon} BDCR=0x${bdcrCheck.toString(16).padStart(8, '0')}.\n`
          + (dbp === 0
              ? `DBP=0: proteção do backup domain ativa — verifique PWREN/PWR_CR.`
              : lseon === 0
                  ? `LSEON=0: escrita no BDCR falhou mesmo com DBP=1. Verifique o hardware e o clock APB1.`
                  : `Verifique o cristal de 32768Hz na placa ou selecione LSI.`)
                );
            }
        } else {
            // HSE or LSI — just run the setup commands
            if (clockSetupCmds.length) {
                await openocdBatch(clockSetupCmds);
            }
        }

        // Set RTCSEL + RTCEN (without clearing LSEON/LSION/HSEON bits)
        await openocdBatch([
            `mmw ${hex(RCC_BDCR)} ${hex(bdcrVal)} 0x8300`,  // set RTCSEL+RTCEN, clear only other RTCSEL bits
            'sleep 10',                                     // let RTC clock settle
        ]);

        // (LSE/LSI/HSE clock readiness already verified above)

        // ── Batch 2: unlock WPR + enter INIT mode + wait for INITF ──
        // Single connection, polling done inside OpenOCD via sleep + read sequence.
        const initResults = await openocdBatch([
            `mww ${hex(WPR)} 0xCA`,
            `mww ${hex(WPR)} 0x53`,
            `mww ${hex(ISR)} 0x80`,                         // INIT=1
            'sleep 200',                                    // wait up to 200ms for INITF
            `mdw ${hex(ISR)} 1`,
        ]);
        const isrAfterInit = parseWord(initResults[4]);
        if (!(isrAfterInit & (1 << 6))) {
            const bdcrDbg = parseWord((await openocdBatch([`mdw ${hex(RCC_BDCR)} 1`]))[0]);
            await openocdBatch([`mww ${hex(WPR)} 0xFF`]);   // lock WPR
            throw new Error(`RTC INITF timeout (clock=${clockSrc}). ISR=0x${isrAfterInit.toString(16)} BDCR=0x${bdcrDbg.toString(16)}`);
        }

        // ── Batch 3: write PRER, TR, DR, exit INIT, lock WPR, wait RSF, read back ──
        const writeResults = await openocdBatch([
            `mww ${hex(base + RTC_REG.PRER)} ${hex((predivA << 16) | predivS)}`,
            `mww ${hex(base + RTC_REG.TR)} ${hex(tr)}`,
            `mww ${hex(base + RTC_REG.DR)} ${hex(dr)}`,
            `mmw ${hex(ISR)} 0 0x80`,                       // INIT=0 (exit init mode)
            `mww ${hex(WPR)} 0xFF`,                         // lock WPR
            'sleep 200',                                    // wait for RSF
            `mdw ${hex(ISR)} 1`,
            `mdw ${hex(base + RTC_REG.TR)} 1`,
        ]);
        const rsfOk = (parseWord(writeResults[6]) & (1 << 5)) !== 0;
        const trBack = rsfOk ? parseWord(writeResults[7]) : 0;

        const pad2 = (n: number) => String(n).padStart(2, '0');
        const wdays = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        this._send('result', 'rtcSet', {
            ok: true,
            clockSrc,
            time: `${pad2(hour)}:${pad2(min)}:${pad2(sec)}`,
            date: `${pad2(day)}/${pad2(month)}/20${pad2(year)} (${wdays[wday]})`,
            TR_written: `0x${tr.toString(16).padStart(8, '0')}`,
            TR_readback: `0x${trBack.toString(16).padStart(8, '0')}`,
            DR: `0x${dr.toString(16).padStart(8, '0')}`,
            match: tr === trBack ? 'OK' : `MISMATCH — escrita falhou?`,
        });
    }

    // ─── Target control ───────────────────────────────────────────────────────────

    private async _haltTarget(): Promise<void> {
    // On STM32F4, DBGMCU lets the debugger freeze peripherals on halt so the
    // watchdog does not expire and reset the chip while paused.
    // DBGMCU_APB1_FZ (0xE0042008):
    //   bit 12 = DBG_IWDG_STOP  (Independent Watchdog stops on halt)
    //   bit 11 = DBG_WWDG_STOP  (Window Watchdog stops on halt)
    //   bit 0-2 = DBG_TIMx_STOP
    // Set these BEFORE halting so any currently-counting IWDG freezes immediately.
        const resp = await openocdBatch([
            'mmw 0xE0042008 0x1800 0',  // freeze IWDG + WWDG on halt
            'halt',
        ]);
        this._send('result', 'haltTarget', { ok: true, response: resp.join(' | ').trim() });
    }

    private async _resumeTarget(): Promise<void> {
        const resp = await openocdSend('resume');
        this._send('result', 'resumeTarget', { ok: true, response: resp.trim() });
    }

    private async _resetTarget(): Promise<void> {
        const resp = await openocdSend('reset run');
        this._send('result', 'resetTarget', { ok: true, response: resp.trim() });
    }

    private async _eraseFlash(): Promise<void> {
    // halt first so the chip is not executing from flash during erase
        await openocdSend('halt');
        // probe flash bank 0 to ensure OpenOCD knows the flash layout
        await openocdSend('flash probe 0');
        // Full mass_erase on STM32F4 (up to 1 MB) can take 15-30s; allow 60s timeout.
        const resp = await openocdSend('stm32f4x mass_erase 0', 60000);
        this._send('result', 'eraseFlash', { ok: true, response: resp.trim() });
    }

    // ─── HTML helpers ─────────────────────────────────────────────────────────

    /** Custom compact pin picker: 8 ports × 16 pins in a horizontal grid. */
    private _pinSelect(id: string, defaultPin: string, includeNone = false, multiSelect = false): string {
        const ports = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
        let grid = '';
        for (const p of ports) {
            grid += `<div class="pin-col"><div class="pin-col-hdr">${p}</div>`;
            for (let n = 0; n < 16; n++) {
                const pin = `P${p}${n}`;
                if (multiSelect) {
                    const isSel = defaultPin.includes(pin);
                    const chk = isSel ? 'checked' : '';
                    grid += `<div class="pin-cell multi" data-pin="${pin}" style="display:flex; align-items:center; justify-content:center; gap:2px">
            <input type="checkbox" value="${pin}" ${chk} style="margin:0;cursor:pointer;width:auto"><span>${n}</span>
          </div>`;
                } else {
                    const sel = pin === defaultPin ? ' data-selected' : '';
                    grid += `<div class="pin-cell" data-pin="${pin}"${sel}>${n}</div>`;
                }
            }
            grid += `</div>`;
        }
        const noneHtml = includeNone
            ? `<div class="pin-none-row"><span data-pin="">— None —</span></div>`
            : '';
        return `
<div class="pin-picker" data-picker-id="${id}">
  <input type="text" id="${id}" value="${defaultPin}" readonly class="pin-picker-input">
  <div class="pin-picker-popup" hidden>${noneHtml}<div class="pin-picker-grid">${grid}</div></div>
</div>`;
    }

    // ─── HTML ─────────────────────────────────────────────────────────────────

    private _buildHtml(): string {
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Peripheral Tester</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family, monospace);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 12px 16px 32px;
  }

  /* ── chip bar ── */
  #ocd-dot { color: #555; transition: color .4s; }
  #ocd-dot.running  { color: #4ec9b0; }
  #ocd-dot.starting { color: #e9c46a; animation: pulse .8s infinite alternate; }
  #ocd-dot.stopped  { color: #f48771; }
  @keyframes pulse { from { opacity: 1 } to { opacity: .3 } }

  #chip-bar {
    display: flex; flex-direction: column; gap: 6px;
    padding: 8px 12px;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    margin-bottom: 12px;
  }
  #chip-bar-row1 { display: flex; align-items: center; gap: 8px; }
  #chip-bar-row2 { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  #chip-info { flex: 1; min-width: 0; font-size: 12px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #chip-info b { color: var(--vscode-foreground); font-size: 13px; }

  /* ── tabs ── */
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 14px; }
  .tab-btn {
    padding: 6px 14px; cursor: pointer; border: none; background: none;
    color: var(--vscode-tab-inactiveForeground); font-size: 12px;
    border-bottom: 2px solid transparent;
  }
  .tab-btn:hover { color: var(--vscode-foreground); }
  .tab-btn.active {
    color: var(--vscode-tab-activeForeground);
    border-bottom-color: var(--vscode-focusBorder);
  }
  .tab-pane { display: none; }
  .tab-pane.active { display: block; }

  /* ── form grid ── */
  .form-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 8px 10px;
    align-items: center;
    max-width: 520px;
    margin-bottom: 10px;
  }
  label { color: var(--vscode-descriptionForeground); font-size: 12px; text-align: right; white-space: nowrap; }

  input, select {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 3px;
    padding: 4px 7px;
    font-family: inherit;
    font-size: 12px;
  }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }

  /* ── buttons ── */
  .btn-row { display: flex; gap: 8px; margin: 8px 0 4px; max-width: 520px; }

  /* ── Pin picker (custom compact dropdown) ── */
  .pin-picker { position: relative; }
  .pin-picker-input {
    cursor: pointer;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    padding: 4px 8px;
    border-radius: 2px;
    width: 100%;
    font-family: 'Cascadia Code', monospace;
  }
  .pin-picker-popup {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 1000;
    background: var(--vscode-dropdown-background, #252526);
    border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
    padding: 6px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    border-radius: 3px;
    margin-top: 2px;
  }
  .pin-picker-popup[hidden] { display: none; }
  .pin-none-row {
    font-size: 11px; padding: 4px 6px; cursor: pointer;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 4px;
  }
  .pin-none-row:hover { background: var(--vscode-list-hoverBackground); }
  .pin-picker-grid {
    display: grid;
    grid-template-columns: repeat(8, auto);
    gap: 2px;
  }
  .pin-col {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .pin-col-hdr {
    font-weight: 700;
    font-size: 10px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    padding: 2px 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
    margin-bottom: 2px;
  }
  .pin-cell {
    font-family: 'Cascadia Code', monospace;
    font-size: 10px;
    padding: 3px 8px;
    text-align: center;
    cursor: pointer;
    border-radius: 2px;
    color: var(--vscode-foreground);
    min-width: 26px;
  }
  .pin-cell:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
  }
  .pin-cell[data-selected] {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    color: var(--vscode-list-activeSelectionForeground, #ffffff);
  }

  /* ── GPIO visual pin grid ── */
  .gpio-visual {
    margin-top: 12px;
    padding: 10px 12px;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    max-width: 520px;
  }
  .gpio-visual-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    font-weight: 600;
    font-size: 12px;
  }
  .gpio-visual-idr {
    font-family: 'Cascadia Code', 'Courier New', monospace;
    color: #9cdcfe;
  }
  .gpio-pin-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 4px;
  }
  .gpio-pin {
    padding: 6px 2px;
    text-align: center;
    border-radius: 3px;
    font-family: 'Cascadia Code', 'Courier New', monospace;
    font-size: 10px;
    font-weight: 600;
    border: 1px solid transparent;
    transition: background 0.15s;
  }
  .gpio-pin-label {
    display: block;
    font-size: 9px;
    opacity: 0.7;
    margin-bottom: 1px;
  }
  .gpio-pin.high {
    background: #2d6a2d;
    color: #c8ffc8;
    border-color: #4ec94e;
  }
  .gpio-pin.low {
    background: #3a3a3a;
    color: #888;
    border-color: #555;
  }
  .gpio-pin.warn {
    background: #7a5c00;
    color: #ffd700;
    border-color: #b8860b;
  }
  .gpio-pin.live-pulse {
    box-shadow: 0 0 4px rgba(78, 201, 78, 0.6);
  }
  button {
    padding: 5px 14px;
    border: none; border-radius: 3px; cursor: pointer;
    font-size: 12px; font-family: inherit;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger {
    background: #c0392b;
    color: #fff;
  }
  button.danger:hover { background: #e74c3c; }

  /* ── GPIO toggle buttons ── */
  .gpio-btns { display: flex; gap: 6px; }
  .gpio-btns button { flex: 1; }

  /* ── log ── */
  .log-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 16px;
    padding: 4px 10px;
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-panel-border);
    border-bottom: none;
    border-radius: 4px 4px 0 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
  }
  .log-header button {
    font-size: 11px;
    padding: 2px 10px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #cccccc);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    cursor: pointer;
  }
  .log-header button:hover {
    background: var(--vscode-button-secondaryHoverBackground, #45494e);
  }
  #log {
    background: var(--vscode-terminal-background, #1e1e1e);
    color: var(--vscode-terminal-foreground, #ccc);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 0 0 4px 4px;
    padding: 8px 10px;
    font-family: 'Cascadia Code', 'Courier New', monospace;
    font-size: 12px;
    min-height: 120px;
    max-height: 280px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .log-ok    { color: #4ec9b0; }
  .log-err   { color: #f48771; }
  .log-info  { color: #9cdcfe; }

  /* ── section header ── */
  .section-title {
    font-size: 11px; font-weight: bold; letter-spacing: .06em;
    text-transform: uppercase; color: var(--vscode-descriptionForeground);
    margin: 16px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px;
  }

  /* ── spinner ── */
  .spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid transparent;
    border-top-color: currentColor; border-radius: 50%; animation: spin .6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<!-- ── Chip bar ────────────────────────────────────────────────────────── -->
<div id="chip-bar">
  <!-- Row 1: status dot + chip info + family selector -->
  <div id="chip-bar-row1">
    <span id="ocd-dot" title="OpenOCD status" style="font-size:16px;line-height:1">⬤</span>
    <div id="chip-info">
      <b id="ci-family">—</b>
      &nbsp;·&nbsp;<span id="ci-state">not detected</span>
      &nbsp;·&nbsp;<span id="ci-devid" style="font-family:monospace"></span>
    </div>
    <select id="chip-select" title="Chip family (manual override)">
      <option value="stm32g0">stm32g0</option>
      <option value="stm32g4">stm32g4</option>
      <option value="stm32f0">stm32f0</option>
      <option value="stm32f1">stm32f1</option>
      <option value="stm32f3">stm32f3</option>
      <option value="stm32f4" selected>stm32f4</option>
      <option value="stm32f7">stm32f7</option>
      <option value="stm32h7">stm32h7</option>
      <option value="stm32l4">stm32l4</option>
    </select>
  </div>
  <!-- Row 2: action buttons -->
  <div id="chip-bar-row2">
    <button id="btn-detect">⟳ Detect chip</button>
    <button id="btn-halt"   class="secondary">⏸ Halt</button>
    <button id="btn-resume" class="secondary">▶ Resume</button>
    <button id="btn-reset"  class="secondary">↺ Reset</button>
    <button id="btn-erase"  class="danger" title="Apaga TODA a flash">🗑 Erase Flash</button>
  </div>
</div>

<!-- ── Tabs ───────────────────────────────────────────────────────────── -->
<div class="tabs">
  <button class="tab-btn active" data-tab="gpio">GPIO</button>
  <button class="tab-btn" data-tab="spi">SPI</button>
  <button class="tab-btn" data-tab="i2c">I2C</button>
  <button class="tab-btn" data-tab="usart">USART</button>
  <button class="tab-btn" data-tab="can">CAN</button>
  <button class="tab-btn" data-tab="rtc">RTC</button>
  <button class="tab-btn" data-tab="reg">Register</button>
  <button class="tab-btn" data-tab="pwm">PWM</button>
</div>

<!-- ══ GPIO ═══════════════════════════════════════════════════════════════ -->
<div id="pane-gpio" class="tab-pane active">

  <div class="section-title">Initialize pin</div>
  <div class="form-grid">
    <label>Pin(s)</label>
    ${this._pinSelect('gpio-pin', 'PA0', false, true)}
    <label>Mode</label>
    <select id="gpio-mode">
      <option value="output">Output</option>
      <option value="input">Input</option>
      <option value="af">Alternate Function</option>
      <option value="analog">Analog</option>
    </select>
    <label>Pull</label>
    <select id="gpio-pull">
      <option value="none">None</option>
      <option value="up">Pull-up</option>
      <option value="down">Pull-down</option>
    </select>
  </div>
  <div class="btn-row">
    <button id="btn-init-gpio">Init pin(s)</button>
  </div>

  <div class="section-title">Set output</div>
  <div class="form-grid">
    <label>Pin(s)</label>
    ${this._pinSelect('gpio-set-pin', 'PA0', false, true)}
  </div>
  <div class="btn-row">
    <button id="btn-gpio-high">Set HIGH</button>
    <button class="secondary" id="btn-gpio-low">Set LOW</button>
  </div>

  <div class="section-title">Read port IDR</div>
  <div class="form-grid">
    <label>Port</label>
    <select id="gpio-read-port">
      <option>A</option><option>B</option><option>C</option>
      <option>D</option><option>E</option><option>F</option>
      <option>G</option><option>H</option><option>I</option>
    </select>
  </div>
  <div class="btn-row">
    <button id="btn-read-gpio">Read once</button>
    <button class="secondary" id="btn-read-gpio-live" title="Le IDR a cada 500ms">▶ Live monitor</button>
    <button class="secondary" id="btn-diagnose-gpio" title="Le todos os registradores de um pino especifico">🔍 Diagnose pin</button>
  </div>

  <div id="gpio-visual" class="gpio-visual" style="display:none">
    <div class="gpio-visual-header">
      <span id="gpio-visual-title">GPIOA</span>
      <span id="gpio-visual-idr" class="gpio-visual-idr">0x0000</span>
    </div>
    <div id="gpio-visual-grid" class="gpio-pin-grid"></div>
  </div>
</div>

<!-- ══ SPI ════════════════════════════════════════════════════════════════ -->
<div id="pane-spi" class="tab-pane">

  <div class="section-title">Initialize SPI</div>
  <div class="form-grid">
    <label>Peripheral</label>
    <select id="spi-periph"><option>SPI1</option><option>SPI2</option><option>SPI3</option><option>SPI4</option></select>
    <label>SCK pin</label>
    ${this._pinSelect('spi-sck', 'PB3')}
    <label>MISO pin</label>
    ${this._pinSelect('spi-miso', 'PB4')}
    <label>MOSI pin</label>
    ${this._pinSelect('spi-mosi', 'PB5')}
    <label>CS pin (optional)</label>
    ${this._pinSelect('spi-cs', 'PA15', true)}
    <label>Speed (Hz)</label>
    <input id="spi-speed" value="4000000" type="number">
    <label>Mode (CPOL/CPHA)</label>
    <select id="spi-mode">
      <option value="0">Mode 0 — CPOL=0 CPHA=0</option>
      <option value="1">Mode 1 — CPOL=0 CPHA=1</option>
      <option value="2">Mode 2 — CPOL=1 CPHA=0</option>
      <option value="3">Mode 3 — CPOL=1 CPHA=1</option>
    </select>
  </div>
  <div class="btn-row">
    <button id="btn-init-spi">Init SPI</button>
  </div>

  <div class="section-title">Transfer bytes</div>
  <div class="form-grid">
    <label>TX bytes (hex)</label>
    <input id="spi-data" value="0xF1 0x00" placeholder="0x9F 0x00 0x00">
  </div>
  <div class="btn-row">
    <button id="btn-spi-transfer">Transfer</button>
  </div>
</div>

<!-- ══ I2C ════════════════════════════════════════════════════════════════ -->
<div id="pane-i2c" class="tab-pane">

  <div class="section-title">Initialize I2C</div>
  <div class="form-grid">
    <label>Peripheral</label>
    <select id="i2c-periph"><option>I2C1</option><option>I2C2</option></select>
    <label>SCL pin</label>
    ${this._pinSelect('i2c-scl', 'PB6')}
    <label>SDA pin</label>
    ${this._pinSelect('i2c-sda', 'PB7')}
    <label>Speed (Hz)</label>
    <select id="i2c-speed">
      <option value="100000">100 kHz (standard)</option>
      <option value="400000">400 kHz (fast)</option>
    </select>
  </div>
  <div class="btn-row">
    <button id="btn-init-i2c">Init I2C</button>
  </div>

  <div class="section-title">Transaction</div>
  <div class="form-grid">
    <label>Device address (hex)</label>
    <input id="i2c-addr" value="68" placeholder="68 for MPU6050">
    <label>Write bytes (hex)</label>
    <input id="i2c-write" value="0x75" placeholder="0x75 0x00 … (leave blank for read-only)">
    <label>Read count</label>
    <input id="i2c-read-count" value="1" type="number" min="0" max="64">
  </div>
  <div class="btn-row">
    <button id="btn-i2c-tx">Send / Receive</button>
  </div>
</div>

<!-- ══ USART ═══════════════════════════════════════════════════════════════ -->
<div id="pane-usart" class="tab-pane">

  <div class="section-title">Initialize USART</div>
  <div class="form-grid">
    <label>Peripheral</label>
    <select id="usart-periph">
      <option>USART1</option><option>USART2</option><option>USART3</option>
      <option>UART4</option><option>UART5</option><option>USART6</option>
    </select>
    <label>TX pin</label>
    ${this._pinSelect('usart-tx', 'PA9')}
    <label>RX pin</label>
    ${this._pinSelect('usart-rx', 'PA10')}
    <label>Baud rate</label>
    <select id="usart-baud">
      <option value="9600">9600</option>
      <option value="19200">19200</option>
      <option value="38400">38400</option>
      <option value="57600">57600</option>
      <option value="115200" selected>115200</option>
      <option value="230400">230400</option>
      <option value="460800">460800</option>
      <option value="921600">921600</option>
    </select>
  </div>
  <div class="btn-row">
    <button id="btn-init-usart">Init USART</button>
  </div>

  <div class="section-title">Transmit</div>
  <div class="form-grid">
    <label>Data (hex bytes)</label>
    <input id="usart-tx-data" value="0x48 0x65 0x6C 0x6C 0x6F" placeholder="0x48 0x65 0x6C 0x6C 0x6F = Hello">
  </div>
  <div class="btn-row">
    <button id="btn-usart-tx">Send bytes</button>
  </div>

  <div class="section-title">Status</div>
  <div class="btn-row">
    <button id="btn-usart-status">Read ISR/SR</button>
    <button class="secondary" id="btn-usart-rx">Read RDR/DR</button>
  </div>
</div>

<!-- ══ CAN ════════════════════════════════════════════════════════════════ -->
<div id="pane-can" class="tab-pane">

  <div class="section-title">Initialize CAN</div>
  <div class="form-grid">
    <label>Peripheral</label>
    <select id="can-periph"><option>CAN1</option><option>CAN2</option></select>
    <label>TX pin</label>
    ${this._pinSelect('can-tx', 'PB9')}
    <label>RX pin</label>
    ${this._pinSelect('can-rx', 'PB8')}
    <label>Bitrate</label>
    <select id="can-bitrate-preset">
      <option value="">— manual —</option>
      <option value="1000|3|11|2">1000 kbps</option>
      <option value="500|6|11|2">500 kbps</option>
      <option value="250|12|11|2">250 kbps</option>
      <option value="125|24|11|2">125 kbps</option>
      <option value="100|30|11|2">100 kbps</option>
    </select>
    <label>Prescaler (BTR)</label>
    <input id="can-psc" value="6" type="number" min="1" max="1024">
    <label>BS1 segments</label>
    <input id="can-bs1" value="11" type="number" min="1" max="16">
    <label>BS2 segments</label>
    <input id="can-bs2" value="2" type="number" min="1" max="8">
    <label>APB1 clock (MHz)</label>
    <input id="can-apb1" value="42" type="number" min="1" max="90">
    <label>→ Calculado</label>
    <span id="can-kbps-display" style="font-weight:bold;color:var(--vscode-terminal-ansiGreen);">500 kbps</span>
  </div>
  <div class="btn-row">
    <button id="btn-init-can">Init CAN</button>
  </div>

  <div class="section-title">Configure Filter</div>
  <div class="form-grid">
    <label>Bank (0–13)</label>
    <input id="can-fbank" value="0" type="number" min="0" max="13">
    <label>Mode</label>
    <select id="can-fmode">
      <option value="mask">Mask mode (ID + Mask)</option>
      <option value="list">List mode (ID1 + ID2)</option>
    </select>
    <label>Scale</label>
    <select id="can-fscale">
      <option value="32">32-bit</option>
      <option value="16">16-bit</option>
    </select>
    <label>FIFO</label>
    <select id="can-ffifo">
      <option value="0">FIFO 0</option>
      <option value="1">FIFO 1</option>
    </select>
    <label>ID / ID1 (hex)</label>
    <input id="can-fid" value="0x00000000" placeholder="0x00000000">
    <label id="can-fmask-label">Mask / ID2 (hex)</label>
    <input id="can-fmask" value="0x00000000" placeholder="0x00000000 = aceita tudo">
  </div>
  <div class="btn-row">
    <button id="btn-can-filter-all">Accept All</button>
    <button id="btn-can-filter">Set Filter</button>
  </div>

  <div class="section-title">Status</div>
  <div class="btn-row">
    <button id="btn-can-status">Read MSR / ESR</button>
  </div>
</div>

<!-- ══ RTC ════════════════════════════════════════════════════════════════ -->
<div id="pane-rtc" class="tab-pane">

  <div class="section-title">Read RTC</div>
  <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:8px">
    O RTC usa o backup domain (alimentado por VBAT). Ler TR+DR mostra hora/data em BCD.
    Para escrever, desbloqueie via PWR + RCC_BDCR + WPR (0xCA → 0x53).
  </p>
  <div class="btn-row">
    <button id="btn-rtc-read">Ler hora/data (TR + DR)</button>
    <button class="secondary" id="btn-rtc-ssr">Ler sub-segundos (SSR)</button>
  </div>

  <div class="section-title">Ajustar hora / data</div>
  <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:8px">
    Faz unlock automático (PWR DBP + WPR 0xCA→0x53), entra em init mode, escreve TR+DR e sai.
  </p>
  <div class="form-grid">
    <label>Clock source</label>
    <select id="rtc-clock-src" style="width:220px">
      <option value="LSE">LSE — cristal 32.768 kHz (±0.1s/dia)</option>
      <option value="LSI">LSI — RC interno 32 kHz (±10min/dia)</option>
      <option value="HSE_DIV25">HSE ÷25 — precisão do cristal HSE</option>
    </select>
    <label>Hora (HH:MM:SS)</label>
    <input id="rtc-set-time" type="time" step="1" value="12:00:00" style="width:130px">
    <label>Data (DD/MM/AAAA)</label>
    <input id="rtc-set-date" type="date" value="2025-01-01" style="width:130px">
  </div>
  <div class="btn-row">
    <button id="btn-rtc-set">✎ Gravar hora/data</button>
    <button class="secondary" id="btn-rtc-now" title="Preenche com a hora do PC">⟳ Usar hora do PC</button>
  </div>

  <div class="section-title">Backup registers</div>
  <div class="form-grid">
    <label>BKP index (0–19)</label>
    <input id="rtc-bkp-idx" value="0" type="number" min="0" max="19">
    <label>Value (hex, para escrita)</label>
    <input id="rtc-bkp-val" placeholder="0x00000000">
  </div>
  <div class="btn-row">
    <button id="btn-rtc-bkp-read">Ler BKP</button>
    <button class="secondary" id="btn-rtc-bkp-write">Escrever BKP</button>
  </div>
</div>

<!-- ══ Register ═══════════════════════════════════════════════════════════ -->
<div id="pane-reg" class="tab-pane">

  <div class="section-title">Read register</div>
  <div class="form-grid">
    <label>Peripheral</label>
    <input id="reg-periph-r" value="GPIOA" placeholder="GPIOA, SPI1, I2C1, TIM1 …">
    <label>Register</label>
    <input id="reg-name-r" value="IDR" placeholder="MODER, IDR, CR1, SR …">
  </div>
  <div class="btn-row">
    <button id="btn-read-reg">Read</button>
  </div>

  <div class="section-title">Write register</div>
  <div class="form-grid">
    <label>Peripheral</label>
    <input id="reg-periph-w" value="GPIOA" placeholder="GPIOA, SPI1 …">
    <label>Register</label>
    <input id="reg-name-w" value="BSRR" placeholder="BSRR, BRR, CR1 …">
    <label>Value (hex, full write)</label>
    <input id="reg-value" value="" placeholder="0x00000001 (or use masks below)">
    <label>Set mask (hex)</label>
    <input id="reg-set-mask" placeholder="0x0001 — bits to set">
    <label>Clear mask (hex)</label>
    <input id="reg-clr-mask" placeholder="0x0002 — bits to clear">
  </div>
  <div class="btn-row">
    <button id="btn-write-reg">Write</button>
  </div>
</div>

<!-- ══ PWM ════════════════════════════════════════════════════════════════ -->
<div id="pane-pwm" class="tab-pane">

  <div class="section-title">Initialize PWM</div>
  <div class="form-grid">
    <label>Timer</label>
    <select id="pwm-timer">
      <option>TIM1</option><option>TIM2</option><option>TIM3</option>
      <option>TIM4</option><option>TIM5</option><option>TIM6</option>
      <option>TIM7</option><option>TIM8</option><option>TIM9</option>
      <option>TIM10</option><option>TIM11</option><option>TIM12</option>
      <option>TIM13</option><option>TIM14</option><option>TIM15</option>
      <option>TIM16</option><option>TIM17</option>
    </select>
    <label>Channel</label>
    <select id="pwm-ch">
      <option value="1">CH1</option><option value="2">CH2</option>
      <option value="3">CH3</option><option value="4">CH4</option>
    </select>
    <label>Pin</label>
    ${this._pinSelect('pwm-pin', 'PA8')}
    <label></label>
    <span id="pwm-pin-hint" style="font-size:11px;color:var(--vscode-descriptionForeground);"></span>
    <label>Frequency (Hz)</label>
    <input id="pwm-freq" value="1000" type="number" min="1">
    <label>Duty cycle (%)</label>
    <input id="pwm-duty" value="50" type="number" min="0" max="100">
  </div>
  <div class="btn-row">
    <button id="btn-init-pwm">Start PWM</button>
  </div>
</div>

<!-- ── Log ────────────────────────────────────────────────────────────── -->
<div class="log-header">
  <span>Monitor</span>
  <button id="btn-log-clear" title="Limpa todas as mensagens do monitor">🧹 Limpar Monitor</button>
</div>
<div id="log"><span class="log-info">Peripheral Tester ready. Click "Detect chip" to start.</span></div>

<script>
const vscode = acquireVsCodeApi();

// ── chip state ──────────────────────────────────────────────────────────────
const _chipSelectEl = document.getElementById('chip-select');
let currentChip = (_chipSelectEl && _chipSelectEl.value) ? _chipSelectEl.value : 'stm32g0';

// ── tab switching ───────────────────────────────────────────────────────────
function switchTab(id) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === id);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === 'pane-' + id);
  });
}
document.querySelectorAll('.tab-btn').forEach(b => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

// ── log helpers ─────────────────────────────────────────────────────────────
function log(text, cls) {
  const el = document.getElementById('log');
  const line = document.createElement('span');
  if (cls) line.className = cls;
  line.textContent = text + '\\n';
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function clearLog() {
  document.getElementById('log').innerHTML = '';
}
document.getElementById('btn-log-clear').addEventListener('click', () => {
  clearLog();
  log('Monitor limpo.', 'log-info');
});
function logResult(op, data) {
  log('✓ ' + op + ': ' + JSON.stringify(data, null, 2), 'log-ok');
}
function logError(op, msg) {
  log('✗ ' + op + ': ' + msg, 'log-err');
}

// ── OpenOCD dot helper ───────────────────────────────────────────────────────
function setOcdDot(state) { // 'running' | 'starting' | 'stopped'
  const d = document.getElementById('ocd-dot');
  d.className = state;
  d.title = 'OpenOCD: ' + state;
}

// ── message handler ──────────────────────────────────────────────────────────
window.addEventListener('message', e => {
  const { type, op, data } = e.data;
  // Re-enable detect button whenever any response comes back for it
  if (op === 'detectChip' || type === 'chipInfo') {
    clearTimeout(_detectTimeout);
    const btn = document.getElementById('btn-detect');
    btn.disabled = false;
    btn.textContent = '⟳ Detect';
  }
  if (type === 'chipInfo') {
    currentChip = data.family !== 'unknown' ? data.family : currentChip;
    document.getElementById('ci-family').textContent = data.family;
    document.getElementById('ci-state').textContent  = data.state;
    document.getElementById('ci-devid').textContent  = data.devId ?? '';
    // Sync manual select if we have a known family
    const sel = document.getElementById('chip-select');
    if (data.family !== 'unknown' && sel.querySelector('option[value="' + data.family + '"]')) {
      sel.value = data.family;
    }
    setOcdDot('running');
    log('→ ' + data.targetName + '  family=' + data.family + '  state=' + data.state + '  devId=' + (data.devId ?? '?'), 'log-info');
  } else if (type === 'validPwmPins') {
    const hint = document.getElementById('pwm-pin-hint');
    if (hint) {
      hint.textContent = data && data.pins && data.pins.length
        ? 'Valid: ' + data.pins.join(', ')
        : 'No mapped pins for this timer/channel';
    }
  } else if (type === 'result') {
    setOcdDot('running');
    if (op === 'readGpio' && data && data.pins) {
      updateGpioVisual(data.port, data.idr, data.pins);
      // Log a compact summary instead of the full JSON
      const highs = Object.keys(data.pins).filter(k => data.pins[k].active && data.pins[k].state === 'HIGH');
      log('✓ ' + data.port + ' IDR=' + data.idr + '  HIGH: ' + (highs.length ? highs.join(', ') : '(none)'), 'log-ok');
    } else {
      logResult(op, data);
    }
  } else if (type === 'error') {
    // Only mark stopped if it's an OpenOCD connection error
    if (String(data).toLowerCase().includes('openocd') || String(data).toLowerCase().includes('telnet')) {
      setOcdDot('stopped');
    }
    logError(op, data);
  } else if (type === 'ocdLog') {
    const line = String(data);
    // Update dot state based on log content
    if (line.includes('Listening on port 50002') || line.includes('✓')) {
      setOcdDot('running');
    } else if (line.includes('iniciando') || line.includes('Iniciando') || line.includes('starting')) {
      setOcdDot('starting');
    }
    log('[ocd] ' + line, 'log-info');
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────
function send(obj) { vscode.postMessage(obj); }
function v(id)     { return document.getElementById(id).value.trim(); }
function btn(id)   { return document.getElementById(id); }

// ── Pin picker (custom compact dropdown) ────────────────────────────────────
document.querySelectorAll('.pin-picker').forEach(picker => {
  const input = picker.querySelector('.pin-picker-input');
  const popup = picker.querySelector('.pin-picker-popup');
  input.addEventListener('click', e => {
    e.stopPropagation();
    // Close any other open picker first
    document.querySelectorAll('.pin-picker-popup').forEach(p => {
      if (p !== popup) p.hidden = true;
    });
    popup.hidden = !popup.hidden;
  });
  popup.querySelectorAll('[data-pin]').forEach(cell => {
    cell.addEventListener('click', e => {
      e.stopPropagation();
      const pin = cell.getAttribute('data-pin') || '';
      
      if (cell.classList.contains('multi')) {
        // Toggle if not clicked exactly on the checkbox
        if (e.target.tagName !== 'INPUT') {
          const chk = cell.querySelector('input[type="checkbox"]');
          if (chk) chk.checked = !chk.checked;
        }
        // Collect all checked values
        const checked = Array.from(popup.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
        input.value = checked.join(', ');
        input.dispatchEvent(new Event('change'));
        return; // Don't close
      }

      input.value = pin;
      // Update selection highlight
      popup.querySelectorAll('[data-selected]').forEach(c => c.removeAttribute('data-selected'));
      if (pin) cell.setAttribute('data-selected', '');
      popup.hidden = true;
      input.dispatchEvent(new Event('change'));
    });
  });
});
// Close popup on outside click
document.addEventListener('click', () => {
  document.querySelectorAll('.pin-picker-popup').forEach(p => p.hidden = true);
});

// ── Chip bar ────────────────────────────────────────────────────────────────
document.getElementById('chip-select').addEventListener('change', function() {
  currentChip = this.value;
  log('→ Chip definido manualmente: ' + this.value, 'log-info');
});

let _detectTimeout = null;
btn('btn-detect').addEventListener('click', () => {
  btn('btn-detect').disabled = true;
  btn('btn-detect').textContent = '⏳ Detecting…';
  log('→ Detectando chip…', 'log-info');
  clearTimeout(_detectTimeout);
  _detectTimeout = setTimeout(() => {
    btn('btn-detect').disabled = false;
    btn('btn-detect').textContent = '⟳ Detect chip';
    log('✗ Timeout — OpenOCD não respondeu em 12 s.', 'log-err');
  }, 12000);
  send({ command: 'detectChip' });
});

btn('btn-halt').addEventListener('click', () => {
  log('→ Halt…', 'log-info');
  send({ command: 'haltTarget' });
});
btn('btn-resume').addEventListener('click', () => {
  log('→ Resume…', 'log-info');
  send({ command: 'resumeTarget' });
});
btn('btn-reset').addEventListener('click', () => {
  log('→ Reset…', 'log-info');
  send({ command: 'resetTarget' });
});
let _erasePending = false;
let _eraseTimer = null;
btn('btn-erase').addEventListener('click', () => {
  if (!_erasePending) {
    _erasePending = true;
    btn('btn-erase').textContent = '⚠ Confirme: clique novamente em 5s';
    btn('btn-erase').style.background = '#ff6b00';
    log('⚠ Clique novamente em btn-erase em 5 segundos para confirmar. Toda a flash sera apagada.', 'log-err');
    clearTimeout(_eraseTimer);
    _eraseTimer = setTimeout(() => {
      _erasePending = false;
      btn('btn-erase').textContent = '🗑 Erase Flash';
      btn('btn-erase').style.background = '';
      log('→ Erase cancelado (timeout).', 'log-info');
    }, 5000);
    return;
  }
  clearTimeout(_eraseTimer);
  _erasePending = false;
  btn('btn-erase').textContent = '🗑 Erase Flash';
  btn('btn-erase').style.background = '';
  log('→ Apagando flash… (halt → probe → mass_erase)', 'log-info');
  send({ command: 'eraseFlash' });
});

// ── GPIO ────────────────────────────────────────────────────────────────────
btn('btn-init-gpio').addEventListener('click', () => {
  send({ command:'initGpio', chip:currentChip, pin:v('gpio-pin'), mode:v('gpio-mode'), pull:v('gpio-pull') });
});
btn('btn-gpio-high').addEventListener('click', () => {
  send({ command:'setGpio', chip:currentChip, pin:v('gpio-set-pin'), value:'high' });
});
btn('btn-gpio-low').addEventListener('click', () => {
  send({ command:'setGpio', chip:currentChip, pin:v('gpio-set-pin'), value:'low' });
});
btn('btn-read-gpio').addEventListener('click', () => {
  send({ command:'readGpio', chip:currentChip, port:v('gpio-read-port') });
});
btn('btn-diagnose-gpio').addEventListener('click', () => {
  // Use the pin from the Init section (gpio-pin select)
  const pin = v('gpio-pin') || v('gpio-set-pin');
  log('→ Diagnosing ' + pin + '...', 'log-info');
  send({ command: 'diagnoseGpio', chip: currentChip, pin });
});
let _liveGpioTimer = null;
btn('btn-read-gpio-live').addEventListener('click', () => {
  const b = btn('btn-read-gpio-live');
  if (_liveGpioTimer) {
    clearInterval(_liveGpioTimer);
    _liveGpioTimer = null;
    b.textContent = '▶ Live monitor';
    b.classList.remove('danger');
    log('→ Live monitor stopped.', 'log-info');
    return;
  }
  b.textContent = '■ Stop';
  b.classList.add('danger');
  log('→ Live monitor started (500ms).', 'log-info');
  const poll = () => send({ command:'readGpio', chip:currentChip, port:v('gpio-read-port') });
  poll();
  _liveGpioTimer = setInterval(poll, 500);
});
function updateGpioVisual(port, idrHex, pins) {
  const box = document.getElementById('gpio-visual');
  box.style.display = 'block';
  document.getElementById('gpio-visual-title').textContent = port;
  document.getElementById('gpio-visual-idr').textContent = idrHex;
  const grid = document.getElementById('gpio-visual-grid');
  const p = port.replace('GPIO', '');
  // Show P15 to P0 (left to right = MSB to LSB) in 2 rows of 8
  let html = '';
  for (let i = 15; i >= 0; i--) {
    const pin = 'P' + p + i;
    const pinObj = pins[pin];
    if (!pinObj.active) {
      html += '<div class="gpio-pin" style="opacity:0.2" title="Pino n\xE3o inicializado (flutuante)"><span class="gpio-pin-label">' + pin + '</span>-</div>';
    } else {
      let cls = pinObj.state === 'HIGH' ? 'high' : 'low';
      if (pinObj.isWarn) cls += ' warn';
      const title = pinObj.warnMsg ? ' title="' + pinObj.warnMsg + '"' : '';
      html += '<div class="gpio-pin ' + cls + '"' + title + '><span class="gpio-pin-label">' + pin + '</span>' + (pinObj.state === 'HIGH' ? '1' : '0') + '</div>';
    }
  }
  grid.innerHTML = html;
}

// ── SPI ─────────────────────────────────────────────────────────────────────
btn('btn-init-spi').addEventListener('click', () => {
  send({ command:'initSpi', chip:currentChip, peripheral:v('spi-periph'),
    sck:v('spi-sck'), miso:v('spi-miso'), mosi:v('spi-mosi'), cs:v('spi-cs'),
    speed:v('spi-speed'), mode:parseInt(v('spi-mode')) });
});
btn('btn-spi-transfer').addEventListener('click', () => {
  send({ command:'spiTransfer', chip:currentChip, peripheral:v('spi-periph'),
    cs:v('spi-cs'), data:v('spi-data') });
});

// ── I2C ─────────────────────────────────────────────────────────────────────
btn('btn-init-i2c').addEventListener('click', () => {
  send({ command:'initI2c', chip:currentChip, peripheral:v('i2c-periph'),
    scl:v('i2c-scl'), sda:v('i2c-sda'), speed:v('i2c-speed') });
});
btn('btn-i2c-tx').addEventListener('click', () => {
  send({ command:'i2cTx', chip:currentChip, peripheral:v('i2c-periph'),
    address:v('i2c-addr'), write:v('i2c-write'), readCount:v('i2c-read-count') });
});

// ── Register ────────────────────────────────────────────────────────────────
btn('btn-read-reg').addEventListener('click', () => {
  send({ command:'readReg', chip:currentChip, peripheral:v('reg-periph-r'), register:v('reg-name-r') });
});
btn('btn-write-reg').addEventListener('click', () => {
  const val = v('reg-value'), setM = v('reg-set-mask'), clrM = v('reg-clr-mask');
  send({ command:'writeReg', chip:currentChip, peripheral:v('reg-periph-w'), register:v('reg-name-w'),
    value: val || undefined, setMask: setM || undefined, clearMask: clrM || undefined });
});

// ── USART ────────────────────────────────────────────────────────────────────
btn('btn-init-usart').addEventListener('click', () => {
  send({ command:'initUsart', chip:currentChip, peripheral:v('usart-periph'),
    tx:v('usart-tx'), rx:v('usart-rx'), baud:v('usart-baud') });
});
btn('btn-usart-tx').addEventListener('click', () => {
  send({ command:'usartTx', chip:currentChip, peripheral:v('usart-periph'), data:v('usart-tx-data') });
});
btn('btn-usart-status').addEventListener('click', () => {
  send({ command:'readReg', chip:currentChip, peripheral:v('usart-periph'), register:'ISR' });
});
btn('btn-usart-rx').addEventListener('click', () => {
  send({ command:'readReg', chip:currentChip, peripheral:v('usart-periph'), register:'RDR' });
});

// ── CAN ──────────────────────────────────────────────────────────────────────
function updateCanKbps() {
  const apb1Hz = (parseFloat(document.getElementById('can-apb1').value) || 42) * 1e6;
  const psc  = parseInt(document.getElementById('can-psc').value)  || 1;
  const bs1  = parseInt(document.getElementById('can-bs1').value)  || 1;
  const bs2  = parseInt(document.getElementById('can-bs2').value)  || 1;
  const bps  = apb1Hz / (psc * (1 + bs1 + bs2));
  const kbps = (bps / 1000).toFixed(1);
  document.getElementById('can-kbps-display').textContent = kbps + ' kbps';
}
document.getElementById('can-psc').addEventListener('input', updateCanKbps);
document.getElementById('can-bs1').addEventListener('input', updateCanKbps);
document.getElementById('can-bs2').addEventListener('input', updateCanKbps);
document.getElementById('can-apb1').addEventListener('input', updateCanKbps);
document.getElementById('can-bitrate-preset').addEventListener('change', function() {
  if (!this.value) return;
  const [, psc, bs1, bs2] = this.value.split('|');
  document.getElementById('can-psc').value = psc;
  document.getElementById('can-bs1').value = bs1;
  document.getElementById('can-bs2').value = bs2;
  updateCanKbps();
});

btn('btn-init-can').addEventListener('click', () => {
  send({ command:'initCan', chip:currentChip, peripheral:v('can-periph'),
    tx:v('can-tx'), rx:v('can-rx'),
    psc:v('can-psc'), bs1:v('can-bs1'), bs2:v('can-bs2') });
});
document.getElementById('can-fmode').addEventListener('change', function() {
  document.getElementById('can-fmask-label').textContent =
    this.value === 'list' ? 'ID2 (hex)' : 'Mask (hex)';
});
btn('btn-can-filter-all').addEventListener('click', () => {
  document.getElementById('can-fid').value   = '0x00000000';
  document.getElementById('can-fmask').value = '0x00000000';
  log('→ ID=0 Mask=0 → aceita todos os IDs', 'log-info');
});
btn('btn-can-filter').addEventListener('click', () => {
  send({ command:'setCanFilter', chip:currentChip, peripheral:v('can-periph'),
    bank:v('can-fbank'), mode:v('can-fmode'), scale:v('can-fscale'),
    fifo:v('can-ffifo'), id:v('can-fid'), mask:v('can-fmask') });
});
btn('btn-can-status').addEventListener('click', () => {
  send({ command:'canStatus', chip:currentChip, peripheral:v('can-periph') });
});

// ── RTC ───────────────────────────────────────────────────────────────────────
btn('btn-rtc-read').addEventListener('click',     () => send({ command:'rtcRead',    chip:currentChip }));
btn('btn-rtc-ssr').addEventListener('click',      () => send({ command:'rtcReadSsr', chip:currentChip }));
btn('btn-rtc-bkp-read').addEventListener('click', () => send({ command:'rtcBkpRead',  chip:currentChip, index:v('rtc-bkp-idx') }));
btn('btn-rtc-bkp-write').addEventListener('click',() => send({ command:'rtcBkpWrite', chip:currentChip, index:v('rtc-bkp-idx'), value:v('rtc-bkp-val') }));
btn('btn-rtc-set').addEventListener('click', () => {
  const tParts = (document.getElementById('rtc-set-time').value || '12:00:00').split(':');
  const dParts = (document.getElementById('rtc-set-date').value || '2025-01-01').split('-');
  const hour = tParts[0] || '12', min = tParts[1] || '0', sec = tParts[2] || '0';
  const year = String(Number(dParts[0] || '2025') % 100);
  const month = dParts[1] || '1', day = dParts[2] || '1';
  // calc weekday: JS 0=Sun → STM32 7=Sun, 1=Mon..6=Sat
  const jsDay = new Date(Number(dParts[0]), Number(dParts[1]) - 1, Number(dParts[2])).getDay();
  const wday = String(jsDay === 0 ? 7 : jsDay);
  const clockSrc = v('rtc-clock-src') || 'LSE';
  send({ command:'rtcSet', chip:currentChip, hour, min, sec, day, month, year, wday, clockSrc });
});
btn('btn-rtc-now').addEventListener('click', () => {
  const n = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  document.getElementById('rtc-set-time').value =
    pad(n.getHours()) + ':' + pad(n.getMinutes()) + ':' + pad(n.getSeconds());
  const y = n.getFullYear(), mo = n.getMonth() + 1, d = n.getDate();
  document.getElementById('rtc-set-date').value =
    y + '-' + pad(mo) + '-' + pad(d);
  log('→ Campos preenchidos com hora do PC', 'log-info');
});

// ── PWM ─────────────────────────────────────────────────────────────────────
function updatePwmHint() {
  const hint = document.getElementById('pwm-pin-hint');
  if (!hint) return;
  hint.textContent = '';
  send({ command:'getValidPwmPins', chip:currentChip, timer:v('pwm-timer'), channel:v('pwm-ch') });
}
document.getElementById('pwm-timer').addEventListener('change', updatePwmHint);
document.getElementById('pwm-ch').addEventListener('change', updatePwmHint);

btn('btn-init-pwm').addEventListener('click', () => {
  send({ command:'initPwm', chip:currentChip, timer:v('pwm-timer'),
    channel:v('pwm-ch'), pin:v('pwm-pin'),
    frequency:v('pwm-freq'), duty:v('pwm-duty') });
});

// ── Log ─────────────────────────────────────────────────────────────────────
btn('btn-log-clear').addEventListener('click', () => {
  document.getElementById('log').innerHTML = '';
});
</script>
</body>
</html>`;
    }
}
