package server

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// ---- adding a tab from Songsterr ----
//
// Songsterr no longer hands out Guitar Pro files: a song is its tab page
// (artist, title, the revision and the tracks) plus one JSON file per
// track on Songsterr's CDN. The server fetches those two things (a
// browser cannot: Songsterr does not allow other sites to read them) and
// the browser turns them into a Guitar Pro 7 file with alphaTab
// (web/src/songsterr), then uploads it like any other tab. One song at
// a time, on purpose: no bulk downloads.

var songsterrURL = regexp.MustCompile(`(?i)^https?://(?:www\.)?songsterr\.com/a/wsa/[\w~%.-]*-?tab-s(\d+)`)

var stateScript = regexp.MustCompile(`(?s)<script id="state"[^>]*>(.*?)</script>`)

// Songsterr's two CDNs for the per-track JSON (the second is tried when the first has nothing).
var songsterrCDNs = []string{"https://dqsljvtekg760.cloudfront.net", "https://d3d3l6a6rcgkaf.cloudfront.net"}

var songsterrImage = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func (s *Server) songsterrGet(ctx context.Context, u string, accept string, limit int64) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; "+s.cfg.UserAgent+")")
	req.Header.Set("Accept", accept)
	req.Header.Set("Referer", "https://www.songsterr.com/")
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, limit))
	return b, res.StatusCode, err
}

// handleSongsterrSong reads a tab page: {song_id, revision_id, image, title, artist, url, tracks[]}.
func (s *Server) handleSongsterrSong(w http.ResponseWriter, r *http.Request) {
	u := strings.TrimSpace(r.URL.Query().Get("url"))
	m := songsterrURL.FindStringSubmatch(u)
	if m == nil {
		writeErr(w, http.StatusBadRequest, "that is not the address of a Songsterr tab (it looks like songsterr.com/a/wsa/…-tab-s12345)")
		return
	}
	b, code, err := s.songsterrGet(r.Context(), u, "text/html", 8<<20)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Songsterr did not answer: "+err.Error())
		return
	}
	if code != http.StatusOK {
		writeErr(w, http.StatusBadGateway, fmt.Sprintf("Songsterr answered HTTP %d", code))
		return
	}
	sm := stateScript.FindSubmatch(b)
	if sm == nil {
		writeErr(w, http.StatusBadGateway, "Songsterr's page has no song data (is this a tab page?)")
		return
	}
	var st struct {
		Meta struct {
			Current struct {
				SongID     int             `json:"songId"`
				RevisionID int             `json:"revisionId"`
				Image      string          `json:"image"`
				Title      string          `json:"title"`
				Artist     string          `json:"artist"`
				Tracks     json.RawMessage `json:"tracks"`
			} `json:"current"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(sm[1], &st); err != nil {
		if err := json.Unmarshal([]byte(html.UnescapeString(string(sm[1]))), &st); err != nil {
			writeErr(w, http.StatusBadGateway, "could not read Songsterr's song data")
			return
		}
	}
	c := st.Meta.Current
	if c.SongID == 0 || c.RevisionID == 0 || !songsterrImage.MatchString(c.Image) {
		writeErr(w, http.StatusBadGateway, "Songsterr's song data is missing the revision of the tab")
		return
	}
	tracks := c.Tracks
	if len(tracks) == 0 || tracks[0] != '[' {
		tracks = json.RawMessage("[]")
	}
	writeJSON(w, http.StatusOK, map[string]any{"song_id": c.SongID, "revision_id": c.RevisionID, "image": c.Image,
		"title": strings.TrimSpace(c.Title), "artist": strings.TrimSpace(c.Artist), "url": u, "tracks": tracks})
}

// handleSongsterrPart passes one track's JSON through from Songsterr's CDN.
func (s *Server) handleSongsterrPart(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	song, err1 := strconv.Atoi(q.Get("song"))
	rev, err2 := strconv.Atoi(q.Get("revision"))
	part, err3 := strconv.Atoi(q.Get("part"))
	image := q.Get("image")
	if err1 != nil || err2 != nil || err3 != nil || song <= 0 || rev <= 0 || part < 0 || part > 200 || !songsterrImage.MatchString(image) {
		writeErr(w, http.StatusBadRequest, "song, revision, image and part are needed")
		return
	}
	lastCode := 0
	for _, cdn := range songsterrCDNs {
		b, code, err := s.songsterrGet(r.Context(), fmt.Sprintf("%s/%d/%d/%s/%d.json", cdn, song, rev, image, part), "application/json", 32<<20)
		if err != nil || code != http.StatusOK || !json.Valid(b) {
			lastCode = code
			continue
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "private, max-age=86400")
		_, _ = w.Write(b)
		return
	}
	writeErr(w, http.StatusBadGateway, fmt.Sprintf("Songsterr has no data for track %d of this song (HTTP %d)", part, lastCode))
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
		if m := songsterrURL.FindStringSubmatch(firstNonEmpty(t.OriginURL, t.SourceRef)); m != nil {
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "results": out})
}
