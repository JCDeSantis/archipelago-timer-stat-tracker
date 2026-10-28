# Race tools

The timer is always the first and largest element. Supporting tools open beneath
it; Timer Only retains its compact clock, notifications and runner statistics.
Nothing in these tools automatically connects, starts a game, posts chat or
changes Archipelago gameplay status.

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
sounds for the 3–2–1 ticks, GO, and each alert category. Four built-in choices are
available: Classic beep, Soft chime, Arcade, and Bell. Preview buttons audition
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
