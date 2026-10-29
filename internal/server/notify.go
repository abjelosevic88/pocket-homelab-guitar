package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/notify"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// pushes runs every minute and sends, each at the person's own time:
// practice reminders (skipped when today's goal is already met), the
// evening "your streak ends tonight" nudge and the weekly report.
func (s *Server) pushes(ctx context.Context) {
	ids, err := s.store.SettingsUsers(ctx)
	if err != nil {
		return
	}
	now := time.Now()
	today := store.Today()
	hm := now.Format("15:04")
	wd := int(now.Weekday())
	if wd == 0 {
		wd = 7
	}
	for _, uid := range ids {
		st, err := s.store.GetSettings(ctx, uid)
		if err != nil || st.NotifyURL == "" {
			continue
		}
		n := notify.New(st.NotifyURL, st.NotifyFormat)
		once := func(key string) bool {
			k := fmt.Sprintf("push:%d:%s:%s", uid, today, key)
			if _, _, done := s.store.CacheGet(ctx, k); done {
				return false
			}
			_ = s.store.CachePut(ctx, k, "1")
			return true
		}
		todayMin := s.store.DayMinutes(ctx, uid, today)
		goalMet := st.DailyGoalMin > 0 && todayMin+0.01 >= float64(st.DailyGoalMin)

		// reminders at the chosen times on the chosen weekdays
		if strings.Contains(st.ReminderDays, fmt.Sprint(wd)) {
			for _, t := range st.ReminderTimes {
				if !withinMinutes(hm, t, 4) || !once("reminder:"+t) {
					continue
				}
				if st.ReminderSkipDone && (goalMet || (st.DailyGoalMin == 0 && todayMin > 0)) {
					continue
				}
				_ = n.Send(ctx, notify.Message{Title: "Time to play", Body: s.reminderText(ctx, uid, todayMin, st.DailyGoalMin), Priority: "info", Tags: []string{"guitar"}, Link: s.cfg.BaseURL + "/"})
			}
		}
		// the streak ends tonight
		if st.NotifyStreak && now.Hour() == st.StreakHour && now.Minute() < 5 && todayMin == 0 {
			if cur, _ := s.streaks(ctx, uid); cur >= 2 && once("streak") {
				_ = n.Send(ctx, notify.Message{Title: fmt.Sprintf("Keep your %d-day streak", cur), Body: "No guitar yet today. Five minutes on a riff keeps it going.", Priority: "warning", Tags: []string{"fire"}, Link: s.cfg.BaseURL + "/"})
			}
		}
		// the weekly report
		if st.NotifyWeekly && wd == st.WeeklyDay && now.Hour() == st.WeeklyHour && now.Minute() < 5 && once("weekly") {
			if msg := s.weeklyReport(ctx, uid, st); msg != "" {
				_ = n.Send(ctx, notify.Message{Title: "Your week in Pocket Guitar", Body: msg, Priority: "info", Tags: []string{"bar_chart"}, Link: s.cfg.BaseURL + "/practice"})
			}
		}
	}
}

// withinMinutes reports whether now (HH:MM) is at or up to n minutes after t (HH:MM).
func withinMinutes(now, t string, n int) bool {
	a, err1 := time.Parse("15:04", now)
	b, err2 := time.Parse("15:04", t)
	if err1 != nil || err2 != nil {
		return false
	}
	d := a.Sub(b)
	return d >= 0 && d <= time.Duration(n)*time.Minute
}

func (s *Server) reminderText(ctx context.Context, uid int64, todayMin float64, goal int) string {
	cur, _ := s.streaks(ctx, uid)
	if tabs, _, err := s.store.ListTabs(ctx, uid, store.TabFilter{Status: "learning", Sort: "recent", Limit: 1}); err == nil && len(tabs) > 0 {
		return fmt.Sprintf("Pick up where you left off: %s.", tabs[0].Name())
	}
	switch {
	case todayMin > 0 && goal > 0:
		return fmt.Sprintf("%.0f of %d minutes so far today. One more run through?", todayMin, goal)
	case cur >= 2:
		return fmt.Sprintf("Day %d of your streak is waiting. Even five minutes count.", cur+1)
	}
	return "A few minutes with the guitar. Your fingers will thank you."
}

// weeklyReport is the plain-text summary of the last seven days vs the seven before.
func (s *Server) weeklyReport(ctx context.Context, uid int64, st store.Settings) string {
	to := store.Today()
	from := store.AddDays(to, -6)
	ps, _, err := s.store.ListPractice(ctx, uid, store.PracticeFilter{From: from, To: to})
	if err != nil || len(ps) == 0 {
		return ""
	}
	prev, _, _ := s.store.ListPractice(ctx, uid, store.PracticeFilter{From: store.AddDays(from, -7), To: store.AddDays(from, -1)})
	mins, days := 0.0, map[string]float64{}
	songs := map[string]float64{}
	for _, p := range ps {
		m := float64(p.DurationS) / 60
		mins += m
		days[p.Date] += m
		songs[p.Title] += m
	}
	prevMin := 0.0
	for _, p := range prev {
		prevMin += float64(p.DurationS) / 60
	}
	lines := []string{fmt.Sprintf("%s of guitar on %d of 7 days", fmtMinutes(mins), len(days))}
	if prevMin > 0 {
		lines[0] += fmt.Sprintf(" (%+.0f%% vs the week before)", (mins-prevMin)/prevMin*100)
	}
	top, topM := "", 0.0
	for t, m := range songs {
		if m > topM || (m == topM && t < top) {
			top, topM = t, m
		}
	}
	if top != "" {
		lines = append(lines, fmt.Sprintf("Most played: %s (%s)", top, fmtMinutes(topM)))
	}
	if cur, _ := s.streaks(ctx, uid); cur >= 2 {
		lines = append(lines, fmt.Sprintf("Streak: %d days", cur))
	}
	if st.WeeklyGoalDays > 0 {
		met := 0
		for _, m := range days {
			if st.DailyGoalMin == 0 || m+0.01 >= float64(st.DailyGoalMin) {
				met++
			}
		}
		lines = append(lines, fmt.Sprintf("Goal days: %d of %d", met, st.WeeklyGoalDays))
	}
	return strings.Join(lines, "\n")
}

// handleWeeklyNow sends the weekly report right away (Settings → Notifications).
func (s *Server) handleWeeklyNow(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	st, _ := s.store.GetSettings(ctx, uid)
	msg := s.weeklyReport(ctx, uid, st)
	if msg == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "no practice in the last seven days yet"})
		return
	}
	if st.NotifyURL == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sent": false, "report": msg})
		return
	}
	n := notify.New(st.NotifyURL, st.NotifyFormat)
	if err := n.Send(ctx, notify.Message{Title: "Your week in Pocket Guitar", Body: msg, Priority: "info", Tags: []string{"bar_chart"}, Link: s.cfg.BaseURL + "/practice"}); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error(), "report": msg})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sent": true, "report": msg})
}
