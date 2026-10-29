package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// ---- Pocket Habits: rules that tick a habit ----
//
// A rule says "when a day has at least N minutes of guitar, tick this habit".
// Each practice is looked at once; a day is ticked once per rule.

func (s *Server) handleListRules(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListRules(r.Context(), actorID(r.Context()))
	if err != nil {
		s.fail(w, err, "rules")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

type ruleInput struct {
	MinMinutes *float64 `json:"min_minutes"`
	HabitID    int64    `json:"habit_id"`
	HabitName  string   `json:"habit_name"`
	Enabled    *bool    `json:"enabled"`
}

func (in *ruleInput) apply(ru *store.HabitRule) error {
	if in.MinMinutes != nil {
		if *in.MinMinutes < 0 || *in.MinMinutes > 600 {
			return fmt.Errorf("0 to 600 minutes")
		}
		ru.MinMinutes = *in.MinMinutes
	}
	if in.HabitID > 0 {
		ru.HabitID = in.HabitID
	}
	if ru.HabitID <= 0 {
		return fmt.Errorf("pick a habit")
	}
	if in.HabitName != "" {
		ru.HabitName = strings.TrimSpace(in.HabitName)
	}
	if in.Enabled != nil {
		ru.Enabled = *in.Enabled
	}
	return nil
}

func (s *Server) handleCreateRule(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var in ruleInput
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	ru := store.HabitRule{Enabled: true, MinMinutes: 15}
	if err := in.apply(&ru); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.store.CreateRule(ctx, actorID(ctx), &ru); err != nil {
		s.fail(w, err, "save rule")
		return
	}
	writeJSON(w, http.StatusCreated, ru)
}

func (s *Server) handleUpdateRule(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	ru, err := s.store.GetRule(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "rule")
		return
	}
	var in ruleInput
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if err := in.apply(ru); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.store.UpdateRule(ctx, uid, ru); err != nil {
		s.fail(w, err, "save rule")
		return
	}
	writeJSON(w, http.StatusOK, ru)
}

func (s *Server) handleDeleteRule(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := s.store.DeleteRule(ctx, actorID(ctx), idParam(r, "id")); err != nil {
		s.fail(w, err, "delete rule")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleHabitsList lists the person's habits from Pocket Habits (through
// the connection in effect) for the rule picker.
func (s *Server) handleHabitsList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	conn, err := s.clients(ctx, actorID(ctx)).conn(ctx, appHabits, scopeHabitsRead)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"connected": false, "detail": err.Error(), "habits": []any{}})
		return
	}
	habits, err := conn.client.Habits(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"connected": true, "detail": err.Error(), "habits": []any{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": true, "via": conn.via, "habits": habits, "open_url": conn.public})
}

// tickPendingHabits applies the rules to the days of recent practices that
// no rule has looked at yet. A day below a rule's minutes is looked at again
// with the next practice that day.
func (s *Server) tickPendingHabits(ctx context.Context, uid int64, since string) int {
	s.ruleMu.Lock()
	defer s.ruleMu.Unlock()
	pending, err := s.store.PendingHabits(ctx, uid, since)
	if err != nil || len(pending) == 0 {
		return 0
	}
	rules, _ := s.store.ListRules(ctx, uid)
	var active []store.HabitRule
	for _, ru := range rules {
		if ru.Enabled {
			active = append(active, ru)
		}
	}
	days := map[string]bool{}
	for _, p := range pending {
		days[p.Date] = true
	}
	n := 0
	errText := map[string]string{}
	for date := range days {
		for _, ru := range active {
			if s.store.HabitMarked(ctx, uid, ru.ID, date) {
				continue
			}
			if s.store.DayMinutes(ctx, uid, date)+0.01 < ru.MinMinutes {
				continue
			}
			cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
			conn, err := s.clients(cctx, uid).conn(cctx, appHabits, scopeEntriesWrite)
			if err == nil {
				err = conn.client.MarkHabit(cctx, ru.HabitID, date)
			}
			cancel()
			if err != nil {
				if !isNotConnected(err) {
					errText[date] = err.Error()
					s.log.Warn("habit tick failed", "user", uid, "rule", ru.ID, "date", date, "err", err)
				}
				continue
			}
			_ = s.store.MarkHabitDay(ctx, uid, ru.ID, date)
			n++
		}
	}
	now := store.Now()
	for _, p := range pending {
		if e := errText[p.Date]; e != "" {
			_ = s.store.SetHabitMark(ctx, uid, p.ID, "", e) // try again next round
			continue
		}
		_ = s.store.SetHabitMark(ctx, uid, p.ID, now, "")
	}
	return n
}
