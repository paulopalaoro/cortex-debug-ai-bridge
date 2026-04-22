import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function getChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Cortex Debug AI');
    }
    return outputChannel;
}

function level(): string {
    return vscode.workspace
        .getConfiguration('cortexDebugAi')
        .get<string>('logLevel', 'info');
}

export function info(msg: string) {
    if (level() === 'off') return;
    getChannel().appendLine(`[INFO]  ${new Date().toISOString()} ${msg}`);
}

export function debug(msg: string) {
    if (level() !== 'debug') return;
    getChannel().appendLine(`[DEBUG] ${new Date().toISOString()} ${msg}`);
}

export function error(msg: string) {
    if (level() === 'off') return;
    getChannel().appendLine(`[ERROR] ${new Date().toISOString()} ${msg}`);
}

export function dispose() {
    outputChannel?.dispose();
    outputChannel = undefined;
}
