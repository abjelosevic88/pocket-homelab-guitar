package server

import (
	"net/http"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// ---- setlists ----

type setlistInput struct {
	Name   string  `json:"name"`
	Note   string  `json:"note"`
	TabIDs []int64 `json:"tab_ids"`
}

func (s *Server) handleListSetlists(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListSetlists(r.Context(), actorID(r.Context()))
	if err != nil {
		s.fail(w, err, "setlists")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// setlistWithTabs loads a setlist and its songs in order.
func (s *Server) setlistWithTabs(r *http.Request, id int64) (*store.Setlist, error) {
	ctx := r.Context()
	uid := actorID(ctx)
	l, err := s.store.GetSetlist(ctx, uid, id)
	if err != nil {
		return nil, err
	}
	l.Tabs = []store.Tab{}
	if len(l.TabIDs) == 0 {
		return l, nil
	}
	tabs, _, err := s.store.ListTabs(ctx, uid, store.TabFilter{IDs: l.TabIDs})
	if err != nil {
		return nil, err
	}
	by := map[int64]store.Tab{}
	for _, t := range tabs {
		by[t.ID] = t
	}
	for _, id := range l.TabIDs {
		if t, ok := by[id]; ok {
			l.Tabs = append(l.Tabs, t)
		}
	}
	return l, nil
}

func (s *Server) handleGetSetlist(w http.ResponseWriter, r *http.Request) {
	l, err := s.setlistWithTabs(r, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "setlist")
		return
	}
	writeJSON(w, http.StatusOK, l)
}

func (s *Server) handleCreateSetlist(w http.ResponseWriter, r *http.Request) {
	var in setlistInput
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	l := store.Setlist{Name: trimTo(in.Name, 120), Note: trimTo(in.Note, 2000), TabIDs: in.TabIDs}
	if l.Name == "" {
		writeErr(w, http.StatusBadRequest, "give the setlist a name")
		return
	}
	if l.TabIDs == nil {
		l.TabIDs = []int64{}
	}
	if err := s.store.SaveSetlist(r.Context(), actorID(r.Context()), &l); err != nil {
		s.fail(w, err, "save setlist")
		return
	}
	out, err := s.setlistWithTabs(r, l.ID)
	if err != nil {
		s.fail(w, err, "setlist")
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (s *Server) handleUpdateSetlist(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	l, err := s.store.GetSetlist(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "setlist")
		return
	}
	var in setlistInput
	keys, err := decodeKeys(r, &in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if keys["name"] {
		l.Name = trimTo(in.Name, 120)
		if l.Name == "" {
			writeErr(w, http.StatusBadRequest, "give the setlist a name")
			return
		}
	}
	if keys["note"] {
		l.Note = trimTo(in.Note, 2000)
	}
	l.TabIDs = nil
	if keys["tab_ids"] {
		l.TabIDs = in.TabIDs
		if l.TabIDs == nil {
			l.TabIDs = []int64{}
		}
	}
	if err := s.store.SaveSetlist(ctx, uid, l); err != nil {
		s.fail(w, err, "save setlist")
		return
	}
	out, err := s.setlistWithTabs(r, l.ID)
	if err != nil {
		s.fail(w, err, "setlist")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDeleteSetlist(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteSetlist(r.Context(), actorID(r.Context()), idParam(r, "id")); err != nil {
		s.fail(w, err, "delete setlist")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
