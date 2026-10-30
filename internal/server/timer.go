package server

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// ---- the shared practice timer (Pocket Time) ----
//
// With Pocket Time connected, the practice timer here IS the person's one
// timer in Pocket Time (docs/worklog.md in pocket-homelab-time): starting it
// here shows it running there, stopping it in either place stops it in both.
// The browser only talks to Guitar; Guitar calls Time as that person.
//
// Who records the time: Pocket Time does. Guitar starts the timer with
// deliver = true, and when it stops (here or there) Time writes the finished
// practice back through Guitar's own POST /practice (source "time",
// external_id "time:<entry>"). So Guitar never saves a timer session itself.
//
// No double counting: while a Guitar timer runs (app "guitar"; started here
// or in Pocket Time for a song or free practice), the song player's automatic
// log records nothing — the player stops counting and starts a new session
// after the timer stops. As a backstop the server holds automatic saves of a
// player session that began while that timer was running (an older page, a
// second device), so those minutes are not counted next to the timer's.

// timeEntry is the part of a Pocket Time entry Guitar uses.
type timeEntry struct {
	ID          int64  `json:"id"`
	Title       string `json:"title"`
	ProjectName string `json:"project_name"`
	StartedAt   string `json:"started_at"`
	EndedAt     string `json:"ended_at"`
	DurationS   int    `json:"duration_s"`
	Running     bool   `json:"running"`
	Source      string `json:"source"`
	App         string `json:"app"`
	AppRef      string `json:"app_ref"`
	AppLabel    string `json:"app_label"`
	AppURL      string `json:"app_url"`
}

// timeTimer is Pocket Time's answer to the timer calls.
type timeTimer struct {
	Error   string     `json:"error"`
	Running *timeEntry `json:"running"`
	Stopped *timeEntry `json:"stopped"`
	Now     string     `json:"now"`
}

func (e *timeEntry) name() string {
	return firstNonEmpty(e.Title, e.AppLabel, e.ProjectName, appDisplayName(e.App), "Untitled")
}

// guitar reports whether this timer is guitar practice (it counts here).
func (e *timeEntry) guitar() bool { return e != nil && e.App == "guitar" }

// appDisplayName is a Pocket app's name from its slug ("" = Pocket Time itself).
func appDisplayName(slug string) string {
	switch slug {
	case "", "time":
		return "Pocket Time"
	case "guitar":
		return "Pocket Guitar"
	}
	if a, ok := appBySlug(slug); ok {
		return a.name
	}
	return "Pocket " + strings.ToUpper(slug[:1]) + slug[1:]
}

// timerView is what the browser gets for a timer.
type timerView struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	StartedAt string `json:"started_at"`
	EndedAt   string `json:"ended_at,omitempty"`
	ElapsedS  int    `json:"elapsed_s"`
	App       string `json:"app"`
	Source    string `json:"source"`
	StartedIn string `json:"started_in"` // "here", "Pocket Time", "Pocket Projects"…
	Guitar    bool   `json:"guitar"`     // guitar practice: a song or free practice here
	TabID     *int64 `json:"tab_id"`
	URL       string `json:"url"` // a path here for guitar practice, else "" (open Pocket Time)
}

func (s *Server) viewTimer(uid int64, e *timeEntry, now time.Time) *timerView {
	v := viewTimer(e, now)
	if v != nil && v.StartedIn != "here" {
		s.timerMu.Lock()
		if s.startedHere[uid] == e.ID {
			v.StartedIn = "here"
		}
		s.timerMu.Unlock()
	}
	return v
}

func viewTimer(e *timeEntry, now time.Time) *timerView {
	if e == nil {
		return nil
	}
	v := &timerView{ID: e.ID, Name: e.name(), StartedAt: e.StartedAt, EndedAt: e.EndedAt, ElapsedS: e.DurationS, App: e.App, Source: e.Source, Guitar: e.guitar()}
	if e.Running || e.EndedAt == "" {
		if t, ok := store.ParseTime(e.StartedAt); ok {
			v.ElapsedS = max(0, int(now.Sub(t).Seconds()))
		}
	}
	switch e.Source {
	case "guitar":
		v.StartedIn = "here"
	default:
		v.StartedIn = appDisplayName(e.Source)
	}
	if v.Guitar {
		if id, ok := strings.CutPrefix(e.AppRef, "tab:"); ok {
			if n, err := strconv.ParseInt(id, 10, 64); err == nil && n > 0 {
				v.TabID = &n
				v.URL = fmt.Sprintf("/tab/%d", n)
			}
		}
		if v.URL == "" {
			v.URL = "/tools/timer"
		}
	}
	return v
}

// ---- what Guitar last saw of each person's timer (for the backstop) ----

type seenTimer struct {
	running *timeEntry // nil = none
	at      time.Time
}

// seenFresh is how long a seen timer state is trusted. The pages that save
// automatic practice ask for the timer every 20 seconds.
const seenFresh = 90 * time.Second

func (s *Server) sawTimer(uid int64, running *timeEntry) {
	s.timerMu.Lock()
	s.timers[uid] = seenTimer{running: running, at: time.Now()}
	s.timerMu.Unlock()
}

func (s *Server) forgetTimer(uid int64) {
	s.timerMu.Lock()
	delete(s.timers, uid)
	s.timerMu.Unlock()
}

// runningGuitarTimer is the person's running Guitar timer as last seen (recently), if any.
func (s *Server) runningGuitarTimer(uid int64) *timeEntry {
	s.timerMu.Lock()
	defer s.timerMu.Unlock()
	t, ok := s.timers[uid]
	if !ok || time.Since(t.at) > seenFresh || !t.running.guitar() {
		return nil
	}
	return t.running
}

// holdAutoPractice reports whether an automatic player save is held because
// a Guitar timer was already running when that player session began.
func (s *Server) holdAutoPractice(uid int64, startedAt string) bool {
	run := s.runningGuitarTimer(uid)
	if run == nil {
		return false
	}
	ts, ok1 := store.ParseTime(run.StartedAt)
	ps, ok2 := store.ParseTime(startedAt)
	return ok1 && ok2 && !ps.Before(ts)
}

// ---- the proxy ----

// timeConn connects to the person's Pocket Time, or says plainly why not.
func (s *Server) timeConn(ctx context.Context, uid int64, scopes ...string) (*siblingConn, error) {
	return s.clients(ctx, uid).conn(ctx, appTime, scopes...)
}

func (s *Server) timeOpenURL(ctx context.Context, sib *siblingConn) string {
	if sib != nil && sib.public != "" {
		return sib.public
	}
	return s.resolveSibling(ctx, "time")
}

func (s *Server) handleGetTimer(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	sib, err := s.timeConn(ctx, uid, scopeTimeRead)
	if isNotConnected(err) {
		s.forgetTimer(uid)
		writeJSON(w, http.StatusOK, map[string]any{"connected": false, "detail": err.Error()})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"connected": false, "detail": err.Error(), "error": true})
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var tr timeTimer
	if _, err := sib.client.Call(cctx, http.MethodGet, "/api/v1/timer", nil, nil, &tr); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"connected": false, "detail": "Pocket Time did not answer: " + err.Error(), "error": true})
		return
	}
	s.sawTimer(uid, tr.Running)
	writeJSON(w, http.StatusOK, map[string]any{"connected": true, "via": sib.via, "running": s.viewTimer(uid, tr.Running, time.Now()), "time_url": s.timeOpenURL(ctx, sib)})
}

// handleStartTimer starts the shared timer for a song (tab_id) or for free
// practice (title). switch = stop whatever runs and start this.
func (s *Server) handleStartTimer(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	var in struct {
		TabID  int64  `json:"tab_id"`
		Title  string `json:"title"`
		Switch bool   `json:"switch"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	// "app" matters only on a direct connection (with a Core link Time knows
	// the caller); without it Time would keep the timer as its own.
	body := map[string]any{"app": "guitar", "deliver": true, "switch": in.Switch}
	if in.TabID > 0 {
		t, err := s.store.GetTab(ctx, uid, in.TabID)
		if err != nil {
			s.fail(w, err, "tab")
			return
		}
		body["app_ref"], body["app_label"], body["app_url"] = fmt.Sprintf("tab:%d", t.ID), t.Name(), fmt.Sprintf("/tab/%d", t.ID)
	} else {
		body["app_ref"], body["app_label"], body["app_url"] = "", firstNonEmpty(trimTo(strings.TrimSpace(in.Title), 120), "Free practice"), "/tools/timer"
	}
	s.timerCall(w, r, "/api/v1/timer/start", body)
}

// handleStopTimer stops the shared timer; only_if = the one the page shows,
// so a timer started elsewhere meanwhile is never stopped by mistake.
func (s *Server) handleStopTimer(w http.ResponseWriter, r *http.Request) {
	var in struct {
		OnlyIf int64  `json:"only_if"`
		Note   string `json:"note"`
	}
	_ = decode(r, &in)
	body := map[string]any{}
	if in.OnlyIf > 0 {
		body["only_if"] = in.OnlyIf
	}
	if n := strings.TrimSpace(in.Note); n != "" {
		body["note"] = trimTo(n, 2000)
	}
	s.timerCall(w, r, "/api/v1/timer/stop", body)
}

// timerCall sends a start or stop to Pocket Time and answers in Guitar's shape;
// a 409 (another timer runs) is passed on with what is running.
func (s *Server) timerCall(w http.ResponseWriter, r *http.Request, path string, body map[string]any) {
	ctx := r.Context()
	uid := actorID(ctx)
	sib, err := s.timeConn(ctx, uid, scopeTimeWrite)
	if err != nil {
		code := http.StatusBadGateway
		if isNotConnected(err) {
			code = http.StatusBadRequest
		}
		writeJSON(w, code, map[string]any{"error": err.Error(), "not_connected": isNotConnected(err)})
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var tr timeTimer
	code, err := sib.client.Call(cctx, http.MethodPost, path, nil, body, &tr)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Pocket Time: "+err.Error())
		return
	}
	now := time.Now()
	s.sawTimer(uid, tr.Running)
	if code == http.StatusConflict {
		msg := "another timer is running"
		if tr.Running != nil {
			msg = "your timer is running: " + tr.Running.name()
		}
		writeJSON(w, http.StatusConflict, map[string]any{"error": msg, "running": s.viewTimer(uid, tr.Running, now)})
		return
	}
	if path == "/api/v1/timer/start" && tr.Running != nil {
		s.timerMu.Lock()
		s.startedHere[uid] = tr.Running.ID
		s.timerMu.Unlock()
	}
	writeJSON(w, http.StatusOK, map[string]any{"running": s.viewTimer(uid, tr.Running, now), "stopped": s.viewTimer(uid, tr.Stopped, now)})
}
