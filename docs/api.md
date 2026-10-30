# API

JSON over HTTP under `/api/v1`. Authenticate with the session cookie (browser), `Authorization: Bearer <token>`
(`pgt_…`, made under Settings → API & shortcuts), or a Pocket Core token. Types: `web/src/lib/types.ts`.
Everything is per person: another person's ids answer 404.

## Library

| Call | What |
| :--- | :--- |
| `GET /tabs?q=&status=&favorite=1&tag=&tuning=&artist=&source=&sort=recent\|added\|title\|artist\|practice&limit=&offset=` | `{tabs, total}` |
| `GET /tabs/facets` | Tags, tunings, artists with counts, per-status counts |
| `POST /tabs` (multipart, one or more `file` fields; optional `status`, `tags`; `songsterr_url`, `title`, `artist` for a file built from Songsterr) | `{added[], existing[], errors[]}`; a file you already have (same bytes) is returned under `existing` |
| `GET /songsterr/search?q=` | Search Songsterr: `{ok, results:[{id, title, artist, url, guitars, bass, drums, tuning, difficulty, tab_id}]}`; `tab_id` = the song in your library already |
| `GET /songsterr/song?url=` · `GET /songsterr/part?song=&revision=&image=&part=` | A Songsterr song's data and one track's data, fetched by the server; the browser builds the Guitar Pro file from them (`web/src/songsterr`) and uploads it |
| `GET /tabs/{id}` | The tab with its `sections` |
| `GET /tabs/{id}/file` | The original file |
| `PUT /tabs/{id}` | Any of `title artist album tabber status difficulty favorite tags notes capo goal_speed best_speed player recording` |
| `PUT /tabs/{id}/analysis` | What the browser read from the file: `{title?, artist?, album?, tabber?, tempo, bars, duration_s, tracks[], tuning}`; names only fill blanks |
| `DELETE /tabs/{id}` | Removes it here (a file in a Pocket Files folder stays there) |
| `GET /tabs/{id}/sections` · `POST /tabs/{id}/sections` `{name, start_bar, end_bar, goal_speed?, color?}` | Sections (loops) |
| `PUT /sections/{id}` · `DELETE /sections/{id}` | `{name, start_bar, end_bar, speed, goal_speed, best_speed, color, sort}` |

## Practice

| Call | What |
| :--- | :--- |
| `GET /practice?from=&to=&tab_id=&limit=&offset=` | `{sessions, total}`, newest first |
| `POST /practice` | `PracticeInput`; with `external_id` the same id updates the same session (the player saves every minute) |
| `PUT /practice/{id}` · `DELETE /practice/{id}` | |
| `GET /dashboard` | Today, goal, streak, the week, counts, recent / learning / newly added tabs |
| `GET /stats?from=&to=` | Totals, days, the year heatmap, per song, per weekday and hour, songs mastered |
| `GET /day/{date}` | One day's practice (for Pocket Day) |
| `GET /overlay?from=&to=` | Practice per day (for Pocket Calendar) |

## Setlists

`GET /setlists`, `POST /setlists` `{name, note, tab_ids}`, `GET /setlists/{id}` (with `tabs`), `PUT /setlists/{id}`, `DELETE /setlists/{id}`.

## Pocket Files folders

| Call | What |
| :--- | :--- |
| `GET /folders` · `POST /folders` `{space, path, label?}` · `PUT /folders/{id}` · `DELETE /folders/{id}` | Folders whose tabs appear in the library (read through Pocket Files) |
| `POST /folders/{id}/sync` · `POST /folders/sync` | Look for new, changed and removed files now (also every 15 minutes) |
| `GET /files/spaces` · `GET /files/browse?space=&path=` | Browse Pocket Files to pick a folder |

## Connected apps

| Call | What |
| :--- | :--- |
| `GET /rules` · `POST /rules` `{min_minutes, habit_id, habit_name}` · `PUT /rules/{id}` · `DELETE /rules/{id}` | "A day with N minutes of guitar ticks this habit" (Pocket Habits) |
| `GET /habits/list` | Your habits in Pocket Habits, for the picker |
| `GET /timer` | Your practice timer in Pocket Time → `{connected, running: {id, name, started_at, elapsed_s, app, started_in, guitar, tab_id, url} \| null, time_url}`; `connected: false` with a `detail` when Pocket Time is not set up |
| `POST /timer/start` `{tab_id}` or `{title}`, `switch?` | Start the shared timer for a song or free practice; `409 {error, running}` when another timer runs, `switch: true` stops it and starts this. Pocket Time saves the practice here when it stops (`external_id` `time:<id>`) |
| `POST /timer/stop` `{only_if, note?}` | Stop it (only if `only_if` is still the one running, else `409`) |
| `GET /music/search?q=` | Songs in your Navidrome (for the original recording) |
| `GET /music/stream/{id}` | One song, streamed through the app (ranges work) |
| `POST /ai/plan` `{tab_id, section_id?}` | A short practice plan for the song from your AI → `{text}` |
| `GET /ai/status` · `GET /ai/models` · `POST /ai/ask` | |

## Account and box

`GET /auth/status`, `POST /auth/login`, `POST /auth/setup`, `POST /auth/logout`, `GET|PUT /auth/me`, `GET|POST /tokens`,
`DELETE /tokens/{id}`, `GET|PUT /settings`, `GET /settings/system`, `POST /integrations/test`, `POST /notify/test`,
`GET|POST /users`, `PUT|DELETE /users/{id}` (admins), `GET /backup` (admins), `GET /export.json`, `GET /export.csv`,
`POST /import` (a Pocket Guitar export; tabs come back with their files).

`GET /healthz`, `GET /readyz`, `GET /metrics`.
