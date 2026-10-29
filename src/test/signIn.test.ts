import test from "node:test";
import assert from "node:assert/strict";
import {
    describeSignedIn,
    parseSignOut,
    parseSignedIn,
    querySignIn,
    signIn,
    signOut,
} from "../runner/signIn";
import { answerWhoami, fakeCovdbg, settle, stubSpawn } from "./fakeCovdbg";

const EXE = "C:/covdbg/covdbg.exe";
const PROMPT =
    "\n  Open https://app.covdbg.com/device?code=ABCD-1234\n" +
    "  and confirm the code there:  ABCD-1234\n\nWaiting for you to finish...\n";

test("parseSignedIn reads the team out of the login line", () => {
    assert.deepEqual(parseSignedIn("Signed in as a@acme.com for Acme Inc.\r\n"), {
        email: "a@acme.com",
        teamName: "Acme Inc",
    });
    assert.deepEqual(parseSignedIn("Signed in as a@acme.com for Made for You.\n"), {
        email: "a@acme.com",
        teamName: "Made for You",
    });
    assert.deepEqual(parseSignedIn("Signed in as dev@example.com.\n"), {});
    assert.deepEqual(
        parseSignedIn("Already signed in as old@acme.com for Old. Signing in again replaces it.\n"),
        {},
    );
    assert.deepEqual(parseSignedIn("Not signed in.\n"), {});
    assert.equal(
        describeSignedIn({ email: "a@acme.com", teamName: "Acme" }),
        "Signed in as a@acme.com for Acme",
    );
    assert.equal(describeSignedIn({ email: "a@acme.com" }), "Signed in as a@acme.com");
    assert.equal(describeSignedIn({}), "Signed in");
});

test("whoami --json gives the account and team, whatever the exit code", async () => {
    const json = {
        signedIn: true,
        email: "a@acme.com",
        accountId: "acc_1",
        teamName: "Acme",
        teamSlug: "acme",
        teamKind: "team",
        source: "local",
        projectToken: false,
    };
    const covdbg = fakeCovdbg((process) => {
        process.print(JSON.stringify(json) + "\r\n");
        process.exit(0);
    });
    assert.deepEqual(await querySignIn(EXE, { marker: "1" }, covdbg.start), {
        kind: "signedIn",
        email: "a@acme.com",
        accountId: "acc_1",
        teamName: "Acme",
        teamSlug: "acme",
        teamKind: "team",
    });
    assert.deepEqual(
        covdbg.started.map((process) => process.args),
        [["whoami", "--json"]],
    );
    assert.equal(covdbg.started[0].env.marker, "1");

    const out = fakeCovdbg((process) => {
        process.print(JSON.stringify({ signedIn: false, email: null }));
        process.exit(1);
    });
    assert.deepEqual(await querySignIn(EXE, {}, out.start), { kind: "signedOut" });
    assert.equal(out.started.length, 1);
});

test("whoami --json that is not the contract's object is an error", async () => {
    const cases: [string, number, RegExp][] = [
        ["covdbg: unknown option --json\n", 2, /expected JSON.*exit code 2/],
        ["", 0, /expected JSON/],
        ["[]", 0, /expected JSON/],
        ["null", 0, /expected JSON/],
        ['{"email":"a@acme.com"}', 0, /expected JSON/],
        ['{"signedIn":"yes"}', 0, /expected JSON/],
    ];
    for (const [stdout, code, message] of cases) {
        const covdbg = fakeCovdbg((process) => {
            process.print(stdout);
            process.exit(code);
        });
        const result = await querySignIn(EXE, {}, covdbg.start);
        assert.equal(result.kind, "error");
        assert.match(result.kind === "error" ? result.message : "", message);
        assert.equal(covdbg.started.length, 1);
    }
});

test("whoami that cannot start is an error", async () => {
    const covdbg = fakeCovdbg((process) => process.emit("error", new Error("ENOENT")));
    assert.deepEqual(await querySignIn(EXE, {}, covdbg.start), {
        kind: "error",
        message: "Failed to start covdbg: ENOENT",
    });
});

test("sign-in announces the page once, even when the prompt arrives in pieces", async () => {
    const prompts: unknown[] = [];
    const covdbg = fakeCovdbg(() => undefined);
    const result = signIn(
        EXE,
        {},
        (prompt) => prompts.push(prompt),
        new AbortController().signal,
        covdbg.start,
    );
    const login = covdbg.started[0];
    assert.deepEqual(login.args, ["login"]);

    login.print("\n  Open https://app.covdbg.com/dev");
    login.print("ice?code=ABCD-1234\r\n  and confirm the code the");
    assert.equal(prompts.length, 0);
    login.print("re:  ABCD-1234\r\n\r\nWaiting for you to finish...\r\n");
    assert.deepEqual(prompts, [
        { url: "https://app.covdbg.com/device?code=ABCD-1234", code: "ABCD-1234" },
    ]);

    login.print(
        "Signed in as dev@example.com for Acme.\nSeats, teams and your personal lock are managed at ",
    );
    login.print("https://app.covdbg.com\n");
    login.exit(0);
    assert.deepEqual(await result, {
        kind: "signedIn",
        email: "dev@example.com",
        teamName: "Acme",
    });
    assert.equal(prompts.length, 1);
});

test("the login line names the team", async () => {
    const covdbg = fakeCovdbg((process) => {
        process.print(PROMPT + "Signed in as a@acme.com for Acme.\n");
        process.exit(0);
    });
    const result = await signIn(
        EXE,
        {},
        () => undefined,
        new AbortController().signal,
        covdbg.start,
    );
    assert.deepEqual(result, { kind: "signedIn", email: "a@acme.com", teamName: "Acme" });
});

test("a bare 'Signed in.\' is a sign-in without an email", async () => {
    const covdbg = fakeCovdbg((process) => {
        process.print(PROMPT + "Signed in.\n");
        process.exit(0);
    });
    const result = await signIn(
        EXE,
        {},
        () => undefined,
        new AbortController().signal,
        covdbg.start,
    );
    assert.deepEqual(result, { kind: "signedIn" });
});

test("a failed sign-in reports the line covdbg printed on stdout", async () => {
    const covdbg = fakeCovdbg((process) => {
        process.print(PROMPT + "The code expired before it was entered.\n");
        process.exit(1);
    });
    const result = await signIn(
        EXE,
        {},
        () => undefined,
        new AbortController().signal,
        covdbg.start,
    );
    assert.deepEqual(result, {
        kind: "failed",
        message: "The code expired before it was entered.",
    });
});

test("cancelling a sign-in kills covdbg login", async () => {
    const abort = new AbortController();
    const covdbg = fakeCovdbg((process) => process.print(PROMPT));
    const result = signIn(EXE, {}, () => undefined, abort.signal, covdbg.start);
    await settle();
    abort.abort();
    assert.deepEqual(await result, { kind: "cancelled" });
    assert.equal(covdbg.started[0].killed, true);
});

test("sign-out passes on the 'Signed out' line and the service's problem", async () => {
    const stdout =
        "Signed out dev@example.com.\r\n" +
        "covdbg: the session could not be ended on the service (timed out); it stays listed under " +
        "your sessions until it expires. End it at https://app.covdbg.com\r\n" +
        "Your seats and personal lock stay as they are; manage them at https://app.covdbg.com\r\n";
    const covdbg = fakeCovdbg((process) => {
        process.print(stdout);
        process.exit(0);
    });
    assert.deepEqual(await signOut(EXE, {}, covdbg.start), {
        ok: true,
        message: "Signed out dev@example.com.",
        serviceProblem:
            "covdbg: the session could not be ended on the service (timed out); it stays listed " +
            "under your sessions until it expires. End it at https://app.covdbg.com",
    });
    assert.deepEqual(covdbg.started[0].args, ["logout"]);

    assert.deepEqual(
        parseSignOut(
            "Signed out dev@example.com.\nYour seats and personal lock stay as they are; manage them at https://app.covdbg.com\n",
        ),
        { message: "Signed out dev@example.com.", serviceProblem: undefined },
    );
    assert.deepEqual(parseSignOut("Not signed in.\n"), {
        message: "Not signed in.",
        serviceProblem: undefined,
    });
    assert.deepEqual(parseSignOut(""), { message: "Signed out.", serviceProblem: undefined });
});

test("a failed sign-in without a line on stdout says what stderr said, or how covdbg exited", async () => {
    const login = (script: Parameters<typeof fakeCovdbg>[0]) =>
        signIn(EXE, {}, () => undefined, new AbortController().signal, fakeCovdbg(script).start);

    assert.deepEqual(
        await login((process) => {
            process.stderr.emit("data", Buffer.from("covdbg: the service is down\r\n"));
            process.exit(1);
        }),
        { kind: "failed", message: "covdbg: the service is down" },
    );
    assert.deepEqual(await login((process) => process.exit(5)), {
        kind: "failed",
        message: "covdbg login exited with code 5",
    });
    assert.deepEqual(await login((process) => process.emit("error", new Error("ENOENT"))), {
        kind: "failed",
        message: "Failed to start covdbg login: ENOENT",
    });
});

test("a sign-in that outlasts covdbg's own limit is given up", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const covdbg = fakeCovdbg((process) => process.print(PROMPT));
    const result = signIn(EXE, {}, () => undefined, new AbortController().signal, covdbg.start);
    await settle();

    t.mock.timers.tick(11 * 60_000);
    assert.deepEqual(await result, {
        kind: "failed",
        message: "The sign-in did not finish in time.",
    });
    assert.equal(covdbg.started[0].killed, true);
});

test("a failed sign-out says covdbg's last line, or how it exited", async () => {
    const logout = (script: Parameters<typeof fakeCovdbg>[0]) =>
        signOut(EXE, {}, fakeCovdbg(script).start);

    assert.deepEqual(
        await logout((process) => {
            process.print("Signing out...\nThe credential store is locked.\n");
            process.exit(1);
        }),
        { ok: false, message: "The credential store is locked." },
    );
    assert.deepEqual(
        await logout((process) => {
            process.stderr.emit("data", Buffer.from("covdbg: access denied\n"));
            process.exit(1);
        }),
        { ok: false, message: "covdbg: access denied" },
    );
    assert.deepEqual(await logout((process) => process.exit(1)), {
        ok: false,
        message: "covdbg logout exited with code 1",
    });
    assert.deepEqual(await logout((process) => process.emit("error", new Error("EACCES"))), {
        ok: false,
        message: "Failed to start covdbg: EACCES",
    });
});

test("a covdbg that does not answer whoami in time is killed and reported", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const covdbg = fakeCovdbg(() => undefined);
    const result = querySignIn(EXE, {}, covdbg.start);
    await settle();

    t.mock.timers.tick(15_000);
    assert.deepEqual(await result, {
        kind: "error",
        message: "covdbg whoami did not finish in time.",
    });
    assert.equal(covdbg.started[0].killed, true);
});

test("unless told otherwise, covdbg is started hidden with the environment given", async (t) => {
    const spawned = stubSpawn((process) => answerWhoami(process, undefined));
    t.after(spawned.restore);

    assert.deepEqual(await querySignIn(EXE, { marker: "1" }), { kind: "signedOut" });
    assert.equal(spawned.started[0].command, EXE);
    assert.deepEqual(spawned.started[0].options, { env: { marker: "1" }, windowsHide: true });
});
