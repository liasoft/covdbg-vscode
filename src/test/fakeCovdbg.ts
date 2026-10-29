import { EventEmitter } from "events";
import type { SignedInAccount, SpawnCovdbg } from "../runner/signIn";

/** A covdbg process the test drives: it prints and exits when told to. */
export class FakeProcess extends EventEmitter {
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    killed = false;
    /** What `stubSpawn` started: the executable and the spawn options. */
    command = "";
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {};

    constructor(
        readonly args: string[],
        readonly env: NodeJS.ProcessEnv,
    ) {
        super();
    }

    print(text: string): void {
        this.stdout.emit("data", Buffer.from(text));
    }

    exit(code: number | null): void {
        this.emit("close", code);
    }

    kill(): boolean {
        this.killed = true;
        setImmediate(() => this.exit(null));
        return true;
    }
}

/** Stands in for spawning covdbg. `script` runs on the next tick for every process started. */
export function fakeCovdbg(script: (process: FakeProcess) => void): {
    start: SpawnCovdbg;
    started: FakeProcess[];
} {
    const started: FakeProcess[] = [];
    const start: SpawnCovdbg = (_executablePath, args, env) => {
        const process = new FakeProcess(args, env);
        started.push(process);
        setImmediate(() => script(process));
        return process;
    };
    return { start, started };
}

/** Answers a `whoami --json` process the way covdbg does, with the contract's object. */
export function answerWhoami(process: FakeProcess, account: SignedInAccount | undefined): void {
    process.print(
        JSON.stringify({
            signedIn: account !== undefined,
            email: account?.email ?? null,
            accountId: account?.accountId ?? null,
            teamName: account?.teamName ?? null,
            teamSlug: account?.teamSlug ?? null,
            teamKind: account?.teamKind ?? null,
            source: "service",
            projectToken: false,
        }) + "\n",
    );
    process.exit(account ? 0 : 1);
}

/** Lets pending callbacks and timers of zero length run. */
export function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/** The module itself, not a copy of its exports, so a stubbed spawn reaches every caller. */
const childProcess = process.getBuiltinModule("child_process");

/**
 * Makes `child_process.spawn` start fake covdbg processes, for modules that spawn covdbg directly.
 * `script` runs on the next tick for every process started; `restore` puts the real spawn back.
 */
export function stubSpawn(script: (process: FakeProcess) => void): {
    started: FakeProcess[];
    restore: () => void;
} {
    const real = childProcess.spawn;
    const covdbg = fakeCovdbg(script);
    const spawning = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        const process = covdbg.start(command, args, options.env ?? {}) as FakeProcess;
        process.command = command;
        process.options = options;
        return process;
    };
    childProcess.spawn = spawning as unknown as typeof childProcess.spawn;
    return { started: covdbg.started, restore: () => (childProcess.spawn = real) };
}
