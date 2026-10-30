package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// fakeTime is one person's Pocket Time: one timer at a time, 409 when busy.
type fakeTime struct {
	mu      sync.Mutex
	next    int64
	running map[string]any
	starts  []map[string]any
	stops   []map[string]any
}

func (f *fakeTime) handler(t *testing.T) http.Handler {
	answer := func(w http.ResponseWriter, code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			answer(w, 200, map[string]any{"status": "ok", "version": "0.1.0"})
			return
		}
		if r.Header.Get("Authorization") != "Bearer pt_test_token" {
			answer(w, 401, map[string]any{"error": "no"})
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		switch r.Method + " " + r.URL.Path {
		case "GET /api/v1/auth/me":
			answer(w, 200, map[string]any{"email": "alice@example.com"})
		case "GET /api/v1/timer":
			answer(w, 200, map[string]any{"running": f.running, "now": time.Now().Format(time.RFC3339)})
		case "POST /api/v1/timer/start":
			f.starts = append(f.starts, in)
			var stopped map[string]any
			if f.running != nil {
				if in["switch"] != true {
					answer(w, 409, map[string]any{"error": "a timer is already running", "running": f.running})
					return
				}
				stopped = f.running
				stopped["running"], stopped["ended_at"] = false, time.Now().Format(time.RFC3339)
			}
			f.next++
			f.running = map[string]any{"id": f.next, "running": true, "source": "time", "app": in["app"], "app_ref": in["app_ref"], "app_label": in["app_label"],
				"app_url": in["app_url"], "started_at": time.Now().Add(-2 * time.Second).Format(time.RFC3339), "deliver": in["deliver"]}
			answer(w, 200, map[string]any{"running": f.running, "stopped": stopped})
		case "POST /api/v1/timer/stop":
			f.stops = append(f.stops, in)
			if f.running == nil {
				answer(w, 200, map[string]any{"running": nil, "stopped": nil})
				return
			}
			if id, ok := in["only_if"].(float64); ok && int64(id) != f.running["id"].(int64) {
				answer(w, 409, map[string]any{"error": "a different timer is running now", "running": f.running})
				return
			}
			stopped := f.running
			stopped["running"], stopped["ended_at"] = false, time.Now().Format(time.RFC3339)
			f.running = nil
			answer(w, 200, map[string]any{"running": nil, "stopped": stopped})
		default:
			t.Errorf("fake time: unexpected %s %s", r.Method, r.URL.Path)
			answer(w, 404, map[string]any{"error": "not found"})
		}
	})
}

func TestSharedTimer(t *testing.T) {
	a := newApp(t, nil)
	ft := &fakeTime{}
	ts := httptest.NewServer(ft.handler(t))
	defer ts.Close()
	_, res := a.upload(a.alice, map[string]string{"a.tex": tex("Wonderwall", "Oasis")})
	tabID := int64(num(firstAdded(t, res), "id"))

	// without a connection nothing changes: no timer, starting says why
	if m := a.ok(a.alice, "GET", "/api/v1/timer", nil); m["connected"] != false || m["detail"] == "" {
		t.Fatalf("unconnected timer: %v", m)
	}
	a.expect(400, a.alice, "POST", "/api/v1/timer/start", map[string]any{"tab_id": tabID})

	a.ok(a.alice, "PUT", "/api/v1/settings", map[string]any{"time_mode": "direct", "time_url": ts.URL, "time_token": "pt_test_token"})
	if st := a.ok(a.alice, "GET", "/api/v1/settings", nil); st["time_via"] != "direct" || st["time_token"] == "pt_test_token" {
		t.Fatalf("time settings: via %v token %v", st["time_via"], st["time_token"])
	}
	if m := a.ok(a.alice, "POST", "/api/v1/integrations/test", map[string]any{"which": "time"}); m["ok"] != true {
		t.Fatalf("test connection: %v", m)
	}
	if m := a.ok(a.alice, "GET", "/api/v1/timer", nil); m["connected"] != true || m["running"] != nil {
		t.Fatalf("connected timer: %v", m)
	}
	// per person: Bob has no connection and cannot start one for Alice's song
	if m := a.ok(a.bob, "GET", "/api/v1/timer", nil); m["connected"] != false {
		t.Fatalf("bob sees alice's timer: %v", m)
	}
	a.expect(404, a.bob, "POST", "/api/v1/timer/start", map[string]any{"tab_id": tabID})

	// a passive player session that started before the timer
	before := time.Now().Add(-5 * time.Minute).Format(time.RFC3339)
	a.ok(a.alice, "POST", "/api/v1/practice", map[string]any{"tab_id": tabID, "started_at": before, "duration_s": 120, "external_id": "visit-1"})

	// start for the song: Time gets the song, and is told to deliver
	m := a.ok(a.alice, "POST", "/api/v1/timer/start", map[string]any{"tab_id": tabID})
	run := m["running"].(map[string]any)
	if run["guitar"] != true || num(run, "tab_id") != float64(tabID) || run["started_in"] != "here" || run["url"] != fmt.Sprintf("/tab/%d", tabID) || run["name"] != "Oasis – Wonderwall" {
		t.Fatalf("started: %v", run)
	}
	first := int64(num(run, "id"))
	if s := ft.starts[0]; s["app_ref"] != fmt.Sprintf("tab:%d", tabID) || s["app_url"] != fmt.Sprintf("/tab/%d", tabID) || s["deliver"] != true || s["switch"] != false || s["app"] != "guitar" {
		t.Fatalf("start body: %v", s)
	}

	// no double counting: the player's automatic log is held while the timer runs…
	if p := a.ok(a.alice, "POST", "/api/v1/practice", map[string]any{"tab_id": tabID, "started_at": time.Now().Format(time.RFC3339), "duration_s": 90, "external_id": "visit-2"}); p["held"] != true {
		t.Fatalf("automatic practice during the timer was saved: %v", p)
	}
	// …but a session from before the timer still saves, and so does practice logged by hand
	if p := a.ok(a.alice, "POST", "/api/v1/practice", map[string]any{"tab_id": tabID, "started_at": before, "duration_s": 150, "external_id": "visit-1"}); p["held"] == true {
		t.Fatal("the session from before the timer was held")
	}
	a.ok(a.alice, "POST", "/api/v1/practice", map[string]any{"title": "Lesson", "started_at": before, "duration_s": 600})

	// one timer at a time: another start answers 409 with what runs and where
	m = a.expect(409, a.alice, "POST", "/api/v1/timer/start", map[string]any{"title": "Scales"})
	if r := m["running"].(map[string]any); int64(num(r, "id")) != first || r["name"] != "Oasis – Wonderwall" {
		t.Fatalf("409: %v", m)
	}
	m = a.ok(a.alice, "POST", "/api/v1/timer/start", map[string]any{"title": "Scales", "switch": true})
	if m["stopped"] == nil || int64(num(m["stopped"].(map[string]any), "id")) != first || m["running"].(map[string]any)["name"] != "Scales" || m["running"].(map[string]any)["url"] != "/tools/timer" {
		t.Fatalf("switch: %v", m)
	}
	second := int64(num(m["running"].(map[string]any), "id"))
	if s := ft.starts[2]; s["app_ref"] != "" || s["app_label"] != "Scales" || s["switch"] != true {
		t.Fatalf("free practice start body: %v", s)
	}

	// stop only the one shown
	a.expect(409, a.alice, "POST", "/api/v1/timer/stop", map[string]any{"only_if": first})
	m = a.ok(a.alice, "POST", "/api/v1/timer/stop", map[string]any{"only_if": second, "note": "C major"})
	if m["running"] != nil || int64(num(m["stopped"].(map[string]any), "id")) != second || ft.stops[1]["note"] != "C major" {
		t.Fatalf("stop: %v", m)
	}

	// Guitar never saved a timer session itself (Time writes it back): only the
	// pre-timer visit and the hand-logged lesson are here
	if l := a.ok(a.alice, "GET", "/api/v1/practice", nil); num(l, "total") != 2 {
		t.Fatalf("practice rows: %v", l["sessions"])
	}
	// after the timer the automatic log works again
	if p := a.ok(a.alice, "POST", "/api/v1/practice", map[string]any{"tab_id": tabID, "started_at": time.Now().Format(time.RFC3339), "duration_s": 60, "external_id": "visit-3"}); p["held"] == true {
		t.Fatal("automatic practice still held after the timer stopped")
	}
	// switching the connection off forgets the timer at once
	a.ok(a.alice, "POST", "/api/v1/timer/start", map[string]any{"tab_id": tabID})
	a.ok(a.alice, "PUT", "/api/v1/settings", map[string]any{"time_mode": "off"})
	if p := a.ok(a.alice, "POST", "/api/v1/practice", map[string]any{"tab_id": tabID, "started_at": time.Now().Format(time.RFC3339), "duration_s": 60, "external_id": "visit-4"}); p["held"] == true {
		t.Fatal("held with the Pocket Time connection off")
	}
	if m := a.ok(a.alice, "GET", "/api/v1/timer", nil); m["connected"] != false {
		t.Fatalf("off: %v", m)
	}
}

func TestTimerRoutesClosedToLinks(t *testing.T) {
	for _, m := range []string{"GET", "POST"} {
		for _, p := range []string{"/api/v1/timer", "/api/v1/timer/start", "/api/v1/timer/stop"} {
			r, _ := http.NewRequest(m, p, nil)
			if linkAllows([]string{"guitar:read", "guitar:write"}, r) {
				t.Fatalf("a link may call %s %s", m, p)
			}
		}
	}
}
