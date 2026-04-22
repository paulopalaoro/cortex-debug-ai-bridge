import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetCallStack } from './getCallStack';
import { registerGetVariables } from './getVariables';
import { registerExpandVariable } from './expandVariable';
import { registerGetRegisters } from './getRegisters';
import { registerGetMemory } from './getMemory';
import { registerEvaluate } from './evaluate';
import { registerSetBreakpoint } from './setBreakpoint';
import { registerContinueExecution } from './continueExecution';
import { registerPauseExecution } from './pauseExecution';
import { registerStepOver } from './stepOver';
import { registerGdbCommand } from './gdbCommand';
import { registerGetSessionInfo } from './getSessionInfo';
import { registerReadLiveMemory } from './readLiveMemory';
import { registerWriteMemory } from './writeMemory';
import { registerRemoveBreakpoint } from './removeBreakpoint';
import { registerGetSymbols } from './getSymbols';
// Peripheral testing tools — no firmware needed, uses OpenOCD register writes
import { registerGetChipInfo } from './getChipInfo';
import { registerReadRegister } from './readRegister';
import { registerWriteRegister } from './writeRegister';
import { registerInitPeripheral } from './initPeripheral';
import { registerSpiTransfer } from './spiTransfer';
import { registerI2cTransaction } from './i2cTransaction';

export function registerAllTools(server: McpServer) {
    // ── DAP / Cortex-Debug tools (require paused target or active debug session) ──
    registerGetSessionInfo(server);
    registerGetSymbols(server);
    registerGetCallStack(server);
    registerGetVariables(server);
    registerExpandVariable(server);
    registerGetRegisters(server);
    registerGetMemory(server);
    registerEvaluate(server);
    registerSetBreakpoint(server);
    registerRemoveBreakpoint(server);
    registerContinueExecution(server);
    registerPauseExecution(server);
    registerStepOver(server);
    registerGdbCommand(server);

    // ── OpenOCD live-memory tools (target running, no pause needed) ──
    registerReadLiveMemory(server);
    registerWriteMemory(server);

    // ── Peripheral testing tools (OpenOCD register writes, no firmware needed) ──
    registerGetChipInfo(server);
    registerReadRegister(server);
    registerWriteRegister(server);
    registerInitPeripheral(server);   // also registers set_pwm_duty
    registerSpiTransfer(server);
    registerI2cTransaction(server);
}
