import assert from "node:assert/strict";
import test from "node:test";
import { CovdbReloadScheduler } from "../coverage/covdbReloadScheduler";

test("CovdbReloadScheduler defers reloads while coverage execution is active", () => {
    const scheduler = new CovdbReloadScheduler();

    scheduler.beginExecution();
    scheduler.queueReload("workspace-a", "D:\\repo\\coverage.covdb");

    assert.equal(scheduler.hasActiveExecution(), true);
    assert.equal(scheduler.hasPendingReloads(), true);
    assert.deepEqual(
        scheduler.drainPendingReloads(new Map([["workspace-a", "D:\\repo\\coverage.covdb"]])),
        [],
    );

    assert.equal(scheduler.endExecution(), true);
    assert.deepEqual(
        scheduler.drainPendingReloads(new Map([["workspace-a", "D:\\repo\\coverage.covdb"]])),
        [
            {
                stateKey: "workspace-a",
                covdbPath: "D:\\repo\\coverage.covdb",
            },
        ],
    );
    assert.equal(scheduler.hasPendingReloads(), false);
});

test("CovdbReloadScheduler drops queued reloads for stale covdb paths", () => {
    const scheduler = new CovdbReloadScheduler();

    scheduler.queueReload("workspace-a", "D:\\repo\\old.covdb");

    assert.deepEqual(
        scheduler.drainPendingReloads(new Map([["workspace-a", "D:\\repo\\new.covdb"]])),
        [],
    );
    assert.equal(scheduler.hasPendingReloads(), false);
});

test("CovdbReloadScheduler tracks nested executions before draining", () => {
    const scheduler = new CovdbReloadScheduler();

    scheduler.beginExecution();
    scheduler.beginExecution();
    scheduler.queueReload("workspace-a", "D:\\repo\\coverage.covdb");

    assert.equal(scheduler.endExecution(), false);
    assert.deepEqual(
        scheduler.drainPendingReloads(new Map([["workspace-a", "D:\\repo\\coverage.covdb"]])),
        [],
    );

    assert.equal(scheduler.endExecution(), true);
    assert.deepEqual(
        scheduler.drainPendingReloads(new Map([["workspace-a", "D:\\repo\\coverage.covdb"]])),
        [
            {
                stateKey: "workspace-a",
                covdbPath: "D:\\repo\\coverage.covdb",
            },
        ],
    );
});

test("CovdbReloadScheduler stays usable after dropping a reload for another path", () => {
    // An MCP run can write anywhere a model asks it to. A reload queued for a path that is not
    // the active one is correctly dropped - switching the active database under the user is not
    // this scheduler's job - but dropping it must not wedge the queue for the paths that ARE
    // active, which is the failure the backlog worried about.
    const scheduler = new CovdbReloadScheduler();
    const active = new Map([["folder", "D:\\repo\\.covdbg\\coverage.covdb"]]);

    scheduler.queueReload("folder", "D:\repo\somewhere-else\other.covdb");
    assert.deepEqual(scheduler.drainPendingReloads(active), []);
    assert.equal(scheduler.hasPendingReloads(), false, "the dropped entry must not linger");

    scheduler.queueReload("folder", "D:\\repo\\.covdbg\\coverage.covdb");
    const drained = scheduler.drainPendingReloads(active);

    assert.equal(drained.length, 1, "a later reload for the active path must still be delivered");
    assert.equal(drained[0].covdbPath, "D:\\repo\\.covdbg\\coverage.covdb");
});

test("CovdbReloadScheduler matches the active path regardless of case or separator style", () => {
    // The active path comes from settings and the queued one from a file-system event, and on
    // Windows those disagree about case and about forward versus backslashes routinely. Comparing
    // them literally would drop every reload as though it were for another file.
    const scheduler = new CovdbReloadScheduler();

    scheduler.queueReload("folder", "D:/Repo/.covdbg/Coverage.covdb");
    const drained = scheduler.drainPendingReloads(
        new Map([["folder", "D:\\repo\\.covdbg\\coverage.covdb"]]),
    );

    assert.equal(drained.length, 1, "the same file spelled differently is still the same file");
});

test("CovdbReloadScheduler ignores an end without a matching begin", () => {
    const scheduler = new CovdbReloadScheduler();

    assert.equal(scheduler.endExecution(), true);
    assert.equal(scheduler.hasActiveExecution(), false);

    scheduler.beginExecution();
    assert.equal(scheduler.endExecution(), true, "one begin still needs only one end");
});

test("CovdbReloadScheduler drops reloads for a folder that no longer has coverage loaded", () => {
    const scheduler = new CovdbReloadScheduler();

    scheduler.queueReload("closed", "D:\\repo\\coverage.covdb");
    scheduler.queueReload("open", "D:\\other\\coverage.covdb");

    assert.deepEqual(
        scheduler.drainPendingReloads(new Map([["open", "D:\\other\\coverage.covdb"]])),
        [{ stateKey: "open", covdbPath: "D:\\other\\coverage.covdb" }],
    );
    assert.equal(scheduler.hasPendingReloads(), false);
});
