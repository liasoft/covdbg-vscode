/** What the editor can offer next to a notice. */
export type NoticeAction = "signIn" | "openProfile" | "openApp";

/**
 * Something covdbg said about the license of a run: a refusal, a sign-in that has ended, a
 * personal lock, gated reporting, or any other message the license service attached.
 */
export interface RunNotice {
    kind: "refused" | "sessionInvalid" | "lockSet" | "gated" | "message";
    message: string;
    action?: NoticeAction;
}

export const PROFILE_URL = "https://app.covdbg.com/profile";
export const APP_URL = "https://app.covdbg.com";

/**
 * covdbg's own progress lines on stdout, which say nothing about the license. Since covdbg 1.5.1
 * every run also says how the program exited and, where nothing was measured, why.
 */
const PROGRESS_LINES = [
    /^collecting coverage for /,
    /^coverage written to /,
    /^an empty coverage database was written to /,
    /^no coverage database was written to /,
    /^\d+ of \d+ basic blocks hit /,
    /^continued past \d+ breakpoint\(s\) the program did not handle/,
    / exited with (code \d+|0x[0-9a-f]{8})(;|$)/,
    /^nothing was measured: /,
];

/**
 * Reads one whole line of a run's output. A refusal is logged as an error, so it arrives on
 * stderr; everything the service attached to a granted run is printed on stdout. With a project
 * token in the run's environment, covdbg decides on the token, so signing in fixes nothing.
 */
export function classifyRunLine(
    stream: "stdout" | "stderr",
    line: string,
    projectToken = false,
): RunNotice | undefined {
    const text = line.trim();
    if (stream === "stderr") {
        const refusal = /This run is not licensed: (.+)$/.exec(text)?.[1].trim();
        if (!refusal) {
            return undefined;
        }
        const action = routeRefusal(refusal);
        return {
            kind: "refused",
            message: refusal,
            action: projectToken && action === "signIn" ? "openApp" : action,
        };
    }

    const message = /^covdbg: (.+)$/.exec(text)?.[1].trim();
    if (!message || PROGRESS_LINES.some((pattern) => pattern.test(message))) {
        return undefined;
    }
    // The service rejected the credential (401) and covdbg fell back to running offline: the run
    // went ahead, but the sign-in (or the project token) is no longer accepted.
    if (/could not be reached/.test(message) && /covdbg login/.test(message)) {
        return projectToken
            ? {
                  kind: "message",
                  message: "The license service did not accept COVDBG_PROJECT_TOKEN.",
                  action: "openApp",
              }
            : { kind: "sessionInvalid", message: "Your sign-in has ended.", action: "signIn" };
    }
    if (/now locked to/i.test(message)) {
        return { kind: "lockSet", message, action: "openProfile" };
    }
    if (/coverage reporting is gated/.test(message)) {
        return { kind: "gated", message };
    }
    return { kind: "message", message };
}

/** The fix to offer for a refusal, from its message. */
function routeRefusal(message: string): NoticeAction | undefined {
    if (/covdbg login|sign in/i.test(message)) {
        return "signIn";
    }
    if (/locked to/i.test(message)) {
        return "openProfile";
    }
    if (/no remote and no commits/i.test(message)) {
        // The message already says what to do: add a remote or make a first commit.
        return undefined;
    }
    return "openApp";
}

/** A batch shows at most one toast, and only for a refusal. */
export function pickBatchToast(notices: readonly RunNotice[]): RunNotice | undefined {
    return notices.find((notice) => notice.kind === "refused");
}

const NOTICE_PRIORITY: RunNotice["kind"][] = [
    "refused",
    "sessionInvalid",
    "lockSet",
    "gated",
    "message",
];

/** The one notice to keep from a batch: the one that matters most, the latest of equals. */
export function summarizeNotices(notices: readonly RunNotice[]): RunNotice | undefined {
    for (const kind of NOTICE_PRIORITY) {
        const matching = notices.filter((notice) => notice.kind === kind);
        if (matching.length > 0) {
            return matching[matching.length - 1];
        }
    }
    return undefined;
}

/** Whether the notices say this machine is no longer signed in. */
export function endsSignIn(notices: readonly RunNotice[]): boolean {
    return notices.some(
        (notice) =>
            notice.kind === "sessionInvalid" ||
            (notice.kind === "refused" && notice.action === "signIn"),
    );
}
