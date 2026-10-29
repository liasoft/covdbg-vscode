import { vscodeStub } from "./vscodeStub";
import test from "node:test";
import assert from "node:assert/strict";
import * as output from "../views/outputChannel";

const log = vscodeStub.window.log;

test("lines are timestamped, and errors say so", () => {
    output.log("indexed");
    output.logError("broken");

    assert.match(log[log.length - 2], /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] indexed$/);
    assert.match(log[log.length - 1], /^\[[^\]]+\] ERROR: broken$/);
});

test("the channel is created once, shown on request, and made anew after it is disposed", () => {
    const create = vscodeStub.window.createOutputChannel;
    let created = 0;
    let disposed = 0;
    vscodeStub.window.createOutputChannel = () => {
        created++;
        return {
            ...create(),
            dispose: () => {
                disposed++;
                return undefined;
            },
        };
    };
    try {
        output.dispose(); // forgets the channel the first test made
        output.dispose(); // with none open, there is nothing to dispose
        output.show();
        output.log("again");
        assert.equal(log[log.length - 2], "<shown>");
        assert.equal(created, 1);
        assert.equal(output.getOutputChannel(), output.getOutputChannel());

        output.dispose();
        output.log("after");
        assert.equal(created, 2);
        assert.equal(disposed, 1);
    } finally {
        vscodeStub.window.createOutputChannel = create;
    }
});
