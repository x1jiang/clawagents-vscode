# Human time in conversation Info

ClawAgents estimates how much time you spend preparing messages and viewing files associated with a conversation. Open **Info** in the conversation to see both categories and their deduplicated total. Agent execution time is shown separately and can overlap with human time.

Tracking is enabled by default. Turn it off under **Settings → Advanced → Estimate human time**. Turning it off stops collection and preserves the totals already saved for the workspace.

## What counts

| Activity | When timing starts | Idle limit |
| --- | --- | --- |
| Message preparation | You edit or paste into a draft, or a dictation result is inserted. Sending or clearing the draft ends its timing. | 2 minutes after the last edit |
| File viewing | An associated file becomes the active editor tab while VS Code has focus and the chat panel does not. Scrolling can resume or extend reading if VS Code reports the event for the active editor while it is unfocused. | 3 minutes after the last viewing signal |

Each qualifying interaction refreshes its idle limit. You can spend longer than two minutes on a draft or three minutes on a file by continuing to interact with it.

File associations come from Agent file-change reports. A file associated with one conversation is credited to that conversation. If several conversations share the file, the selected conversation receives the credit when it is one of the owners. Otherwise the viewing time is left unattributed. An unreported file can be missed.

## Resuming after an interruption

A focus change can pause an active draft or file. Continuing the same draft, or returning to the same file under the same conversation, within **60 seconds** can fill the gap. For a draft, editing again confirms the return. For a file, returning to the active editor or a qualifying scroll confirms it. The gap must also fall within the idle limit that was in effect at the time of the pause.

The first activity credited for any interval keeps that credit. A later resume only fills uncovered time, even when the activities belong to different conversations. For example, if you write for 40 seconds, step away for 50 seconds, then continue the same draft for 5 seconds, message preparation totals 95 seconds. If 20 seconds of the gap were already credited to viewing a file in that conversation, Info shows 75 seconds of message preparation and 20 seconds of file viewing, still totaling 95 seconds.

Time outside VS Code is inferred from a short, confirmed return. The estimate does not require tracking browser tabs or storing input text. Only cumulative timing and file associations are saved.
