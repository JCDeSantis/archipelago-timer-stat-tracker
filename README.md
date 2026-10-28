# Archipelago Timer and Stat Tracker

**Work in progress — experimental software.** Features and saved data formats may
change, and bugs are expected. Try it with a practice room before relying on it
for a race. This is an independent community project, unaffiliated with Archipelago.

A standalone Windows app for synchronized Archipelago run timing and completion
statistics. It runs independently of PO Launcher, emulators and item trackers.

## Run

Windows x64 builds are available from this repository's **Releases** page once a
release has been published. Choose the portable EXE for a single-file app, the
Setup EXE for an installer, or the ZIP for an unpacked copy. Development builds
are also available under **Actions → Windows builds → completed run → Artifacts**
(GitHub sign-in required; artifacts expire after 30 days).

Use the portable executable, extract the ZIP, or install with the Setup executable.
For development, use Node.js 24 and npm on Windows:

```powershell
npm ci
npm start
npm test
npm run test:ui
npm run build
```

Builds are placed in `dist/`. Local builds never publish automatically. No hosting
account is needed to use the app. Builds currently have no publisher certificate;
Windows may display an unknown-publisher warning.

## Automated Windows builds

The `Windows builds` GitHub Actions workflow runs on pushes, pull requests, manual
dispatch, and published releases. It installs dependencies from the lockfile,
runs protocol and Electron UI tests, builds Windows x64 outputs, and smoke-tests
the packaged app using an isolated temporary profile. Only the portable EXE,
installer, ZIP, and SHA-256 checksums are included in the download artifact.

To publish downloads, update `package.json` and `package-lock.json` together, then
create and publish a GitHub release tagged `v` followed by that version (for
example, `v0.1.11`). Mark releases as **pre-release** while the project is a work
in progress. The workflow rejects a release tag that differs from the package
version and attaches the verified builds to that release after all checks pass.
Publishing a release is a separate maintainer action; ordinary builds only
produce temporary Actions artifacts. No signing secrets are required.

Forgejo has a separate Windows build workflow in `.forgejo/workflows/`. It runs
the same checks and produces the same four downloads as a Forgejo Actions
artifact, using the native `windows-latest` runner label. If that runner is
offline, jobs wait in the queue until it is available. Repository Actions must
be enabled in Forgejo. The workflow does not publish or push to GitHub.

## Repository layout

- `src/`: application code and timer interface.
- `assets/`: app icons; the ICO is used to build Windows executables.
- `test/`: automated checks, including hidden UI checks.
- `scripts/`: packaged-build verification and release download preparation.
- `.github/workflows/`: Windows build and release automation.
- `.forgejo/workflows/`: Windows builds for the private Forgejo copy.
- `docs/`: [feature ideas](docs/FEATURE_IDEAS.md).

The Windows downloads contain only the app, its runtime dependency, the runtime
icon, and license information. Tests, development dependencies, documentation,
build scripts, and workflows are not bundled into the application. `node_modules/`
and `dist/` are generated locally and excluded from Git. To use the app, download
a release asset; cloning this source repository is only needed for development.

## Shared runs

The main timer remains first and prominent in every view. **Live race**, **History
& racers**, **Profiles**, **Alerts & sounds**, and **Connection health** sit beneath
it. See the [race tools guide](docs/RACE_TOOLS.md) for history, called-off runs,
username links, finish cards, profiles, sound cues, previews and awards.

The shared clock is the main view. **Timer only** opens a frameless, resizable
window with no header. The clock, brief event alerts and personal BK timer scale
with the available width and height. Hover anywhere in the timer canvas to reveal
**Show Stats** and **Full view** in a small overlay; Tab also reveals controls for
keyboard use. The overlay does not move the clocks or notifications.
Drag the top edge to move the compact window and resize using its edges.
**Full view** or **Escape** restores the previous window size.
In **Timer only**, **Show Stats** opens a runner panel beneath the clock and
slightly increases the window height. It shows each selected runner's recorded
check count and Longest BK, including an ongoing gap if it is the longest so far.
Up to six runners fit without scrolling; additional runners scroll inside that
panel while the clock and notifications stay fixed. Live updates preserve your
scroll position. **Hide Stats** collapses the panel and reduces the window height.
In Full View, **Show Stats** reveals the detailed individual and group results.
Race setup and runners collapse when a shared run starts. Reopen **Race setup &
runners** whenever needed. The independent solo stopwatch is in its own expandable
panel. Changing views does not pause the timer or stop event recording.

1. Enter the Archipelago server address, your original slot name, an optional room
   password, and a shared session name. All participants use the same room and
   session name. Bare `archipelago.gg:PORT` addresses use TLS (`wss://`). Local
   servers can use `ws://HOST:PORT`. Old plaintext connections that reset during
   the handshake are retried with TLS; encrypted connections are never downgraded.
2. Connect and select the players who count toward the group result. Other games
   are supported; item-link groups are excluded. Not every player needs this app.
3. One person starts the 5–60 second countdown. The first start wins atomically,
   fixing the roster and start for that session. Start playing manually at zero.
4. Each game's Archipelago client reports goal completion. The tracker detects
   `PrintJSON` events of type `Goal` and client status `30` (`CLIENT_GOAL`) through
   `_read_client_status_<team>_<slot>` notifications and 15-second polling.
   A host's `/release <player>` or a permitted player's `!release` produces a
   `PrintJSON` event of type `Release`: that player becomes **Released** and their
   timer stops. The group stops when everyone selected is completed or released.
   Goal completion takes priority over release, including automatic release after
   a goal. Collecting items and chat messages do not stop timers.
5. Export statistics to JSON to save individual and group results. Unknown finish
   times are null, not zero. Passwords are never saved or exported.

Keep at least one timer connected throughout the run. Minimize the app to keep
recording in the background. Closing the app stops recording. Network loss triggers
automatic reconnect; elapsed time continues through disconnections. Room storage
preserves the shared start and observed finishes for late joins and reconnects.
The room server must retain its save data to preserve results after a restart.
Choose a new session name for a different run. Slots already marked as completed
or observed as released cannot enter another timed run in that room/team.
This app cannot reset those results. Exports distinguish completed, released and
total finished players, and include each player's observed release timestamp.

## Following Archipelago room countdowns

**Follow room countdowns automatically** is enabled by default in **Settings**.
If the current timer session has no saved start, a server announcement such as
`[Server]: Starting countdown of 30s` automatically schedules the shared timer
for 30 seconds after that message was observed. There is no need to press Start
in this app. The manual countdown selector does not override the room's duration.

The app uses structured `PrintJSON` / `Countdown` packets when available and
supports the exact server announcement text as a fallback. Structured remaining
seconds also allow a connected tracker to join an ongoing countdown. Durations
from 1 to 3600 seconds are supported. Ordinary player chat, malformed messages,
and a standalone GO message cannot create a race.

Automatic starts use the selected, eligible runners and bypass this app's ready
checks so other Archipelago clients can coordinate the start. Select runners
before the room countdown begins; with no selection, automatic start is blocked.
The first saved start wins for that room/team/session, including across multiple
timer apps and reconnects. Repeated countdown ticks or another countdown cannot
replace a saved start, even if its countdown has not reached zero yet. Choose a
fresh session name for a new race, or disable following in Settings to start only
from this app.

Timing uses notification receipt on the synchronized room clock, so normal
network delay still affects precision. A countdown received while the tracker
is loading room data keeps its original target time rather than starting an
extra countdown after loading finishes. The tracker never sends countdown chat
commands or gameplay status updates to control other clients.

## Ready checks, race events and BK

**Require ready checks** is enabled in race setup by default. Every selected
runner opens this app with their own slot, the same room/team/session, and the
same selected roster, then presses **I'm ready**. Changing the roster requires
new confirmations. Ready confirmations refresh every 15 seconds and expire after
45 seconds without a heartbeat. A normal Disconnect clears your confirmation.
Uncheck the requirement for runs with players who do not use the timer app.

One person presses Start once everyone is ready. The app retrieves fresh ready
confirmations before scheduling. The first shared start written to room storage
wins; all connected timers count down to that same absolute server-clock time,
including late joins. Games must still be started manually. Readiness uses the
timer's own storage, never Archipelago gameplay `StatusUpdate` packets. It is a
coordination feature; network delays can affect display precision, and ready
changes after a countdown has been committed do not cancel or restart it.

The **Race events** area under the group clock shows ready confirmations, race
start, player completion and release, first recorded check, check milestones
(10, 25, 50, 100, 250 and 500), over-half progress, and the group finish. Events
are reconstructed from shared results and check history on reconnect and are
included in JSON exports. Unknown historical timestamps remain unknown.

Halfway means strictly more than 50% of the slot's total locations, including
checks completed before the timed run. Each slot's timer shares the total and
known checked locations supplied by its Archipelago connection. A runner whose
total is unavailable gets check-count milestones without guessed percentages.
Release-generated checks do not trigger halfway milestones. Automatic collect
can generate indistinguishable check events, as described under Run statistics.

The personal **BK Timer** appears in Race events after five minutes without a
recorded check for the slot you connected as. Until your first check, it counts
from the shared start. Other runners' checks do not reset it. Your next check
hides it; completion or release removes it. Only selected runners have a personal
BK timer. Offline, it explicitly shows that it is based on the last recorded
check.

In **Timer only**, brief text popups appear directly beneath the clock. Each
lasts eight seconds and fades away, with a short gap before the next alert.
Player finishes, releases and the group finish take priority over check
milestones. Finish and release messages are green in both the compact popups and
the main event log. Old events are not replayed when entering this view or
reconnecting, and stale queued messages are discarded. Your own BK never
generates popup reminders; its live clock remains available. Other active,
selected runners get a BK alert after ten minutes without a recorded check and
then at most once every ten minutes while that gap continues. Their next check,
finish or release clears any pending BK alert. Switching views or reconnecting
does not restart the reminder interval.
The full event history remains available in the main view.

Timer Only also shows a separate, continuously updating **BK Timer** beneath
the event popups once your own gap reaches five minutes. It shows the full time
since your last recorded check (or the race start before your first check), stays
visible after popups fade, and disappears on your next check, finish or release.

**Always on top** is available in the main view's **Settings** panel. It applies
to both views and is remembered in this app's settings profile. The full view's
header provides minimize, maximize/restore and close controls.

## Timing accuracy

These are real elapsed times, not game time. The app uses the room's clock and live
goal notification receipt. Network delay affects precision. Archipelago does not
provide historical goal timestamps. If every timer misses a goal, the app can
recover completion status but shows the finish time as unavailable; the group
time is also unavailable if any required finish time is missing. Goals before the
scheduled start also have no valid elapsed time.

Observed releases are saved in room storage across timer sessions and reconnects.
Archipelago has no persistent release client status: a release missed by every
tracker cannot be recovered reliably. Checking every location is not proof of a
goal or release. At least one tracker must witness the structured release event.
Both goal and release timing use event receipt; polling recovery uses detection
time. Releases before the scheduled start have no valid elapsed time.

The app connects as a `Tracker` observer with no item handling. It uses room data
storage and goal/release notifications and never sends gameplay checks or goal statuses.
Protocol: https://github.com/ArchipelagoMW/Archipelago/blob/main/docs/network%20protocol.md

## Run statistics

The Run statistics panel shows recorded checks for every selected runner and the
whole group. Individual times finalize when that runner completes or releases;
group time finalizes when everyone has finished. JSON exports include the same
statistics (`checksCompleted`, `elapsedMs`, `longestBKMs`).

**Longest BK** is the longest gap without a recorded check, including the shared
start to the first check and the last check to the finish. A runner with no checks
has their whole elapsed time as BK. Group BK uses the combined check timeline
of all selected runners, so a check by anyone ends the group's current gap.
Unknown finish times produce unknown BK values; active runs show In progress.

Checks use team-broadcast `PrintJSON` / `ItemSend` events and the finding player's
slot (`item.player`), not the recipient. Each location counts once per world.
Only events during the timed run and before that runner stops count. Release
notifications precede their generated item events, so released checks are excluded.
History is saved in room storage and shared across observers and reconnects.

These are recorded statistics, not a reconstruction of historical play. Checks
missed by every tracker cannot be recovered from this event history. Older runs,
late joins and connection gaps may have incomplete counts and BK values. Automatic
collect can generate checks in other worlds without an unambiguous per-check
marker, so those events can appear in the recorded statistics.

## Share finished race results

Once every selected runner has completed or released, **Copy results** and
**Post to chat** appear beside the timer controls in both views. In Timer Only,
hover over the clock or use Tab to reveal them. Nothing is copied or posted
automatically.

Both buttons now open **Result preview** first. Review the exact text, choose
checks/BK/highlights and original versus local display names, then explicitly
copy or post the preview. Recording warnings and completion/release labels are
mandatory. A preview expires after 15 minutes; posting also verifies that its
data has not changed and the connected room/team/session matches the saved run.
Historical finished races can be previewed from History, but cannot be posted
to an unrelated connected race. Called-off runs must be restored before sharing
completed results. **Finish card** exports group or individual PNGs; group cards
paginate at six runners rather than shrinking long rosters into unreadable text.

Both options use the same summary: Total Group Time and group check count,
followed by each runner's completion/release status, individual time, recorded
check count, and Longest BK. Runner BK values below five minutes display **N/A**;
exactly five minutes and longer display the recorded duration. Missing finish
or BK times display **Unavailable**, not a guessed value.

Copying works offline after results are available. Posting requires an active,
fully loaded room connection and sends a header plus one printable chat line
per runner, as the slot connected to this app. After sending, posting is disabled
for that run in this app instance, including after reconnects. It is not a
room-wide duplicate lock, and restarting the app allows posting again. Server
delivery or display is not acknowledged by the chat protocol. The only chat
messages the tracker sends are these explicitly requested results; it never
sends gameplay checks, goal updates, or countdown commands.

## Solo stopwatch and local data

The solo stopwatch has manual Start, Finish and Reset controls. It survives app
restarts and includes elapsed time while the app is closed. It is independent of
the shared run.

Settings live in `%APPDATA%\archipelago-timer-stat-tracker\settings.json`, separate
from PO Launcher. The app does not read, change or import PO Launcher settings.
Room passwords stay in memory only. There is no telemetry or automatic upload.

Race history, local racer identities and profiles live beside settings in
`race-history.sqlite` (with SQLite journal files). They are not packaged or
included in Git. Unfinished runs retain their observations, without a guessed
finish. The library remembers the room address and own slot locally for an
explicit **Prepare resume** action; race exports omit that connection information
and local identity links. JSON imports never overwrite an existing run's local
tracking choice. The initial database schema is versioned; newer schemas are
preserved and reported rather than overwritten by an older app.

## Verification

`npm test` covers the protocol, shared starts, individual/group finishes,
reconnection, missing timestamps, TLS upgrade and solo persistence using local
fixtures. `npm run test:ui` exercises the real standalone Electron window and IPC
against a local simulated room with a temporary app profile. UI checks run in a
hidden, non-focusable window, using Chromium input emulation so they do not move
the desktop pointer, steal focus, or interrupt other applications. Native window
minimize/maximize actions are not exercised by this background check.

Set `AP_TIMER_SELFTEST` to an absolute report path when launching a packaged app
to run its isolated self-test. `AP_TIMER_SCREENSHOT` optionally specifies a PNG
capture path. The self-test never touches the normal app profile.

## License

MIT. This project was separated from an unpublished timer experiment in PO Launcher.
It contains no PO Launcher runtime, vendored game tracker, ROM handling or native
window helper. The Archipelago protocol implementation is independent.
