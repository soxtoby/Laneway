import type { EngineMessage } from "@git-workbench/shared";

interface EngineStatusReady {
    state: "ready";
    path: string;
    name: "workbench-engine";
    version: string;
    repositoryPath: string;
}

interface EngineStatusError {
    state: "error";
    path: string;
    error: string;
    repositoryPath: string;
}

interface EngineCommandResult {
    exitCode: number;
    diagnostics: string;
    messages: EngineMessage[];
}

declare global {
    interface Window {
        workbench: {
            getEngineStatus(): Promise<EngineStatusReady | EngineStatusError>;
            runEcho(message: string, repositoryPath: string): Promise<EngineCommandResult>;
            cancel(): Promise<boolean>;
            onEngineMessage(listener: (message: EngineMessage) => void): () => void;
        };
    }
}

export {};
