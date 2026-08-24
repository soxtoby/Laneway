import { ENGINE_VERSION, type EngineMessage, EngineMessageSchema } from "@git-workbench/shared";
import { execFile, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface EnginePathOptions {
    override?: string;
    isPackaged: boolean;
    applicationPath: string;
    workspacePath: string;
}

export function resolveEnginePath(options: EnginePathOptions) {
    if (options.override) {
        return resolve(options.override);
    }

    if (options.isPackaged) {
        return join(dirname(options.applicationPath), "workbench-engine.exe");
    }

    return join(options.workspacePath, "cli", "bin", "workbench-engine.exe");
}

export function parseEngineIdentity(output: string) {
    const match = /^workbench-engine (\d+\.\d+\.\d+)\r?\n?$/.exec(output);

    if (!match) {
        throw new Error("The selected Workbench Engine returned an invalid --version response.");
    }

    const version = match[1];
    if (version !== ENGINE_VERSION) {
        throw new Error(
            `Incompatible Workbench Engine version ${version}; expected ${ENGINE_VERSION}.`,
        );
    }

    return { name: "workbench-engine" as const, version };
}

export async function inspectEngine(enginePath: string) {
    const { stdout } = await execFileAsync(enginePath, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
    });

    return { path: enginePath, ...parseEngineIdentity(stdout) };
}

export function parseEngineMessage(line: string) {
    try {
        return EngineMessageSchema.parse(JSON.parse(line));
    } catch {
        throw new Error(`Workbench Engine returned malformed NDJSON: ${line}`);
    }
}

export interface EngineCommandOptions {
    enginePath: string;
    cwd: string;
    args: string[];
    onMessage?: (message: EngineMessage) => void;
}

export interface EngineCommandResult {
    exitCode: number;
    diagnostics: string;
    messages: EngineMessage[];
}

export function runEngineCommand(options: EngineCommandOptions) {
    const args = options.args.includes("--json")
        ? options.args
        : [...options.args, "--json"];
    const child = spawn(options.enginePath, args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });
    const messages: EngineMessage[] = [];
    let diagnostics = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        diagnostics += chunk;
    });

    const completion = new Promise<number>((resolveCompletion, rejectCompletion) => {
        child.once("error", rejectCompletion);
        child.once("close", (code) => resolveCompletion(code ?? 1));
    });

    const result = (async (): Promise<EngineCommandResult> => {
        const lines = createInterface({ input: child.stdout });
        let protocolError: Error | undefined;

        for await (const line of lines) {
            if (protocolError || line.length === 0) {
                continue;
            }

            try {
                const message = parseEngineMessage(line);
                messages.push(message);
                options.onMessage?.(message);
            } catch {
                protocolError = new Error(
                    `Workbench Engine returned malformed NDJSON: ${line}`,
                );
            }
        }

        const exitCode = await completion;
        if (protocolError) {
            throw protocolError;
        }

        return { exitCode, diagnostics, messages };
    })();

    return {
        result,
        cancel() {
            child.stdin.end("cancel\n");
        },
    };
}
