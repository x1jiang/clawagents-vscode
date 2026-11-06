# Human time in conversation Info

ClawAgents estimates the time you spend preparing messages, reading a thread, and viewing files associated with a conversation. Open **Info → Human time (estimated)** to see each category and the deduplicated total. Agent execution time is shown separately and can overlap with human time.

Tracking is enabled by default. Turn it off under **Settings → Advanced → Estimate human time**. Turning it off stops collection and discards pending resume gaps, while preserving saved totals. Turning it back on does not backfill the disabled period.

## What counts

| Activity | When timing starts or refreshes | Idle limit |
| --- | --- | --- |
| Message preparation | You edit or paste into a draft, or a dictation result is inserted. Sending or clearing the draft ends its timing. | 120 seconds after the last edit signal |
| Thread reading | You deliberately open a nonempty conversation, or interact with its visible transcript by scrolling, selecting text, clicking content or tool controls, or using navigation keys. | 90 seconds after the last reading signal |
| File viewing | An associated file becomes the active editor tab while VS Code has focus and the chat panel does not. Selection and scrolling refresh viewing. | 180 seconds after the last viewing signal |

Each qualifying interaction refreshes its idle deadline. These limits apply to quiet intervals, not to the entire session: continued interaction can keep any activity running for several minutes. Timing uses a monotonic clock.

## How thread reading is detected

Reading begins after an explicit conversation selection has loaded its transcript, or after a direct interaction inside the transcript. Clicking the Chat tab to return to an already loaded conversation also qualifies. Empty conversations and conversations that are still loading do not start reading time.

Qualifying transcript interactions include wheel scrolling, touch scrolling, pointer presses and releases (including text selection and tool-card controls), dragging with a pointer button held, and navigation keys such as arrows, Page Up/Down, Home/End, Space, and Enter. Input fields inside the transcript are excluded from reading signals. Merely moving the pointer over content does not qualify.

The following do **not** start or refresh reading:

- Agent tokens, tool updates, or run completion.
- Automatic scrolling, layout changes, or restoring a conversation at startup.
- Simply bringing the window back into focus.
- Settings, History, the Info panel, or an empty transcript.
- Synthetic DOM interactions.

A reading signal allows up to **90 seconds** of quiet reading. Leaving the window, hiding the chat, switching conversations, interacting outside the transcript, or starting message preparation/file viewing pauses it sooner. A visible but unfocused transcript can resume on an actual wheel, touch-scroll, or pointer-drag event; focus alone is not required for those direct signals. Hidden transcripts never generate reading signals.

The current implementation tracks the main transcript. Reading a temporary side-chat transcript is not yet measured. Message preparation in a side chat remains attributed to that side chat.

## Resuming after an interruption

Continuing the same draft, the same thread, or the same file under the same conversation within **60 seconds** can fill a paused gap. A qualifying return confirms the continuation:

- **Draft:** edit again. Sending, clearing, or navigating away from its draft ends that draft session.
- **Thread:** deliberately reopen it or interact with its transcript again. A focus return alone does not confirm reading.
- **File:** return to the active editor or produce a qualifying viewing signal. VS Code can also report scrolling for an unfocused active editor.

The return must also be at or before the previous idle deadline. If either deadline has passed, the whole paused gap is excluded; timing restarts at the new interaction. At most one paused candidate per activity is retained, so starting to read a different thread replaces the previous thread's resume candidate.

The first activity credited for an interval keeps that credit. A later resume fills only uncovered intervals, even when activities belong to different conversations. The total therefore counts each moment at most once within a VS Code window. Category totals describe attribution, not independent stopwatches that all run at once.

### Examples

| Sequence | Human time credited |
| --- | --- |
| Open a thread, read quietly for 60 seconds, then leave | 60 seconds of thread reading |
| Open a thread and leave it visible for 5 minutes without another interaction | At most 90 seconds of thread reading |
| Read for 20 seconds, leave for 40 seconds, return and scroll, then read for 10 seconds | 70 seconds of thread reading; the 40-second gap is within both deadlines |
| Read for 80 seconds, leave for 20 seconds, return and scroll, then read for 10 seconds | 90 seconds of thread reading; the paused gap crossed the original 90-second idle deadline |
| Read for 20 seconds, spend 30 seconds editing the same thread's draft, return to the transcript, then read for 10 seconds | 30 seconds of thread reading + 30 seconds of message preparation = 60 seconds total |
| Write for 40 seconds, leave for 50 seconds, return to the same draft, then write for 5 seconds | 95 seconds of message preparation, provided none of the gap was already credited |
| The previous draft example, with 20 seconds of its gap already credited to a linked file | 75 seconds of message preparation + 20 seconds of file viewing = 95 seconds total |
| Send a request, walk away, and let the Agent run for 5 minutes | Sending ends draft timing; Agent activity alone adds no human time |

## File ownership

File associations come from Agent file-change reports. A file associated with one conversation is credited to that conversation. If several conversations share it, the selected conversation receives the credit when it is one of the owners. Otherwise the viewing time is left unattributed. Viewing one shared file never credits all of its owners at once. Files not reported by the Agent can be missed.

## Implementation and cost

`HumanTiming` owns accumulation, idle clipping, resume gaps, interval deduplication, file ownership, and snapshots. Its injected `HumanTimingPolicy` provides activity-specific idle limits, resume windows, and file attribution. Changing a duration does not require changing event collection.

`HumanTimingMonitor` routes VS Code focus/editor events and webview activity into the timer, and saves workspace totals. `installThreadReading` is a separate webview event adapter: it filters direct interactions and emits at most one reading pulse per second. It does not listen to transcript scroll events, because those also occur during automatic scrolling.

There is one live activity segment per window. The timer retains only the short interval union needed by pending resume gaps, rather than a history of every interaction. Activity checkpoints run every 15 seconds while needed. The Info display requests a snapshot once per second while mounted and the document is visible. Reading adds no polling loop, content analysis, screenshot capture, or browser monitoring.

Saved data consists of cumulative category totals and file associations. Existing records without a reading total load with zero reading time. Live segments and pause candidates are not restored after reload, and shutdown/checkpoints save only elapsed time. Abrupt termination can lose time since the last checkpoint. No message text, selected text, keystrokes, or browsing history is collected by this feature.

## Limits of the estimate

The signals show interaction, not attention. Quiet reading beyond an idle limit is missed; a person who stops working immediately after an interaction can receive credit until the deadline. A short confirmed return can include unrelated time in its gap. The 90-second reading window is a configurable heuristic, not a measured reading speed.

Work outside observed surfaces—terminal preparation, unrelated browser research, unassociated files, and offline thinking—can be missed. Time outside VS Code is inferred only through the bounded resume rule. Deduplication is local to one window; this is not a cross-window or cross-device time tracker. Conversation span is elapsed calendar time, and Agent time can include unattended execution; neither should be interpreted as human effort or added to human time to obtain a deduplicated work total.
