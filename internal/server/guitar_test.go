package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/config"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

type app struct {
	t     *testing.T
	url   string
	s     *Server
	st    *store.Store
	alice string
	bob   string
	ids   map[string]int64
}

func newApp(t *testing.T, tweak func(*config.Config)) *app {
	t.Helper()
	cfg := testConfig(t.TempDir())
	cfg.BaseURL = "http://guitar.test"
	cfg.MaxBodyBytes = 64 << 20
	if tweak != nil {
		tweak(cfg)
	}
	st := openTestStore(t, cfg)
	ctx := context.Background()
	a := &app{t: t, st: st, ids: map[string]int64{}}
	for _, u := range []*store.User{{Email: "alice@example.com", Name: "Alice", Role: "admin"}, {Email: "bob@example.com", Name: "Bob", Role: "member"}} {
		if err := st.CreateUser(ctx, u); err != nil {
			t.Fatal(err)
		}
		tok, _, _ := st.CreateAPIToken(ctx, u.ID, "t")
		a.ids[u.Name] = u.ID
		if u.Name == "Alice" {
			a.alice = tok
		} else {
			a.bob = tok
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	t.Cleanup(cancel)
	a.s = New(cfg, st, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err := a.s.Bootstrap(ctx); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(a.s.Router())
	t.Cleanup(ts.Close)
	a.url = ts.URL
	return a
}

func (a *app) do(req *http.Request, auth string) (int, []byte) {
	a.t.Helper()
	if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, raw
}

func (a *app) call(auth, method, path string, body any) (int, map[string]any, []any) {
	a.t.Helper()
	var rd io.Reader
	if body != nil {
		j, _ := json.Marshal(body)
		rd = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(method, a.url+path, rd)
	req.Header.Set("Content-Type", "application/json")
	code, raw := a.do(req, auth)
	var m map[string]any
	var l []any
	if json.Unmarshal(raw, &m) != nil {
		_ = json.Unmarshal(raw, &l)
	}
	return code, m, l
}

func (a *app) ok(auth, method, path string, body any) map[string]any {
	a.t.Helper()
	code, m, _ := a.call(auth, method, path, body)
	if code >= 300 {
		a.t.Fatalf("%s %s → %d %v", method, path, code, m)
	}
	return m
}

func (a *app) expect(want int, auth, method, path string, body any) map[string]any {
	a.t.Helper()
	code, m, _ := a.call(auth, method, path, body)
	if code != want {
		a.t.Fatalf("%s %s → %d, want %d (%v)", method, path, code, want, m)
	}
	return m
}

// upload posts files (name → content) and returns the result.
func (a *app) upload(auth string, files map[string]string) (int, map[string]any) {
	a.t.Helper()
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	for name, content := range files {
		fw, _ := mw.CreateFormFile("file", name)
		_, _ = fw.Write([]byte(content))
	}
	_ = mw.Close()
	req, _ := http.NewRequest("POST", a.url+"/api/v1/tabs", &b)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	code, raw := a.do(req, auth)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return code, m
}

func num(m map[string]any, k string) float64 { v, _ := m[k].(float64); return v }

func tex(title, artist string) string {
	return fmt.Sprintf("\\title \"%s\"\n\\artist \"%s\"\n\\tempo 90\n.\n\\track \"Guitar\"\n\\staff {tabs}\n:4 0.1 1.1 3.1 0.1 | 3.2 1.2 0.2 3.3\n", title, artist)
}

func firstAdded(t *testing.T, m map[string]any) map[string]any {
	t.Helper()
	l, _ := m["added"].([]any)
	if len(l) == 0 {
		t.Fatalf("nothing added: %v", m)
	}
	return l[0].(map[string]any)
}

func TestTabsArePerPerson(t *testing.T) {
	a := newApp(t, nil)
	code, res := a.upload(a.alice, map[string]string{"song.tex": tex("Etude", "Alice")})
	if code != 201 {
		t.Fatalf("upload = %d %v", code, res)
	}
	tab := firstAdded(t, res)
	id := int64(num(tab, "id"))
	if tab["title"] != "Etude" || tab["artist"] != "Alice" || tab["format"] != "alphatex" {
		t.Fatalf("names from the file: %v", tab)
	}
	p := fmt.Sprintf("/api/v1/tabs/%d", id)
	a.expect(404, a.bob, "GET", p, nil)
	a.expect(404, a.bob, "PUT", p, map[string]any{"title": "Mine now"})
	a.expect(404, a.bob, "DELETE", p, nil)
	a.expect(404, a.bob, "GET", p+"/file", nil)
	a.expect(404, a.bob, "PUT", p+"/analysis", map[string]any{"tempo": 1})
	a.expect(404, a.bob, "POST", p+"/sections", map[string]any{"start_bar": 1, "end_bar": 2})
	a.expect(400, a.bob, "POST", "/api/v1/practice", map[string]any{"tab_id": id, "started_at": time.Now().Format(time.RFC3339), "duration_s": 60})
	sec := a.ok(a.alice, "POST", p+"/sections", map[string]any{"name": "Intro", "start_bar": 1, "end_bar": 2})
	a.expect(404, a.bob, "PUT", fmt.Sprintf("/api/v1/sections/%d", int64(num(sec, "id"))), map[string]any{"speed": 80})
	l := a.ok(a.bob, "POST", "/api/v1/setlists", map[string]any{"name": "Sneaky", "tab_ids": []int64{id}})
	if num(l, "count") != 0 {
		t.Fatalf("bob's setlist took alice's tab: %v", l)
	}
	if l := a.ok(a.bob, "GET", "/api/v1/tabs", nil); num(l, "total") != 0 {
		t.Fatalf("bob sees %v tabs", l["total"])
	}
	// the same file for bob is his own tab
	code, res = a.upload(a.bob, map[string]string{"song.tex": tex("Etude", "Alice")})
	if code != 201 || int64(num(firstAdded(t, res), "id")) == id {
		t.Fatalf("bob's upload = %d %v", code, res)
	}
}

func TestUploadDedupNamesAndAnalysis(t *testing.T) {
	a := newApp(t, nil)
	_, res := a.upload(a.alice, map[string]string{"Some Band - Some Song (v2).gp5": "not really a tab"})
	if errs, _ := res["errors"].([]any); len(errs) != 1 {
		t.Fatalf("junk accepted: %v", res)
	}
	plain := "\\tempo 100\n.\n:4 0.1 1.1 3.1 0.1\n"
	_, res = a.upload(a.alice, map[string]string{"Some Band - Some Song (v2).tex": plain})
	tab := firstAdded(t, res)
	if tab["artist"] != "Some Band" || tab["title"] != "Some Song" {
		t.Fatalf("names from the file name: %v", tab)
	}
	_, again := a.upload(a.alice, map[string]string{"copy.tex": plain})
	if ex, _ := again["existing"].([]any); len(ex) != 1 {
		t.Fatalf("same bytes twice: %v", again)
	}
	p := fmt.Sprintf("/api/v1/tabs/%d", int64(num(tab, "id")))
	got := a.ok(a.alice, "PUT", p+"/analysis", map[string]any{"title": "Real Title", "artist": "Real Band", "tempo": 100, "bars": 1, "duration_s": 3,
		"tuning": "Standard", "tracks": []any{map[string]any{"index": 0, "name": "Guitar", "strings": 6, "tuning": "E A D G B E"}}})
	if got["title"] != "Real Title" || got["analyzed"] != true || got["tuning"] != "Standard" {
		t.Fatalf("analysis: %v", got)
	}
	a.ok(a.alice, "PUT", p, map[string]any{"title": "My Name", "status": "learning", "favorite": true, "player": map[string]any{"speed": 80}})
	got = a.ok(a.alice, "PUT", p+"/analysis", map[string]any{"title": "File Again", "tempo": 100})
	if got["title"] != "My Name" {
		t.Fatalf("a name the person typed was overwritten: %v", got["title"])
	}
	a.expect(400, a.alice, "PUT", p, map[string]any{"status": "rockstar"})
	a.expect(400, a.alice, "PUT", p, map[string]any{"player": "nope"})
	if f := a.ok(a.alice, "GET", "/api/v1/tabs?status=learning&favorite=1", nil); num(f, "total") != 1 {
		t.Fatalf("filter: %v", f)
	}
	req, _ := http.NewRequest("GET", a.url+p+"/file", nil)
	if code, body := a.do(req, a.alice); code != 200 || string(body) != plain {
		t.Fatalf("file = %d %q", code, body)
	}
}

func TestPracticeUpsertStreakAndStats(t *testing.T) {
	a := newApp(t, nil)
	_, res := a.upload(a.alice, map[string]string{"a.tex": tex("Song", "Band")})
	id := int64(num(firstAdded(t, res), "id"))
	now := time.Now().Add(-10 * time.Minute).Format(time.RFC3339)
	p1 := a.ok(a.alice, "POST", "/api/v1/practice", map[string]any{"tab_id": id, "started_at": now, "duration_s": 60, "speed": 80, "external_id": "visit-1"})
	p2 := a.ok(a.alice, "POST", "/api/v1/practice", map[string]any{"tab_id": id, "started_at": now, "duration_s": 300, "speed": 70, "loops": 4, "external_id": "visit-1"})
	if num(p1, "id") != num(p2, "id") || num(p2, "duration_s") != 300 || num(p2, "speed") != 80 || p2["title"] != "Band – Song" {
		t.Fatalf("upsert: %v → %v", p1, p2)
	}
	yesterday := time.Now().AddDate(0, 0, -1).Format("2006-01-02") + "T19:00:00"
	a.ok(a.alice, "POST", "/api/v1/practice", map[string]any{"title": "Scales", "started_at": yesterday, "duration_s": 600})
	d := a.ok(a.alice, "GET", "/api/v1/dashboard", nil)
	if num(d, "streak") != 2 || num(d, "today_s") != 300 {
		t.Fatalf("dashboard: streak %v today %v", d["streak"], d["today_s"])
	}
	tab := a.ok(a.alice, "GET", fmt.Sprintf("/api/v1/tabs/%d", id), nil)
	if num(tab, "practice_s") != 300 || num(tab, "play_count") != 1 || tab["last_played_at"] == "" {
		t.Fatalf("tab totals: %v", tab)
	}
	st := a.ok(a.alice, "GET", "/api/v1/stats?from="+time.Now().AddDate(0, 0, -6).Format("2006-01-02"), nil)
	if num(st, "total_s") != 900 || num(st, "days_practised") != 2 {
		t.Fatalf("stats: %v %v", st["total_s"], st["days_practised"])
	}
	if l := a.ok(a.bob, "GET", "/api/v1/practice", nil); num(l, "total") != 0 {
		t.Fatal("bob sees alice's practice")
	}
	a.expect(404, a.bob, "DELETE", fmt.Sprintf("/api/v1/practice/%d", int64(num(p1, "id"))), nil)
	day := a.ok(a.alice, "GET", "/api/v1/day/"+time.Now().Format("2006-01-02"), nil)
	if num(day, "minutes") != 5 {
		t.Fatalf("day: %v", day)
	}
}

func TestLinkScopes(t *testing.T) {
	get := func(p string) *http.Request { r, _ := http.NewRequest("GET", p, nil); return r }
	post := func(p string) *http.Request { r, _ := http.NewRequest("POST", p, nil); return r }
	if !linkAllows([]string{"guitar:read"}, get("/api/v1/day/2026-10-29")) || !linkAllows([]string{"guitar:read"}, get("/api/v1/tabs/3")) {
		t.Fatal("read should allow the day and a tab")
	}
	if linkAllows([]string{"guitar:read"}, get("/api/v1/tabs/3/file")) || linkAllows([]string{"guitar:read"}, post("/api/v1/practice")) {
		t.Fatal("read must not download files or write")
	}
	if linkAllows([]string{"guitar:read", "guitar:write"}, get("/api/v1/settings")) || linkAllows([]string{"guitar:read"}, get("/api/v1/export.json")) {
		t.Fatal("links never see settings or exports")
	}
	if !linkAllows([]string{"guitar:write"}, post("/api/v1/practice")) || linkAllows([]string{"guitar:write"}, get("/api/v1/practice")) {
		t.Fatal("write may log but not read")
	}
}

func TestExportImportIsIdempotent(t *testing.T) {
	a := newApp(t, nil)
	_, res := a.upload(a.alice, map[string]string{"a.tex": tex("One", "Band"), "b.tex": tex("Two", "Band")})
	id := int64(num(firstAdded(t, res), "id"))
	a.ok(a.alice, "POST", fmt.Sprintf("/api/v1/tabs/%d/sections", id), map[string]any{"name": "Solo", "start_bar": 1, "end_bar": 2})
	a.ok(a.alice, "POST", "/api/v1/practice", map[string]any{"tab_id": id, "started_at": time.Now().Add(-time.Hour).Format(time.RFC3339), "duration_s": 600})
	a.ok(a.alice, "POST", "/api/v1/setlists", map[string]any{"name": "Gig", "tab_ids": []int64{id}})
	_, doc, _ := a.call(a.alice, "GET", "/api/v1/export.json", nil)
	r1 := a.ok(a.bob, "POST", "/api/v1/import", doc)
	if num(r1, "tabs") != 2 || num(r1, "practice") != 1 || num(r1, "setlists") != 1 {
		t.Fatalf("import = %v", r1)
	}
	a.ok(a.bob, "POST", "/api/v1/import", doc)
	if l := a.ok(a.bob, "GET", "/api/v1/tabs", nil); num(l, "total") != 2 {
		t.Fatalf("second import doubled tabs: %v", l["total"])
	}
	if l := a.ok(a.bob, "GET", "/api/v1/practice", nil); num(l, "total") != 1 {
		t.Fatalf("second import doubled practice: %v", l["total"])
	}
	tabs := a.ok(a.bob, "GET", "/api/v1/tabs?q=one", nil)["tabs"].([]any)
	secs := a.ok(a.bob, "GET", fmt.Sprintf("/api/v1/tabs/%d", int64(num(tabs[0].(map[string]any), "id"))), nil)["sections"].([]any)
	if len(secs) != 1 {
		t.Fatalf("sections not imported: %v", secs)
	}
}

func TestSettingsPerPerson(t *testing.T) {
	a := newApp(t, nil)
	a.ok(a.alice, "PUT", "/api/v1/settings", map[string]any{"daily_goal_min": 45, "habits_token": "ph_secretsecret", "title": "Family Guitar", "notation": "both", "reminder_times": []string{"21:00", "07:30"}})
	bob := a.ok(a.bob, "GET", "/api/v1/settings", nil)
	if num(bob, "daily_goal_min") != 20 || bob["habits_token"] != "" || bob["title"] != "Family Guitar" || bob["notation"] != "tab" {
		t.Fatalf("bob's settings leak: %v", bob)
	}
	a.ok(a.bob, "PUT", "/api/v1/settings", map[string]any{"title": "Bob's"})
	al := a.ok(a.alice, "GET", "/api/v1/settings", nil)
	if al["title"] != "Family Guitar" || al["habits_token"] == "" || strings.Contains(al["habits_token"].(string), "secret") {
		t.Fatalf("alice settings = %v", al)
	}
	a.expect(400, a.alice, "PUT", "/api/v1/settings", map[string]any{"notation": "braille"})
	a.expect(400, a.alice, "PUT", "/api/v1/settings", map[string]any{"save_folder_id": 999})
	a.expect(400, a.alice, "PUT", "/api/v1/settings", map[string]any{"trainer_step": 0})
}

// fakeFiles is a tiny Pocket Files: one place, an in-memory folder tree.
type fakeFiles struct {
	mu    sync.Mutex
	files map[string]string // path → content
	mtime map[string]time.Time
	puts  []string
}

func (f *fakeFiles) handler(t *testing.T) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/spaces", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, []map[string]any{{"id": "home", "kind": "home", "name": "My files", "perm": "edit", "is_dir": true}})
	})
	mux.HandleFunc("/api/v1/fs/list", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		dir := strings.TrimSuffix(cleanPath(r.URL.Query().Get("path")), "/")
		seen := map[string]bool{}
		entries := []map[string]any{}
		for p, c := range f.files {
			if !strings.HasPrefix(p, dir+"/") {
				continue
			}
			rest := strings.TrimPrefix(p, dir+"/")
			if i := strings.Index(rest, "/"); i >= 0 {
				sub := dir + "/" + rest[:i]
				if !seen[sub] {
					seen[sub] = true
					entries = append(entries, map[string]any{"name": rest[:i], "path": sub, "is_dir": true})
				}
				continue
			}
			entries = append(entries, map[string]any{"name": rest, "path": p, "size": len(c), "modified": f.mtime[p]})
		}
		writeJSON(w, 200, map[string]any{"path": dir, "entries": entries, "writable": true})
	})
	mux.HandleFunc("/api/v1/fs/raw", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		c, ok := f.files[r.URL.Query().Get("path")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(c))
	})
	mux.HandleFunc("/api/v1/fs/upload", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		b, _ := io.ReadAll(r.Body)
		p := strings.TrimSuffix(r.URL.Query().Get("path"), "/") + "/" + r.URL.Query().Get("name")
		f.files[p] = string(b)
		f.mtime[p] = time.Now()
		f.puts = append(f.puts, p)
		writeJSON(w, 200, map[string]any{"name": r.URL.Query().Get("name"), "path": p, "size": len(b), "modified": f.mtime[p]})
	})
	mux.HandleFunc("/api/v1/auth/me", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{"id": 1}) })
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"status": "ok", "version": "test"})
	})
	return mux
}

func TestFolderSync(t *testing.T) {
	a := newApp(t, nil)
	t0 := time.Now().Add(-time.Hour)
	ff := &fakeFiles{files: map[string]string{
		"/Tabs/Band - First.tex":           tex("", ""),
		"/Tabs/Band - First.tex.meta.json": `{"title":"First Song","artist":"The Band","album":"LP"}`,
		"/Tabs/Old/Second.tex":             tex("Second", "Other"),
		"/Tabs/readme.txt":                 "not a tab",
		"/Elsewhere/Third.tex":             tex("Third", "X"),
	}, mtime: map[string]time.Time{}}
	for p := range ff.files {
		ff.mtime[p] = t0
	}
	fs := httptest.NewServer(ff.handler(t))
	defer fs.Close()
	a.ok(a.alice, "PUT", "/api/v1/settings", map[string]any{"files_mode": "direct", "files_url": fs.URL, "files_token": "pf_test_token"})
	a.expect(400, a.bob, "POST", "/api/v1/folders", map[string]any{"space": "home", "path": "/Tabs"}) // bob has no Files connection
	f := a.ok(a.alice, "POST", "/api/v1/folders", map[string]any{"space": "home", "path": "/Tabs"})
	fid := int64(num(f, "id"))
	a.expect(409, a.alice, "POST", "/api/v1/folders", map[string]any{"space": "home", "path": "/Tabs/"})
	time.Sleep(200 * time.Millisecond)
	res := a.ok(a.alice, "POST", fmt.Sprintf("/api/v1/folders/%d/sync", fid), nil)
	if !strings.Contains(fmt.Sprint(res), "ok:true") {
		t.Fatalf("sync = %v", res)
	}
	tabs := a.ok(a.alice, "GET", "/api/v1/tabs?sort=title", nil)
	if num(tabs, "total") != 2 {
		t.Fatalf("library after sync: %v", tabs["total"])
	}
	first := tabs["tabs"].([]any)[0].(map[string]any)
	if first["title"] != "First Song" || first["artist"] != "The Band" || first["source"] != "files" || first["source_label"] != "Pocket Files: Tabs" {
		t.Fatalf("sidecar names: %v", first)
	}
	// a changed file is read again; a removed one is marked missing
	ff.mu.Lock()
	ff.files["/Tabs/Old/Second.tex"] = tex("Second", "Other") + "| 0.1 0.1 0.1 0.1\n"
	ff.mtime["/Tabs/Old/Second.tex"] = time.Now()
	delete(ff.files, "/Tabs/Band - First.tex")
	ff.mu.Unlock()
	res = a.ok(a.alice, "POST", fmt.Sprintf("/api/v1/folders/%d/sync", fid), nil)
	r := res["result"].(map[string]any)
	if num(r, "updated") != 1 || num(r, "missing") != 1 {
		t.Fatalf("second sync = %v", r)
	}
	// new uploads go into the folder when chosen
	a.ok(a.alice, "PUT", "/api/v1/settings", map[string]any{"save_folder_id": fid})
	_, up := a.upload(a.alice, map[string]string{"New One.tex": tex("New One", "Me")})
	nt := firstAdded(t, up)
	if nt["source"] != "files" || len(ff.puts) != 1 || ff.puts[0] != "/Tabs/New One.tex" {
		t.Fatalf("upload into the folder: %v %v", nt["source"], ff.puts)
	}
	a.expect(404, a.bob, "POST", fmt.Sprintf("/api/v1/folders/%d/sync", fid), nil)
	a.expect(404, a.bob, "DELETE", fmt.Sprintf("/api/v1/folders/%d", fid), nil)
	// unlinking keeps the tabs as uploads when asked
	a.expect(204, a.alice, "DELETE", fmt.Sprintf("/api/v1/folders/%d?keep=1", fid), nil)
	if l := a.ok(a.alice, "GET", "/api/v1/tabs?source=upload", nil); num(l, "total") != 3 {
		t.Fatalf("kept tabs: %v", l["total"])
	}
	if st := a.ok(a.alice, "GET", "/api/v1/settings", nil); num(st, "save_folder_id") != 0 {
		t.Fatal("save folder not cleared")
	}
}

func TestWithinMinutes(t *testing.T) {
	if !withinMinutes("08:02", "08:00", 4) || withinMinutes("07:59", "08:00", 4) || withinMinutes("08:05", "08:00", 4) {
		t.Fatal("withinMinutes")
	}
}
