# jam wire protocol

This is the contract between the browser, the Worker (Hub and Room Durable Objects) and the host bridge. It was reverse-engineered from
`worker.src.js`, `ui.html` and `bridge.mjs` on 2026-10-09; the code is authoritative. If you add or change a message, update this file in
the same PR. Offline coverage: `test-worker-hub.mjs` (REST and auth routing), `test-bridge-turn.mjs` (the bridge's side of the room socket).
The websocket paths of the Worker itself are only exercised by `run-tests.sh` against a live deployment.

All websocket frames are JSON text, one object per frame, with a `type` field. Nothing is versioned: browsers reload on a new build hash
(`/health` returns `build`), and the bridge restarts itself when its code changes.

## Credentials and roles

| Credential | Passed as | Resolves to |
| --- | --- | --- |
| Owner key (`JAM_KEY`, the host's `.jam-key`) | `?k=` or `x-jam-key` header | `owner`, all rooms |
| Invite token (12 chars from `a-z` minus `l` and `o`, plus `2-9`) | `?k=` | the invite's role (`owner`, `driver` or `viewer`), one room |

An *owner-by-invite* is scoped to its own room: it can change that room's settings and invites but cannot list or create other rooms.
`GET /api/rooms` is filtered to its room, and everything else under `/api/` answers `403 scoped to <room>`.

Keys travel in the query string, so they appear in URLs and any proxy logs. Treat links as secrets.

Capabilities on a room socket (`canDrive` is everything except viewer):

| Capability | owner | driver | viewer |
| --- | --- | --- | --- |
| Read the transcript, presence, queue | yes | yes | yes |
| `say`, `upload`, `unqueue`, `typing`, `stop`, `browser-click` | yes | yes (budget permitting) | no |
| `clear`, `login`, `login-code`, `approve` | yes | no | no |

## Sockets

| Path | Who may connect | Purpose |
| --- | --- | --- |
| `/ws?room=<r>&k=<key>&name=<n>` | any valid credential | a person's browser in room `<r>` |
| `/ws?room=<r>&k=<owner key>&role=bridge` | owner key | the host bridge for room `<r>` (one socket per room) |
| `/ws?room=<r>&k=<owner key>&role=screen` | owner key, never an invite | `browser.mjs` live-view frames |
| `/hub?k=<owner key>&role=bridge` | owner key | the bridge's registry socket |
| `/hub?k=<owner key>` | owner key | the owner lobby |

Close codes: `4001` revoked invite, `4002` room moved or deleted, `1012` service restart (browsers reconnect on their own).

## Room socket: server → browser

| `type` | Payload (main fields) | Notes |
| --- | --- | --- |
| `hello` | `you{name,role}`, `room`, `log[]` (last 400 entries), `status`, `bridge`, `agents`, `schedules`, `usage`, `auth`, `catalog`, `ctx`, `session`, `approvals`, `queue`, `seq` | First frame. `usage` and `auth` are owner-only (null otherwise). |
| `presence` | `users[{name,role,token?}]`, `bridge` | `token` is included for owners only. |
| `say` | `id`, `from`, `role`, `text`, `ts`, `attachments?` | A message was accepted into the queue. |
| `status` | `running`, `queue`, `current` | |
| `queue` | `items[{id,from,text,ts}]` | Messages waiting for the bridge. |
| `start` | `id` | The bridge began a turn. |
| `delta` | `id`, `text` | Streamed text. |
| `tool`, `tool_result` | `id`, `callId`, ... | Tool cards. `tool` carries a raw `summary` for the expandable card and a sanitized `label` for the status bar. |
| `done`, `error` | `id`, `text`, `cost?`, `ctx?`, `ctxMax?`, `model?`, `tier?`, `roomCost?` | End of a turn. `roomCost` is on the live frame only. |
| `route` | `id`, `tier`, `label`, `why`, `score` | Which model the router picked, and why. |
| `session` | `id`, `cwd`, `model`, `tier`, `effort`, `runLocal` | |
| `approval` | `id`, `from`, `tool`, `summary`, `detail`, `state`, `by?` | An Allow/Deny card for the owner. |
| `budget` | driver view of a share of the host plan, `denied?`, `text?` | Sent to that driver only. |
| `sys` | `text`, `ts` | A line in the transcript. |
| `typing` | `from`, `on` | |
| `hb` | `running`, `current`, `since`, `lastTool`, `task`, `queue` | Heartbeat, about every 10 s while a bridge is connected. |
| `screen` | `sid`, `data`, `label`, `url`, `end` | Live browser frame; never stored. |
| `catalog`, `colors`, `agents`, `schedules`, `compacted` | | Mirrors of bridge state. |
| `usage`, `auth` | | Host plan usage and host login state; owners only. |
| `uploaded`, `upload_error` | `id`, `path`?/`text`? | Result of an upload. |
| `cleared`, `moved`, `gone`, `kicked`, `refresh`, `pong` | | Room lifecycle and keep-alive. |

## Room socket: browser → server

| `type` | Payload | Who |
| --- | --- | --- |
| `say` | `text` (at most 20,000 chars), `attachments[]` (at most 6) | owner, driver |
| `upload` | `id`, `name`, `mime`, `seq`, `total`, `data` (base64 chunk) | owner, driver |
| `unqueue` | `id` | owner, or the sender of that message |
| `typing` | `on` | owner, driver |
| `stop` | | owner, driver |
| `browser-click` | `x`, `y`, `callId` | owner, driver |
| `clear` | | owner |
| `login`, `login-code` | `code` | owner |
| `approve` | `id`, `ok` | owner |
| `ping` | | all |

A driver's `say` is checked against their budget first. A limited driver gets one live message at a time; a blocked or paused driver gets a
`budget` frame with `denied` and their text back, and the message is not queued.

## Room socket: bridge → server

| `type` | Effect |
| --- | --- |
| `hb`, `sync` | Heartbeat and a full status resync. |
| `start`, `delta`, `tool`, `tool_result`, `done`, `error` | The turn stream. `done` and `error` are stored in the log and drop the message from the outbox. |
| `spend` | A cost to charge to the driver who sent message `id` (every attempt, including retries and `/compact`). `final` ends the charge. |
| `session`, `route`, `compacted`, `uploaded`, `upload_error` | Re-broadcast to browsers. |
| `catalog` | Validated by `cleanCatalog` before it is stored or broadcast. |
| `colors`, `agents`, `schedules` | Stored and re-broadcast. |
| `sys` | Stored and shown to everyone, unless `owners: true`, which goes to owners only and is not stored. |
| `auth`, `usage` | Owners only. `auth` is stored so a reload still shows a signed-out host. |
| `ping` | Answered with `pong`. |

## Room socket: server → bridge

`say` (the queued message, with `role` and an optional `budget: "downshift"` flag that browsers never see), `upload` chunks, `unqueue`,
`stop`, `browser-click`, `login`, `login-code`, `refresh`. On every (re)connect the Room replays its outbox; the bridge de-duplicates by
message id.

## Hub socket

| Direction | `type` | Notes |
| --- | --- | --- |
| Hub → both | `rooms` | `rooms[]` and `bridge`, sent on connect and on `rooms.list`. |
| Hub → both | `room.change` | `op` is `add`, `remove`, `update` or `order`, with `room` or `order`. |
| Hub → lobby | `bridge` | `on` flips as the bridge connects and disconnects. |
| Hub → bridge | `refresh` | A lobby opened; re-read the model catalog (throttled bridge-side). |
| Hub → lobby | `catalog` | The validated model catalog, re-broadcast when a bridge reports a new one. |
| Bridge → Hub | `catalog`, `plan` | The model catalog (validated by `cleanCatalog`) and plan usage with the learned rate (validated by `cleanPlan`). A changed plan pushes budget updates to affected drivers. |
| Bridge → Hub | `ping` | Answered with `pong`. |
| Lobby → Hub | `rooms.list` | |

## REST

Owner key or an owner invite (scoped, see above) unless noted. Paths are under `/api`.

| Method and path | Notes |
| --- | --- |
| `GET /health` | Public. `{ok, t, build}`. |
| `GET /api/whoami` | `{role, name, room}` for any valid credential. |
| `GET /my-accessible-rooms` | Rooms the credential can open. Not under `/api`. |
| `GET /api/sponsor` | Public. `POST` is owner only. |
| `GET/POST /api/rooms` | List, and create (`name`, `cwd`, `model`, `tier`, `effort`). Errors, in order: bad name, duplicate (409), cwd missing, cwd not absolute. |
| `POST /api/rooms/order` | `{order: [names]}`. Unknown names dropped. |
| `POST /api/rooms/<r>/settings` | `model`, `tier`, `effort`, `runLocal`, `cwd`. A bad `cwd` rejects the whole request. |
| `POST /api/rooms/<r>/rename` | `{to, cwd?}`. Copies the transcript to a new Room DO, then wipes the old one. |
| `DELETE /api/rooms/<r>` | Also wipes the transcript and drops the room's invites. |
| `GET/POST /api/rooms/<r>/invites` | Create takes `role`, `name`; an unknown role becomes `driver`. |
| `DELETE /api/invites/<t>` | Removes the invite and kicks live sockets. |
| `POST /api/revoke/<t>` | Durable revocation first, then a best-effort kick. |
| `GET/POST /api/invites/<t>/budget` | Driver invites only. `share` is 0 to 100, or `null` for no limit. |
| `POST /api/rooms/<r>/drop` | Force every tab in the room to reconnect. |
| `GET /api/history`, `GET /api/export` | A room's transcript, paged or as Markdown. |
| `POST /api/approve`, `GET /api/approve/<id>` | The bridge-side hook posts an approval and long-polls the decision (25 s). |

`/api/rooms/<r>/activity`, `/api/rooms/<r>/presence` and `/api/budget/*` are internal (Room to Hub) and answer 404 on the public router.

## Known sharp edges

Recorded here so nobody has to rediscover them:

- Message shapes from the bridge are only partly validated: `hb`, `done` and `error` are stored with the sender's fields spread in. The bridge is
  trusted (owner key only).
- The Hub rewrites `rooms`, `tokens`, `revoked` and `spend` as whole storage values on each change. Revoked tokens are never pruned.
- Invite tokens are about 60 bits and are accepted from the query string with no rate limit on guessing.
- An owner-by-invite can set `runLocal` and `cwd` on its own room.
- A rename copies and wipes across two Durable Objects without a transaction.
