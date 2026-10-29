import test from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { meetsMinimumVersion, parseCovdbgVersion, probeCovdbgVersion } from "../runner/version";
import { stubSpawn } from "./fakeCovdbg";
import { tempFolder, writeFile } from "./fixtures";

test("parseCovdbgVersion reads what covdbg --version prints", () => {
    assert.equal(parseCovdbgVersion("covdbg 1.4.0\r\n"), "1.4.0");
    assert.equal(parseCovdbgVersion("covdbg 0.0.1-debug\n"), "0.0.1-debug");
    assert.equal(parseCovdbgVersion("Usage: covdbg [options]\n"), undefined);
    assert.equal(parseCovdbgVersion(""), undefined);
});

test("meetsMinimumVersion lets 1.4.0 and newer through", () => {
    assert.equal(meetsMinimumVersion("1.4.0"), true);
    assert.equal(meetsMinimumVersion("1.4.1"), true);
    assert.equal(meetsMinimumVersion("1.10.0"), true);
    assert.equal(meetsMinimumVersion("2.0.0"), true);
});

test("meetsMinimumVersion rejects older covdbg, the local debug build included", () => {
    assert.equal(meetsMinimumVersion("1.3.0"), false);
    assert.equal(meetsMinimumVersion("1.3.9"), false);
    assert.equal(meetsMinimumVersion("0.9.0"), false);
    assert.equal(meetsMinimumVersion("0.0.1-debug"), false);
});

/** A covdbg.exe of its own, so no earlier probe of another file is reused. */
function covdbgFile(): string {
    return writeFile(path.join(tempFolder(), "covdbg.exe"));
}

test("probing runs covdbg --version once and remembers the answer", async (t) => {
    const spawned = stubSpawn((process) => {
        process.print("covdbg ");
        process.print("1.5.1\r\n");
        process.exit(0);
    });
    t.after(spawned.restore);
    const exe = covdbgFile();

    assert.equal(await probeCovdbgVersion(exe), "1.5.1");
    assert.equal(await probeCovdbgVersion(exe), "1.5.1");
    assert.equal(spawned.started.length, 1);
    assert.equal(spawned.started[0].command, exe);
    assert.deepEqual(spawned.started[0].args, ["--version"]);
});

test("a file that is not there is not run", async (t) => {
    const spawned = stubSpawn((process) => process.exit(0));
    t.after(spawned.restore);

    assert.equal(await probeCovdbgVersion(path.join(tempFolder(), "covdbg.exe")), undefined);
    assert.equal(spawned.started.length, 0);
});

test("a failed probe gives no version and is tried again next time", async (t) => {
    const spawned = stubSpawn((process) => {
        process.print("covdbg 1.5.1\n");
        process.exit(1);
    });
    t.after(spawned.restore);
    const exe = covdbgFile();

    assert.equal(await probeCovdbgVersion(exe), undefined);
    assert.equal(await probeCovdbgVersion(exe), undefined);
    assert.equal(spawned.started.length, 2);
});

test("a covdbg that cannot start gives no version", async (t) => {
    const spawned = stubSpawn((process) => process.emit("error", new Error("spawn EACCES")));
    t.after(spawned.restore);

    assert.equal(await probeCovdbgVersion(covdbgFile()), undefined);
});

test("a spawn that throws gives no version", async (t) => {
    const childProcess = process.getBuiltinModule("child_process");
    const real = childProcess.spawn;
    childProcess.spawn = (() => {
        throw new Error("spawn EINVAL");
    }) as unknown as typeof childProcess.spawn;
    t.after(() => (childProcess.spawn = real));

    assert.equal(await probeCovdbgVersion(covdbgFile()), undefined);
});

test("a covdbg that does not answer within 5 seconds is killed", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const spawned = stubSpawn(() => undefined);
    t.after(spawned.restore);

    const probing = probeCovdbgVersion(covdbgFile());
    while (spawned.started.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    t.mock.timers.tick(5000);
    assert.equal(await probing, undefined);
    assert.equal(spawned.started[0].killed, true);
});
