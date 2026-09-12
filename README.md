# TaskFlow

A personal task manager in a single HTML page: Eisenhower priorities, recurring
tasks, a daily planning wizard ("Moments"), and cross-device sync.
No framework, no build step, no dependencies — plus a tiny Node backend so the
same list follows you from your Mac to your iPhone.

*(Русская версия — [README.ru.md](README.ru.md).)*

> **Heads-up: the user interface is in Russian.** This README is English, but the
> app itself — buttons, view names, the settings sheet, the Moments wizard — is
> not translated, and neither are the source comments. Everything below describes
> real behaviour; only the labels you will see on screen are Russian.

---

## Features

- **Views:** Today (overdue tasks included), Inbox, Tomorrow, Upcoming (grouped by day), All, Done.
- **Inbox** — a flat list of unsorted stuff, with no date and no priority. Anything without a day lands here: a task created without a date, a task whose date was cleared, and whatever the agent drops in. You sort it out during the Moments pass, or right on the card — "Make it a task" or "Discard".
- **Tasks:** title, notes, checkable subtasks.
- **Clickable links:** a URL in a task title or in its notes stays where it was written and simply becomes clickable — in the list row, in the task card and on the day-planning card. It opens in a new tab; tapping it in the list neither opens the card nor starts a drag. Clicking the notes anywhere else starts editing, with the caret right where you tapped.
- **Complete / reopen**, plus a "Clear completed" button with undo.
- **Due date and time:** quick buttons — Today / Tomorrow / In 2 days / Next week — alongside plain date and time fields.
- **Recurrence:** daily, weekly, or monthly, with an interval and a time of day. Marking a task done moves it to the next date in the series and resets its subtasks.
- **Priorities:** P1 urgent and important, P2 important and not urgent, P3 urgent and not important, P4 neither.
- **Drag and drop:** grab a task anywhere on its row. With a mouse, just drag; with a finger, press and hold until the row lifts (a short swipe still scrolls the list). The `⠿` handle on the right picks the row up immediately, without the hold. Dropping inside a group reorders it; dropping into another group reschedules the task — drop it on "Tomorrow" and it moves to tomorrow, and to send a task back to the Inbox, just clear its date in the card. Keyboard works too: `Tab` to the handle, then `↑` / `↓`.
- **List order:** automatic by default (by time, then by priority). The first drag pins a manual order; the `⇅` button in the header (or the `s` key) switches back.
- **Moments** — a daily planning pass: the app walks one queue — unsorted inbox items first, then tasks (overdue and due today) — and asks, for each card, a priority and a slot: today (morning / noon / afternoon / evening), tomorrow, in 2 days, next week. Answering "when" turns an inbox item into a task; the last button leaves an inbox item unsorted and sends a task back to the Inbox. "Already done" and "Not relevant" are there too.
- **Local reminders** — while the tab or the installed app is open.
- **Theme** — light, dark, or follow the system.
- **Cross-device sync** — tasks live on your own server, so your Mac, your iPhone, and any browser all see one list. It works offline: edits pile up locally and are pushed once the network is back.
- **Agent access** — an optional MCP server exposes the same task operations, plus the Inbox, to Claude Code and other MCP clients, behind its own token, separate from sync.
- **Your data stays yours** — your own server plus a local copy in the browser. JSON export and import for backups.

**Adding a task.** There is no input field above the list — the main page is the
list itself. A new task is created with the "+" button in the bottom-right corner
or with the `n` key; both open the same quick-entry window. The window stays open
after Enter: the field clears, the steps reset, the caret stays in the field, and
you can enter a run of tasks one after another.

Priority and due date are asked one step at a time: P1–P4 first, then the day —
today, tomorrow, in 2 days, next week, a calendar, or "no date" — and only once a
day is picked does the "what time" step appear: morning, noon, afternoon, evening,
or no time. Day-part times come from the settings. "Add" and Enter wait for the
first two answers; the section the window was opened from does not supply a date,
so a task with no day picked lands in the Inbox.

Quick entry understands inline hints: `Купить молоко завтра 18:30 !1` creates a
task for tomorrow at 18:30 with priority P1. The recognised date words are
Russian — `сегодня` (today), `завтра` (tomorrow), `послезавтра` (the day after) —
alongside an `HH:MM` time and `!1`…`!4`, which work regardless of language. What
the text specifies is marked in the steps right away, so such a line is added with
a single Enter; pressing a button afterwards overrides what was parsed.

**The same picker everywhere.** A task card shows priority and due date as collapsed
rows with the current value; editing expands the same steps underneath, and the
answer applies immediately. There are no separate date and time inputs on the card —
the calendar and the day parts do that job. "To task" on an inbox item opens a
sorting window with the same steps and decides nothing for you: until you answer
the "when" step, the record stays in the Inbox. Moments asks the same questions and
moves to the next card once the last step is answered.

Keyboard shortcuts: `n` new task, `m` Moments, `s` list order, `,` settings, `1`…`6` views (`1` Today, `5` Inbox).

---

## Running locally

```bash
git clone https://github.com/triumphpc/taskflow.git
cd taskflow
node serve.mjs          # http://localhost:8787
```

Node 18+ is required. The first run creates a `data/` directory and prints a sync
token. Paste that token into **Settings → Cross-device sync** in every browser
that should see the shared list:

```
TaskFlow → http://127.0.0.1:8787
Data: /path/to/taskflow/data
Sync token: H5are3dTiFGZq_1uRphwwZX2vQc9oNY4
```

The token is stored in `data/token.txt`; the `TASKFLOW_TOKEN` environment
variable overrides it. The server listens on `127.0.0.1` only — it is not
reachable from outside until you explicitly set `HOST=0.0.0.0`.

The app also opens without the server (it is static after all), but sync will be
unavailable and tasks will stay in one browser.

> Do not open `index.html` by double-clicking it (`file://`): browsers block ES
> modules and service workers in that mode.

---

## Cross-device sync

The app keeps tasks in two places at once:

- **on the server** — `data/taskflow.json`, shared by every device;
- **in the browser** — `localStorage`, a local copy that keeps things working offline.

Exchange is a merge, not an overwrite: each device sends its full state, the
server merges it into the shared one and returns the result. On a conflict the
more recent edit wins — task `updatedAt` timestamps are compared. Deletions are
kept as tombstones (`{id, at}`) for 30 days: without them a task deleted on the
Mac would come straight back on the next exchange with an iPhone that has not
heard about the deletion yet. If a task was edited **after** it was deleted, the
merge treats that as a deliberate restore and brings it back.

Sync runs when the app opens, when you return to the tab, when the network comes
back, once a minute in the background, and on the `☁` button in the header.
Edits are pushed as a batch a second after the last change rather than one at a time.

**Do settings sync? No.** Theme and sort order stay local to each device —
only tasks are synchronised.

### API

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/ping`  | check that a sync server is there at all (no token needed) |
| `GET`  | `/api/state` | current shared state |
| `POST` | `/api/sync`  | merge the posted state into the shared one and return the result |

Everything except `/api/ping` requires an `Authorization: Bearer <token>` header.
The token is compared in constant time, and the `data/` directory is never served
as static content.

---

## Agent access (MCP)

A second process, `mcp.mjs`, can run alongside the main server. It speaks the
[Model Context Protocol](https://modelcontextprotocol.io) and gives an agent
(Claude Code or any other MCP client) the same task operations the app has:

| Tool | What it does |
|---|---|
| `tasks_list` | tasks in a view: `today`, `tomorrow`, `upcoming`, `all`, `done`, `overdue` |
| `task_get` | one task in full: notes, subtasks, recurrence |
| `task_add` | create a task in a single call: due date, priority, notes, subtasks, recurrence |
| `task_edit` | change fields; `clear_due` drops the due date along with the recurrence |
| `task_snooze` | move the due date; the time of day is kept |
| `task_done` | complete or reopen; a recurring task moves to the next date in the series |
| `subtask_add` | add a subtask |
| `subtask_toggle` | toggle a subtask |
| `task_delete` | delete a task — only with `confirm: true` |
| `inbox_list` | unsorted inbox items: source, agent summary, timestamp |
| `inbox_add` | drop an inbox item: `title`, `summary`, `source_kind`, `source_url`, `source_title`, `source_ref` |
| `task_comment` | append context to the `agentNotes` feed of a task or an inbox item |

Tasks can be named in words: `task: "milk"` finds it by title. If several match,
the tool returns the candidates and **changes nothing**. Due dates are words too:
`today`, `tomorrow`, `monday`, `next-week`, `+3`, `2026-09-15`, `tomorrow 18:30`
(the Russian equivalents work as well).

### What the agent may do with the Inbox

The agent fills the Inbox **only when asked, or by explicitly agreed sorting
rules** — never on its own initiative.

What goes in is raw material: a title, a summary and a link to the source —
**with no date and no priority**. Planning is the human's job, done while sorting.
`inbox_add` takes neither a date nor a priority at all, and `task_add` without a
date creates an inbox item rather than a task.

Calling `inbox_add` again with the same `source_ref` (a `Message-ID` for mail,
`chat_id:message_id` for Telegram) updates the existing record instead of adding
a second one. The agent's summary goes into the `agentNotes` feed — the `notes`
field, which the human writes, is never touched, here or in `task_comment`.

Running it:

```bash
npm install             # the only dependency is @modelcontextprotocol/sdk
node mcp.mjs            # http://127.0.0.1:8788/mcp
```

`mcp.mjs` needs Node 20+ (the SDK requires it); the app and `serve.mjs` are still
fine on Node 18.

`node serve.mjs` still runs with no `npm install` at all: the SDK is needed by
`mcp.mjs` alone and is imported dynamically.

On start it prints the token and a ready-to-paste connection command:

```
TaskFlow MCP → http://127.0.0.1:8788/mcp
Основной сервер: http://127.0.0.1:8787
Токен MCP: 8Kx2n5Qw...
Подключение: claude mcp add --transport http taskflow http://127.0.0.1:8788/mcp --header "Authorization: Bearer 8Kx2n5Qw..."
```

**The MCP token is its own, separate from the sync token.** The sync token is
typed into the browsers on your Mac and iPhone; the MCP token lives in
`data/mcp-token.txt` and is overridden by `TASKFLOW_MCP_TOKEN`. Delete the file
and restart `mcp.mjs` and the agent loses access while the browsers notice
nothing.

`mcp.mjs` never touches the data file: it reads through `GET /api/state` and
writes through `POST /api/sync`, exactly like one more device. The file has a
single owner, `serve.mjs`, and the agent's edits merge under the same rules as
edits from the phone.

Environment variables: `PORT` (8788), `TASKFLOW_API` (the main server's address),
`TASKFLOW_DATA`, `TASKFLOW_MCP_TOKEN`, `TASKFLOW_TOKEN`, `TASKFLOW_MCP_ORIGINS`
(extra allowed `Origin` values, comma-separated).

### Why a bearer token and not OAuth 2.1

The MCP specification suggests OAuth 2.1 for the HTTP transport. It is
deliberately not used here: this is a single-person tool, and an authorization
server, client registration and refresh tokens are a layer too many for reaching
your own to-do list.

Instead: a bearer token compared in constant time (as `sync.mjs` already does),
listening on `127.0.0.1` only, and an `Origin` check — the specification's own
recommendation against DNS rebinding; Caddy publishes the port over HTTPS. The
deviation is written down on purpose: if a second user or a third-party client
ever shows up, this decision has to be revisited just as deliberately.

---

## Deploying to a VPS

Reaching the app from an iPhone needs an HTTPS address: `localhost` is not
reachable from the phone, and neither PWA install nor notifications work without
HTTPS.

### 1. The service

Copy the repository to `/var/www/taskflow` and create a systemd unit at
`/etc/systemd/system/taskflow.service`:

```ini
[Unit]
Description=TaskFlow
After=network.target

[Service]
Type=simple
User=taskflow
WorkingDirectory=/var/www/taskflow
Environment=PORT=8787
Environment=TASKFLOW_DATA=/var/lib/taskflow
ExecStart=/usr/bin/node serve.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin taskflow
sudo mkdir -p /var/lib/taskflow && sudo chown taskflow: /var/lib/taskflow
sudo systemctl enable --now taskflow
sudo journalctl -u taskflow | grep -i token      # you will need it in Settings
```

Keeping data in `/var/lib/taskflow` rather than inside the code directory means a
code update never touches your tasks.

### 2. HTTPS

Caddy obtains a Let's Encrypt certificate on its own and proxies everything to Node:

```caddyfile
tasks.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8787
}
```

The nginx equivalent:

```nginx
server {
    listen 443 ssl http2;
    server_name tasks.example.com;

    ssl_certificate     /etc/letsencrypt/live/tasks.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tasks.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
    }
}
```

Node now serves the static files as well, so a separate `root` is not needed —
adding one would make `/api` unreachable.

### 3. Connecting devices

Open `https://tasks.example.com` on the Mac and on the iPhone and paste the same
token into **Settings → Cross-device sync** → "Connect". On iPhone, add the app
to the Home Screen (Safari → Share → Add to Home Screen).

### 4. The MCP server (optional)

Only needed if an agent talks to your task list. A separate unit,
`/etc/systemd/system/taskflow-mcp.service`:

```ini
[Unit]
Description=TaskFlow MCP
After=network.target taskflow.service
Wants=taskflow.service

[Service]
Type=simple
User=taskflow
WorkingDirectory=/var/www/taskflow
Environment=PORT=8788
Environment=TASKFLOW_API=http://127.0.0.1:8787
Environment=TASKFLOW_DATA=/var/lib/taskflow
ExecStart=/usr/bin/node mcp.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
cd /var/www/taskflow && sudo -u taskflow npm install
sudo systemctl enable --now taskflow-mcp
sudo journalctl -u taskflow-mcp | grep Подключение   # the ready-made client command
```

`/mcp` goes to a different port, so in Caddy it gets its own route **before** the
general one:

```caddyfile
tasks.example.com {
    encode gzip
    handle /mcp* {
        reverse_proxy 127.0.0.1:8788
    }
    handle {
        reverse_proxy 127.0.0.1:8787
    }
}
```

Connecting a client to the server uses the same token over the HTTPS address:

```bash
claude mcp add --transport http taskflow https://tasks.example.com/mcp \
  --header "Authorization: Bearer <token from journalctl>"
```

### The old way: static only

If you do not need sync, the files can still be served as plain static content —
the app copes and keeps tasks locally:

```nginx
server {
    listen 80;
    server_name tasks.example.com;

    root /var/www/taskflow;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # The app ships as a whole, so the shell is not cached for long
    location = /sw.js        { add_header Cache-Control "no-cache"; }
    location = /index.html   { add_header Cache-Control "no-cache"; }
}
```

There is no sync in this setup: without `/api` the app behaves exactly as it did
before — every browser on its own.

### HTTPS is mandatory for PWA

Over plain `http://`, tasks, priorities, recurrence, Moments, sync, and local
storage all work. **What does not work:** the service worker, Home Screen
install, and notifications. In other words, you can open the app on an iPhone
over HTTP, but you cannot install it.

The shortest path to a certificate is Caddy — it fetches Let's Encrypt itself,
and the config from the HTTPS step above is two lines long.

---

## Installing as an app

Requires HTTPS (or `http://localhost`).

- **iPhone / iPad:** Safari → Share → **Add to Home Screen**. It opens without an address bar, with an icon.
- **macOS Safari:** File → **Add to Dock**.
- **Chrome / Edge:** the install icon in the address bar → "Install".

Every install is a separate browser storage, so paste the token into
**Settings → Cross-device sync** afterwards — otherwise the app starts with an
empty list.

---

## Storing and moving data

With sync enabled, the primary copy of the list is `data/taskflow.json` on the
server; that is the file to back up. Every browser keeps a local copy in
`localStorage`, so clearing site data does not lose anything — the tasks come
back from the server on the next exchange.

Without sync, everything lives only in the `localStorage` of the browser you work
in. To move the list, use **Settings → Data → Export JSON** and **Import JSON** on
the other device (merge by modification time, or full replace).

---

## Project layout

```
index.html              shell markup
styles.css              theme, layout, responsive rules
js/core.js              dates, recurrence, formatting — shared by browser and server
js/dom.js               DOM helpers
js/store.js             state, localStorage, export/import
js/model.js             tasks: CRUD, recurrence, per-view queries, manual order
js/ui.js                rendering, drag and drop, task editor, settings
js/moments.js           the daily planning wizard
js/sync.js              exchange with the sync server, applying the merged result
js/app.js               entry point, routing, shortcuts, reminders
sw.js                   offline shell cache
serve.mjs               server: static files + /api
sync.mjs                server-side task storage and merge rules
mcp.mjs                 MCP server for agents (needs npm install)
package.json            the single dependency — the MCP SDK, used only by mcp.mjs
data/                   tasks and token (created on first run, never committed)
manifest.webmanifest    PWA manifest
```

Dates inside the app are naive local strings: `2026-08-19` (all day) or
`2026-08-19T18:30` (with a time). No timezone is stored: a task at 18:30 stays a
task at 18:30 in whatever zone you open it in.

Manual order is kept in the task's `order` field. While automatic mode is on the
field is unused; on the first drag the current list order is written into `order`
so nothing jumps, and from then on it is authoritative. Drag and drop is built on
Pointer Events rather than HTML5 drag-and-drop — otherwise it would not work on
touch screens. The whole row is draggable, but that row is already claimed by a
click (open the task) and by a vertical swipe (scroll the list), so intent is
read from the input method: a mouse starts dragging after 5 px of movement, a
finger only after a 350 ms hold.

---

## Licence

MIT — see [LICENSE](LICENSE).
