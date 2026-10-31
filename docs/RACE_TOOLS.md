# Race tools

The timer is always the first and largest element. Supporting tools open beneath
it; Timer Only retains its compact clock, notifications and runner statistics.
Nothing in these tools automatically connects, starts a game, posts chat or
changes Archipelago gameplay status.

## Version 0.5.0: hotkeys, review and display options

**Display & hotkeys** contains the new local preferences. Global hotkeys are
disabled until explicitly enabled and saved. Defaults use Ctrl+Alt+Shift plus
P (Playing), W (Waiting), B (Break), G (Go mode), S (toggle statistics),
T (toggle Timer Only), or M (temporarily mute/unmute sounds). Each binding can
be changed or left blank. A shortcut already owned by another app is rejected;
the app attempts to restore the previous working bindings. Shortcuts do not
focus the timer, start or stop the race, or submit results. Status shortcuts
require a connected, unfinished runner. View shortcuts wait until dialogs are
closed. Temporary sound mute resets on app restart and retains saved sound
preferences. Hidden automated tests simulate registration instead of claiming
system shortcuts while a game is running.

Compact layout preferences can hide game, declared status, world checks, Hints
Used or Longest BK; names always remain visible. Filter to all racers,
unfinished racers or yourself, sort by roster/name/world completion percentage,
and pin usernames in your preferred order. Pinning applies within the filter.
These settings persist locally. Show Stats sizes to the filtered list and keeps
scrolling inside that list after six rows; an empty filter shows a clear message.

Open **History & racers**, select a run, then scroll to **Race review timeline**.
The slider and previous/next event controls explore recorded checks, declared
statuses, finishes, count recoveries and recording gaps. Filter by racer or
event kind. Green marks indicate recorded checks and amber bands mark known
recording gaps. The list shows the latest 100 matching events at the slider
position. Refresh recording to update an active run's review. Review is silent
and does not replay notifications or alter the live timer.

Individual check timestamps and structured Go-mode declarations are retained
from this version forward, including in history exports/imports. Older records
can still be opened but missing detail remains unavailable. Unknown timestamps
from recovered counters never become check marks or new BK boundaries. History
retains up to 100,000 check timestamps and 5,000 events per race; chart marks are
sampled for large runs. Recording quality warnings remain visible.

Below the timeline, **Same-seed comparisons** offers other non-excluded attempts
from the same seed and team. Matching runners require the same slot, original
username and game. Choose completion time, first recorded check, first recorded
Go-mode declaration, recorded check count or Longest BK. Negative differences
mean this attempt's value is lower. Unknown values stay unavailable; check/BK
differences are withheld when either recording has uncertain coverage. Group
time differences require matching rosters and completed runners in both attempts;
release is not treated as completion. Different seeds are never compared.

Count refreshes now explain additions beyond the previously known baseline in
the Race events log and Connection health, including the source and racer/count.
An initial snapshot stays quiet, live-observed checks are not reported again as
recoveries, and unchanged polling does not repeat the explanation. The optional
**Recovered check counts** alert category defaults to no popup and no sound.
The explanation's timestamp is the recovery time, not an invented check time.

In Timer Only, hover over the timer (or use Tab) and choose **Status** to quickly
share Playing, Waiting, Taking a break or Go mode. The choices overlay the timer;
they do not resize the window or move the clock and notifications. Escape closes
the choices first, and clicking outside also dismisses them. Waiting uses your
existing waiting detail if present; edit that optional detail in the full view.
Status changes use the same shared room/team/session data as the full-view
controls and never pause the clock or reset BK. They require a connected,
unfinished runner.

Compact Show Stats displays a small status badge beside each runner name, with
the game on the line below. Waiting details are available in the badge tooltip.
Completed and Released replace declared statuses once that runner stops. Runners
who have not declared a status have no badge.

## Compact statistics and progress synchronization (0.4.1)

Timer Only → Show Stats lists runner name, game, world checks completed / total,
Hints Used, and Longest BK. The game is shown as a second line under the name so
the panel still fits six runners before its own list starts scrolling. Long game
names truncate visually and remain available in the tooltip.

The denominator comes from that slot's actual server-reported checked and missing
locations, not a generic number of locations supported by the game. World totals
include checks before this timed race and checks created by release/collect.
The full run statistics and shared race results continue to count recorded timed
checks separately. If a world total is unavailable, the compact row shows
recorded race checks followed by ` / ?`, with an explanatory tooltip.

Hints Used counts purchased hints across the room session, calculated from the
server's matching checked count, points earned per check, hint price and remaining
hint-point balance. It does not count entries in the visible hint list: those can
include starting hints, hints for other players, repeated announcements, or hints
supplied without a purchase. Zero-cost hints and missing/inconsistent pricing data
show `—` rather than an invented zero. These fields are also retained in saved
race records; older records keep unknown values.

Each connected timer receives live RoomUpdate data and republishes its own world
progress to the room's shared timer storage. Every minute, it reauthenticates the
same observer slot on the existing socket to obtain a complete server snapshot,
then reconciles shared observer records. This does not reset the race, readiness,
declared status, check timestamps, or finish times. A normal reconnect also gets
a complete snapshot. **Connection health → Sync progress now** requests the same
refresh manually and shows the latest own-world refresh time.

Normal use requires no tracker URL. The app uses observed live checks, own-slot
server snapshots and any snapshots shared by other timer users. This is
best-effort tracking: missed checks during offline periods can remain absent.

Optional all-player count recovery uses the structured WebHost tracker API.
Enter the correct room or tracker page URL in the connection form, or open
**Connection health**, paste it and select **Use this source**. Other racers do
not need to install this app. A server address/port alone cannot identify its
room's tracker; the app does not guess or search other rooms.

The app discovers the tracker from a room URL and reads all-player checked
location IDs, totals and games automatically once per minute. Dynamic data is
cached for 60 seconds and static data for five minutes. Roster/game/own-world
checks reject mismatched responses. API errors retain known counts, display a
clear connection-health explanation and retry automatically. Without a URL or
during API outages, own-slot server snapshots, shared observers and live events
continue; full remote-player recovery remains unavailable until API sync works.
No chat commands are sent for synchronization. The old chat-command fallback was
removed in 0.5.1. Connection health shows whether setup is missing, the selected
source, last refresh and any error.

Hints Used remains best-effort: other runners' hint purchases are available when
their updated timer shares them. The tracker API does not provide
an exact purchase counter. Missing values stay unknown. The app does not sign
into other players' slots or infer totals from a game-wide item database.
Last known counts remain visible offline; refreshes stop while the app is closed.
Applying a profile or history setup clears an unspecified tracker URL; enter the
matching URL for that room if desired.

Unknown timestamps from missed checks remain unknown: a corrected world counter
cannot reconstruct BK history or a missed finish time. API counts do
not create check timestamps or mark racers as finished.
The server's normal Sync command only resends received items, so it is not used
as a world-check snapshot request.

## History and called-off runs

History is saved locally whenever the app observes a shared race. Check counts,
times, finish/release state and recording quality update together. An unfinished
record stays unfinished if you close or disconnect the app. Reconnecting to the
same seed, team, session and start updates that record rather than creating a copy.

To remove a canceled run from tracking after the fact:

1. Open **History & racers** and select the run.
2. Select **Call off / exclude this run**.
3. Find it later under **Called off / excluded** or **All runs**.
4. Select **Restore tracking** if you want it included again.

Excluded runs are omitted from the default tracked list and cannot receive awards
or be shared as completed results. Their saved observations remain recoverable.
Further room notifications do not overwrite an excluded record. This is a local
choice: it does not release a player, mark a goal, cancel a shared start or alter
another timer app. Use a new shared session for a new race.

Search by race name, seed, session, game, original username, local racer display
name or a linked username. The filters also show finished and unfinished runs.
Run details support renaming and JSON export. **Import JSON** accepts current
history exports and the app's older statistics exports. Legacy coverage is marked
uncertain; missing values are not replaced with zero. Existing records are never
overwritten by import, preserving local exclusions and names.

For a locally recorded unfinished run, disconnect first and use **Prepare resume**.
This fills the original room/slot/session without connecting. Enter its password
if required and press Connect. The app verifies the original seed, team and saved
start. If the server no longer has that start, it refuses to invent a replacement.
Imported records omit connection information and require manual reconnection.

## Racer identities and several usernames

Open **Racer identities & linked usernames** in History. Create a display name,
choose it, and link usernames one at a time. For example, Riley can explicitly
link Samus and SpaceRiley. Searching either alias or Riley finds their associated
records. Original slot names remain intact; the live room is not renamed.

Game scope `*` applies a username to all games. Choose an exact game name when
different people reuse a username. A conflicting alias in the same game scope
is rejected. **Unlink** removes the grouping rule without deleting races.

Each historical runner also has a **Local identity** selector. This overrides
username rules for that single slot result, handling exceptions without changing
other races. Choose **Use username links** to remove that override. Multiple slots
belonging to the same person remain separate results.

Links stay local and are omitted from individual race exports. Sharing defaults
to the original race names; local display names are an explicit preview choice.

## Alert preferences and countdown sounds

### New in 0.3.0: event notifications and shared runner context

The Race events area includes **Your declared status**: Playing, Waiting on an
item, Taking a break, or Go mode. Waiting can include a short optional description.
Press **Share status** to send it through Archipelago storage to other copies of
the app using the same room, team and timer session. Each copy changes only its
connected runner through this UI. Status survives reconnecting to that session;
use a new session for a new race. This is a declaration, not automatic game logic
or online-presence detection. A room's other clients can read its shared storage.

Shared labels appear under Race events. Your compact BK label also shows your
declared state while the BK clock is visible. Neither selecting a state nor
receiving progression resets the BK clock, stops timing, or changes completion
and release status. Two copies connected to the same slot share that slot's
latest declaration. Older app versions continue timing but do not show these
new declarations.

Additional configurable alerts cover first checks, long-gap recovery, resumed
group activity, watched items, progression received while Waiting, relevant new
hints, watched hints found, hint affordability, declared status changes, and item
burst digests. Completion messages also report completed/released/active counts.
They use the existing eight-second popup area and independent sound/popup toggles.
Finish/release events keep priority over routine new notifications.

Popups prefix the message with its original race elapsed time, for example
`[00:02:14] Link completed their first recorded race check.` Queued alerts retain
that timestamp while waiting and during display. Item digests use the first item
in the burst; BK reminders use the time the reminder was generated. Before a
shared start is available, the label reads `Pre-race`.

For watched-item and watched-hint notifications, enter exact item names (one per
line) in **Alerts & sounds**. This small list only configures alerts. Item names
are hidden by default; **Reveal watched item names in alerts** enables them.
The app reads the room's game-specific data package to resolve item names.
Events need a connected observer: old hint lists and restored check histories
do not replay as fresh notifications. Affordability alerts require known points,
cost and location total, and occur on a transition to being able to buy a hint.
The app never buys a hint automatically.

Three or more received item messages within a short collection window become a
single digest with the number of watched items. A watched hint found and its
matching item are deduplicated. First-check/recovery messages for the same check
are combined for popups, with the separate events retained in the log. Recently
observed release activity suppresses nearby recovery claims where possible;
server-generated collection checks cannot always be distinguished from play.

Five additional original synthesized retro presets are built in: Countdown
pulse, Item discovery, Secret chime, Heart pickup and Victory fanfare. They use
short square-wave notes inspired by classic adventure games, with no extracted
game audio. New installations use retro sound selections; saved selections and
the audio-off default are preserved. All presets can also be selected per event.

**Alerts & sounds** separates popup and sound switches for runner completion,
release, group finish, check milestones, halfway, other-runner BK, ready
confirmations and race start. Scope runner events to everyone, others or your
connected slot. Group events remain group events. Save preferences to apply them.

Popups last eight seconds, with finish/release priority and green text. Full View
popups are optional; Timer Only uses the same queue. Muting a category does not
stop recording or remove its log entries. Historical and reconnect events are
not replayed. Personal BK never creates repeated popups; the personal live clock
remains independent. Other-runner BK reminders repeat at most once per ten minutes.

Countdown audio is off by default. Enable **Enable countdown sounds**, set the
volume, and optionally allow audio when another app has focus. Choose separate
sounds for the 3–2–1 ticks, GO, and each alert category. Classic beep, Soft chime,
Arcade and Bell are available alongside the five retro presets. Preview buttons audition
the selected sound even if that event is disabled. **Preview 3–2–1 + GO** auditions
the whole countdown. Save preferences to keep your choices.
Mute all sounds stops current previews and disables countdown and event audio.
No sound requires taking focus or changing Windows output devices.

Use **Import custom sound** to choose WAV, MP3, OGG, FLAC, M4A, or WebM audio up to
10 MB. The app copies it into its own `sounds/` folder beside its local settings.
The original file can then be moved or deleted. Duplicate imports reuse the same
sound. Imported sounds are available in every sound selector across restarts;
choose one and save preferences to assign it. Preview saved sounds or remove
them from the library using the adjacent controls. Playback is limited to five
seconds, and countdown ticks to 0.8 seconds so they do not overlap the next tick.
Use short clips with no leading silence for accurate countdowns. Unsupported
codecs report a playback error; converting the file to WAV or MP3 usually helps.

Profiles save sound selections, but profile exports do not embed audio. Import
the same original audio on another computer to restore its custom selections.
Missing custom audio uses Classic beep until restored; deleting a sound resets
current assignments to built-ins and saved profiles use that fallback too.
Custom files stay local and are never sent to the room or included in builds.

Cues follow the committed shared start, including a room-originated countdown.
They do not replay missed beeps after a late join, reconnect, sleep or clock jump.
Unknown/unconfirmed starts and historical races never generate countdown audio.
Normal clock, network and audio latency still affect precision.

## Profiles

Profiles save room address, own slot, preferred roster, manual countdown, readiness,
room-countdown following, always-on-top, preferred compact view, and alert/sound
settings. Use Save, Save as copy, or Delete to maintain recurring setups.
Existing and imported profiles retain their own alert/sound settings unless
**Save current alert and sound preferences** is explicitly selected in the editor.

**Apply to next setup** requires disconnecting first. It fills fields and generates
a fresh session name, but does not connect, ready, start or clear the previous
race. Give that session name to the other participants; applying a profile on
several machines independently does not coordinate their generated names.

Preferred runners can use usernames or local display names with linked aliases.
Names resolve against the actual room after connection. Missing or ambiguous
matches block that profile's automatic selection; choose the correct runners
manually before starting. Manual selection overrides the profile for that
connection. An empty preferred roster means the normal eligible-room selection.

Passwords are never stored. Profile export excludes address and own slot unless
**Include address and slot name** is selected. Import fills an editor for review
and saving, without connecting or modifying the active race.

## Connection and recording health

The small timer indicator opens **Connection health**. It shows the latest room
response, reconnect attempts, history recording state and observation gaps.
No checks arriving in a quiet room does not by itself mean a disconnection.

The elapsed clock continues through network loss. Known finish times remain
known, but a local outage or late join makes full observation coverage uncertain.
The app reconciles shared room data on recovery, without claiming that every
missing check is recoverable. Earlier warnings remain after reconnecting.

History and shared results show quality warnings. Check/BK awards are withheld
when coverage is uncertain; time awards may still be available for known finishes.
A storage error is reported separately and does not intentionally reset the
shared timer. Old finish timestamps are never guessed from reconnect/poll time.

## Result preview and finish cards

After a tracked run finishes, the timer's Copy results and Post to chat controls
open a preview. History provides the same action for saved finished runs.

Select check counts, BK and highlights, plus race names or local display names.
The text is the exact snapshot that will be copied. Posting checks for changed
data and requires the original connected seed/team/session/start. Refresh an
outdated preview. Copy works offline; previews expire after 15 minutes.

Nothing posts automatically. Chat sends a header and one printable line per
runner, plus mandatory warnings and optional highlights. Each line is prefixed
so names cannot become commands. Repeated posting is disabled for that run in
this app instance; restarting the app permits a new explicit post. There is no
server delivery acknowledgment or room-wide duplicate lock.

BK below five minutes displays N/A. Unknown values display Unavailable. Completion
and release remain distinct, and warnings cannot be omitted by hiding a column.

**Finish card** shows a real PNG preview. Choose a full-group or individual card,
Scoreboard or Highlights layout, name style, and check/BK fields. Group cards use
six-runner pages; save each desired page. No image uploads occur. Images omit the
room address/password and retain recording warnings.

## Race highlights

- Fastest completion uses known elapsed times for completed slots.
- Most recorded checks uses completed slots with suitable recording coverage.
- Steady progress uses completed slots' known Longest BK with suitable coverage.

At least two eligible completed slots are needed per category. Released slots
remain visible in results but cannot win completion highlights. Unknown values
are excluded. Ties share a highlight at the displayed whole-second precision;
they are never broken by player order. Under-five-minute steady progress reads
No BK over five minutes rather than exposing a BK duration otherwise shown as N/A.

These are descriptive statistics, not an overall skill ranking across games with
different lengths or check totals. Include highlights in shared output only by
selecting them. Hiding checks or BK also omits that category's shared highlight.
