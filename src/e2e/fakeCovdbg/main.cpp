// A covdbg stand-in for the end-to-end tests. It answers --version, whoami, login and logout
// the way covdbg 1.4 does, keeping its sign-in in FAKE_COVDBG_STATE instead of the machine's
// credential store, and hands every other command line to the real covdbg in FAKE_COVDBG_REAL.
#include <windows.h>

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>

namespace fs = std::filesystem;

static fs::path StateDir()
{
    wchar_t buffer[MAX_PATH];
    DWORD length = GetEnvironmentVariableW(L"FAKE_COVDBG_STATE", buffer, MAX_PATH);
    return length ? fs::path(buffer) : fs::temp_directory_path() / L"fake-covdbg";
}

static void Say(const char* line)
{
    std::fputs(line, stdout);
    std::fputs("\n", stdout);
    std::fflush(stdout);
}

static int Forward()
{
    wchar_t real[MAX_PATH];
    if (!GetEnvironmentVariableW(L"FAKE_COVDBG_REAL", real, MAX_PATH)) {
        Say("fake covdbg: FAKE_COVDBG_REAL is not set");
        return 1;
    }
    // Everything after our own argv[0] goes to the real covdbg unchanged.
    std::wstring rest = GetCommandLineW();
    bool quoted = !rest.empty() && rest[0] == L'"';
    size_t end = quoted ? rest.find(L'"', 1) + 1 : rest.find(L' ');
    rest = end == std::wstring::npos || end >= rest.size() ? L"" : rest.substr(end);
    std::wstring commandLine = L"\"" + std::wstring(real) + L"\"" + rest;

    STARTUPINFOW startup{sizeof(startup)};
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(real, commandLine.data(), nullptr, nullptr, TRUE, 0, nullptr, nullptr, &startup,
            &process)) {
        Say("fake covdbg: could not start the real covdbg");
        return 1;
    }
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return static_cast<int>(code);
}

int wmain(int argc, wchar_t** argv)
{
    fs::path state = StateDir();
    fs::create_directories(state);
    fs::path signedIn = state / L"signed-in";
    std::wstring command = argc > 1 ? argv[1] : L"";

    if (command == L"--version") {
        // FAKE_COVDBG_VERSION, when set, is the real covdbg's line, so the editor shows its version.
        char version[64];
        Say(GetEnvironmentVariableA("FAKE_COVDBG_VERSION", version, sizeof(version)) ? version
                                                                                     : "covdbg 1.4.0");
        return 0;
    }
    if (command == L"whoami") {
        // The extension asks for `whoami --json`; the exit code follows the sign-in too.
        if (fs::exists(signedIn)) {
            Say("{\"signedIn\":true,\"email\":\"e2e@example.com\",\"accountId\":\"acc_e2e\","
                "\"teamName\":\"E2E Team\",\"teamSlug\":\"e2e-team\",\"teamKind\":\"team\","
                "\"source\":\"service\",\"projectToken\":false}");
            return 0;
        }
        Say("{\"signedIn\":false,\"email\":null,\"source\":\"none\",\"projectToken\":false}");
        return 1;
    }
    if (command == L"logout") {
        fs::remove(signedIn);
        Say("Signed out e2e@example.com.");
        Say("Your devices are listed at https://app.covdbg.com/profile; manage them at https://app.covdbg.com/profile.");
        return 0;
    }
    if (command == L"login") {
        // Word for word what covdbg 1.4.0 prints (RunLoginCommand in covdbg's main.cpp).
        Say("");
        Say("  Open https://app.covdbg.com/device?code=E2EE-TEST");
        Say("  and confirm the code there:  E2EE-TEST");
        Say("");
        Say("Waiting for you to finish...");
        // The test "confirms in the browser" by dropping a file; "deny" makes the sign-in fail.
        for (int i = 0; i < 1200; ++i) {
            if (fs::exists(state / L"confirm")) {
                fs::remove(state / L"confirm");
                std::FILE* file = _wfopen(signedIn.c_str(), L"w");
                if (file) {
                    std::fclose(file);
                }
                Say("Signed in as e2e@example.com for E2E Team.");
                Say("Seats, teams and your personal lock are managed at https://app.covdbg.com");
                return 0;
            }
            if (fs::exists(state / L"deny")) {
                fs::remove(state / L"deny");
                Say("The sign-in was refused in the browser.");
                return 1;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        Say("The code expired before it was entered.");
        return 1;
    }
    return Forward();
}
