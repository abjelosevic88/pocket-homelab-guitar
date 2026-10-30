package server

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/ai"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/notify"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/pocket"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// ---- settings ----

func mask(s string) string {
	if s == "" {
		return ""
	}
	if len(s) <= 8 {
		return "••••"
	}
	return s[:4] + "••••" + s[len(s)-4:]
}

// publicSettings is what one person sees: their settings with the secrets
// masked and, per Pocket app, the mode in effect (<app>_mode), whether it
// works and how (<app>_via: core | direct | "") and why not (<app>_detail).
func (s *Server) publicSettings(ctx context.Context, u *store.User, st store.Settings) map[string]any {
	if st.ReminderTimes == nil {
		st.ReminderTimes = []string{}
	}
	out := map[string]any{
		"core_configured": s.core.Configured(), "core_registered": s.coreStatus()["registered"],
		"title": st.Title, "date_format": st.DateFormat, "time_format": st.TimeFormat, "week_start": st.WeekStart,
		"daily_goal_min": st.DailyGoalMin, "weekly_goal_days": st.WeeklyGoalDays,
		"notation": st.Notation, "layout": st.Layout, "zoom": st.Zoom, "count_in": st.CountIn, "metronome": st.Metronome, "speed_step": st.SpeedStep,
		"auto_scroll": st.AutoScroll, "fretboard": st.Fretboard, "left_handed": st.LeftHanded, "score_colors": st.ScoreColors, "keep_awake": st.KeepAwake,
		"trainer_start": st.TrainerStart, "trainer_step": st.TrainerStep, "trainer_every": st.TrainerEvery, "trainer_target": st.TrainerTarget,
		"save_folder_id": st.SaveFolderID,
		"reminder_times": st.ReminderTimes, "reminder_days": st.ReminderDays, "reminder_skip_done": st.ReminderSkipDone,
		"notify_streak": st.NotifyStreak, "streak_hour": st.StreakHour,
		"notify_weekly": st.NotifyWeekly, "weekly_day": st.WeeklyDay, "weekly_hour": st.WeeklyHour,
		"notify_url": st.NotifyURL, "notify_format": st.NotifyFormat, "notify_configured": st.NotifyURL != "",
		"files_url": st.FilesURL, "files_token": mask(st.FilesToken), "files_public_url": st.FilesPublicURL,
		"habits_url": st.HabitsURL, "habits_token": mask(st.HabitsToken), "habits_public_url": st.HabitsPublicURL,
		"time_url": st.TimeURL, "time_token": mask(st.TimeToken), "time_public_url": st.TimePublicURL,
		"music_url": st.MusicURL, "music_user": st.MusicUser, "music_password": mask(st.MusicPassword),
		"music_mode":  s.connMode(st.MusicMode, st.MusicPassword),
		"ai_provider": st.AIProvider, "ai_pocket_model": st.AIPocketModel, "openai_api_key": mask(st.OpenAIKey), "openai_model": st.OpenAIModel, "openai_base_url": st.OpenAIBaseURL,
		"setup_complete": st.SetupComplete, "base_url": s.cfg.BaseURL, "songsterr_available": true,
	}
	for _, a := range pocketApps {
		mode, via, detail := s.connStatus(ctx, u, st, a)
		out[a.slug+"_mode"], out[a.slug+"_via"], out[a.slug+"_detail"] = mode, via, detail
		out[a.slug+"_configured"] = via != ""
		_, _, _, public := connSettings(st, a)
		if public == "" && via != "" {
			public = s.resolveSibling(ctx, a.slug)
		}
		out[a.slug+"_open_url"] = public
	}
	return out
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	st, err := s.store.GetSettings(r.Context(), actorID(r.Context()))
	if err != nil {
		s.fail(w, err, "settings")
		return
	}
	writeJSON(w, http.StatusOK, s.publicSettings(r.Context(), userFrom(r.Context()), st))
}

var hhmm = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)

// handlePutSettings saves the caller's personal settings. The box-wide title
// is only taken from an admin.
func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	me := userFrom(r.Context())
	isAdmin := me.Role == "admin"
	cur, err := s.store.GetSettings(r.Context(), me.ID)
	if err != nil {
		s.fail(w, err, "settings")
		return
	}
	var in store.Settings
	keys, err := decodeKeys(r, &in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	bad := func(msg string) { writeErr(w, http.StatusBadRequest, msg) }
	if keys["title"] && isAdmin {
		cur.Title = strings.TrimSpace(in.Title)
		if cur.Title == "" {
			cur.Title = store.DefaultTitle
		}
	}
	if keys["date_format"] {
		cur.DateFormat = in.DateFormat
	}
	if keys["time_format"] {
		cur.TimeFormat = in.TimeFormat
	}
	if keys["week_start"] && (in.WeekStart == 1 || in.WeekStart == 7 || in.WeekStart == 6) {
		cur.WeekStart = in.WeekStart
	}
	intIn := func(k string, dst *int, v, lo, hi int) bool {
		if !keys[k] {
			return true
		}
		if v < lo || v > hi {
			bad(fmt.Sprintf("%s is %d to %d", k, lo, hi))
			return false
		}
		*dst = v
		return true
	}
	if !intIn("daily_goal_min", &cur.DailyGoalMin, in.DailyGoalMin, 0, 600) || !intIn("weekly_goal_days", &cur.WeeklyGoalDays, in.WeeklyGoalDays, 0, 7) ||
		!intIn("streak_hour", &cur.StreakHour, in.StreakHour, 0, 23) || !intIn("weekly_day", &cur.WeeklyDay, in.WeeklyDay, 1, 7) ||
		!intIn("weekly_hour", &cur.WeeklyHour, in.WeeklyHour, 0, 23) || !intIn("zoom", &cur.Zoom, in.Zoom, 50, 200) ||
		!intIn("speed_step", &cur.SpeedStep, in.SpeedStep, 1, 25) || !intIn("trainer_start", &cur.TrainerStart, in.TrainerStart, 10, 200) ||
		!intIn("trainer_step", &cur.TrainerStep, in.TrainerStep, 1, 25) || !intIn("trainer_every", &cur.TrainerEvery, in.TrainerEvery, 1, 20) ||
		!intIn("trainer_target", &cur.TrainerTarget, in.TrainerTarget, 10, 200) {
		return
	}
	pick := func(k string, dst *string, v string, allowed []string) bool {
		if !keys[k] {
			return true
		}
		for _, a := range allowed {
			if v == a {
				*dst = v
				return true
			}
		}
		bad(fmt.Sprintf("%s must be one of %s", k, strings.Join(allowed, ", ")))
		return false
	}
	if !pick("notation", &cur.Notation, in.Notation, []string{"tab", "score", "both"}) || !pick("layout", &cur.Layout, in.Layout, []string{"page", "horizontal"}) ||
		!pick("score_colors", &cur.ScoreColors, in.ScoreColors, []string{"theme", "paper"}) {
		return
	}
	if keys["save_folder_id"] {
		if in.SaveFolderID != 0 {
			if _, err := s.store.GetFolder(r.Context(), me.ID, in.SaveFolderID); err != nil {
				bad("no such folder")
				return
			}
		}
		cur.SaveFolderID = in.SaveFolderID
	}
	if keys["reminder_times"] {
		ts := []string{}
		seen := map[string]bool{}
		for _, t := range in.ReminderTimes {
			t = strings.TrimSpace(t)
			if !hhmm.MatchString(t) {
				bad("reminder times are HH:MM")
				return
			}
			if !seen[t] {
				seen[t] = true
				ts = append(ts, t)
			}
		}
		if len(ts) > 6 {
			bad("up to six reminders a day")
			return
		}
		sort.Strings(ts)
		cur.ReminderTimes = ts
	}
	if keys["reminder_days"] {
		d := ""
		for _, c := range "1234567" {
			if strings.ContainsRune(in.ReminderDays, c) {
				d += string(c)
			}
		}
		cur.ReminderDays = d
	}
	secret := func(k string, dst *string, v string) {
		if keys[k] && !strings.Contains(v, "••") {
			*dst = strings.TrimSpace(v)
		}
	}
	url := func(k string, dst *string, v string) {
		if keys[k] {
			*dst = strings.TrimRight(strings.TrimSpace(v), "/")
		}
	}
	text := func(k string, dst *string, v string) {
		if keys[k] {
			*dst = strings.TrimSpace(v)
		}
	}
	boolIn := func(k string, dst *bool, v bool) {
		if keys[k] {
			*dst = v
		}
	}
	boolIn("count_in", &cur.CountIn, in.CountIn)
	boolIn("metronome", &cur.Metronome, in.Metronome)
	boolIn("auto_scroll", &cur.AutoScroll, in.AutoScroll)
	boolIn("fretboard", &cur.Fretboard, in.Fretboard)
	boolIn("left_handed", &cur.LeftHanded, in.LeftHanded)
	boolIn("keep_awake", &cur.KeepAwake, in.KeepAwake)
	boolIn("reminder_skip_done", &cur.ReminderSkipDone, in.ReminderSkipDone)
	boolIn("notify_streak", &cur.NotifyStreak, in.NotifyStreak)
	boolIn("notify_weekly", &cur.NotifyWeekly, in.NotifyWeekly)
	text("notify_url", &cur.NotifyURL, in.NotifyURL)
	if keys["notify_format"] && in.NotifyFormat != "" {
		cur.NotifyFormat = in.NotifyFormat
	}
	url("habits_url", &cur.HabitsURL, in.HabitsURL)
	secret("habits_token", &cur.HabitsToken, in.HabitsToken)
	url("habits_public_url", &cur.HabitsPublicURL, in.HabitsPublicURL)
	url("files_url", &cur.FilesURL, in.FilesURL)
	secret("files_token", &cur.FilesToken, in.FilesToken)
	url("files_public_url", &cur.FilesPublicURL, in.FilesPublicURL)
	url("time_url", &cur.TimeURL, in.TimeURL)
	secret("time_token", &cur.TimeToken, in.TimeToken)
	url("time_public_url", &cur.TimePublicURL, in.TimePublicURL)
	url("music_url", &cur.MusicURL, in.MusicURL)
	text("music_user", &cur.MusicUser, in.MusicUser)
	secret("music_password", &cur.MusicPassword, in.MusicPassword)
	if keys["ai_provider"] {
		if !validAIProvider(in.AIProvider) {
			bad("AI is automatic, Pocket AI or OpenAI")
			return
		}
		cur.AIProvider = in.AIProvider
	}
	if keys["ai_pocket_model"] {
		if !validPocketModel(in.AIPocketModel) {
			bad("unknown model")
			return
		}
		cur.AIPocketModel = in.AIPocketModel
	}
	secret("openai_api_key", &cur.OpenAIKey, in.OpenAIKey)
	text("openai_model", &cur.OpenAIModel, in.OpenAIModel)
	url("openai_base_url", &cur.OpenAIBaseURL, in.OpenAIBaseURL)
	mode := func(k string, dst *string, v string) {
		if keys[k] && (v == modeCore || v == modeDirect || v == modeOff) {
			*dst = v
		}
	}
	mode("habits_mode", &cur.HabitsMode, in.HabitsMode)
	mode("files_mode", &cur.FilesMode, in.FilesMode)
	mode("music_mode", &cur.MusicMode, in.MusicMode)
	mode("time_mode", &cur.TimeMode, in.TimeMode)
	if err := s.store.SaveUserSettings(r.Context(), me.ID, cur); err != nil {
		s.fail(w, err, "save settings")
		return
	}
	if isAdmin && keys["title"] {
		if err := s.store.SaveBoxSettings(r.Context(), cur); err != nil {
			s.fail(w, err, "save settings")
			return
		}
	}
	for _, k := range modeKeys {
		if keys[k] {
			s.reportModesSoon()
			break
		}
	}
	if keys["time_mode"] || keys["time_url"] || keys["time_token"] {
		s.forgetTimer(me.ID)
	}
	writeJSON(w, http.StatusOK, s.publicSettings(r.Context(), me, cur))
}

// handleIntegrationTest checks a connection with the caller's own saved
// settings (or the URL/key typed into the form).
func (s *Server) handleIntegrationTest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Which  string `json:"which"`
		URL    string `json:"url"`
		Key    string `json:"key"`
		User   string `json:"user"`
		Format string `json:"format"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	uid := actorID(r.Context())
	st, _ := s.store.GetSettings(r.Context(), uid)
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	keyOr := func(saved string) string {
		if strings.Contains(in.Key, "••") || in.Key == "" {
			return saved
		}
		return in.Key
	}
	urlOr := func(saved string) string {
		if strings.TrimSpace(in.URL) == "" {
			return saved
		}
		return strings.TrimRight(strings.TrimSpace(in.URL), "/")
	}
	var msg string
	var err error
	if a, ok := appBySlug(in.Which); ok {
		mode, savedURL, savedTok, _ := connSettings(st, a)
		typed := in.Key != "" && !strings.Contains(in.Key, "••")
		var conn *siblingConn
		if tok := keyOr(savedTok); tok != "" && (typed || s.connMode(mode, savedTok) == modeDirect) {
			base := urlOr(savedURL)
			if base == "" {
				base = s.resolveSibling(ctx, a.slug)
			}
			conn = &siblingConn{client: pocket.New(base, tok, 15*time.Second), via: modeDirect}
		} else {
			conn, err = s.clients(ctx, uid).conn(ctx, a, a.scopes...)
		}
		if err == nil {
			how := "direct connection"
			if conn.via == modeCore {
				how = "through Pocket Core"
			}
			var v string
			if v, err = conn.client.Health(ctx); err == nil {
				switch a.slug {
				case "habits":
					var hs []pocket.Habit
					hs, err = conn.client.Habits(ctx)
					msg = fmt.Sprintf("Pocket Habits %s, %s, %d habits", v, how, len(hs))
				case "files":
					var sp []pocket.Space
					sp, err = conn.client.Spaces(ctx)
					msg = fmt.Sprintf("Pocket Files %s, %s, %d places", v, how, len(sp))
				case "time":
					var tr timeTimer
					if _, err = conn.client.Call(ctx, http.MethodGet, "/api/v1/timer", nil, nil, &tr); err == nil {
						now := "no timer running"
						if tr.Running != nil {
							now = "your timer is running: " + tr.Running.name()
						}
						msg = fmt.Sprintf("Pocket Time %s, %s, %s", v, how, now)
					}
				}
			}
		}
	} else if in.Which == "music" {
		var n *navidrome
		if in.User != "" || (in.Key != "" && !strings.Contains(in.Key, "••")) || in.URL != "" {
			n = &navidrome{base: urlOr(st.MusicURL), user: firstNonEmpty(in.User, st.MusicUser), pass: keyOr(st.MusicPassword), via: modeDirect, http: &http.Client{Timeout: 15 * time.Second}}
		} else {
			n, err = s.navidromeFor(ctx, uid)
		}
		if err == nil {
			var out struct {
				MusicFolders struct {
					MusicFolder []struct {
						Name string `json:"name"`
					} `json:"musicFolder"`
				} `json:"musicFolders"`
			}
			if err = n.call(ctx, "getMusicFolders", nil, &out); err == nil {
				how := "direct connection"
				if n.via == modeCore {
					how = "through Pocket Core"
				}
				msg = fmt.Sprintf("Navidrome, %s, %d music folders", how, len(out.MusicFolders.MusicFolder))
			}
		}
	} else if in.Which == "openai" {
		c := ai.New(urlOr(st.OpenAIBaseURL), keyOr(st.OpenAIKey), st.OpenAIModel, 20*time.Second)
		var ids []string
		if ids, err = c.Models(ctx); err == nil {
			msg = fmt.Sprintf("The key works (%d models)", len(ids))
		}
	} else if in.Which == "notify" {
		f := in.Format
		if f == "" {
			f = st.NotifyFormat
		}
		n := notify.New(urlOr(st.NotifyURL), f)
		err = n.Send(ctx, notify.Message{Title: "Pocket Guitar", Body: "Notifications work. Practice reminders and the weekly report will arrive here.", Priority: "info", Tags: []string{"guitar"}})
		msg = "Test message sent via " + n.Format
	} else {
		writeErr(w, http.StatusBadRequest, "unknown integration")
		return
	}
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg})
}

func (s *Server) handleNotifyTest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	st, _ := s.store.GetSettings(ctx, actorID(ctx))
	n := notify.New(st.NotifyURL, st.NotifyFormat)
	if err := n.Send(ctx, notify.Message{Title: "Pocket Guitar", Body: "Notifications work.", Priority: "info", Tags: []string{"guitar"}}); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---- system / backup / export ----

func (s *Server) handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	var size int64
	if fi, err := os.Stat(s.cfg.DBPath); err == nil {
		size = fi.Size()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version": Version, "go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH,
		"core":      s.coreStatus(),
		"auth_mode": s.cfg.AuthMode, "data_dir": s.cfg.DataDir, "db_path": s.cfg.DBPath, "db_bytes": size,
		"uptime": time.Since(s.started).Round(time.Second).String(), "timezone": time.Now().Location().String(),
		"counts": s.store.CountsFor(r.Context(), actorID(r.Context())), "saved": s.saved.Load(),
	})
}

// handleBackup downloads the whole database, an admin-only box operation.
func (s *Server) handleBackup(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	dir := filepath.Join(s.cfg.DataDir, "backups")
	name := fmt.Sprintf("pocket-guitar-%s.db", time.Now().Format("20060102-150405"))
	dst := filepath.Join(dir, name)
	if err := s.store.Backup(r.Context(), dst); err != nil {
		s.fail(w, err, "backup")
		return
	}
	w.Header().Set("Content-Type", "application/vnd.sqlite3")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	http.ServeFile(w, r, dst)
}

// exportDoc is the JSON export of one person's data. Tabs carry their
// files (base64), so an export moves a whole library to another box.
type exportDoc struct {
	App      string            `json:"app"`
	Version  string            `json:"version"`
	Exported string            `json:"exported_at"`
	Tabs     []exportTab       `json:"tabs"`
	Practice []store.Practice  `json:"practice"`
	Setlists []store.Setlist   `json:"setlists"`
	Rules    []store.HabitRule `json:"habit_rules"`
}

type exportTab struct {
	store.Tab
	Status    string          `json:"status"`
	NamesFrom string          `json:"names_from"`
	File      []byte          `json:"file"`
	Sections  []store.Section `json:"sections"`
}

func (s *Server) handleExportJSON(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	doc := exportDoc{App: "pocket-guitar", Version: Version, Exported: store.Now(), Tabs: []exportTab{}}
	tabs, _, err := s.store.ListTabs(ctx, uid, store.TabFilter{Sort: "added"})
	if err != nil {
		s.fail(w, err, "export")
		return
	}
	for _, t := range tabs {
		b, err := os.ReadFile(s.blobPath(uid, t.SHA256))
		if err != nil {
			continue
		}
		secs, _ := s.store.ListSections(ctx, uid, t.ID)
		doc.Tabs = append(doc.Tabs, exportTab{Tab: t, Status: t.Status, NamesFrom: t.NamesFrom, File: b, Sections: secs})
	}
	doc.Practice, _, _ = s.store.ListPractice(ctx, uid, store.PracticeFilter{Asc: true})
	doc.Setlists, _ = s.store.ListSetlists(ctx, uid)
	doc.Rules, _ = s.store.ListRules(ctx, uid)
	w.Header().Set("Content-Disposition", `attachment; filename="pocket-guitar-export.json"`)
	writeJSON(w, http.StatusOK, doc)
}

// handleExportCSV writes every practice session as a CSV row.
func (s *Server) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ps, _, err := s.store.ListPractice(ctx, actorID(ctx), store.PracticeFilter{Asc: true})
	if err != nil {
		s.fail(w, err, "export")
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="pocket-guitar-practice.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"date", "started_at", "kind", "title", "minutes", "top_speed_percent", "loops", "source", "note"})
	for _, p := range ps {
		_ = cw.Write([]string{p.Date, p.StartedAt, p.Kind, p.Title, strconv.FormatFloat(float64(p.DurationS)/60, 'f', 1, 64),
			strconv.Itoa(p.Speed), strconv.Itoa(p.Loops), p.Source, p.Note})
	}
	cw.Flush()
}

// handleImportJSON merges an export into the caller's own library. Tabs are
// matched by their bytes and practice by its identity, so importing the same
// file twice adds nothing.
func (s *Server) handleImportJSON(w http.ResponseWriter, r *http.Request) {
	var doc exportDoc
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, s.cfg.MaxBodyBytes))
	if err := dec.Decode(&doc); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if doc.App != "" && doc.App != "pocket-guitar" {
		writeErr(w, http.StatusBadRequest, "this is not a Pocket Guitar export")
		return
	}
	ctx := r.Context()
	uid := actorID(ctx)
	counts := map[string]int{}
	tabIDs := map[int64]int64{}
	secIDs := map[int64]int64{}
	for _, et := range doc.Tabs {
		t, existing, err := s.addTab(ctx, uid, newTab{name: firstNonEmpty(et.FileName, "tab.gp"), data: et.File, source: "import", origin: et.OriginURL, status: et.Status, tags: et.Tags,
			title: et.Title, artist: et.Artist, album: et.Album})
		if err != nil {
			counts["skipped"]++
			continue
		}
		tabIDs[et.ID] = t.ID
		if existing {
			continue
		}
		t.Tempo, t.Bars, t.DurationS, t.Tracks, t.Tuning = et.Tempo, et.Bars, et.DurationS, et.Tracks, et.Tuning
		if et.Analyzed {
			_ = s.store.SetAnalysis(ctx, uid, t)
		}
		t.Status, t.MasteredAt, t.Difficulty, t.Favorite, t.Notes, t.Capo = et.Status, et.MasteredAt, et.Difficulty, et.Favorite, et.Notes, et.Capo
		t.GoalSpeed, t.BestSpeed, t.Player, t.Recording, t.Tabber = et.GoalSpeed, et.BestSpeed, et.Player, et.Recording, et.Tabber
		if !store.ValidStatus(t.Status) {
			t.Status = "to_learn"
		}
		if t.GoalSpeed == 0 {
			t.GoalSpeed = 100
		}
		_ = s.store.UpdateTab(ctx, uid, t)
		for _, x := range et.Sections {
			old := x.ID
			x.ID, x.TabID = 0, t.ID
			if s.store.CreateSection(ctx, uid, &x) == nil {
				secIDs[old] = x.ID
			}
		}
		counts["tabs"]++
	}
	for _, p := range doc.Practice {
		old := p.ID
		p.ID = 0
		if p.ExternalID == "" {
			p.ExternalID = fmt.Sprintf("%s:%d", firstNonEmpty(p.Source, "app"), old)
		}
		p.Source = "import"
		if p.TabID != nil {
			if id, ok := tabIDs[*p.TabID]; ok {
				p.TabID = &id
			} else {
				p.TabID = nil
			}
		}
		if p.SectionID != nil {
			if id, ok := secIDs[*p.SectionID]; ok && p.TabID != nil {
				p.SectionID = &id
			} else {
				p.SectionID = nil
			}
		}
		if _, ok := store.ParseTime(p.StartedAt); !ok || p.DurationS < 0 {
			counts["skipped"]++
			continue
		}
		if s.practiceExists(ctx, uid, "import", p.ExternalID) {
			continue
		}
		if err := s.store.CreatePractice(ctx, uid, &p); err != nil {
			counts["skipped"]++
			continue
		}
		_ = s.store.SetHabitMark(ctx, uid, p.ID, store.Now(), "")
		counts["practice"]++
	}
	have, _ := s.store.ListSetlists(ctx, uid)
	names := map[string]bool{}
	for _, l := range have {
		names[l.Name] = true
	}
	for _, l := range doc.Setlists {
		if names[l.Name] {
			continue
		}
		ids := []int64{}
		for _, id := range l.TabIDs {
			if nid, ok := tabIDs[id]; ok {
				ids = append(ids, nid)
			}
		}
		if s.store.SaveSetlist(ctx, uid, &store.Setlist{Name: l.Name, Note: l.Note, TabIDs: ids}) == nil {
			counts["setlists"]++
		}
	}
	rules, _ := s.store.ListRules(ctx, uid)
	for _, ru := range doc.Rules {
		dup := false
		for _, h := range rules {
			if h.HabitID == ru.HabitID {
				dup = true
			}
		}
		if dup {
			continue
		}
		ru.ID = 0
		if err := s.store.CreateRule(ctx, uid, &ru); err == nil {
			counts["rules"]++
		}
	}
	writeJSON(w, http.StatusOK, counts)
}
