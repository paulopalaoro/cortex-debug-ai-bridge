/**
 * dapBridge.ts
 *
 * All communication with the active debug session goes through this module.
 * Uses VSCode's Debug Adapter Protocol (DAP) API — both standard DAP requests
 * and Cortex-Debug custom requests (read-registers, read-memory, execute-command).
 *
 * IMPORTANT: Most DAP requests only work while the target MCU is paused (halted).
 * The Cortex-Debug adapter returns an error if the target is running.
 */

import * as vscode from 'vscode';
import * as logger from './logger';
import { StackFrame, Variable, Scope, Register, MemoryReadResult, EvaluateResult } from './types';

const SUPPORTED_SESSION_TYPES = ['cortex-debug', 'platformio-debug'];

// ── Session guard ─────────────────────────────────────────────────────────────

export function getSession(): vscode.DebugSession {
    const session = vscode.debug.activeDebugSession;
    if (!session) {
        throw new Error(
            'No active debug session. Start a Cortex-Debug or PlatformIO debug session first, '
      + 'then pause the target at a breakpoint.'
        );
    }
    if (!SUPPORTED_SESSION_TYPES.includes(session.type)) {
        throw new Error(
            `Active session type is '${session.type}'. `
      + `Only ${SUPPORTED_SESSION_TYPES.join(', ')} are supported.`
        );
    }
    return session;
}

export function hasSession(): boolean {
    const session = vscode.debug.activeDebugSession;
    return !!session && SUPPORTED_SESSION_TYPES.includes(session.type);
}

// ── Threads ───────────────────────────────────────────────────────────────────

async function getFirstThreadId(): Promise<number> {
    const session = getSession();
    try {
        const resp = await session.customRequest('threads');
        const id = resp?.threads?.[0]?.id;
        if (id !== undefined) return id;
    } catch (_) { /* fall through to default */ }
    // Cortex-Debug hides thread enumeration while the core is running. For
    // single-core MCUs (all STM32 Cortex-M targets), threadId=1 is always valid.
    return 1;
}

// ── Call Stack ────────────────────────────────────────────────────────────────

export async function getCallStack(levels = 20): Promise<StackFrame[]> {
    const session = getSession();
    const threadId = await getFirstThreadId();
    logger.debug(`getCallStack threadId=${threadId} levels=${levels}`);
    const resp = await session.customRequest('stackTrace', {
        threadId,
        startFrame: 0,
        levels
    });
    return resp.stackFrames as StackFrame[];
}

// ── Variables ─────────────────────────────────────────────────────────────────

export async function getScopesForFrame(frameId: number): Promise<Scope[]> {
    const session = getSession();
    const resp = await session.customRequest('scopes', { frameId });
    return resp.scopes as Scope[];
}

export async function getVariablesForRef(variablesReference: number): Promise<Variable[]> {
    const session = getSession();
    const resp = await session.customRequest('variables', { variablesReference });
    return resp.variables as Variable[];
}

export async function getVariables(frameIndex = 0): Promise<Record<string, Variable[]>> {
    const stack = await getCallStack();
    if (!stack.length) throw new Error('Call stack is empty — is the target paused?');

    const frame = stack[frameIndex];
    if (!frame) throw new Error(`No frame at index ${frameIndex}. Stack has ${stack.length} frames.`);

    logger.debug(`getVariables frameId=${frame.id} frameName=${frame.name}`);
    const scopes = await getScopesForFrame(frame.id);

    const result: Record<string, Variable[]> = {};
    for (const scope of scopes) {
        if (scope.variablesReference === 0) continue;
        result[scope.name] = await getVariablesForRef(scope.variablesReference);
    }
    return result;
}

export async function expandVariable(
    variablesReference: number
): Promise<Variable[]> {
    if (variablesReference === 0) throw new Error('This variable has no children to expand.');
    return getVariablesForRef(variablesReference);
}

// ── Evaluate ──────────────────────────────────────────────────────────────────

export async function evaluate(
    expression: string,
    frameIndex = 0
): Promise<EvaluateResult> {
    const session = getSession();
    const stack = await getCallStack();
    const frame = stack[frameIndex];
    if (!frame) throw new Error(`No frame at index ${frameIndex}.`);

    logger.debug(`evaluate expr="${expression}" frameId=${frame.id}`);
    const resp = await session.customRequest('evaluate', {
        expression,
        frameId: frame.id,
        context: 'watch'
    });
    return resp as EvaluateResult;
}

// ── ARM Registers ─────────────────────────────────────────────────────────────

export async function getRegisters(): Promise<Register[]> {
    const session = getSession();
    logger.debug('getRegisters');
    // Cortex-Debug custom DAP command
    const resp = await session.customRequest('read-registers', { hex: true });
    return resp as Register[];
}

export async function getRegisterList(): Promise<{ number: number; id: number; name: string }[]> {
    const session = getSession();
    logger.debug('getRegisterList');
    const resp = await session.customRequest('read-register-list');
    return resp;
}

// ── Memory ────────────────────────────────────────────────────────────────────

export async function readMemory(
    address: string,
    length: number
): Promise<MemoryReadResult> {
    const session = getSession();
    logger.debug(`readMemory addr=${address} len=${length}`);
    // Cortex-Debug custom DAP command
    const resp = await session.customRequest('read-memory', { address, length });

    // Cortex-Debug 1.x returns an array of numbers directly
    // Cortex-Debug 2.x / some builds return { startAddress, data: number[] }
    let bytes: number[] = [];
    if (Array.isArray(resp)) {
        bytes = resp as number[];
    } else if (resp && typeof resp === 'object') {
        const data = (resp as Record<string, unknown>).data;
        if (Array.isArray(data)) {
            bytes = data as number[];
        } else if (typeof data === 'string') {
            // hex string like "aabbccdd..."
            const hex = (data).replace(/\s/g, '');
            for (let i = 0; i < hex.length; i += 2) {
                bytes.push(parseInt(hex.substring(i, i + 2), 16));
            }
        }
    }
    logger.debug(`readMemory resp type=${Array.isArray(resp) ? 'array' : typeof resp} bytes=${bytes.length}`);

    const hexStr = bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return { address, data: hexStr, bytes };
}

// ── Execution Control ─────────────────────────────────────────────────────────

export async function pauseExecution(): Promise<void> {
    const session = getSession();
    const threadId = await getFirstThreadId();
    logger.debug(`pause threadId=${threadId}`);
    await session.customRequest('pause', { threadId });
}

export async function continueExecution(): Promise<void> {
    const session = getSession();
    const threadId = await getFirstThreadId();
    logger.debug(`continue threadId=${threadId}`);
    await session.customRequest('continue', { threadId });
}

export async function stepOver(): Promise<void> {
    const session = getSession();
    const threadId = await getFirstThreadId();
    logger.debug(`next (stepOver) threadId=${threadId}`);
    await session.customRequest('next', { threadId });
}

export async function stepInto(): Promise<void> {
    const session = getSession();
    const threadId = await getFirstThreadId();
    logger.debug(`stepIn threadId=${threadId}`);
    await session.customRequest('stepIn', { threadId });
}

export async function stepOut(): Promise<void> {
    const session = getSession();
    const threadId = await getFirstThreadId();
    logger.debug(`stepOut threadId=${threadId}`);
    await session.customRequest('stepOut', { threadId });
}

// ── Breakpoints ───────────────────────────────────────────────────────────────

// Track active breakpoints per file so add/remove work correctly
// (DAP setBreakpoints replaces the entire list for a file)
const breakpointMap = new Map<string, Set<number>>();

export async function setBreakpoint(
    filePath: string,
    line: number
): Promise<unknown> {
    const session = getSession();
    if (!breakpointMap.has(filePath)) breakpointMap.set(filePath, new Set());
    breakpointMap.get(filePath).add(line);
    const lines = Array.from(breakpointMap.get(filePath));
    logger.debug(`setBreakpoint ${filePath}:${line} — active lines: [${lines}]`);
    return session.customRequest('setBreakpoints', {
        source: { path: filePath },
        breakpoints: lines.map((l) => ({ line: l }))
    });
}

export async function removeBreakpoint(
    filePath: string,
    line: number
): Promise<unknown> {
    const session = getSession();
    const lines = breakpointMap.get(filePath);
    if (lines) {
        lines.delete(line);
        if (lines.size === 0) breakpointMap.delete(filePath);
    }
    const remaining = lines ? Array.from(lines) : [];
    logger.debug(`removeBreakpoint ${filePath}:${line} — remaining: [${remaining}]`);
    return session.customRequest('setBreakpoints', {
        source: { path: filePath },
        breakpoints: remaining.map((l) => ({ line: l }))
    });
}

export async function clearBreakpoints(filePath?: string): Promise<void> {
    const session = getSession();
    if (filePath) {
        breakpointMap.delete(filePath);
        await session.customRequest('setBreakpoints', {
            source: { path: filePath },
            breakpoints: []
        });
        logger.debug(`clearBreakpoints ${filePath}`);
    } else {
        for (const [fp] of breakpointMap) {
            await session.customRequest('setBreakpoints', {
                source: { path: fp },
                breakpoints: []
            });
        }
        breakpointMap.clear();
        logger.debug('clearBreakpoints (all files)');
    }
}

// ── GDB / MI command passthrough ──────────────────────────────────────────────

const BLOCKED_GDB_COMMANDS = ['quit', 'kill', '-gdb-exit', 'detach'];

export async function executeGdbCommand(command: string): Promise<unknown> {
    const trimmed = command.trim().toLowerCase();
    for (const blocked of BLOCKED_GDB_COMMANDS) {
        if (trimmed === blocked || trimmed.startsWith(blocked + ' ')) {
            throw new Error(`GDB command '${command}' is blocked for safety.`);
        }
    }
    const session = getSession();
    logger.debug(`executeGdbCommand: ${command}`);
    // Cortex-Debug custom command — runs raw GDB MI command
    return session.customRequest('execute-command', { command });
}
