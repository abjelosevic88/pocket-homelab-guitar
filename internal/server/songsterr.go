package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
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
