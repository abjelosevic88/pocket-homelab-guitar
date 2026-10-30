export interface User { id: number; email: string; name: string; role: 'admin' | 'member'; created_at: string }
export interface APIToken { id: number; user_id: number; name: string; prefix: string; last_used_at: string | null; created_at: string }

export type ConnMode = 'core' | 'direct' | 'off'
export type ConnVia = '' | 'core' | 'direct'

export type Notation = 'tab' | 'score' | 'both'
export type ScoreLayout = 'page' | 'horizontal'

export interface Settings {
  core_configured: boolean
  core_registered?: boolean
  title: string; date_format: string; time_format: string; week_start: number
  daily_goal_min: number; weekly_goal_days: number

  // the player's defaults (a tab's own choices win, see PlayerPrefs)
  notation: Notation; layout: ScoreLayout; zoom: number
  count_in: boolean; metronome: boolean; speed_step: number; auto_scroll: boolean
  fretboard: boolean; left_handed: boolean; score_colors: 'theme' | 'paper'; keep_awake: boolean
  trainer_start: number; trainer_step: number; trainer_every: number; trainer_target: number

  // where new tabs go: 0 = the app itself, else a linked Pocket Files folder (its id)
  save_folder_id: number

  reminder_times: string[]; reminder_days: string; reminder_skip_done: boolean
  notify_streak: boolean; streak_hour: number; notify_weekly: boolean; weekly_day: number; weekly_hour: number
  notify_url: string; notify_format: string; notify_configured: boolean

  files_mode: ConnMode; files_via: ConnVia; files_detail: string; files_open_url: string; files_configured: boolean
  files_url: string; files_token: string; files_public_url: string
  habits_mode: ConnMode; habits_via: ConnVia; habits_detail: string; habits_open_url: string; habits_configured: boolean
  habits_url: string; habits_token: string; habits_public_url: string
  time_mode: ConnMode; time_via: ConnVia; time_detail: string; time_open_url: string; time_configured: boolean
  time_url: string; time_token: string; time_public_url: string
  music_mode: ConnMode; music_url: string; music_user: string; music_password: string

  ai_provider: 'auto' | 'pocket' | 'openai'; ai_pocket_model: string; openai_api_key: string; openai_model: string; openai_base_url: string
  setup_complete: boolean; base_url: string
  songsterr_available: boolean
}

// ---- the library ----

/** Where a song is in your learning: want to learn → learning → polishing → can play it. */
export type TabStatus = 'to_learn' | 'learning' | 'polishing' | 'mastered'

export interface TabTrack {
  index: number; name: string; instrument: string
  strings: number      // 0 for drums / non-string tracks
  tuning: string       // "E A D G B E" (low to high), "" for drums
  drums: boolean
}

/** Per-tab player choices, saved as the person changes them. Missing = the Settings default. */
export interface PlayerPrefs {
  track?: number            // the track shown (index into score.tracks)
  tracks?: number[]         // several tracks shown together (overrides track)
  muted?: number[]
  solo?: number[]
  volume?: Record<string, number> // track index → 0..1
  speed?: number            // playback speed in percent (25..200)
  layout?: ScoreLayout
  zoom?: number             // 50..200 percent
  notation?: Notation
  transpose?: number        // display transposition in semitones
  metronome?: boolean
  count_in?: boolean
  fretboard?: boolean
}

/** The original recording linked to a tab (a Navidrome song), for playing along. */
export interface Recording { id: string; title: string; artist: string; album: string; duration: number; offset_ms: number }

export interface Tab {
  id: number
  title: string; artist: string; album: string; tabber: string
  format: string           // gp | gp3 | gp4 | gp5 | gpx | musicxml | alphatex
  file_name: string; size: number
  source: string           // upload | files | songsterr | import | <pocket app>
  source_ref: string       // the Pocket Files path or the Songsterr address
  source_label: string     // plain words: "Pocket Files: Music/Tabs", "Songsterr", "Uploaded"
  source_missing: boolean  // the file is gone from its folder (the tab stays here)
  tempo: number; bars: number; duration_s: number
  tracks: TabTrack[]; tuning: string // the main guitar track's tuning name ("Standard", "Drop D", or the notes)
  analyzed: boolean        // tracks/tempo/bars were read from the file (the browser does it once)
  status: TabStatus; difficulty: number /* 0 = not rated, 1..5 */; favorite: boolean
  tags: string; notes: string; capo: number
  goal_speed: number; best_speed: number // percent of the written tempo
  last_played_at: string; play_count: number; practice_s: number
  player: PlayerPrefs
  recording: Recording | null
  created_at: string; updated_at: string
  sections?: Section[]     // only on GET /tabs/{id}
}

/** A named part of a song (bars, 1-based, inclusive) practised as a loop, with its own speed trainer. */
export interface Section {
  id: number; tab_id: number; name: string
  start_bar: number; end_bar: number
  speed: number; goal_speed: number; best_speed: number // percent
  color: string; sort: number
  last_practiced_at: string; practice_s: number; created_at: string
}

export interface TabList { tabs: Tab[]; total: number }
export interface Facets { tags: { name: string; count: number }[]; tunings: { name: string; count: number }[]; artists: { name: string; count: number }[]; status: Record<TabStatus, number>; favorites: number; total: number }
export interface UploadResult { added: Tab[]; existing: Tab[]; errors: { name: string; error: string }[] }

/** What the browser read from the file with alphaTab (PUT /tabs/{id}/analysis). */
export interface Analysis { title?: string; artist?: string; album?: string; tabber?: string; tempo: number; bars: number; duration_s: number; tracks: TabTrack[]; tuning: string }

// ---- practice ----

export interface PracticeSession {
  id: number; tab_id: number | null; section_id: number | null
  title: string            // "Artist – Song" (kept when the tab is deleted), or what was practised
  started_at: string; ended_at: string; date: string
  duration_s: number; speed: number /* top speed played, percent */; loops: number
  kind: 'tab' | 'free'     // free = scales, improvising, anything without a tab
  note: string; source: string; external_id: string
  created_at: string
}
export interface PracticeInput {
  tab_id?: number | null; section_id?: number | null; title?: string
  started_at: string; ended_at?: string; duration_s: number; speed?: number; loops?: number
  kind?: 'tab' | 'free'; note?: string
  external_id?: string     // the player's id for a running session: the same id updates the same row
}
export interface DayPoint { date: string; seconds: number }

export interface Dashboard {
  today_s: number; goal_min: number; week_s: number; streak: number; longest_streak: number
  week: DayPoint[]          // the last 7 days, oldest first
  counts: { tabs: number; to_learn: number; learning: number; polishing: number; mastered: number; favorites: number }
  recent: Tab[]             // last played
  learning: Tab[]           // status learning or polishing, most recently played first
  added: Tab[]              // newest never played
}

export interface Stats {
  from: string; to: string
  total_s: number; sessions: number; days_practised: number; avg_day_s: number
  streak: number; longest_streak: number
  days: DayPoint[]          // every day from..to
  year: DayPoint[]          // the last 365 days, for the heatmap
  by_tab: { tab_id: number | null; title: string; artist: string; seconds: number; sessions: number }[]
  by_weekday: number[]      // seconds, Monday first
  by_hour: number[]         // seconds, 0..23
  mastered: { tab_id: number; title: string; artist: string; at: string }[]
}

// ---- setlists ----

export interface Setlist { id: number; name: string; note: string; tab_ids: number[]; count: number; duration_s: number; created_at: string; updated_at: string; tabs?: Tab[] }

// ---- Pocket Files folders ----

export interface Folder {
  id: number; space: string; space_name: string; path: string; label: string
  last_sync_at: string; last_error: string; tab_count: number; syncing: boolean; created_at: string
}
export interface FilesSpace { id: string; name: string; kind: string; writable: boolean }
export interface FilesBrowse { ok: boolean; error?: string; not_connected?: boolean; space: string; path: string; folders: { name: string; path: string }[]; tab_files: number; writable: boolean }

// ---- connected apps ----

export interface HabitRule { id: number; min_minutes: number; habit_id: number; habit_name: string; enabled: boolean; created_at: string }
export interface Habit { id: number; name: string; color: string; days: string }
export interface MusicSong { id: string; title: string; artist: string; album: string; duration: number }
export interface MusicSearch { ok: boolean; error?: string; not_connected?: boolean; via?: string; songs: MusicSong[] }
