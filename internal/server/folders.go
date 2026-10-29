package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/pocket"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/tabfile"
)

// ---- Pocket Files folders ----
//
// A person links one or more of their Pocket Files folders. Every tab file in
// the folder (and below it) appears in the library; changed files are read
// again, removed ones are marked "no longer in the folder" (the tab and its
// practice stay until the person deletes it). Guitar keeps its own copy of
// each file, so tabs play when Files is away. New tabs can be saved into a
// folder too (Settings → save_folder_id), so the folder stays the one place
// the files live. A sidecar "<file>.meta.json" from TabVault ({title,
// artist, album}) names the song.

const (
	folderMaxFiles = 3000
	folderMaxDepth = 8
)

// syncing tracks folders being synced right now (one sync per folder at a time).
var syncing sync.Map

func (s *Server) filesConn(ctx context.Context, uid int64, write bool) (*siblingConn, error) {
	scopes := []string{scopeFilesRead}
	if write {
		scopes = append(scopes, scopeFilesWrite)
	}
	return s.clients(ctx, uid).conn(ctx, appFiles, scopes...)
}

func (s *Server) handleListFolders(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListFolders(r.Context(), actorID(r.Context()))
	if err != nil {
		s.fail(w, err, "folders")
		return
	}
	for i := range list {
		_, list[i].Syncing = syncing.Load(list[i].ID)
	}
	writeJSON(w, http.StatusOK, list)
}

func cleanPath(p string) string { return path.Clean("/" + strings.ReplaceAll(p, "\\", "/")) }

func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	var in struct {
		Space string `json:"space"`
		Path  string `json:"path"`
		Label string `json:"label"`
	}
	if err := decode(r, &in); err != nil || in.Space == "" {
		writeErr(w, http.StatusBadRequest, "pick a place and a folder")
		return
	}
	conn, err := s.filesConn(ctx, uid, false)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	f := store.Folder{Space: in.Space, Path: cleanPath(in.Path), Label: trimTo(in.Label, 120)}
	spaces, err := conn.client.Spaces(ctx)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Pocket Files: "+err.Error())
		return
	}
	for _, sp := range spaces {
		if sp.ID == f.Space {
			f.SpaceName = sp.Name
		}
	}
	if f.SpaceName == "" {
		writeErr(w, http.StatusBadRequest, "Pocket Files has no such place for you")
		return
	}
	if _, err := conn.client.List(ctx, f.Space, f.Path); err != nil {
		writeErr(w, http.StatusBadRequest, "Pocket Files cannot open that folder: "+err.Error())
		return
	}
	if err := s.store.CreateFolder(ctx, uid, &f); err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeErr(w, http.StatusConflict, "this folder is linked already")
			return
		}
		s.fail(w, err, "save folder")
		return
	}
	go s.syncFolderBG(uid, f.ID)
	out, _ := s.store.GetFolder(ctx, uid, f.ID)
	out.Syncing = true
	writeJSON(w, http.StatusCreated, out)
}

func (s *Server) handleUpdateFolder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	var in struct {
		Label string `json:"label"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if err := s.store.UpdateFolderLabel(ctx, uid, idParam(r, "id"), trimTo(in.Label, 120)); err != nil {
		s.fail(w, err, "save folder")
		return
	}
	out, err := s.store.GetFolder(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "folder")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleDeleteFolder unlinks a folder; ?keep=1 keeps its tabs as uploads.
func (s *Server) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	id := idParam(r, "id")
	shas, _ := s.store.AllSHAs(ctx, uid)
	if err := s.store.DeleteFolder(ctx, uid, id, queryBool(r, "keep")); err != nil {
		s.fail(w, err, "unlink folder")
		return
	}
	for h := range shas {
		s.dropBlob(ctx, uid, h)
	}
	if st, err := s.store.GetSettings(ctx, uid); err == nil && st.SaveFolderID == id {
		st.SaveFolderID = 0
		_ = s.store.SaveUserSettings(ctx, uid, st)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSyncFolder(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	f, err := s.store.GetFolder(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "folder")
		return
	}
	res, err := s.syncFolder(ctx, uid, f)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": res})
}

func (s *Server) handleSyncAll(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	list, err := s.store.ListFolders(ctx, uid)
	if err != nil {
		s.fail(w, err, "folders")
		return
	}
	total := syncResult{}
	var errs []string
	for i := range list {
		res, err := s.syncFolder(ctx, uid, &list[i])
		if err != nil {
			errs = append(errs, firstNonEmpty(list[i].Label, list[i].Path)+": "+err.Error())
			continue
		}
		total.Added += res.Added
		total.Updated += res.Updated
		total.Missing += res.Missing
		total.Skipped += res.Skipped
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": len(errs) == 0, "result": total, "errors": errs})
}

func (s *Server) syncFolderBG(uid, id int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	f, err := s.store.GetFolder(ctx, uid, id)
	if err != nil {
		return
	}
	if _, err := s.syncFolder(ctx, uid, f); err != nil {
		s.log.Warn("folder sync failed", "user", uid, "folder", id, "err", err)
	}
}

type syncResult struct {
	Added   int `json:"added"`
	Updated int `json:"updated"`
	Missing int `json:"missing"`
	Skipped int `json:"skipped"`
	Files   int `json:"files"`
}

type sidecar struct {
	Title  string `json:"title"`
	Artist string `json:"artist"`
	Album  string `json:"album"`
}

// syncFolder brings a folder's tabs into the library.
func (s *Server) syncFolder(ctx context.Context, uid int64, f *store.Folder) (syncResult, error) {
	var res syncResult
	if _, busy := syncing.LoadOrStore(f.ID, true); busy {
		return res, errors.New("this folder is being read right now")
	}
	defer syncing.Delete(f.ID)
	conn, err := s.filesConn(ctx, uid, false)
	if err != nil {
		_ = s.store.SetFolderSync(ctx, uid, f.ID, f.LastSyncAt, err.Error())
		return res, err
	}
	files, sidecars, err := walkFolder(ctx, conn.client, f.Space, f.Path)
	if err != nil {
		err = fmt.Errorf("Pocket Files: %w", err)
		_ = s.store.SetFolderSync(ctx, uid, f.ID, f.LastSyncAt, err.Error())
		return res, err
	}
	res.Files = len(files)
	known, err := s.store.TabsInFolder(ctx, uid, f.ID)
	if err != nil {
		return res, err
	}
	fid := f.ID
	seen := map[string]bool{}
	var lastErr string
	for _, e := range files {
		seen[e.Path] = true
		old, had := known[e.Path]
		if had && old.SourceStamp == e.Stamp() && !old.SourceMissing {
			continue
		}
		data, err := conn.client.Read(ctx, f.Space, e.Path, tabfile.MaxSize)
		if err != nil {
			lastErr = e.Name + ": " + err.Error()
			res.Skipped++
			continue
		}
		sha := shaOf(data)
		if had {
			if sha == old.SHA256 {
				_ = s.store.SetTabSource(ctx, uid, old.ID, "files", e.Path, &fid, e.Stamp(), false)
				continue
			}
			meta, ok := tabfile.Read(e.Name, data)
			if !ok {
				res.Skipped++
				continue
			}
			if err := s.writeBlob(uid, sha, data); err != nil {
				return res, err
			}
			if err := s.store.ReplaceTabFile(ctx, uid, old.ID, sha, int64(len(data)), meta.Format, e.Name, e.Stamp()); err != nil {
				// the new bytes are another tab already: leave this one as it was
				res.Skipped++
				continue
			}
			s.dropBlob(ctx, uid, old.SHA256)
			res.Updated++
			continue
		}
		in := newTab{name: e.Name, data: data, source: "files", ref: e.Path, folderID: &fid, stamp: e.Stamp()}
		if sc, ok := sidecars[e.Path]; ok {
			in.title, in.artist, in.album = sc.Title, sc.Artist, sc.Album
			if sc2, err := readSidecar(ctx, conn.client, f.Space, sc.path); err == nil {
				in.title, in.artist, in.album = sc2.Title, sc2.Artist, sc2.Album
			}
		}
		t, existing, err := s.addTab(ctx, uid, in)
		if err != nil {
			if !errors.Is(err, errNotTab) {
				lastErr = e.Name + ": " + err.Error()
			}
			res.Skipped++
			continue
		}
		if existing {
			// the same file was uploaded (or is in another folder): it lives here now
			if t.FolderID == nil || t.SourceMissing {
				_ = s.store.SetTabSource(ctx, uid, t.ID, "files", e.Path, &fid, e.Stamp(), false)
			}
			continue
		}
		res.Added++
	}
	for p, t := range known {
		if !seen[p] && !t.SourceMissing {
			_ = s.store.SetTabSource(ctx, uid, t.ID, "files", t.SourceRef, &fid, t.SourceStamp, true)
			res.Missing++
		}
	}
	_ = s.store.SetFolderSync(ctx, uid, f.ID, store.Now(), lastErr)
	return res, nil
}

type sidecarRef struct {
	sidecar
	path string
}

// walkFolder lists every tab file below a folder (breadth first, bounded),
// plus TabVault sidecars by the path of the tab they describe.
func walkFolder(ctx context.Context, c *pocket.Client, space, root string) ([]pocket.Entry, map[string]sidecarRef, error) {
	var files []pocket.Entry
	side := map[string]sidecarRef{}
	type item struct {
		path  string
		depth int
	}
	queue := []item{{root, 0}}
	for len(queue) > 0 {
		it := queue[0]
		queue = queue[1:]
		l, err := c.List(ctx, space, it.path)
		if err != nil {
			if it.path == root {
				return nil, nil, err
			}
			continue
		}
		for _, e := range l.Entries {
			switch {
			case e.IsDir:
				if it.depth < folderMaxDepth && !strings.HasPrefix(e.Name, ".") {
					queue = append(queue, item{e.Path, it.depth + 1})
				}
			case strings.HasSuffix(strings.ToLower(e.Name), ".meta.json"):
				side[strings.TrimSuffix(e.Path, ".meta.json")] = sidecarRef{path: e.Path}
			case tabfile.Supported(e.Name) && e.Size > 0 && e.Size <= tabfile.MaxSize:
				files = append(files, e)
			}
			if len(files) >= folderMaxFiles {
				return files, side, nil
			}
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, side, nil
}

func readSidecar(ctx context.Context, c *pocket.Client, space, p string) (sidecar, error) {
	var sc sidecar
	b, err := c.Read(ctx, space, p, 64<<10)
	if err != nil {
		return sc, err
	}
	err = json.Unmarshal(b, &sc)
	sc.Title, sc.Artist, sc.Album = trimTo(sc.Title, 200), trimTo(sc.Artist, 200), trimTo(sc.Album, 200)
	return sc, err
}

// keepInFolder saves a new tab's file into the person's chosen Pocket Files
// folder (Settings → where new tabs go), so the folder holds every tab. On
// any failure the tab simply stays here.
func (s *Server) keepInFolder(ctx context.Context, cl *clients, t *store.Tab, data []byte) *store.Tab {
	if cl.st.SaveFolderID == 0 || t == nil {
		return nil
	}
	f, err := s.store.GetFolder(ctx, cl.u.ID, cl.st.SaveFolderID)
	if err != nil {
		return nil
	}
	conn, err := cl.conn(ctx, appFiles, scopeFilesRead, scopeFilesWrite)
	if err != nil {
		s.log.Debug("save to folder: not connected", "err", err)
		return nil
	}
	name := t.FileName
	if t.Source == "songsterr" || name == "" {
		name = safeFileName(t.Name()) + "." + extFor(t.Format)
	}
	e, err := conn.client.Upload(ctx, f.Space, f.Path, name, data)
	if err != nil {
		s.log.Warn("save to folder failed", "user", cl.u.ID, "folder", f.ID, "err", err)
		return nil
	}
	fid := f.ID
	_ = s.store.SetTabSource(ctx, cl.u.ID, t.ID, "files", e.Path, &fid, e.Stamp(), false)
	out, err := s.store.GetTab(ctx, cl.u.ID, t.ID)
	if err != nil {
		return nil
	}
	return out
}

func safeFileName(s string) string {
	s = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`\/:*?"<>|`, r) || r < 32 {
			return '_'
		}
		return r
	}, s)
	return trimTo(strings.ReplaceAll(s, "–", "-"), 150)
}

func extFor(format string) string {
	switch format {
	case "musicxml":
		return "musicxml"
	case "alphatex":
		return "tex"
	case "":
		return "gp"
	}
	return format
}

// ---- browsing Pocket Files (the folder picker) ----

func (s *Server) handleFilesSpaces(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	conn, err := s.filesConn(ctx, actorID(ctx), false)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "not_connected": isNotConnected(err), "error": err.Error(), "spaces": []any{}})
		return
	}
	spaces, err := conn.client.Spaces(ctx)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Pocket Files: " + err.Error(), "spaces": []any{}})
		return
	}
	out := []map[string]any{}
	for _, sp := range spaces {
		if !sp.IsDir {
			continue
		}
		out = append(out, map[string]any{"id": sp.ID, "name": sp.Name, "kind": sp.Kind, "writable": sp.Perm == "edit" && !sp.ReadOnly})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "via": conn.via, "spaces": out, "open_url": conn.public})
}

func (s *Server) handleFilesBrowse(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	space, p := r.URL.Query().Get("space"), cleanPath(r.URL.Query().Get("path"))
	conn, err := s.filesConn(ctx, actorID(ctx), false)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "not_connected": isNotConnected(err), "error": err.Error(), "space": space, "path": p, "folders": []any{}})
		return
	}
	l, err := conn.client.List(ctx, space, p)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "Pocket Files: " + err.Error(), "space": space, "path": p, "folders": []any{}})
		return
	}
	folders := []map[string]string{}
	tabs := 0
	for _, e := range l.Entries {
		if e.IsDir {
			if !strings.HasPrefix(e.Name, ".") {
				folders = append(folders, map[string]string{"name": e.Name, "path": e.Path})
			}
		} else if tabfile.Supported(e.Name) {
			tabs++
		}
	}
	sort.Slice(folders, func(i, j int) bool { return strings.ToLower(folders[i]["name"]) < strings.ToLower(folders[j]["name"]) })
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "space": space, "path": p, "folders": folders, "tab_files": tabs, "writable": l.Writable})
}

// syncAllFolders runs every 15 minutes for every linked folder on the box.
func (s *Server) syncAllFolders(ctx context.Context) {
	list, err := s.store.AllFolders(ctx)
	if err != nil {
		return
	}
	for i := range list {
		f := list[i]
		cctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		if _, err := s.syncFolder(cctx, f.UserID, &f); err != nil && !isNotConnected(err) {
			s.log.Debug("folder sync", "user", f.UserID, "folder", f.ID, "err", err)
		}
		cancel()
	}
}
