# ask_user in Pi Web

Pi Web renders the `ask_user` tool (from `@eko24ive/pi-ask`) as a native web
dialog: question tabs, single/multi select, preview panes, per-option and
per-question notes, custom freeform answers, review screen, submit /
submit-and-elaborate / cancel.

## How it works

```
agent calls ask_user
  └─ pi-ask (remote-only mode) emits "@eko24ive/pi-ask:started" on the
     extension event bus
       └─ lib/ask-user-bridge.ts forwards it as an "ask_user_request"
          agent event (SSE) and replays it to (re)connected clients
            └─ components/AskUserDialog.tsx collects answers and POSTs
               { type: "ask_user_submit", flowId, response }
                 └─ lib/rpc-manager.ts → bridge emits
                    "@eko24ive/pi-ask:submit" on the bus and awaits
                    "@eko24ive/pi-ask:submit-result" (validation errors are
                    returned to the dialog; the flow stays open)
                      └─ pi-ask completes the flow → "ask_user_closed" event
```

## Requirements

- **pi-ask must be our fork** (`github:moraluco/pi-ask#main`), which adds
  `runRemoteOnlyAskFlow`: with `PI_ASK_REMOTE_ONLY=1` set, `ask_user` runs on
  the event bus in non-TUI mode instead of returning the non-interactive
  fallback. Install into the pi agent dir:
  `cd ~/.pi/agent/npm && npm install github:moraluco/pi-ask#main`
- `instrumentation.ts` sets `PI_ASK_REMOTE_ONLY=1` automatically; the TUI is
  unaffected (the flag only changes non-TUI behavior).
- Each session gets its own extension event bus
  (`resourceLoaderOptions.eventBus` in `lib/rpc-manager.ts`), so concurrent
  sessions never see each other's ask flows.

## Notes

- SSE reconnects replay active dialogs (`AskUserBridge.getPendingEvents`).
- Aborting the agent run aborts the tool call; pi-ask then completes the flow
  as cancelled and the dialog closes.
- Tests: `node --test lib/ask-user-bridge.test.mjs`
