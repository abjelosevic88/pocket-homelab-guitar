package server

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// ---- the original recording, from Navidrome ----
//
// A tab can be linked to the song in the person's own Navidrome, to play
// along with the record at the practice speed. Guitar asks Core for the
// person's Navidrome login (service connection "navidrome") or uses a URL,
// user and password from Settings, and streams through itself so the
// browser never sees them.

type navidrome struct {
	base, user, pass, via string
	http                  *http.Client
}

// navidromeFor is how Guitar reaches a person's Navidrome.
func (s *Server) navidromeFor(ctx context.Context, uid int64) (*navidrome, error) {
	st, err := s.store.GetSettings(ctx, uid)
	if err != nil {
		return nil, err
	}
	u, err := s.store.GetUser(ctx, uid)
	if err != nil {
		return nil, err
	}
	switch s.connMode(st.MusicMode, st.MusicPassword) {
	case modeOff:
		return nil, &notConnected{"Navidrome is switched off in Settings → Connected apps"}
	case modeDirect:
		if st.MusicURL == "" || st.MusicUser == "" || st.MusicPassword == "" {
			return nil, &notConnected{"Navidrome is not set up (Settings → Connected apps): add its address, a user and a password, or use Pocket Core"}
		}
		return &navidrome{base: strings.TrimRight(st.MusicURL, "/"), user: st.MusicUser, pass: st.MusicPassword, via: modeDirect, http: &http.Client{Timeout: 30 * time.Second}}, nil
	}
	if !s.core.Configured() {
		return nil, &notConnected{"Navidrome through Pocket Core: there is no Pocket Core on this box; use a direct connection"}
	}
	cred, err := s.core.ServiceFor(ctx, u.Email, "navidrome")
	if err != nil {
		var le *core.LinkError
		if errors.As(err, &le) {
			msg := le.Error()
			switch le.Reason {
			case "no_account":
				msg = "you have no Navidrome login in Pocket Core yet (Core → My logins → Navidrome)"
			case "off_admin":
				msg = "the Guitar → Navidrome connection is switched off in Pocket Core (Links)"
			case "off_person":
				msg = "you switched the Guitar → Navidrome connection off in Pocket Core"
			}
			return nil, &notConnected{"Navidrome is not set up: " + msg}
		}
		return nil, err
	}
	user := firstNonEmpty(cred.Fields["USER"], cred.Fields["user"], cred.Fields["username"])
	pass := firstNonEmpty(cred.Fields["PASSWORD"], cred.Fields["password"], cred.Key)
	if cred.URL == "" || user == "" || pass == "" {
		return nil, &notConnected{"Navidrome is not set up: Pocket Core has no user and password for you"}
	}
	return &navidrome{base: strings.TrimRight(cred.URL, "/"), user: user, pass: pass, via: modeCore, http: &http.Client{Timeout: 30 * time.Second}}, nil
}

func (n *navidrome) params(extra url.Values) url.Values {
	salt := store.RandomToken(6)
	sum := md5.Sum([]byte(n.pass + salt))
	q := url.Values{"u": {n.user}, "t": {hex.EncodeToString(sum[:])}, "s": {salt}, "v": {"1.16.1"}, "c": {"pocket-guitar"}, "f": {"json"}}
	for k, v := range extra {
		q[k] = v
	}
	return q
}

// call runs a Subsonic API method and decodes subsonic-response into v.
func (n *navidrome) call(ctx context.Context, method string, extra url.Values, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.base+"/rest/"+method+"?"+n.params(extra).Encode(), nil)
	if err != nil {
		return err
	}
	res, err := n.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("Navidrome: HTTP %d", res.StatusCode)
	}
	var env struct {
		R json.RawMessage `json:"subsonic-response"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 16<<20)).Decode(&env); err != nil {
		return err
	}
	var head struct {
		Status string `json:"status"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(env.R, &head)
	if head.Status != "ok" {
		if head.Error != nil {
			return fmt.Errorf("Navidrome: %s", head.Error.Message)
		}
		return errors.New("Navidrome: request failed")
	}
	return json.Unmarshal(env.R, v)
}

type navSong struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Album    string `json:"album"`
	Duration int    `json:"duration"`
}

func (s *Server) musicError(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error(), "not_connected": isNotConnected(err), "songs": []navSong{}})
}

// handleMusicSearch looks for songs in the person's Navidrome.
func (s *Server) handleMusicSearch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	n, err := s.navidromeFor(ctx, actorID(ctx))
	if err != nil {
		s.musicError(w, err)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "via": n.via, "songs": []navSong{}})
		return
	}
	var out struct {
		SearchResult3 struct {
			Song []navSong `json:"song"`
		} `json:"searchResult3"`
	}
	if err := n.call(ctx, "search3", url.Values{"query": {q}, "songCount": {"25"}, "artistCount": {"0"}, "albumCount": {"0"}}, &out); err != nil {
		s.musicError(w, err)
		return
	}
	songs := out.SearchResult3.Song
	if songs == nil {
		songs = []navSong{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "via": n.via, "songs": songs})
}

// handleMusicStream passes one song through (Range requests included), so
// the browser plays it without ever holding the Navidrome credentials.
func (s *Server) handleMusicStream(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	n, err := s.navidromeFor(ctx, actorID(ctx))
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	q := n.params(url.Values{"id": {chi.URLParam(r, "id")}, "maxBitRate": {"256"}, "format": {"mp3"}})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.base+"/rest/stream?"+q.Encode(), nil)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if rg := r.Header.Get("Range"); rg != "" {
		req.Header.Set("Range", rg)
	}
	client := &http.Client{} // no timeout: a song streams for minutes
	res, err := client.Do(req)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); strings.Contains(ct, "json") || strings.Contains(ct, "xml") {
		writeErr(w, http.StatusBadGateway, "Navidrome refused the song")
		return
	}
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := res.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}
