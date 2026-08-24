import type { EngineMessage } from "@git-workbench/shared";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { inspectEngine, parseEngineIdentity, parseEngineMessage, resolveEnginePath, runEngineCommand } from "../src/main/engine";

const enginePath = join(import.meta.dir, "../../cli/bin/workbench-engine.exe");

describe("Workbench Engine client", () => {
    test("accepts the shipped Engine identity", () => {
        expect(parseEngineIdentity("workbench-engine 0.1.0\n")).toEqual({
            name: "workbench-engine",
            version: "0.1.0",
        });
    });

    test("rejects malformed and incompatible Engine identities", () => {
        expect(() => parseEngineIdentity("hello\n")).toThrow(
            "The selected Workbench Engine returned an invalid --version response.",
        );
        expect(() => parseEngineIdentity("workbench-engine 0.2.0\n")).toThrow(
            "Incompatible Workbench Engine version 0.2.0; expected 0.1.0.",
        );
    });

    test("resolves override, packaged, and development Engine paths", () => {
        const applicationPath = join("D:\\Apps", "Workbench.exe");
        const workspacePath = join("D:\\src", "GitWorkbench");

        expect(resolveEnginePath({
            override: join("D:\\tools", "custom-engine.exe"),
            isPackaged: false,
            applicationPath,
            workspacePath,
        })).toBe(join("D:\\tools", "custom-engine.exe"));
        expect(resolveEnginePath({
            isPackaged: true,
            applicationPath,
            workspacePath,
        })).toBe(join("D:\\Apps", "workbench-engine.exe"));
        expect(resolveEnginePath({
            isPackaged: false,
            applicationPath,
            workspacePath,
        })).toBe(join(workspacePath, "cli", "bin", "workbench-engine.exe"));
    });

    test("inspects the selected Engine executable", async () => {
        await expect(inspectEngine(enginePath)).resolves.toEqual({
            path: enginePath,
            name: "workbench-engine",
            version: "0.1.0",
        });
    });

    test("runs one Engine process and streams validated messages", async () => {
        const received: EngineMessage[] = [];
        const run = runEngineCommand({
            enginePath,
            cwd: join(import.meta.dir, "../.."),
            args: ["echo", "From desktop", "--delay-ms", "0"],
            onMessage: (message) => received.push(message),
        });

        const result = await run.result;

        expect(result.exitCode).toBe(0);
        expect(result.diagnostics).toBe("");
        expect(result.messages).toEqual(received);
        expect(result.messages.at(-1)).toEqual({
            type: "result",
            command: "echo",
            message: "From desktop",
        });
    });

    test("rejects malformed Engine output", () => {
        expect(() => parseEngineMessage("not json")).toThrow(
            "Workbench Engine returned malformed NDJSON: not json",
        );
        expect(() => parseEngineMessage("{\"type\":\"result\",\"command\":\"other\"}")).toThrow(
            "Workbench Engine returned malformed NDJSON: {\"type\":\"result\",\"command\":\"other\"}",
        );
    });

    test("cancels the active Engine process cooperatively", async () => {
        let progressReceived: () => void;
        const firstProgress = new Promise<void>((resolveProgress) => {
            progressReceived = resolveProgress;
        });
        const run = runEngineCommand({
            enginePath,
            cwd: join(import.meta.dir, "../.."),
            args: ["echo", "Cancelled", "--delay-ms", "1000"],
            onMessage: (message) => {
                if (message.type === "progress") {
                    progressReceived();
                }
            },
        });

        await firstProgress;
        run.cancel();
        const result = await run.result;

        expect(result.exitCode).toBe(3);
        expect(result.messages.at(-1)).toEqual({
            type: "cancelled",
            command: "echo",
            message: "Cancellation acknowledged.",
        });
    });
});
