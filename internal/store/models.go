package store

import (
	"encoding/json"
	"strings"
)

// User is an account on this box.
type User struct {
	ID           int64  `json:"id"`
	Email        string `json:"email"`
	Name         string `json:"name"`
	PasswordHash string `json:"-"`
	Role         string `json:"role"` // admin | member
	CreatedAt    string `json:"created_at"`
}

// APIToken is a personal access token (hash stored, plaintext shown once).
type APIToken struct {
	ID         int64   `json:"id"`
	UserID     int64   `json:"user_id"`
	Name       string  `json:"name"`
	Prefix     string  `json:"prefix"`
	LastUsedAt *string `json:"last_used_at"`
	CreatedAt  string  `json:"created_at"`
}

// TabTrack is one instrument of a tab, as read from the file.
type TabTrack struct {
	Index      int    `json:"index"`
	Name       string `json:"name"`
	Instrument string `json:"instrument"`
	Strings    int    `json:"strings"`
	Tuning     string `json:"tuning"`
	Drums      bool   `json:"drums"`
}

// Recording is the original song (a Navidrome id) linked to a tab.
type Recording struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Album    string `json:"album"`
	Duration int    `json:"duration"`
	OffsetMS int    `json:"offset_ms"`
}

// Tab is one song in a person's library.
type Tab struct {
	ID            int64           `json:"id"`
	UserID        int64           `json:"-"`
	Title         string          `json:"title"`
	Artist        string          `json:"artist"`
	Album         string          `json:"album"`
	Tabber        string          `json:"tabber"`
	NamesFrom     string          `json:"-"`
	Format        string          `json:"format"`
	FileName      string          `json:"file_name"`
	Size          int64           `json:"size"`
	SHA256        string          `json:"-"`
	Source        string          `json:"source"`
	SourceRef     string          `json:"source_ref"`
	SourceLabel   string          `json:"source_label"`
	FolderID      *int64          `json:"folder_id"`
	SourceStamp   string          `json:"-"`
	SourceMissing bool            `json:"source_missing"`
	Tempo         int             `json:"tempo"`
	Bars          int             `json:"bars"`
	DurationS     int             `json:"duration_s"`
	Tracks        []TabTrack      `json:"tracks"`
	Tuning        string          `json:"tuning"`
	Analyzed      bool            `json:"analyzed"`
	Status        string          `json:"status"`
	MasteredAt    string          `json:"mastered_at"`
	Difficulty    int             `json:"difficulty"`
	Favorite      bool            `json:"favorite"`
	Tags          string          `json:"tags"`
	Notes         string          `json:"notes"`
	Capo          int             `json:"capo"`
	GoalSpeed     int             `json:"goal_speed"`
	BestSpeed     int             `json:"best_speed"`
	Player        json.RawMessage `json:"player"`
	Recording     *Recording      `json:"recording"`
	LastPlayedAt  string          `json:"last_played_at"`
	PlayCount     int             `json:"play_count"`
	PracticeS     int             `json:"practice_s"`
	CreatedAt     string          `json:"created_at"`
	UpdatedAt     string          `json:"updated_at"`
	Sections      []Section       `json:"sections,omitempty"`
}

// Name is "Artist – Title" (or just the title).
func (t Tab) Name() string {
	if t.Artist != "" && t.Title != "" {
		return t.Artist + " – " + t.Title
	}
	if t.Title != "" {
		return t.Title
	}
	return t.FileName
}

// Section is a named range of bars practised as a loop.
type Section struct {
	ID              int64  `json:"id"`
	UserID          int64  `json:"-"`
	TabID           int64  `json:"tab_id"`
	Name            string `json:"name"`
	StartBar        int    `json:"start_bar"`
	EndBar          int    `json:"end_bar"`
	Speed           int    `json:"speed"`
	GoalSpeed       int    `json:"goal_speed"`
	BestSpeed       int    `json:"best_speed"`
	Color           string `json:"color"`
	Sort            int    `json:"sort"`
	LastPracticedAt string `json:"last_practiced_at"`
	PracticeS       int    `json:"practice_s"`
	CreatedAt       string `json:"created_at"`
}

// Practice is time spent playing: a tab, a section of one, or free practice.
type Practice struct {
	ID            int64  `json:"id"`
	UserID        int64  `json:"-"`
	TabID         *int64 `json:"tab_id"`
	SectionID     *int64 `json:"section_id"`
	Title         string `json:"title"`
	Kind          string `json:"kind"`
	StartedAt     string `json:"started_at"`
	EndedAt       string `json:"ended_at"`
	Date          string `json:"date"`
	DurationS     int    `json:"duration_s"`
	Speed         int    `json:"speed"`
	Loops         int    `json:"loops"`
	Note          string `json:"note"`
	Source        string `json:"source"`
	ExternalID    string `json:"external_id"`
	HabitMarkedAt string `json:"-"`
	HabitError    string `json:"-"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

// Setlist is an ordered list of tabs.
type Setlist struct {
	ID        int64   `json:"id"`
	UserID    int64   `json:"-"`
	Name      string  `json:"name"`
	Note      string  `json:"note"`
	TabIDs    []int64 `json:"tab_ids"`
	Count     int     `json:"count"`
	DurationS int     `json:"duration_s"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
	Tabs      []Tab   `json:"tabs,omitempty"`
}

// Folder is a Pocket Files folder whose tabs appear in the library.
type Folder struct {
	ID         int64  `json:"id"`
	UserID     int64  `json:"-"`
	Space      string `json:"space"`
	SpaceName  string `json:"space_name"`
	Path       string `json:"path"`
	Label      string `json:"label"`
	LastSyncAt string `json:"last_sync_at"`
	LastError  string `json:"last_error"`
	TabCount   int    `json:"tab_count"`
	Syncing    bool   `json:"syncing"`
	CreatedAt  string `json:"created_at"`
}

// HabitRule ticks a Pocket Habits habit when the day's practice reaches a length.
type HabitRule struct {
	ID         int64   `json:"id"`
	UserID     int64   `json:"-"`
	MinMinutes float64 `json:"min_minutes"`
	HabitID    int64   `json:"habit_id"`
	HabitName  string  `json:"habit_name"`
	Enabled    bool    `json:"enabled"`
	CreatedAt  string  `json:"created_at"`
}

// Settings are the box-wide values plus one person's preferences and their
// own connections. Connection modes: "core" (an app link through Pocket
// Core), "direct" (URL + token) or "off"; "" = not chosen yet.
type Settings struct {
	Title         string `json:"title"`
	SetupComplete bool   `json:"setup_complete"`

	DateFormat string `json:"date_format"`
	TimeFormat string `json:"time_format"`
	WeekStart  int    `json:"week_start"` // 1 = Monday, 7 = Sunday

	// Goals: minutes a day, and on how many days a week.
	DailyGoalMin   int `json:"daily_goal_min"`
	WeeklyGoalDays int `json:"weekly_goal_days"`

	// The player's defaults; a tab's own choices win.
	Notation      string `json:"notation"` // tab | score | both
	Layout        string `json:"layout"`   // page | horizontal
	Zoom          int    `json:"zoom"`     // percent
	CountIn       bool   `json:"count_in"`
	Metronome     bool   `json:"metronome"`
	SpeedStep     int    `json:"speed_step"` // percent per − / +
	AutoScroll    bool   `json:"auto_scroll"`
	Fretboard     bool   `json:"fretboard"`
	LeftHanded    bool   `json:"left_handed"`
	ScoreColors   string `json:"score_colors"` // theme | paper
	KeepAwake     bool   `json:"keep_awake"`
	TrainerStart  int    `json:"trainer_start"`  // percent
	TrainerStep   int    `json:"trainer_step"`   // percent
	TrainerEvery  int    `json:"trainer_every"`  // loops before the next step
	TrainerTarget int    `json:"trainer_target"` // percent

	// Where new tabs are saved: 0 = here, else a Pocket Files folder (id).
	SaveFolderID int64 `json:"save_folder_id"`

	// Reminders.
	ReminderTimes    []string `json:"reminder_times"` // "18:00"
	ReminderDays     string   `json:"reminder_days"`  // ISO weekdays "1234567"
	ReminderSkipDone bool     `json:"reminder_skip_done"`
	NotifyStreak     bool     `json:"notify_streak"` // evening nudge when today would break the streak
	StreakHour       int      `json:"streak_hour"`
	NotifyWeekly     bool     `json:"notify_weekly"`
	WeeklyDay        int      `json:"weekly_day"`
	WeeklyHour       int      `json:"weekly_hour"`
	NotifyURL        string   `json:"notify_url"`
	NotifyFormat     string   `json:"notify_format"` // apprise | ntfy | json

	FilesMode      string `json:"files_mode"`
	FilesURL       string `json:"files_url"`
	FilesToken     string `json:"files_token"`
	FilesPublicURL string `json:"files_public_url"`

	HabitsMode      string `json:"habits_mode"`
	HabitsURL       string `json:"habits_url"`
	HabitsToken     string `json:"habits_token"`
	HabitsPublicURL string `json:"habits_public_url"`

	// Navidrome, for playing along with the original recording.
	MusicMode     string `json:"music_mode"`
	MusicURL      string `json:"music_url"`
	MusicUser     string `json:"music_user"`
	MusicPassword string `json:"music_password"`

	// AI for practice plans and questions: Pocket AI through Core, or an
	// OpenAI-compatible API with the person's own key.
	AIProvider    string `json:"ai_provider"` // auto | pocket | openai
	AIPocketModel string `json:"ai_pocket_model"`
	OpenAIKey     string `json:"openai_api_key"`
	OpenAIModel   string `json:"openai_model"`
	OpenAIBaseURL string `json:"openai_base_url"`
}

// SplitTags turns "a, b ,c" into clean lowercase tags.
func SplitTags(s string) []string {
	var out []string
	seen := map[string]bool{}
	for _, t := range strings.Split(s, ",") {
		t = strings.ToLower(strings.TrimSpace(t))
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// JoinTags is the stored form of tags.
func JoinTags(s string) string { return strings.Join(SplitTags(s), ", ") }
