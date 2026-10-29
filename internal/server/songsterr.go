package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// ---- adding a tab from Songsterr ----
//
// Songsterr no longer hands out Guitar Pro files; a converter
// (songsterr-downloader, TAB_CONVERTER_URL) rebuilds one from the tab's
// data. One address at a time, on purpose: no bulk downloads.

var songsterrURL = regexp.MustCompile(`(?i)^https?://(?:www\.)?songsterr\.com/a/wsa/[\w~%.-]*-?tab-s(\d+)`)

var stateScript = regexp.MustCompile(`(?s)<script id="state"[^>]*>(.*?)</script>`)

func (s *Server) songsterrAvailable() bool { return s.cfg.TabConverterURL != "" }

// songsterrNames reads artist and title from the tab page's embedded state.
func (s *Server) songsterrNames(ctx context.Context, u string) (artist, title string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; "+s.cfg.UserAgent+")")
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("Songsterr answered HTTP %d", res.StatusCode)
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	m := stateScript.FindSubmatch(b)
	if m == nil {
		return "", "", errors.New("Songsterr's page has no song data (is this a tab page?)")
	}
	var st struct {
		Meta struct {
			Current struct {
				Artist string `json:"artist"`
				Title  string `json:"title"`
			} `json:"current"`
		} `json:"meta"`
	}
	if err := json.Unmarshal([]byte(html.UnescapeString(string(m[1]))), &st); err != nil {
		if err := json.Unmarshal(m[1], &st); err != nil {
			return "", "", errors.New("could not read Songsterr's song data")
		}
	}
	return strings.TrimSpace(st.Meta.Current.Artist), strings.TrimSpace(st.Meta.Current.Title), nil
}

// songsterrFile asks the converter for the Guitar Pro file.
func (s *Server) songsterrFile(ctx context.Context, u string) ([]byte, error) {
	body, _ := json.Marshal(map[string]string{"byLinkUrl": u})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.cfg.TabConverterURL, "/")+"/api/download/byRevisionJson", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 5 * time.Minute}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("the tab converter did not answer: %w", err)
	}
	defer res.Body.Close()
	var out struct {
		File  []int  `json:"file"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 200<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("the tab converter sent something unexpected (HTTP %d)", res.StatusCode)
	}
	if out.Error != "" {
		return nil, fmt.Errorf("the tab converter: %s", out.Error)
	}
	if len(out.File) == 0 {
		return nil, errors.New("the tab converter sent an empty file")
	}
	data := make([]byte, len(out.File))
	for i, v := range out.File {
		data[i] = byte(v)
	}
	return data, nil
}

func (s *Server) handleSongsterr(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	if !s.songsterrAvailable() {
		writeErr(w, http.StatusServiceUnavailable, "adding tabs from Songsterr needs the tab converter (TAB_CONVERTER_URL) on this box")
		return
	}
	var in struct {
		URL string `json:"url"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	u := strings.TrimSpace(in.URL)
	m := songsterrURL.FindStringSubmatch(u)
	if m == nil {
		writeErr(w, http.StatusBadRequest, "paste the address of a Songsterr tab (it looks like songsterr.com/a/wsa/…-tab-s12345)")
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 6*time.Minute)
	defer cancel()
	artist, title, err := s.songsterrNames(cctx, u)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	data, err := s.songsterrFile(cctx, u)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	name := safeFileName(firstNonEmpty(artist, "Unknown artist")+" - "+firstNonEmpty(title, "Song "+m[1])) + ".gp"
	t, existing, err := s.addTab(ctx, uid, newTab{name: name, data: data, source: "songsterr", ref: u, title: title, artist: artist})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if !existing {
		if moved := s.keepInFolder(ctx, s.clients(ctx, uid), t, data); moved != nil {
			t = moved
		}
	}
	code := http.StatusCreated
	if existing {
		code = http.StatusOK
	}
	writeJSON(w, code, map[string]any{"tab": t, "existing": existing})
}

// ---- searching Songsterr ----
//
// Songsterr's public search (the one its own site uses). Each result says
// what the song has (guitar parts, bass, drums, the guitar tuning and how
// hard the most played guitar part is) and whether it is in the library
// already. Adding stays one song at a time, through the converter.

type songsterrTrack struct {
	InstrumentID int    `json:"instrumentId"`
	Instrument   string `json:"instrument"`
	Name         string `json:"name"`
	Views        int    `json:"views"`
	Tuning       []int  `json:"tuning"`
	Difficulty   int    `json:"difficulty"`
}

type songsterrSong struct {
	SongID int              `json:"songId"`
	Artist string           `json:"artist"`
	Title  string           `json:"title"`
	Tracks []songsterrTrack `json:"tracks"`
}

// songsterrResult is one search hit as the app shows it.
type songsterrResult struct {
	ID         int    `json:"id"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	URL        string `json:"url"`
	Tracks     int    `json:"tracks"`
	Guitars    int    `json:"guitars"`
	Bass       bool   `json:"bass"`
	Drums      bool   `json:"drums"`
	Tuning     []int  `json:"tuning"`     // MIDI notes of the main guitar part, high string first ([] = none)
	Difficulty int    `json:"difficulty"` // Songsterr's 1-10 for the main guitar part, 0 = not rated
	Views      int    `json:"views"`
	TabID      int64  `json:"tab_id"` // the song in your library, 0 = not there
}

var slugBad = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	return strings.Trim(slugBad.ReplaceAllString(strings.ToLower(s), "-"), "-")
}

// songsterrTabURL is the address of a song's tab page (the slug is cosmetic; the id decides).
func songsterrTabURL(id int, artist, title string) string {
	slug := strings.Trim(slugify(artist)+"-"+slugify(title), "-")
	if slug == "" {
		slug = "song"
	}
	return fmt.Sprintf("https://www.songsterr.com/a/wsa/%s-tab-s%d", slug, id)
}

func summarize(sg songsterrSong) songsterrResult {
	r := songsterrResult{ID: sg.SongID, Title: strings.TrimSpace(sg.Title), Artist: strings.TrimSpace(sg.Artist), Tracks: len(sg.Tracks), Tuning: []int{}}
	r.URL = songsterrTabURL(sg.SongID, r.Artist, r.Title)
	var main *songsterrTrack
	for i := range sg.Tracks {
		t := &sg.Tracks[i]
		r.Views += t.Views
		inst := strings.ToLower(t.Instrument)
		switch {
		case t.InstrumentID >= 24 && t.InstrumentID <= 31 || strings.Contains(inst, "guitar") && !strings.Contains(inst, "bass"):
			r.Guitars++
			if main == nil || t.Views > main.Views {
				main = t
			}
		case t.InstrumentID >= 32 && t.InstrumentID <= 39 || strings.Contains(inst, "bass"):
			r.Bass = true
		case strings.Contains(inst, "drum") || strings.Contains(inst, "percussion") || t.InstrumentID == 1024:
			r.Drums = true
		}
	}
	if main != nil {
		r.Tuning, r.Difficulty = main.Tuning, main.Difficulty
		if r.Tuning == nil {
			r.Tuning = []int{}
		}
	}
	return r
}

func (s *Server) handleSongsterrSearch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "results": []songsterrResult{}})
		return
	}
	if len(q) > 120 {
		q = q[:120]
	}
	key := "songsterr:search:" + strings.ToLower(q)
	var songs []songsterrSong
	if v, at, ok := s.store.CacheGet(ctx, key); ok && json.Unmarshal([]byte(v), &songs) == nil {
		if t, err := time.Parse(time.RFC3339Nano, at); err != nil || time.Since(t) > 6*time.Hour {
			songs = nil
		}
	}
	if songs == nil {
		cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(cctx, http.MethodGet, "https://www.songsterr.com/api/songs?"+url.Values{"pattern": {q}, "size": {"30"}}.Encode(), nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; "+s.cfg.UserAgent+")")
		req.Header.Set("Accept", "application/json")
		res, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Songsterr did not answer: " + err.Error(), "results": []songsterrResult{}})
			return
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": fmt.Sprintf("Songsterr answered HTTP %d", res.StatusCode), "results": []songsterrResult{}})
			return
		}
		if err := json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&songs); err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Songsterr sent something unexpected", "results": []songsterrResult{}})
			return
		}
		if b, err := json.Marshal(songs); err == nil {
			_ = s.store.CachePut(ctx, key, string(b))
		}
	}
	// what is in the library already: by Songsterr address, else by artist and title
	tabs, _, _ := s.store.ListTabs(ctx, uid, store.TabFilter{})
	have := map[string]int64{}
	for _, t := range tabs {
		if m := songsterrURL.FindStringSubmatch(t.SourceRef); m != nil {
			have["id:"+m[1]] = t.ID
		}
		have["name:"+strings.ToLower(t.Artist)+"|"+strings.ToLower(t.Title)] = t.ID
	}
	out := make([]songsterrResult, 0, len(songs))
	for _, sg := range songs {
		if sg.SongID <= 0 {
			continue
		}
		res := summarize(sg)
		if id, ok := have[fmt.Sprintf("id:%d", res.ID)]; ok {
			res.TabID = id
		} else if id, ok := have["name:"+strings.ToLower(res.Artist)+"|"+strings.ToLower(res.Title)]; ok {
			res.TabID = id
		}
		out = append(out, res)
	}
	// Songsterr's order is good; keep it, but put exact title matches first
	lq := strings.ToLower(q)
	sort.SliceStable(out, func(i, j int) bool {
		ei := strings.Contains(lq, strings.ToLower(out[i].Title))
		ej := strings.Contains(lq, strings.ToLower(out[j].Title))
		return ei && !ej
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "results": out, "available": s.songsterrAvailable()})
}
