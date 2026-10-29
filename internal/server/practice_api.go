package server

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// ---- the practice log ----

type practiceInput struct {
	TabID      *int64 `json:"tab_id"`
	SectionID  *int64 `json:"section_id"`
	Title      string `json:"title"`
	Kind       string `json:"kind"`
	StartedAt  string `json:"started_at"`
	DurationS  int    `json:"duration_s"`
	Speed      int    `json:"speed"`
	Loops      int    `json:"loops"`
	Note       string `json:"note"`
	ExternalID string `json:"external_id"`
}

// check validates the input and fills the title from the tab.
func (s *Server) checkPractice(ctx context.Context, uid int64, in *practiceInput, p *store.Practice) string {
	if _, ok := store.ParseTime(in.StartedAt); !ok {
		return "when did you practise? (started_at)"
	}
	if in.DurationS < 0 || in.DurationS > 24*3600 {
		return "a practice is 0 to 24 hours"
	}
	if in.Speed < 0 || in.Speed > 300 || in.Loops < 0 || in.Loops > 100000 {
		return "speed is 0 to 300 percent"
	}
	if len(in.Note) > 4000 {
		return "the note is too long"
	}
	if in.TabID != nil && *in.TabID <= 0 {
		in.TabID = nil
	}
	if in.SectionID != nil && *in.SectionID <= 0 {
		in.SectionID = nil
	}
	p.TabID, p.SectionID = in.TabID, in.SectionID
	p.Title, p.Kind, p.StartedAt, p.DurationS, p.Speed, p.Loops, p.Note = trimTo(in.Title, 200), in.Kind, in.StartedAt, in.DurationS, in.Speed, in.Loops, in.Note
	p.ExternalID = trimTo(in.ExternalID, 120)
	if p.TabID != nil {
		t, err := s.store.GetTab(ctx, uid, *p.TabID)
		if err != nil {
			return "no such song in your library"
		}
		p.Title, p.Kind = t.Name(), "tab"
		if p.SectionID != nil {
			x, err := s.store.GetSection(ctx, uid, *p.SectionID)
			if err != nil || x.TabID != t.ID {
				return "no such section in this song"
			}
		}
	} else {
		p.SectionID = nil
		p.Kind = "free"
		if p.Title == "" {
			p.Title = "Free practice"
		}
	}
	return ""
}

func (s *Server) handleListPractice(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.PracticeFilter{From: q.Get("from"), To: q.Get("to"), Limit: queryInt(r, "limit"), Offset: queryInt(r, "offset")}
	if !validDate(f.From) || !validDate(f.To) {
		writeErr(w, http.StatusBadRequest, "dates are YYYY-MM-DD")
		return
	}
	if id, err := strconv.ParseInt(q.Get("tab_id"), 10, 64); err == nil {
		f.TabID = id
	}
	if f.Limit <= 0 || f.Limit > 1000 {
		f.Limit = 100
	}
	list, total, err := s.store.ListPractice(r.Context(), actorID(r.Context()), f)
	if err != nil {
		s.fail(w, err, "practice")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": list, "total": total})
}

// handleCreatePractice logs practice. The player sends the same external_id
// every minute while a song is open: one session that grows.
func (s *Server) handleCreatePractice(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	var in practiceInput
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	p := store.Practice{Source: "app"}
	if app := linkApp(ctx); app != "" {
		p.Source = app
	} else if in.ExternalID == "" {
		p.Source = "manual"
	}
	if m := s.checkPractice(ctx, uid, &in, &p); m != "" {
		writeErr(w, http.StatusBadRequest, m)
		return
	}
	fresh := true
	if p.ExternalID != "" {
		fresh = !s.practiceExists(ctx, uid, p.Source, p.ExternalID)
	}
	if err := s.store.CreatePractice(ctx, uid, &p); err != nil {
		s.fail(w, err, "save practice")
		return
	}
	out, err := s.store.GetPractice(ctx, uid, p.ID)
	if err != nil {
		s.fail(w, err, "practice")
		return
	}
	s.saved.Add(1)
	if fresh {
		s.publish(ctx, uid, "guitar.practice_logged", "practice:"+strconv.FormatInt(out.ID, 10), map[string]any{
			"practice_id": out.ID, "tab_id": out.TabID, "title": out.Title, "date": out.Date, "minutes": out.DurationS / 60})
	}
	go s.afterPractice(uid)
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) practiceExists(ctx context.Context, uid int64, source, ext string) bool {
	var n int
	_ = s.store.DB.QueryRowContext(ctx, `SELECT COUNT(1) FROM practice WHERE user_id = ? AND source = ? AND external_id = ?`, uid, source, ext).Scan(&n)
	return n > 0
}

// afterPractice ticks habits soon after practice is saved.
func (s *Server) afterPractice(uid int64) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	s.tickPendingHabits(ctx, uid, store.AddDays(store.Today(), -7))
}

func (s *Server) handleGetPractice(w http.ResponseWriter, r *http.Request) {
	p, err := s.store.GetPractice(r.Context(), actorID(r.Context()), idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "practice")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleUpdatePractice(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	p, err := s.store.GetPractice(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "practice")
		return
	}
	if app := linkApp(ctx); app != "" && p.Source != app {
		writeErr(w, http.StatusForbidden, "this practice was not logged by "+app)
		return
	}
	in := practiceInput{TabID: p.TabID, SectionID: p.SectionID, Title: p.Title, Kind: p.Kind, StartedAt: p.StartedAt, DurationS: p.DurationS,
		Speed: p.Speed, Loops: p.Loops, Note: p.Note, ExternalID: p.ExternalID}
	keys, err := decodeKeys(r, &in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if keys["tab_id"] && in.TabID == nil {
		in.SectionID = nil
	}
	in.ExternalID = p.ExternalID
	if m := s.checkPractice(ctx, uid, &in, p); m != "" {
		writeErr(w, http.StatusBadRequest, m)
		return
	}
	if err := s.store.UpdatePractice(ctx, uid, p); err != nil {
		s.fail(w, err, "save practice")
		return
	}
	out, err := s.store.GetPractice(ctx, uid, p.ID)
	if err != nil {
		s.fail(w, err, "practice")
		return
	}
	go s.afterPractice(uid)
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDeletePractice(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	if app := linkApp(ctx); app != "" {
		if p, err := s.store.GetPractice(ctx, uid, idParam(r, "id")); err == nil && p.Source != app {
			writeErr(w, http.StatusForbidden, "this practice was not logged by "+app)
			return
		}
	}
	if err := s.store.DeletePractice(ctx, uid, idParam(r, "id")); err != nil {
		s.fail(w, err, "delete practice")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- streaks, the dashboard, statistics ----

type dayPoint struct {
	Date    string `json:"date"`
	Seconds int    `json:"seconds"`
}

func (s *Server) days(ctx context.Context, uid int64, from, to string) ([]dayPoint, int) {
	m, _ := s.store.DaySeconds(ctx, uid, from, to)
	out := []dayPoint{}
	total := 0
	for d := from; d <= to; d = store.AddDays(d, 1) {
		out = append(out, dayPoint{d, m[d]})
		total += m[d]
		if len(out) > 3700 {
			break
		}
	}
	return out, total
}

// streaks returns the current run of days with practice (today counts when
// done; yesterday's run is still alive today) and the longest ever.
func (s *Server) streaks(ctx context.Context, uid int64) (cur, longest int) {
	dates, _ := s.store.PracticeDates(ctx, uid)
	if len(dates) == 0 {
		return 0, 0
	}
	run := 0
	prev := ""
	for _, d := range dates {
		if prev != "" && store.AddDays(prev, 1) == d {
			run++
		} else {
			run = 1
		}
		longest = max(longest, run)
		prev = d
	}
	today := store.Today()
	if prev == today || prev == store.AddDays(today, -1) {
		cur = run
	}
	return cur, longest
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	st, _ := s.store.GetSettings(ctx, uid)
	today := store.Today()
	week, weekS := s.days(ctx, uid, store.AddDays(today, -6), today)
	cur, longest := s.streaks(ctx, uid)
	facets, _ := s.store.Facets(ctx, uid)
	status, _ := facets["status"].(map[string]int)
	counts := map[string]int{"tabs": 0, "favorites": 0}
	if n, ok := facets["total"].(int); ok {
		counts["tabs"] = n
	}
	if n, ok := facets["favorites"].(int); ok {
		counts["favorites"] = n
	}
	for k, v := range status {
		counts[k] = v
	}
	recent, _, _ := s.store.ListTabs(ctx, uid, store.TabFilter{Sort: "recent", Limit: 30})
	var played, learning, added []store.Tab
	for _, t := range recent {
		if t.LastPlayedAt != "" && len(played) < 6 {
			played = append(played, t)
		}
		if (t.Status == "learning" || t.Status == "polishing") && len(learning) < 6 {
			learning = append(learning, t)
		}
	}
	news, _, _ := s.store.ListTabs(ctx, uid, store.TabFilter{Sort: "added", Limit: 30})
	for _, t := range news {
		if t.PlayCount == 0 && len(added) < 6 {
			added = append(added, t)
		}
	}
	nz := func(l []store.Tab) []store.Tab {
		if l == nil {
			return []store.Tab{}
		}
		return l
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"today_s": week[len(week)-1].Seconds, "goal_min": st.DailyGoalMin, "week_s": weekS, "streak": cur, "longest_streak": longest,
		"week": week, "counts": counts, "recent": nz(played), "learning": nz(learning), "added": nz(added),
	})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	from, to := dateRange(r, 30)
	days, total := s.days(ctx, uid, from, to)
	today := store.Today()
	year, _ := s.days(ctx, uid, store.AddDays(today, -364), today)
	cur, longest := s.streaks(ctx, uid)
	byTab, _ := s.store.TimeByTab(ctx, uid, from, to, 25)
	practised := 0
	for _, d := range days {
		if d.Seconds > 0 {
			practised++
		}
	}
	list, _, _ := s.store.ListPractice(ctx, uid, store.PracticeFilter{From: from, To: to})
	weekday, hour := make([]int, 7), make([]int, 24)
	for _, p := range list {
		if t, ok := store.ParseTime(p.StartedAt); ok {
			t = t.In(time.Local)
			weekday[(int(t.Weekday())+6)%7] += p.DurationS
			hour[t.Hour()] += p.DurationS
		}
	}
	mastered := []map[string]any{}
	tabs, _, _ := s.store.ListTabs(ctx, uid, store.TabFilter{Status: "mastered", Sort: "title"})
	for _, t := range tabs {
		mastered = append(mastered, map[string]any{"tab_id": t.ID, "title": t.Title, "artist": t.Artist, "at": t.MasteredAt})
	}
	avg := 0
	if n := len(days); n > 0 {
		avg = total / n
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"from": from, "to": to, "total_s": total, "sessions": len(list), "days_practised": practised, "avg_day_s": avg,
		"streak": cur, "longest_streak": longest, "days": days, "year": year, "by_tab": byTab,
		"by_weekday": weekday, "by_hour": hour, "mastered": mastered,
	})
}

// handleDay is one day's practice (for Pocket Day).
func (s *Server) handleDay(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	date := chi.URLParam(r, "date")
	if !validDate(date) || date == "" {
		writeErr(w, http.StatusBadRequest, "dates are YYYY-MM-DD")
		return
	}
	list, _, err := s.store.ListPractice(ctx, uid, store.PracticeFilter{From: date, To: date, Asc: true})
	if err != nil {
		s.fail(w, err, "practice")
		return
	}
	total := 0
	type item struct {
		Title     string `json:"title"`
		TabID     *int64 `json:"tab_id"`
		Minutes   int    `json:"minutes"`
		Speed     int    `json:"speed"`
		StartedAt string `json:"started_at"`
	}
	items := []item{}
	for _, p := range list {
		total += p.DurationS
		items = append(items, item{p.Title, p.TabID, (p.DurationS + 30) / 60, p.Speed, p.StartedAt})
	}
	var mastered []string
	tabs, _, _ := s.store.ListTabs(ctx, uid, store.TabFilter{Status: "mastered"})
	for _, t := range tabs {
		if len(t.MasteredAt) >= 10 {
			if mt, ok := store.ParseTime(t.MasteredAt); ok && mt.In(time.Local).Format("2006-01-02") == date {
				mastered = append(mastered, t.Name())
			}
		}
	}
	summary := ""
	if total > 0 {
		summary = strconv.Itoa((total+30)/60) + " min of guitar"
		if len(items) == 1 {
			summary += ": " + items[0].Title
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"date": date, "seconds": total, "minutes": (total + 30) / 60, "sessions": items, "mastered": mastered, "summary": summary})
}

// handleOverlay is practice per day for a calendar.
func (s *Server) handleOverlay(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	from, to := dateRange(r, 42)
	days, _ := s.days(ctx, uid, from, to)
	items := []map[string]any{}
	for _, d := range days {
		if d.Seconds > 0 {
			items = append(items, map[string]any{"date": d.Date, "title": strconv.Itoa((d.Seconds+30)/60) + " min guitar", "minutes": (d.Seconds + 30) / 60})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"from": from, "to": to, "items": items})
}
