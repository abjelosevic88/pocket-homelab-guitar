package server

import (
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// What Pocket Search, Pocket Day and Pocket Hub ask Guitar (the capabilities
// value in links.go): /api/v1/pocket/search, /day/{date} and /widget, in the
// shape every Pocket app answers in. Each runs as the request's person and
// sees only their tabs and practice; the SDK's handlers check and cap what
// goes in and out. They read what /tabs, /day and /dashboard read and change
// nothing.

// tabURL opens a song in the player.
func tabURL(id int64) string { return "/tab/" + strconv.FormatInt(id, 10) }

// songTitle is a tab's title, or its file's name while it has none.
func songTitle(t *store.Tab) string {
	if t.Title != "" {
		return t.Title
	}
	return t.FileName
}

// dots joins the parts of a line that are there: "The Beatles · Drop D · learning".
func dots(parts ...string) string {
	out := parts[:0:0]
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, " · ")
}

// upperFirst starts a line with a capital letter.
func upperFirst(s string) string {
	r, n := utf8.DecodeRuneInString(s)
	if n == 0 || unicode.IsUpper(r) {
		return s
	}
	return string(unicode.ToUpper(r)) + s[n:]
}

// count is a number with its word: "1 day", "4 days".
func count(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

// wholeMinutes rounds practice time the way the pages do.
func wholeMinutes(seconds int) int { return (seconds + 30) / 60 }

// shortMinutes is a length of time as the pages show it: "35 min", "1 h 20 min"
// (fmtMinutes in web/src/lib/guitar.ts).
func shortMinutes(m int) string {
	switch h, r := m/60, m%60; {
	case h == 0:
		return strconv.Itoa(m) + " min"
	case r == 0:
		return strconv.Itoa(h) + " h"
	default:
		return fmt.Sprintf("%d h %d min", h, r)
	}
}

// minutesWords is a length of time inside a sentence: "35 minutes", "1 h 20 min".
func minutesWords(m int) string {
	if m < 60 {
		return count(m, "minute", "minutes")
	}
	return shortMinutes(m)
}

// nameList: "Blackbird", "Blackbird and Yesterday", "Blackbird, Yesterday and Julia".
func nameList(names []string) string {
	if n := len(names); n > 1 {
		return strings.Join(names[:n-1], ", ") + " and " + names[n-1]
	}
	return strings.Join(names, "")
}

// ---------- search ----------

// searchScan is how many matching tabs are weighed before the best are kept.
const searchScan = 200

// pocketSearch answers Pocket Search with the tabs GET /tabs?q= finds: every
// word in the song's title, artist, album, tags or file name. A title that
// has the words comes first, then title and artist together, then the rest;
// each group with the song played last on top. Song notes are not looked in
// and never shown.
func (s *Server) pocketSearch(r *http.Request, q string, limit int) ([]core.SearchItem, error) {
	ctx := r.Context()
	// nothing to look for in "??" or "*"; in SQL's LIKE "%" and "_" would find every tab
	if strings.IndexFunc(q, func(c rune) bool { return unicode.IsLetter(c) || unicode.IsDigit(c) }) < 0 {
		return nil, nil
	}
	f := store.TabFilter{Q: q, Sort: "recent", Limit: searchScan}
	// SQLite's LOWER leaves "Đ" and "Č" as they are, so words with such
	// letters are looked for here, in the whole library (as far as GET /tabs lists it)
	if strings.IndexFunc(q, func(c rune) bool { return c > unicode.MaxASCII }) >= 0 {
		f.Q, f.Limit = "", 2000
	}
	tabs, _, err := s.store.ListTabs(ctx, actorID(ctx), f)
	if err != nil {
		return nil, err
	}
	words := strings.Fields(strings.ToLower(q))
	has := func(v ...string) bool {
		hay := strings.ToLower(strings.Join(v, "\n"))
		for _, w := range words {
			if !strings.Contains(hay, w) {
				return false
			}
		}
		return true
	}
	out := make([]core.SearchItem, 0, len(tabs))
	for i := range tabs {
		t := &tabs[i]
		it := core.SearchItem{ID: strconv.FormatInt(t.ID, 10), Title: songTitle(t), Kind: "tab", Date: firstNonEmpty(t.LastPlayedAt, t.CreatedAt), URL: tabURL(t.ID), Score: 1}
		// where the words were found, when the line does not show it
		where := ""
		switch {
		case has(t.Title):
			it.Score = 3
		case has(t.Title, t.Artist):
			it.Score = 2
		case has(t.Title, t.Artist, t.Album):
		case has(t.Title, t.Artist, t.Album, t.Tags):
			where = t.Tags
		case has(t.Title, t.Artist, t.Album, t.Tags, t.FileName):
			where = t.FileName
		default:
			continue
		}
		tuning := t.Tuning
		if tuning == "Standard" { // the pages leave it out too
			tuning = ""
		}
		it.Snippet = dots(t.Artist, t.Album, tuning, statusWords[t.Status], where)
		out = append(out, it)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// ---------- day ----------

// pocketDay answers Pocket Day with what GET /day/{date} reports: the day's
// practice, one line per sitting with its song, artist and minutes, and the
// songs marked "Can play it" that day. The log keeps each sitting's day as
// the server saw it; a caller that gives its time zone gets the sittings that
// started on its own day, with their times in its clock.
func (s *Server) pocketDay(r *http.Request, date string, tz *time.Location) (*core.Day, error) {
	ctx := r.Context()
	uid := actorID(ctx)
	loc := time.Local
	f := store.PracticeFilter{From: date, To: date, Asc: true}
	if tz != nil {
		loc = tz
		f.From, f.To = store.AddDays(date, -1), store.AddDays(date, 1)
	}
	list, _, err := s.store.ListPractice(ctx, uid, f)
	if err != nil {
		return nil, err
	}
	sittings := list[:0]
	var ids []int64
	for _, p := range list {
		start, ok := store.ParseTime(p.StartedAt)
		if p.DurationS <= 0 || (tz != nil && (!ok || start.In(loc).Format("2006-01-02") != date)) {
			continue
		}
		sittings = append(sittings, p)
		if p.TabID != nil {
			ids = append(ids, *p.TabID)
		}
	}
	// the songs as they are named now (the log keeps "Artist – Title" from the day it was written)
	songs := map[int64]*store.Tab{}
	if len(ids) > 0 {
		tabs, _, err := s.store.ListTabs(ctx, uid, store.TabFilter{IDs: ids})
		if err != nil {
			return nil, err
		}
		for i := range tabs {
			songs[tabs[i].ID] = &tabs[i]
		}
	}
	mastered, _, err := s.store.ListTabs(ctx, uid, store.TabFilter{Status: "mastered"})
	if err != nil {
		return nil, err
	}

	day := &core.Day{Date: date}
	clock := func(stamp string) string {
		if t, ok := store.ParseTime(stamp); ok {
			return t.In(loc).Format("15:04")
		}
		return ""
	}
	var played, learned []string
	total := 0
	for _, p := range sittings {
		it := core.DayItem{ID: "practice:" + strconv.FormatInt(p.ID, 10), Time: clock(p.StartedAt), End: clock(p.EndedAt), Title: p.Title, Kind: "practised",
			Minutes: math.Round(float64(p.DurationS)/6) / 10, Note: p.Note, URL: "/practice"}
		if p.TabID != nil {
			if t := songs[*p.TabID]; t != nil {
				it.Title, it.Sub, it.URL = songTitle(t), t.Artist, tabURL(t.ID)
			}
		} else if artist, title, ok := strings.Cut(p.Title, " – "); ok && p.Kind == "tab" {
			it.Title, it.Sub = title, artist // a song that is no longer in the library
		}
		day.Items = append(day.Items, it)
		total += p.DurationS
		if !oneOf(it.Title, played) {
			played = append(played, it.Title)
		}
	}
	for i := range mastered {
		t := &mastered[i]
		at, ok := store.ParseTime(t.MasteredAt)
		if !ok || at.In(loc).Format("2006-01-02") != date {
			continue
		}
		day.Items = append(day.Items, core.DayItem{ID: "tab:" + strconv.FormatInt(t.ID, 10), Time: at.In(loc).Format("15:04"), Title: songTitle(t), Sub: t.Artist,
			Kind: "learned", Done: true, URL: tabURL(t.ID)})
		learned = append(learned, songTitle(t))
	}
	if len(day.Items) == 0 {
		return nil, nil
	}

	// "Practised 35 minutes: Blackbird, Yesterday; can now play Blackbird"
	var parts []string
	if len(played) > 0 {
		length := "less than a minute"
		if m := wholeMinutes(total); m > 0 {
			length = minutesWords(m)
		}
		names := strings.Join(played, ", ")
		if len(played) > 3 {
			names = strings.Join(played[:3], ", ") + " and " + strconv.Itoa(len(played)-3) + " more"
		}
		parts = append(parts, "practised "+length+": "+names)
	}
	switch n := len(learned); {
	case n > 3:
		parts = append(parts, fmt.Sprintf("can now play %d more songs", n))
	case n > 0:
		parts = append(parts, "can now play "+nameList(learned))
	}
	day.Summary = upperFirst(strings.Join(parts, "; "))
	return day, nil
}

// oneOf reports whether s is in list.
func oneOf(s string, list []string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// ---------- widget ----------

// widgetSongs is how many songs the widget lists.
const widgetSongs = 5

// playedWords says when a song was last played, by the calendar: "played
// today", "played 3 days ago", "played on 2 Nov", "not played yet".
func playedWords(last, today string) string {
	t, ok := store.ParseTime(last)
	if !ok {
		return "not played yet"
	}
	t = t.In(time.Local)
	day := t.Format("2006-01-02")
	for n := 0; n < 7; n++ {
		if store.AddDays(today, -n) != day {
			continue
		}
		switch n {
		case 0:
			return "played today"
		case 1:
			return "played yesterday"
		}
		return fmt.Sprintf("played %d days ago", n)
	}
	if day[:4] == today[:4] {
		return "played on " + t.Format("2 Jan")
	}
	return "played on " + t.Format("2 Jan 2006")
}

// pocketWidget answers Pocket Hub with the first page in a few lines: the
// practice of today (against the daily goal) and of the last seven days, the
// days in a row, and the songs being learned, the one played last on top
// (or, with none marked, the songs played lately). Someone with no tabs and
// no practice gets nothing to show.
func (s *Server) pocketWidget(r *http.Request) (*core.WidgetData, error) {
	ctx := r.Context()
	uid := actorID(ctx)
	recent, tabs, err := s.store.ListTabs(ctx, uid, store.TabFilter{Sort: "recent", Limit: 30})
	if err != nil {
		return nil, err
	}
	today := store.Today()
	week, err := s.store.DaySeconds(ctx, uid, store.AddDays(today, -6), today)
	if err != nil {
		return nil, err
	}
	streak, longest := s.streaks(ctx, uid)
	if tabs == 0 && longest == 0 {
		return nil, nil
	}
	weekS := 0
	for _, sec := range week {
		weekS += sec
	}
	st, _ := s.store.GetSettings(ctx, uid)

	w := &core.WidgetData{URL: "/"}
	if m := wholeMinutes(weekS); m > 0 {
		w.Line = minutesWords(m) + " this week"
		if streak > 1 {
			w.Line += fmt.Sprintf(", %d days in a row", streak)
		}
	}
	todayWords := shortMinutes(wholeMinutes(week[today]))
	if st.DailyGoalMin > 0 {
		todayWords = fmt.Sprintf("%d of %s", wholeMinutes(week[today]), shortMinutes(st.DailyGoalMin))
	}
	w.Metrics = []core.Metric{{Label: "Today", Value: todayWords}, {Label: "This week", Value: shortMinutes(wholeMinutes(weekS))},
		{Label: "Days in a row", Value: strconv.Itoa(streak)}}

	var learning, played []*store.Tab
	for i := range recent {
		t := &recent[i]
		if t.Status == "learning" || t.Status == "polishing" {
			learning = append(learning, t)
		}
		if t.LastPlayedAt != "" {
			played = append(played, t)
		}
	}
	if len(learning) == 0 {
		learning = played
	}
	for _, t := range learning {
		if len(w.Items) == widgetSongs {
			break
		}
		w.Items = append(w.Items, core.WidgetItem{ID: strconv.FormatInt(t.ID, 10), Title: songTitle(t), Detail: dots(t.Artist, playedWords(t.LastPlayedAt, today)), URL: tabURL(t.ID)})
	}
	return w, nil
}
