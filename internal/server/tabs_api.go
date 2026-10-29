package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/tabfile"
)

// ---- the files behind the tabs ----
//
// A tab's file is kept under FILES_DIR/<user>/<sha256>, named by its bytes,
// so a tab from a Pocket Files folder still opens when Files is away, and
// the same file twice is one file.

func (s *Server) blobPath(uid int64, sha string) string {
	return filepath.Join(s.cfg.FilesDir, strconv.FormatInt(uid, 10), sha)
}

func (s *Server) writeBlob(uid int64, sha string, data []byte) error {
	p := s.blobPath(uid, sha)
	if _, err := os.Stat(p); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".part"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// dropBlob removes a file no tab of the person uses any more.
func (s *Server) dropBlob(ctx context.Context, uid int64, sha string) {
	if sha != "" && !s.store.SHAInUse(ctx, uid, sha) {
		_ = os.Remove(s.blobPath(uid, sha))
	}
}

func shaOf(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

var errNotTab = errors.New("this is not a tab file Pocket Guitar can open (Guitar Pro 3–8, MusicXML or alphaTex)")

// newTab describes where a file came from.
type newTab struct {
	name     string
	data     []byte
	source   string // upload | files | songsterr | import
	ref      string
	origin   string // the Songsterr address it came from
	folderID *int64
	stamp    string
	status   string
	tags     string
	title    string // names known from elsewhere (Songsterr's page, a TabVault sidecar)
	artist   string
	album    string
}

// addTab stores a file and makes a tab of it. When the person already has a
// tab with exactly these bytes, that tab is returned with existing = true.
func (s *Server) addTab(ctx context.Context, uid int64, in newTab) (*store.Tab, bool, error) {
	if len(in.data) == 0 {
		return nil, false, errors.New("the file is empty")
	}
	if len(in.data) > tabfile.MaxSize {
		return nil, false, fmt.Errorf("the file is larger than %d MB", tabfile.MaxSize>>20)
	}
	meta, ok := tabfile.Read(in.name, in.data)
	if !ok {
		return nil, false, errNotTab
	}
	sha := shaOf(in.data)
	if t, err := s.store.TabBySHA(ctx, uid, sha); err == nil {
		return t, true, nil
	}
	if err := s.writeBlob(uid, sha, in.data); err != nil {
		return nil, false, fmt.Errorf("save the file: %w", err)
	}
	t := &store.Tab{Title: meta.Title, Artist: meta.Artist, Album: meta.Album, Tabber: meta.Tabber, Format: meta.Format,
		FileName: filepath.Base(in.name), Size: int64(len(in.data)), SHA256: sha, Source: in.source, SourceRef: in.ref, OriginURL: in.origin,
		FolderID: in.folderID, SourceStamp: in.stamp, Status: in.status, Tags: in.tags, NamesFrom: "file"}
	if in.title != "" {
		t.Title, t.NamesFrom = in.title, "person"
		if in.artist != "" {
			t.Artist = in.artist
		}
		if in.album != "" {
			t.Album = in.album
		}
	}
	if t.Title == "" {
		a, ti := tabfile.FromFileName(in.name)
		t.Title, t.NamesFrom = ti, "filename"
		if t.Artist == "" {
			t.Artist = a
		}
	}
	if t.Format == "" {
		t.Format = "gp"
	}
	if !store.ValidStatus(t.Status) {
		t.Status = "to_learn"
	}
	if err := s.store.CreateTab(ctx, uid, t); err != nil {
		if errors.Is(err, store.ErrConflict) {
			if old, err := s.store.TabBySHA(ctx, uid, sha); err == nil {
				return old, true, nil
			}
		}
		return nil, false, err
	}
	s.publish(ctx, uid, "guitar.tab_added", "tab:"+strconv.FormatInt(t.ID, 10), map[string]any{"tab_id": t.ID, "title": t.Title, "artist": t.Artist, "source": t.Source})
	full, err := s.store.GetTab(ctx, uid, t.ID)
	if err != nil {
		return t, false, nil
	}
	return full, false, nil
}

// ---- handlers ----

func (s *Server) handleListTabs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.TabFilter{Q: q.Get("q"), Status: q.Get("status"), Tag: q.Get("tag"), Tuning: q.Get("tuning"), Artist: q.Get("artist"),
		Source: q.Get("source"), Sort: q.Get("sort"), Favorite: queryBool(r, "favorite"), Limit: queryInt(r, "limit"), Offset: queryInt(r, "offset")}
	if f.Limit <= 0 || f.Limit > 2000 {
		f.Limit = 2000
	}
	for _, v := range strings.Split(q.Get("ids"), ",") {
		if id, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil && id > 0 {
			f.IDs = append(f.IDs, id)
		}
	}
	tabs, total, err := s.store.ListTabs(r.Context(), actorID(r.Context()), f)
	if err != nil {
		s.fail(w, err, "tabs")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tabs": tabs, "total": total})
}

func (s *Server) handleFacets(w http.ResponseWriter, r *http.Request) {
	out, err := s.store.Facets(r.Context(), actorID(r.Context()))
	if err != nil {
		s.fail(w, err, "facets")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

type uploadError struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

// handleUploadTabs takes one or more files (multipart field "file").
func (s *Server) handleUploadTabs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxBodyBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "send the files as multipart/form-data (field \"file\")")
		return
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	files := r.MultipartForm.File["file"]
	if len(files) == 0 {
		writeErr(w, http.StatusBadRequest, "no file")
		return
	}
	status, tags := r.FormValue("status"), r.FormValue("tags")
	// a file the browser built from Songsterr (web/src/songsterr): its address and names come along
	source, origin, title, artist := "upload", "", "", ""
	if o := strings.TrimSpace(r.FormValue("songsterr_url")); o != "" {
		if !songsterrURL.MatchString(o) {
			writeErr(w, http.StatusBadRequest, "songsterr_url is not a Songsterr tab address")
			return
		}
		source, origin, title, artist = "songsterr", o, trimTo(r.FormValue("title"), 200), trimTo(r.FormValue("artist"), 200)
	}
	added, existing, failed := []store.Tab{}, []store.Tab{}, []uploadError{}
	cl := s.clients(ctx, uid)
	for _, fh := range files {
		f, err := fh.Open()
		if err != nil {
			failed = append(failed, uploadError{fh.Filename, err.Error()})
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, tabfile.MaxSize+1))
		f.Close()
		if err != nil {
			failed = append(failed, uploadError{fh.Filename, err.Error()})
			continue
		}
		t, old, err := s.addTab(ctx, uid, newTab{name: fh.Filename, data: data, source: source, ref: origin, origin: origin, status: status, tags: tags, title: title, artist: artist})
		if err != nil {
			failed = append(failed, uploadError{fh.Filename, err.Error()})
			continue
		}
		if old {
			existing = append(existing, *t)
			continue
		}
		if moved := s.keepInFolder(ctx, cl, t, data); moved != nil {
			t = moved
		}
		added = append(added, *t)
	}
	code := http.StatusCreated
	if len(added) == 0 && len(existing) == 0 {
		code = http.StatusBadRequest
	}
	writeJSON(w, code, map[string]any{"added": added, "existing": existing, "errors": failed})
}

func (s *Server) handleGetTab(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	t, err := s.store.GetTab(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "tab")
		return
	}
	t.Sections, err = s.store.ListSections(ctx, uid, t.ID)
	if err != nil {
		s.fail(w, err, "sections")
		return
	}
	writeJSON(w, http.StatusOK, t)
}

// handleTabFile serves the original file.
func (s *Server) handleTabFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	t, err := s.store.GetTab(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "tab")
		return
	}
	f, err := os.Open(s.blobPath(uid, t.SHA256))
	if err != nil {
		writeErr(w, http.StatusNotFound, "the file of this tab is missing")
		return
	}
	defer f.Close()
	fi, _ := f.Stat()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("ETag", `"`+t.SHA256+`"`)
	// a tab's file can change (a new version in its Pocket Files folder): browsers check every
	// time and get "unchanged" (304, by the ETag) when it did not
	w.Header().Set("Cache-Control", "private, no-cache")
	disp := "inline"
	if queryBool(r, "dl") {
		disp = "attachment"
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf(`%s; filename="%s"`, disp, strings.ReplaceAll(t.FileName, `"`, "'")))
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

type tabInput struct {
	Title      string           `json:"title"`
	Artist     string           `json:"artist"`
	Album      string           `json:"album"`
	Tabber     string           `json:"tabber"`
	Status     string           `json:"status"`
	Difficulty int              `json:"difficulty"`
	Favorite   bool             `json:"favorite"`
	Tags       string           `json:"tags"`
	Notes      string           `json:"notes"`
	Capo       int              `json:"capo"`
	GoalSpeed  int              `json:"goal_speed"`
	BestSpeed  int              `json:"best_speed"`
	Player     json.RawMessage  `json:"player"`
	Recording  *store.Recording `json:"recording"`
}

func (s *Server) handleUpdateTab(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	t, err := s.store.GetTab(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "tab")
		return
	}
	var in tabInput
	keys, err := decodeKeys(r, &in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	bad := func(m string) { writeErr(w, http.StatusBadRequest, m) }
	wasStatus := t.Status
	for k, dst := range map[string]*string{"title": &t.Title, "artist": &t.Artist, "album": &t.Album, "tabber": &t.Tabber} {
		if keys[k] {
			*dst = trimTo(in.fieldText(k), 200)
			if k == "title" || k == "artist" {
				t.NamesFrom = "person"
			}
		}
	}
	if keys["title"] && t.Title == "" {
		bad("a song needs a title")
		return
	}
	if keys["status"] {
		if !store.ValidStatus(in.Status) {
			bad("status is to_learn, learning, polishing or mastered")
			return
		}
		t.Status = in.Status
	}
	if keys["difficulty"] {
		if in.Difficulty < 0 || in.Difficulty > 5 {
			bad("difficulty is 0 to 5")
			return
		}
		t.Difficulty = in.Difficulty
	}
	if keys["favorite"] {
		t.Favorite = in.Favorite
	}
	if keys["tags"] {
		t.Tags = trimTo(in.Tags, 500)
	}
	if keys["notes"] {
		if len(in.Notes) > 100000 {
			bad("notes are too long")
			return
		}
		t.Notes = in.Notes
	}
	if keys["capo"] {
		if in.Capo < 0 || in.Capo > 24 {
			bad("capo is 0 to 24")
			return
		}
		t.Capo = in.Capo
	}
	if keys["goal_speed"] {
		if in.GoalSpeed < 10 || in.GoalSpeed > 300 {
			bad("goal speed is 10 to 300 percent")
			return
		}
		t.GoalSpeed = in.GoalSpeed
	}
	if keys["best_speed"] {
		if in.BestSpeed < 0 || in.BestSpeed > 300 {
			bad("best speed is 0 to 300 percent")
			return
		}
		t.BestSpeed = in.BestSpeed
	}
	if keys["player"] {
		if len(in.Player) > 16000 || !json.Valid(in.Player) || !strings.HasPrefix(strings.TrimSpace(string(in.Player)), "{") {
			bad("player settings must be a JSON object")
			return
		}
		t.Player = in.Player
	}
	if keys["recording"] {
		t.Recording = in.Recording
		if t.Recording != nil && (t.Recording.ID == "" || len(t.Recording.ID) > 200) {
			t.Recording = nil
		}
	}
	if err := s.store.UpdateTab(ctx, uid, t); err != nil {
		s.fail(w, err, "save tab")
		return
	}
	if t.Status == "mastered" && wasStatus != "mastered" {
		s.publish(ctx, uid, "guitar.song_mastered", "tab:"+strconv.FormatInt(t.ID, 10), map[string]any{"tab_id": t.ID, "title": t.Title, "artist": t.Artist})
	}
	out, err := s.store.GetTab(ctx, uid, t.ID)
	if err != nil {
		s.fail(w, err, "tab")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (in tabInput) fieldText(k string) string {
	switch k {
	case "title":
		return in.Title
	case "artist":
		return in.Artist
	case "album":
		return in.Album
	}
	return in.Tabber
}

func trimTo(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		s = s[:n]
	}
	return s
}

type analysisInput struct {
	Title     string           `json:"title"`
	Artist    string           `json:"artist"`
	Album     string           `json:"album"`
	Tabber    string           `json:"tabber"`
	Tempo     int              `json:"tempo"`
	Bars      int              `json:"bars"`
	DurationS int              `json:"duration_s"`
	Tracks    []store.TabTrack `json:"tracks"`
	Tuning    string           `json:"tuning"`
}

// handleAnalysis stores what the browser read from the file. Names only fill
// what is empty or was guessed from the file name; a name the person typed stays.
func (s *Server) handleAnalysis(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	t, err := s.store.GetTab(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "tab")
		return
	}
	var in analysisInput
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if t.NamesFrom != "person" {
		if v := trimTo(in.Title, 200); v != "" && (t.Title == "" || t.NamesFrom == "filename") {
			t.Title = v
			if a := trimTo(in.Artist, 200); a != "" {
				t.Artist = a
			}
			t.NamesFrom = "file"
		}
		if t.Artist == "" {
			t.Artist = trimTo(in.Artist, 200)
		}
	}
	if t.Album == "" {
		t.Album = trimTo(in.Album, 200)
	}
	if t.Tabber == "" {
		t.Tabber = trimTo(in.Tabber, 200)
	}
	clamp := func(v, lo, hi int) int { return max(lo, min(hi, v)) }
	t.Tempo, t.Bars, t.DurationS = clamp(in.Tempo, 0, 1000), clamp(in.Bars, 0, 100000), clamp(in.DurationS, 0, 24*3600)
	if len(in.Tracks) > 64 {
		in.Tracks = in.Tracks[:64]
	}
	for i := range in.Tracks {
		in.Tracks[i].Name = trimTo(in.Tracks[i].Name, 120)
		in.Tracks[i].Instrument = trimTo(in.Tracks[i].Instrument, 120)
		in.Tracks[i].Tuning = trimTo(in.Tracks[i].Tuning, 80)
	}
	t.Tracks = in.Tracks
	t.Tuning = trimTo(in.Tuning, 60)
	if err := s.store.SetAnalysis(ctx, uid, t); err != nil {
		s.fail(w, err, "save analysis")
		return
	}
	out, err := s.store.GetTab(ctx, uid, t.ID)
	if err != nil {
		s.fail(w, err, "tab")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDeleteTab(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	t, err := s.store.GetTab(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "tab")
		return
	}
	if err := s.store.DeleteTab(ctx, uid, t.ID); err != nil {
		s.fail(w, err, "delete tab")
		return
	}
	s.dropBlob(ctx, uid, t.SHA256)
	w.WriteHeader(http.StatusNoContent)
}

// ---- sections ----

type sectionInput struct {
	Name      string `json:"name"`
	StartBar  int    `json:"start_bar"`
	EndBar    int    `json:"end_bar"`
	Speed     int    `json:"speed"`
	GoalSpeed int    `json:"goal_speed"`
	BestSpeed int    `json:"best_speed"`
	Color     string `json:"color"`
	Sort      int    `json:"sort"`
}

func (in sectionInput) apply(keys map[string]bool, x *store.Section) string {
	if keys["name"] {
		x.Name = trimTo(in.Name, 120)
	}
	if keys["start_bar"] {
		x.StartBar = in.StartBar
	}
	if keys["end_bar"] {
		x.EndBar = in.EndBar
	}
	if x.StartBar < 1 || x.EndBar < x.StartBar || x.EndBar > 100000 {
		return "a section runs from a bar to the same or a later bar"
	}
	pct := func(k string, dst *int, v, lo int) string {
		if keys[k] {
			if v < lo || v > 300 {
				return fmt.Sprintf("%s is %d to 300 percent", strings.ReplaceAll(k, "_", " "), lo)
			}
			*dst = v
		}
		return ""
	}
	if m := pct("speed", &x.Speed, in.Speed, 10); m != "" {
		return m
	}
	if m := pct("goal_speed", &x.GoalSpeed, in.GoalSpeed, 10); m != "" {
		return m
	}
	if m := pct("best_speed", &x.BestSpeed, in.BestSpeed, 0); m != "" {
		return m
	}
	if keys["color"] {
		x.Color = trimTo(in.Color, 20)
	}
	if keys["sort"] {
		x.Sort = in.Sort
	}
	if x.Name == "" {
		x.Name = fmt.Sprintf("Bars %d–%d", x.StartBar, x.EndBar)
		if x.StartBar == x.EndBar {
			x.Name = fmt.Sprintf("Bar %d", x.StartBar)
		}
	}
	return ""
}

func (s *Server) handleListSections(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	if _, err := s.store.GetTab(ctx, uid, idParam(r, "id")); err != nil {
		s.fail(w, err, "tab")
		return
	}
	list, err := s.store.ListSections(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "sections")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleCreateSection(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	st, _ := s.store.GetSettings(ctx, uid)
	var in sectionInput
	keys, err := decodeKeys(r, &in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	x := store.Section{TabID: idParam(r, "id"), Speed: st.TrainerStart, GoalSpeed: st.TrainerTarget, StartBar: 1, EndBar: 1}
	if m := in.apply(keys, &x); m != "" {
		writeErr(w, http.StatusBadRequest, m)
		return
	}
	if err := s.store.CreateSection(ctx, uid, &x); err != nil {
		s.fail(w, err, "save section")
		return
	}
	out, err := s.store.GetSection(ctx, uid, x.ID)
	if err != nil {
		s.fail(w, err, "section")
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (s *Server) handleUpdateSection(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	x, err := s.store.GetSection(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "section")
		return
	}
	var in sectionInput
	keys, err := decodeKeys(r, &in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if m := in.apply(keys, x); m != "" {
		writeErr(w, http.StatusBadRequest, m)
		return
	}
	if err := s.store.UpdateSection(ctx, uid, x); err != nil {
		s.fail(w, err, "save section")
		return
	}
	out, err := s.store.GetSection(ctx, uid, x.ID)
	if err != nil {
		s.fail(w, err, "section")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDeleteSection(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := s.store.DeleteSection(ctx, actorID(ctx), idParam(r, "id")); err != nil {
		s.fail(w, err, "delete section")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
