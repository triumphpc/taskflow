# TaskFlow

A personal task manager in a single HTML page: Eisenhower priorities, recurring
tasks, a daily planning wizard ("Moments"), and one-way sync to Google Calendar.
No framework, no build step, no dependencies — plus a tiny Node backend so the
same list follows you from your Mac to your iPhone.

*(Русская версия — [README.ru.md](README.ru.md).)*

> **Heads-up: the user interface is in Russian.** This README is English, but the
> app itself — buttons, view names, the settings sheet, the Moments wizard — is
> not translated, and neither are the source comments. Everything below describes
> real behaviour; only the labels you will see on screen are Russian.

---

## Features

- **Views:** Today (overdue tasks included), Tomorrow, Upcoming (grouped by day), No date, All, Calendars, Done.
- **Tasks:** title, notes, checkable subtasks.
- **Clickable links:** a URL in a task title or in its notes stays where it was written and simply becomes clickable — in the list row, in the task card and on the day-planning card. It opens in a new tab; tapping it in the list neither opens the card nor starts a drag. Clicking the notes anywhere else starts editing, with the caret right where you tapped.
- **Complete / reopen**, plus a "Clear completed" button with undo.
- **Due date and time:** quick buttons — Today / Tomorrow / In 2 days / Next week — alongside plain date and time fields.
- **Recurrence:** daily, weekly, or monthly, with an interval and a time of day. Marking a task done moves it to the next date in the series and resets its subtasks.
- **Priorities:** P1 urgent and important, P2 important and not urgent, P3 urgent and not important, P4 neither.
- **Drag and drop:** grab a task anywhere on its row. With a mouse, just drag; with a finger, press and hold until the row lifts (a short swipe still scrolls the list). The `⠿` handle on the right picks the row up immediately, without the hold. Dropping inside a group reorders it; dropping into another group reschedules the task — drop it on "Tomorrow" and it moves to tomorrow, drop it on "No date" and the due date is cleared. Keyboard works too: `Tab` to the handle, then `↑` / `↓`.
- **List order:** automatic by default (by time, then by priority). The first drag pins a manual order; the `⇅` button in the header (or the `s` key) switches back.
- **Moments** — a daily planning pass: the app walks through everything sitting on today (overdue, due today, and undated) and asks, for each task, a priority and a slot — today (morning / noon / afternoon / evening), tomorrow, in 2 days, next week, or no date. "Already done" and "Not relevant" are there too.
- **Google Calendar:** tasks with a due date become events in a dedicated "TaskFlow" calendar. Recurring tasks are exported as recurring events (RRULE). Completing or deleting a task removes its event.
- **Calendars view:** events from all of your calendars for the next 7 days, plus a tab with the official Google Calendar widget (iframe).
- **Local reminders** — while the tab or the installed app is open.
- **Theme** — light, dark, or follow the system.
- **Cross-device sync** — tasks live on your own server, so your Mac, your iPhone, and any browser all see one list. It works offline: edits pile up locally and are pushed once the network is back.
- **Your data stays yours** — your own server plus a local copy in the browser. JSON export and import for backups.

Quick entry understands inline hints: `Купить молоко завтра 18:30 !1` creates a
task for tomorrow at 18:30 with priority P1. The recognised date words are
Russian — `сегодня` (today), `завтра` (tomorrow), `послезавтра` (the day after) —
alongside an `HH:MM` time and `!1`…`!4`, which work regardless of language.

Keyboard shortcuts: `n` new task, `m` Moments, `s` list order, `,` settings, `1`…`5` views.

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

**Do settings sync? No.** Theme, sort order, and the Google Client ID stay local
to each device — only tasks are synchronised.

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

### HTTPS is mandatory for Google and PWA

Over plain `http://`, tasks, priorities, recurrence, Moments, sync, and local
storage all work. **What does not work:** Google OAuth (Google only allows
`https://` and `http://localhost`), the service worker, Home Screen install, and
notifications. In other words, you can open the app on an iPhone over HTTP, but
you cannot install it.

The shortest path to a certificate is Caddy — it fetches Let's Encrypt itself,
and the config from the HTTPS step above is two lines long.

---

## Connecting Google Calendar

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project (for example, `taskflow`).
2. **APIs & Services → Library** → enable the **Google Calendar API**.
3. **APIs & Services → OAuth consent screen**:
   - type **External**; fill in the app name and a contact e-mail;
   - at the **Scopes** step add `https://www.googleapis.com/auth/calendar`;
   - at the **Test users** step add your own Google account.
   You can leave the app in **Testing** mode — publishing and Google's review are
   unnecessary while you are the only user. In that mode access has to be
   re-confirmed every 7 days.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - type **Web application**;
   - **Authorized JavaScript origins**: `http://localhost:8787` and your address `https://tasks.example.com` (no path, no trailing slash);
   - **Authorized redirect URIs** can be left empty — the implicit token flow is used.
5. Copy the **Client ID** (`…apps.googleusercontent.com`).
6. In TaskFlow: **⚙ Settings → Google Calendar** → paste the Client ID, turn on
   "Sync tasks with Google Calendar", and press **"Connect and export"**.

The app finds or creates a calendar named after the setting (`TaskFlow` by
default) and exports every task that has a date.

**Worth knowing:**

- Sync is one-way: TaskFlow → Google. Edits made to an event in Google do not come back.
- The Client ID is not a secret — you can commit it and show it; security comes from the allowed origins list and the user's consent. **No client secret is used here at all.**
- The token lives for about an hour and is kept in `sessionStorage`. While the browser has an active Google session the app renews it silently; otherwise it shows a "Connect" button.
- A task without a date never reaches the calendar.

### Which calendars to show

**Settings → Calendars in the event list** lists your calendars with checkboxes.
Unchecking one means it is not requested for the "Upcoming events" tab (which
also saves API calls). This does not affect the Google widget — that has its own
list below.

### The calendar widget

Under **Settings → Google Calendar widget**, list calendar addresses separated by
commas — usually your Gmail address and the id of the TaskFlow calendar (Google
Calendar → settings for that calendar → "Integrate calendar" → *Calendar ID*).
The "Google widget" tab in the Calendars view renders them in the official iframe.

To tell calendars apart by colour, append a colour after a vertical bar:

```
you@gmail.com|#b99aff, abcdef123@group.calendar.google.com|#92e1c0
```

This matters: if you give **no** calendar a colour, Google paints every event the
same shade and they become indistinguishable. Colour is all-or-nothing — any
calendar you leave out gets the default. You can take ready-made values for your
calendars from the `calendarList` response (the `backgroundColor` field), or just
pick them by hand as `#rrggbb`.

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
js/util.js              DOM helpers, date handling
js/store.js             state, localStorage, export/import
js/model.js             tasks: CRUD, recurrence, per-view queries, manual order
js/gcal.js              OAuth, the TaskFlow calendar, event export, reading calendars
js/ui.js                rendering, drag and drop, task editor, settings, calendars
js/moments.js           the daily planning wizard
js/sync.js              exchange with the sync server, applying the merged result
js/app.js               entry point, routing, shortcuts, reminders
sw.js                   offline shell cache
serve.mjs               server: static files + /api
sync.mjs                server-side task storage and merge rules
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
