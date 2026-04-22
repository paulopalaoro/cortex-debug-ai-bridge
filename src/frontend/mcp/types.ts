export interface StackFrame {
    id: number;
    name: string;
    source?: { path?: string; name?: string };
    line: number;
    column: number;
}

export interface Variable {
    name: string;
    value: string;
    type?: string;
    variablesReference: number;
    evaluateName?: string;
}

export interface Scope {
    name: string;
    variablesReference: number;
    expensive: boolean;
}

export interface Register {
    number: number;
    id: number;
    name: string;
    value: string;
}

export interface MemoryReadResult {
    address: string;
    data: string;   // hex string
    bytes: number[];
}

export interface EvaluateResult {
    result: string;
    type?: string;
    variablesReference: number;
}
