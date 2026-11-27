package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/config"
)

// capApp starts Guitar behind a fake Core whose pcx_<who>_<word> tokens are
// links acting for alice@ or bob@: search, day, widget and capture carry that
// one pocket:* scope (Pocket Hub), read and write the app's own scopes,
// export and import Pocket Move's. The second value is the manifest Guitar
// registered with last.
func capApp(t *testing.T) (*app, func() map[string]any) {
	t.Helper()
	var mu sync.Mutex
	var registered map[string]any
	coreSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/apps/register" {
			var m map[string]any
			_ = json.NewDecoder(r.Body).Decode(&m)
			mu.Lock()
			registered = m
			mu.Unlock()
		}
		if r.URL.Path != "/api/v1/auth/introspect" {
			io.WriteString(w, `{}`)
			return
		}
		var in struct {
			Token string `json:"token"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		parts := strings.SplitN(strings.TrimPrefix(in.Token, "pcx_"), "_", 2)
		scope := ""
		if len(parts) == 2 {
			scope = map[string]string{"search": core.ScopeSearch, "day": core.ScopeDay, "widget": core.ScopeWidget, "capture": core.ScopeCapture,
				"read": "guitar:read", "write": "guitar:write", "export": core.ScopeMoveExport, "import": core.ScopeMoveImport}[parts[1]]
		}
		if scope == "" || (parts[0] != "alice" && parts[0] != "bob") {
			io.WriteString(w, `{"active":false}`)
			return
		}
		email := parts[0] + "@example.com"
		fmt.Fprintf(w, `{"active":true,"kind":"delegated","scope":%q,"audience":"guitar","user":{"id":1,"sub":%q,"email":%q,"name":%q,"role":"member"},"app":{"id":8,"slug":"hub","name":"Pocket Hub"}}`, scope, email, email, parts[0])
	}))
	t.Cleanup(coreSrv.Close)
	a := newApp(t, func(c *config.Config) { c.CoreURL, c.CoreRegistrationKey = coreSrv.URL, "pcr_test" })
	return a, func() map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return registered
	}
}

// addTab uploads one song and returns its id.
func (a *app) addTab(auth, file, title, artist string) int64 {
	a.t.Helper()
	code, res := a.upload(auth, map[string]string{file: tex(title, artist)})
	if code != 201 {
		a.t.Fatalf("upload %s = %d %v", file, code, res)
	}
	return int64(num(firstAdded(a.t, res), "id"))
}

// practise logs a sitting by hand: a song (tab > 0) or free practice by its title.
func (a *app) practise(auth string, tab int64, title, startedAt string, seconds int) int64 {
	a.t.Helper()
	body := map[string]any{"started_at": startedAt, "duration_s": seconds, "title": title}
	if tab > 0 {
		body["tab_id"] = tab
	}
	return int64(num(a.ok(auth, "POST", "/api/v1/practice", body), "id"))
}

// into reads a route's answer into v and returns the status.
func (a *app) into(auth, method, path string, v any) int {
	a.t.Helper()
	code, raw := a.raw(auth, method, path, nil)
	if v != nil {
		_ = json.Unmarshal(raw, v)
	}
	return code
}

func (a *app) search(auth, q string) []core.SearchItem {
	a.t.Helper()
	var res core.SearchResults
	if code := a.into(auth, "GET", "/api/v1/pocket/search?"+q, &res); code != 200 || res.Items == nil {
		a.t.Fatalf("search %s = %d %+v", q, code, res)
	}
	return res.Items
}

func searchTitles(items []core.SearchItem) string {
	var t []string
	for _, it := range items {
		t = append(t, it.Title)
	}
	return strings.Join(t, " | ")
}

// Pocket Search finds a person's tabs by song, artist, album, tag and file
// name, the title first, and says what each is.
func TestPocketSearch(t *testing.T) {
	a := newApp(t, nil)
	tabPath := func(id int64) string { return fmt.Sprintf("/api/v1/tabs/%d", id) }
	bird := a.addTab(a.alice, "blackbird.tex", "Blackbird", "The Beatles")
	a.ok(a.alice, "PUT", tabPath(bird), map[string]any{"album": "The White Album", "status": "learning", "tags": "fingerstyle, acoustic", "notes": "the bridge is the hard part, xyzzy"})
	a.ok(a.alice, "PUT", tabPath(bird)+"/analysis", map[string]any{"tempo": 94, "bars": 30, "duration_s": 138, "tuning": "Drop D"})
	yest := a.addTab(a.alice, "yesterday.tex", "Yesterday", "The Beatles")
	a.ok(a.alice, "PUT", tabPath(yest), map[string]any{"album": "Help!", "status": "mastered"})
	a.ok(a.alice, "PUT", tabPath(yest)+"/analysis", map[string]any{"tempo": 96, "tuning": "Standard"})
	a.addTab(a.alice, "medley.tex", "Beatles Medley", "Cover Band")
	a.addTab(a.alice, "odd_file-0042.tex", "Wish You Were Here", "Pink Floyd")
	a.addTab(a.alice, "djurdjevdan.tex", "Đurđevdan", "Bijelo Dugme")
	a.addTab(a.bob, "secret.tex", "Secret Song", "The Beatles")
	a.practise(a.alice, yest, "", "2026-10-05T19:00:00Z", 600)

	// by title: what the song is, where it stands, when it was last played
	got := a.search(a.alice, "q=blackbird")
	if len(got) != 1 {
		t.Fatalf("blackbird = %s", searchTitles(got))
	}
	if it := got[0]; it.ID != strconv.FormatInt(bird, 10) || it.Title != "Blackbird" || it.Kind != "tab" || it.URL != fmt.Sprintf("/tab/%d", bird) ||
		it.Snippet != "The Beatles · The White Album · Drop D · learning" || it.Date == "" {
		t.Errorf("Blackbird = %+v", it)
	}
	if got := a.search(a.alice, "q=yesterday"); len(got) != 1 || got[0].Snippet != "The Beatles · Help! · can play it" || got[0].Date != "2026-10-05T19:00:00Z" {
		t.Errorf("yesterday = %+v", got)
	}
	// a title that has the words comes before an artist who has them; the song played last leads its group
	if got := a.search(a.alice, "q=Beatles"); searchTitles(got) != "Beatles Medley | Yesterday | Blackbird" {
		t.Errorf("beatles = %s", searchTitles(got))
	}
	// the words may be spread over title and artist, in any order and any capitals
	if got := a.search(a.alice, "q=BEATLES+black"); searchTitles(got) != "Blackbird" || got[0].Score != 2 {
		t.Errorf("beatles black = %+v", got)
	}
	// by album, by tag and by file name: the line says where the words were found
	if got := a.search(a.alice, "q=white+album"); searchTitles(got) != "Blackbird" {
		t.Errorf("white album = %s", searchTitles(got))
	}
	if got := a.search(a.alice, "q=fingerstyle"); len(got) != 1 || got[0].Snippet != "The Beatles · The White Album · Drop D · learning · fingerstyle, acoustic" {
		t.Errorf("fingerstyle = %+v", got)
	}
	if got := a.search(a.alice, "q=0042"); len(got) != 1 || got[0].Snippet != "Pink Floyd · want to learn · odd_file-0042.tex" {
		t.Errorf("file name = %+v", got)
	}
	// letters SQLite does not fold are found whatever the capitals
	for _, q := range []string{"q=đurđevdan", "q=ĐURĐEVDAN+dugme"} {
		if got := a.search(a.alice, q); searchTitles(got) != "Đurđevdan" {
			t.Errorf("%s = %s", q, searchTitles(got))
		}
	}
	if got := a.search(a.alice, "q=ćuprija"); len(got) != 0 {
		t.Errorf("ćuprija = %s", searchTitles(got))
	}
	// song notes are not searched
	if got := a.search(a.alice, "q=xyzzy"); len(got) != 0 {
		t.Errorf("notes = %s", searchTitles(got))
	}
	// the limit, and nothing to look for: no words, or only signs (LIKE's own among them)
	if got := a.search(a.alice, "q=beatles&limit=2"); searchTitles(got) != "Beatles Medley | Yesterday" {
		t.Errorf("limit 2 = %s", searchTitles(got))
	}
	for _, q := range []string{"q=", "q=+", "q=%25", "q=_", "q=%3F%3F", "q=*", "q=%25+_"} {
		if got := a.search(a.alice, q); len(got) != 0 {
			t.Errorf("%s = %s", q, searchTitles(got))
		}
	}
	// a sign inside a word is that sign, not "any letter"
	if got := a.search(a.alice, "q=odd_file"); searchTitles(got) != "Wish You Were Here" {
		t.Errorf("odd_file = %s", searchTitles(got))
	}
	if got := a.search(a.alice, "q=odd_fil_"); len(got) != 0 {
		t.Errorf("odd_fil_ = %s", searchTitles(got))
	}
	// each person finds only their own tabs
	for _, q := range []string{"q=secret", "q=beatles", "q=song", "q=e"} {
		for _, it := range a.search(a.alice, q) {
			if it.Title == "Secret Song" {
				t.Errorf("Alice found Bob's tab with %s", q)
			}
		}
	}
	if got := a.search(a.bob, "q=beatles"); searchTitles(got) != "Secret Song" || got[0].Snippet != "The Beatles · want to learn" {
		t.Errorf("Bob = %+v", got)
	}
	// GET /tabs?q= is as it was
	if l := a.ok(a.alice, "GET", "/api/v1/tabs?q=beatles", nil); num(l, "total") != 3 {
		t.Errorf("/tabs?q=beatles = %v", l["total"])
	}
}

func (a *app) dayOf(auth, date, tz string) core.Day {
	a.t.Helper()
	path := "/api/v1/pocket/day/" + date
	if tz != "" {
		path += "?tz=" + tz
	}
	var d core.Day
	if code := a.into(auth, "GET", path, &d); code != 200 || d.Date != date || d.Items == nil {
		a.t.Fatalf("day %s = %d %+v", date, code, d)
	}
	return d
}

// Pocket Day gets one line per sitting, with the song, its artist and the
// minutes, and the songs the person can play since that day.
func TestPocketDay(t *testing.T) {
	a := newApp(t, nil)
	const day = "2026-10-05"
	bird := a.addTab(a.alice, "blackbird.tex", "Blackbird", "The Beatles")
	yest := a.addTab(a.alice, "yesterday.tex", "Yesterday", "The Beatles")
	first := a.practise(a.alice, bird, "", day+"T19:00:00Z", 25*60)
	a.practise(a.alice, 0, "Scales", day+"T20:00:00Z", 10*60)
	a.ok(a.alice, "PUT", fmt.Sprintf("/api/v1/practice/%d", first), map[string]any{"note": "the bridge at last"})
	a.practise(a.alice, yest, "", day+"T21:00:00Z", 0) // opened, not played
	a.practise(a.bob, 0, "Bob's riffs", day+"T19:00:00Z", 30*60)
	// renamed since: the day shows the song as it is called now
	a.ok(a.alice, "PUT", fmt.Sprintf("/api/v1/tabs/%d", bird), map[string]any{"title": "Blackbird (take 2)"})
	a.ok(a.alice, "PUT", fmt.Sprintf("/api/v1/tabs/%d", yest), map[string]any{"status": "mastered"})
	if _, err := a.st.DB.Exec(`UPDATE tabs SET mastered_at = ? WHERE id = ?`, day+"T20:30:00Z", yest); err != nil {
		t.Fatal(err)
	}

	d := a.dayOf(a.alice, day, "UTC")
	if d.Summary != "Practised 35 minutes: Blackbird (take 2), Scales; can now play Yesterday" || len(d.Items) != 3 || len(d.Metrics) != 0 {
		t.Fatalf("day = %q %+v", d.Summary, d.Items)
	}
	if it := d.Items[0]; it.ID != fmt.Sprintf("practice:%d", first) || it.Title != "Blackbird (take 2)" || it.Sub != "The Beatles" || it.Kind != "practised" || it.Minutes != 25 ||
		it.Time != "19:00" || it.End != "19:25" || it.Done || it.Note != "the bridge at last" || it.URL != fmt.Sprintf("/tab/%d", bird) {
		t.Errorf("song = %+v", it)
	}
	if it := d.Items[1]; it.Title != "Scales" || it.Sub != "" || it.Kind != "practised" || it.Minutes != 10 || it.Time != "20:00" || it.URL != "/practice" {
		t.Errorf("free practice = %+v", it)
	}
	if it := d.Items[2]; it.ID != fmt.Sprintf("tab:%d", yest) || it.Title != "Yesterday" || it.Sub != "The Beatles" || it.Kind != "learned" || !it.Done || it.Minutes != 0 ||
		it.Time != "20:30" || it.URL != fmt.Sprintf("/tab/%d", yest) {
		t.Errorf("learned = %+v", it)
	}

	// the caller's time zone decides the day and the clock: 19:00 UTC is the next morning in Tokyo
	if d := a.dayOf(a.alice, day, "Asia/Tokyo"); len(d.Items) != 0 || d.Summary != "" {
		t.Errorf("Tokyo, the day = %q %+v", d.Summary, d.Items)
	}
	d = a.dayOf(a.alice, "2026-10-06", "Asia/Tokyo")
	if d.Summary != "Practised 35 minutes: Blackbird (take 2), Scales; can now play Yesterday" || d.Items[0].Time != "04:00" || d.Items[0].End != "04:25" || d.Items[2].Time != "05:30" {
		t.Errorf("Tokyo, the next day = %q %+v", d.Summary, d.Items)
	}

	// without a time zone the day is the one the log keeps (the server's), as GET /day
	a.practise(a.alice, bird, "", "2026-10-08T07:15:00", 90)
	a.practise(a.alice, bird, "", "2026-10-08T18:00:00", 20)
	d = a.dayOf(a.alice, "2026-10-08", "")
	if d.Summary != "Practised 2 minutes: Blackbird (take 2)" || len(d.Items) != 2 || d.Items[0].Time != "07:15" || d.Items[0].Minutes != 1.5 || d.Items[1].Minutes != 0.3 {
		t.Errorf("server's day = %q %+v", d.Summary, d.Items)
	}
	if old := a.ok(a.alice, "GET", "/api/v1/day/2026-10-08", nil); num(old, "minutes") != 2 || len(old["sessions"].([]any)) != 2 {
		t.Errorf("/day = %v", old)
	}
	a.practise(a.alice, 0, "", "2026-10-09T07:15:00", 20)
	if d = a.dayOf(a.alice, "2026-10-09", ""); d.Summary != "Practised less than a minute: Free practice" {
		t.Errorf("a few seconds = %q", d.Summary)
	}

	// many songs are counted, not all named; a song that is gone keeps its name
	for i, title := range []string{"One", "Two", "Three", "Four"} {
		id := a.addTab(a.alice, title+".tex", title, "Band")
		a.practise(a.alice, id, "", fmt.Sprintf("2026-10-10T1%d:00:00Z", i), 20*60)
		a.practise(a.alice, id, "", fmt.Sprintf("2026-10-10T1%d:30:00Z", i), 10*60)
		if title == "Four" {
			a.expect(204, a.alice, "DELETE", fmt.Sprintf("/api/v1/tabs/%d", id), nil)
		}
	}
	d = a.dayOf(a.alice, "2026-10-10", "UTC")
	if d.Summary != "Practised 2 h: One, Two, Three and 1 more" || len(d.Items) != 8 {
		t.Fatalf("many = %q %+v", d.Summary, d.Items)
	}
	if it := d.Items[7]; it.Title != "Four" || it.Sub != "Band" || it.URL != "/practice" || it.Minutes != 10 {
		t.Errorf("a song that is gone = %+v", it)
	}

	// a day with only a song learned; nothing that day; nothing of Alice's on Bob's day
	if _, err := a.st.DB.Exec(`UPDATE tabs SET mastered_at = ? WHERE id = ?`, "2026-10-12T09:00:00Z", yest); err != nil {
		t.Fatal(err)
	}
	if d = a.dayOf(a.alice, "2026-10-12", "UTC"); d.Summary != "Can now play Yesterday" || len(d.Items) != 1 {
		t.Errorf("learned only = %q %+v", d.Summary, d.Items)
	}
	if d = a.dayOf(a.alice, "2026-01-01", "UTC"); d.Summary != "" || len(d.Items) != 0 || len(d.Metrics) != 0 {
		t.Errorf("empty day = %+v", d)
	}
	if d = a.dayOf(a.bob, day, "UTC"); d.Summary != "Practised 30 minutes: Bob's riffs" || len(d.Items) != 1 {
		t.Errorf("Bob's day = %q %+v", d.Summary, d.Items)
	}
	if code := a.into(a.alice, "GET", "/api/v1/pocket/day/yesterday", nil); code != 400 {
		t.Errorf("bad date = %d, want 400", code)
	}
}

// Pocket Hub's widget is the first page in a few lines.
func TestPocketWidget(t *testing.T) {
	a := newApp(t, nil)
	widget := func(auth string) core.WidgetData {
		t.Helper()
		var w core.WidgetData
		if code := a.into(auth, "GET", "/api/v1/pocket/widget", &w); code != 200 || w.Items == nil {
			t.Fatalf("widget = %d %+v", code, w)
		}
		return w
	}
	metrics := func(w core.WidgetData) string {
		var m []string
		for _, x := range w.Metrics {
			m = append(m, x.Label+": "+x.Value)
		}
		return strings.Join(m, " | ")
	}
	// no tabs and no practice: nothing to show
	if w := widget(a.alice); w.Line != "" || len(w.Items) != 0 || len(w.Metrics) != 0 || w.URL != "" {
		t.Errorf("empty = %+v", w)
	}
	// tabs, nothing played: the numbers, no line, no songs
	bird := a.addTab(a.alice, "blackbird.tex", "Blackbird", "The Beatles")
	yest := a.addTab(a.alice, "yesterday.tex", "Yesterday", "The Beatles")
	wish := a.addTab(a.alice, "wish.tex", "Wish You Were Here", "Pink Floyd")
	w := widget(a.alice)
	if w.Line != "" || len(w.Items) != 0 || w.URL != "/" || metrics(w) != "Today: 0 of 20 min | This week: 0 min | Days in a row: 0" {
		t.Errorf("nothing played = %+v", w)
	}

	// practice today, yesterday and four days ago; nothing marked as being learned: the songs played lately
	today := time.Now().Format("2006-01-02")
	at := func(daysAgo int) string { return time.Now().AddDate(0, 0, -daysAgo).Format("2006-01-02") + "T00:00:00" }
	a.practise(a.alice, bird, "", at(0), 25*60)
	a.practise(a.alice, yest, "", at(1), 10*60)
	a.practise(a.alice, wish, "", at(4), 45*60)
	a.practise(a.alice, 0, "Scales", at(9), 30*60)
	w = widget(a.alice)
	if w.Line != "1 h 20 min this week, 2 days in a row" || metrics(w) != "Today: 25 of 20 min | This week: 1 h 20 min | Days in a row: 2" || len(w.Items) != 3 {
		t.Fatalf("played = %+v", w)
	}
	if it := w.Items[0]; it.ID != strconv.FormatInt(bird, 10) || it.Title != "Blackbird" || it.Detail != "The Beatles · played today" || it.URL != fmt.Sprintf("/tab/%d", bird) || it.Done {
		t.Errorf("row = %+v", it)
	}
	if w.Items[1].Detail != "The Beatles · played yesterday" || w.Items[2].Detail != "Pink Floyd · played 4 days ago" {
		t.Errorf("rows = %+v", w.Items)
	}

	// songs being learned take the list, the one played last on top; one not played yet says so
	later := a.addTab(a.alice, "later.tex", "Later", "")
	for _, c := range []struct {
		id     int64
		status string
	}{{wish, "learning"}, {yest, "polishing"}, {later, "learning"}} {
		a.ok(a.alice, "PUT", fmt.Sprintf("/api/v1/tabs/%d", c.id), map[string]any{"status": c.status})
	}
	w = widget(a.alice)
	if len(w.Items) != 3 || w.Items[0].Title != "Yesterday" || w.Items[1].Title != "Wish You Were Here" || w.Items[2].Title != "Later" || w.Items[2].Detail != "not played yet" {
		t.Errorf("learning = %+v", w.Items)
	}

	// without a daily goal today is just the minutes; one day in a row is not worth a word
	a.ok(a.alice, "PUT", "/api/v1/settings", map[string]any{"daily_goal_min": 0})
	a.practise(a.bob, 0, "Scales", at(0), 50)
	if w = widget(a.alice); w.Metrics[0] != (core.Metric{Label: "Today", Value: "25 min"}) {
		t.Errorf("no goal = %+v", w.Metrics)
	}
	// Bob has no tabs, only his own minute of practice
	w = widget(a.bob)
	if w.Line != "1 minute this week" || len(w.Items) != 0 || metrics(w) != "Today: 1 of 20 min | This week: 1 min | Days in a row: 1" {
		t.Errorf("Bob = %+v", w)
	}
	// a song last played long ago carries its date
	if got := playedWords("2026-03-02T10:00:00", today); !strings.HasPrefix(got, "played on 2 Mar") {
		t.Errorf("long ago = %q", got)
	}
}

// A link token with one of the pocket:* scopes reaches its one route (and
// /auth/me), as the person it acts for; the app's own scopes do not open them.
func TestPocketLinkScopes(t *testing.T) {
	a, _ := capApp(t)
	day := time.Now().UTC().Format("2006-01-02")
	bird := a.addTab(a.bob, "blackbird.tex", "Blackbird", "The Beatles")
	a.practise(a.bob, bird, "", day+"T00:00:00Z", 15*60)
	a.addTab(a.alice, "secret.tex", "Secret Song", "Alice")
	a.practise(a.alice, 0, "Secret Scales", day+"T00:00:00Z", 15*60)
	type call struct{ m, p string }
	routes := map[string]call{
		"search": {"GET", "/api/v1/pocket/search?q=e"},
		"day":    {"GET", "/api/v1/pocket/day/" + day + "?tz=UTC"},
		"widget": {"GET", "/api/v1/pocket/widget"},
	}
	for scope := range routes {
		tok := "pcx_bob_" + scope
		for name, c := range routes {
			code, body := a.raw(tok, c.m, c.p, nil)
			switch {
			case name == scope && (code != 200 || strings.Contains(string(body), "Secret") || !strings.Contains(string(body), "Blackbird")):
				t.Errorf("pocket:%s %s %s = %d %s", scope, c.m, c.p, code, body)
			case name != scope && (code != 403 || !strings.Contains(string(body), "link does not cover")):
				t.Errorf("pocket:%s on %s %s = %d %s, want 403", scope, c.m, c.p, code, body)
			}
		}
		var me map[string]any
		if code := a.into(tok, "GET", "/api/v1/auth/me", &me); code != 200 || me["email"] != "bob@example.com" {
			t.Errorf("%s auth/me = %d %v", tok, code, me)
		}
		// nothing else in the app
		for _, c := range []call{
			{"GET", "/api/v1/tabs"}, {"GET", fmt.Sprintf("/api/v1/tabs/%d", bird)}, {"GET", fmt.Sprintf("/api/v1/tabs/%d/file", bird)}, {"GET", "/api/v1/practice"},
			{"POST", "/api/v1/practice"}, {"GET", "/api/v1/dashboard"}, {"GET", "/api/v1/day/" + day}, {"GET", "/api/v1/stats"}, {"GET", "/api/v1/settings"},
			{"GET", "/api/v1/export.json"}, {"GET", core.PortablePath}, {"DELETE", fmt.Sprintf("/api/v1/tabs/%d", bird)},
		} {
			if code, _ := a.raw(tok, c.m, c.p, []byte("{}")); code != 403 {
				t.Errorf("%s %s %s = %d, want 403", tok, c.m, c.p, code)
			}
		}
		// and its own route in no other way (the router has no such route to refuse)
		for _, c := range []call{
			{"POST", "/api/v1/pocket/search?q=e"}, {"POST", "/api/v1/pocket/widget"}, {"DELETE", "/api/v1/pocket/day/" + day}, {"GET", "/api/v1/pocket/day/" + day + "/more"},
			{"POST", "/api/v1/pocket/capture"},
		} {
			if code, _ := a.raw(tok, c.m, c.p, []byte("{}")); code != 403 && code != 404 && code != 405 {
				t.Errorf("%s %s %s = %d", tok, c.m, c.p, code)
			}
		}
	}
	// the links the app had before do not open the new routes, and there is no quick line to keep
	for _, tok := range []string{"pcx_bob_read", "pcx_bob_write", "pcx_bob_export", "pcx_bob_import", "pcx_bob_capture"} {
		for _, c := range routes {
			if code, _ := a.raw(tok, c.m, c.p, nil); code != 403 {
				t.Errorf("%s %s %s = %d, want 403", tok, c.m, c.p, code)
			}
		}
		if code, _ := a.raw(tok, "POST", "/api/v1/pocket/capture", []byte(`{"request_id":"hub-0000000000000001","text":"Blackbird"}`)); code != 403 && code != 404 {
			t.Errorf("%s capture = %d, want no such route", tok, code)
		}
	}
	if code, _ := a.raw(a.bob, "POST", "/api/v1/pocket/capture", []byte(`{"request_id":"hub-0000000000000001","text":"Blackbird"}`)); code != 404 && code != 405 {
		t.Errorf("capture as the person = %d, want no such route", code)
	}
	// the app's own links still open what they did
	if code, _ := a.raw("pcx_bob_read", "GET", "/api/v1/day/"+day, nil); code != 200 {
		t.Errorf("guitar:read on /day = %d", code)
	}
	// a token Core does not vouch for
	if code, _ := a.raw("pcx_carol_widget", "GET", "/api/v1/pocket/widget", nil); code != 401 {
		t.Errorf("unknown link token = %d, want 401", code)
	}
	// nothing was added or changed along the way
	if l := a.ok(a.bob, "GET", "/api/v1/tabs", nil); num(l, "total") != 1 {
		t.Errorf("Bob has %v tabs", l["total"])
	}
	if l := a.ok(a.bob, "GET", "/api/v1/practice", nil); num(l, "total") != 1 {
		t.Errorf("Bob has %v sittings", l["total"])
	}
}

// The manifest tells Pocket Core the shelf Hub puts the app on and what
// Search, Day and Hub can ask it.
func TestManifestCapabilities(t *testing.T) {
	a, manifest := capApp(t)
	if err := a.s.registerWithCore(context.Background()); err != nil {
		t.Fatal(err)
	}
	m := manifest()
	if m["slug"] != "guitar" || m["category"] != "Media" {
		t.Fatalf("manifest: %v %v", m["slug"], m["category"])
	}
	search, _ := m["search"].(map[string]any)
	day, _ := m["day"].(map[string]any)
	widget, _ := m["widget"].(map[string]any)
	if search == nil || day == nil || widget == nil {
		t.Fatalf("capabilities: %v %v %v", search, day, widget)
	}
	if _, has := m["capture"]; has {
		t.Errorf("capture: %v", m["capture"])
	}
	if fmt.Sprint(search["bangs"]) != "[tabs tab guitar]" || fmt.Sprint(search["kinds"]) != "[tab]" || search["what"] == "" {
		t.Errorf("search: %v", search)
	}
	if day["label"] != "Guitar" || day["one"] != "session" || day["many"] != "sessions" || day["unit"] != "min" || day["what"] == "" {
		t.Errorf("day: %v", day)
	}
	if widget["title"] != "Guitar practice" || widget["what"] == "" {
		t.Errorf("widget: %v", widget)
	}
	offered := map[string]bool{}
	for _, o := range m["offers"].([]any) {
		offered[o.(map[string]any)["scope"].(string)] = true
	}
	for _, sc := range []string{"guitar:read", "guitar:write", core.ScopeSearch, core.ScopeDay, core.ScopeWidget, core.ScopeMoveExport, core.ScopeMoveImport} {
		if !offered[sc] {
			t.Errorf("%s is not offered", sc)
		}
	}
	if offered[core.ScopeCapture] {
		t.Error("pocket:capture is offered, but there is nothing to keep a quick line as")
	}
}

// Without Pocket Core the routes answer the person signed in to the app.
func TestPocketRoutesWithoutCore(t *testing.T) {
	a := newApp(t, nil)
	bird := a.addTab(a.alice, "blackbird.tex", "Blackbird", "The Beatles")
	a.practise(a.alice, bird, "", "2026-10-05T19:00:00Z", 15*60)
	if got := a.search(a.alice, "q=blackbird"); len(got) != 1 || got[0].Snippet != "The Beatles · want to learn" {
		t.Errorf("search = %+v", got)
	}
	if d := a.dayOf(a.alice, "2026-10-05", "UTC"); d.Summary != "Practised 15 minutes: Blackbird" {
		t.Errorf("day = %+v", d)
	}
	var w core.WidgetData
	if code := a.into(a.alice, "GET", "/api/v1/pocket/widget", &w); code != 200 || len(w.Metrics) != 3 || len(w.Items) != 1 {
		t.Errorf("widget = %d %+v", code, w)
	}
	// a link token means nothing here, and nobody is nobody
	for _, tok := range []string{"pcx_alice_widget", ""} {
		if code, _ := a.raw(tok, "GET", "/api/v1/pocket/widget", nil); code != 401 {
			t.Errorf("%q = %d, want 401", tok, code)
		}
	}
}
