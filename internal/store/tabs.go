package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// The columns of a tab plus what its practice adds up to.
const tabCols = `t.id, t.user_id, t.title, t.artist, t.album, t.tabber, t.names_from, t.format, t.file_name, t.size, t.sha256,
	t.source, t.source_ref, t.folder_id, t.source_stamp, t.source_missing, t.tempo, t.bars, t.duration_s, t.tracks, t.tuning, t.analyzed,
	t.status, t.mastered_at, t.difficulty, t.favorite, t.tags, t.notes, t.capo, t.goal_speed, t.best_speed, t.player, t.recording,
	t.created_at, t.updated_at,
	COALESCE(p.last, ''), COALESCE(p.n, 0), COALESCE(p.secs, 0),
	COALESCE(f.space_name, ''), COALESCE(f.path, '')`

const tabFrom = ` FROM tabs t
	LEFT JOIN (SELECT tab_id, MAX(started_at) AS last, COUNT(1) AS n, SUM(duration_s) AS secs FROM practice WHERE user_id = ? AND tab_id IS NOT NULL GROUP BY tab_id) p ON p.tab_id = t.id
	LEFT JOIN folders f ON f.id = t.folder_id`

// TabStatuses are the learning states, in order.
var TabStatuses = []string{"to_learn", "learning", "polishing", "mastered"}

// ValidStatus reports whether s is a learning state.
func ValidStatus(s string) bool {
	for _, v := range TabStatuses {
		if v == s {
			return true
		}
	}
	return false
}

func scanTab(row interface{ Scan(...any) error }) (*Tab, error) {
	var t Tab
	var folder sql.NullInt64
	var missing, analyzed, fav int
	var tracks, player, rec, spaceName, folderPath string
	if err := row.Scan(&t.ID, &t.UserID, &t.Title, &t.Artist, &t.Album, &t.Tabber, &t.NamesFrom, &t.Format, &t.FileName, &t.Size, &t.SHA256,
		&t.Source, &t.SourceRef, &folder, &t.SourceStamp, &missing, &t.Tempo, &t.Bars, &t.DurationS, &tracks, &t.Tuning, &analyzed,
		&t.Status, &t.MasteredAt, &t.Difficulty, &fav, &t.Tags, &t.Notes, &t.Capo, &t.GoalSpeed, &t.BestSpeed, &player, &rec,
		&t.CreatedAt, &t.UpdatedAt, &t.LastPlayedAt, &t.PlayCount, &t.PracticeS, &spaceName, &folderPath); err != nil {
		return nil, notFound(err)
	}
	if folder.Valid {
		id := folder.Int64
		t.FolderID = &id
	}
	t.SourceMissing, t.Analyzed, t.Favorite = missing == 1, analyzed == 1, fav == 1
	_ = json.Unmarshal([]byte(tracks), &t.Tracks)
	if t.Tracks == nil {
		t.Tracks = []TabTrack{}
	}
	if json.Valid([]byte(player)) {
		t.Player = json.RawMessage(player)
	} else {
		t.Player = json.RawMessage(`{}`)
	}
	if rec != "" {
		var r Recording
		if json.Unmarshal([]byte(rec), &r) == nil && r.ID != "" {
			t.Recording = &r
		}
	}
	t.SourceLabel = sourceLabel(t.Source, t.SourceRef, spaceName)
	return &t, nil
}

// sourceLabel says in plain words where a tab came from.
func sourceLabel(source, ref, space string) string {
	switch source {
	case "upload":
		return "Uploaded"
	case "songsterr":
		return "Songsterr"
	case "import":
		return "Imported"
	case "files":
		where := strings.TrimPrefix(ref, "/")
		if i := strings.LastIndex(where, "/"); i >= 0 {
			where = where[:i]
		} else {
			where = ""
		}
		if space != "" && space != "Home" && space != "My files" {
			where = strings.Trim(space+"/"+where, "/")
		}
		if where == "" {
			return "Pocket Files"
		}
		return "Pocket Files: " + where
	}
	return source
}

// GetTab loads one of a person's tabs.
func (s *Store) GetTab(ctx context.Context, uid, id int64) (*Tab, error) {
	return scanTab(s.DB.QueryRowContext(ctx, `SELECT `+tabCols+tabFrom+` WHERE t.user_id = ? AND t.id = ?`, uid, uid, id))
}

// TabBySHA finds a person's tab with exactly these bytes.
func (s *Store) TabBySHA(ctx context.Context, uid int64, sha string) (*Tab, error) {
	return scanTab(s.DB.QueryRowContext(ctx, `SELECT `+tabCols+tabFrom+` WHERE t.user_id = ? AND t.sha256 = ?`, uid, uid, sha))
}

// TabFilter narrows the library.
type TabFilter struct {
	Q, Status, Tag, Tuning, Artist, Source, Sort string
	Favorite                                     bool
	IDs                                          []int64
	Limit, Offset                                int
}

func (f TabFilter) where(uid int64) (string, []any) {
	conds := []string{"t.user_id = ?"}
	args := []any{uid}
	if q := strings.TrimSpace(f.Q); q != "" {
		for _, w := range strings.Fields(strings.ToLower(q)) {
			conds = append(conds, `(LOWER(t.title) LIKE ? OR LOWER(t.artist) LIKE ? OR LOWER(t.album) LIKE ? OR LOWER(t.tags) LIKE ? OR LOWER(t.file_name) LIKE ?)`)
			like := "%" + w + "%"
			args = append(args, like, like, like, like, like)
		}
	}
	if f.Status != "" {
		conds = append(conds, "t.status = ?")
		args = append(args, f.Status)
	}
	if f.Favorite {
		conds = append(conds, "t.favorite = 1")
	}
	if f.Tag != "" {
		conds = append(conds, "(', ' || t.tags || ',') LIKE ?")
		args = append(args, "%, "+strings.ToLower(f.Tag)+",%")
	}
	if f.Tuning != "" {
		conds = append(conds, "t.tuning = ?")
		args = append(args, f.Tuning)
	}
	if f.Artist != "" {
		conds = append(conds, "t.artist = ?")
		args = append(args, f.Artist)
	}
	if f.Source != "" {
		conds = append(conds, "t.source = ?")
		args = append(args, f.Source)
	}
	if len(f.IDs) > 0 {
		ph := strings.TrimSuffix(strings.Repeat("?,", len(f.IDs)), ",")
		conds = append(conds, "t.id IN ("+ph+")")
		for _, id := range f.IDs {
			args = append(args, id)
		}
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

// ListTabs returns a page of a person's tabs and how many match.
func (s *Store) ListTabs(ctx context.Context, uid int64, f TabFilter) ([]Tab, int, error) {
	where, args := f.where(uid)
	var total int
	if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(1) FROM tabs t`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	order := map[string]string{
		"recent":   "COALESCE(p.last, '') DESC, t.created_at DESC",
		"added":    "t.created_at DESC, t.id DESC",
		"title":    "LOWER(t.title), LOWER(t.artist)",
		"artist":   "LOWER(t.artist), LOWER(t.title)",
		"practice": "COALESCE(p.secs, 0) DESC, LOWER(t.title)",
	}[f.Sort]
	if order == "" {
		order = "LOWER(t.artist), LOWER(t.title)"
	}
	q := `SELECT ` + tabCols + tabFrom + where + ` ORDER BY ` + order
	if f.Limit > 0 {
		q += fmt.Sprintf(" LIMIT %d OFFSET %d", f.Limit, f.Offset)
	}
	rows, err := s.DB.QueryContext(ctx, q, append([]any{uid}, args...)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Tab{}
	for rows.Next() {
		t, err := scanTab(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *t)
	}
	return out, total, rows.Err()
}

// CreateTab saves a new tab. The same bytes twice for one person is a conflict.
func (s *Store) CreateTab(ctx context.Context, uid int64, t *Tab) error {
	if t.Status == "" {
		t.Status = "to_learn"
	}
	if t.GoalSpeed == 0 {
		t.GoalSpeed = 100
	}
	if t.NamesFrom == "" {
		t.NamesFrom = "file"
	}
	tracks, _ := json.Marshal(nonNilTracks(t.Tracks))
	player := string(t.Player)
	if !json.Valid([]byte(player)) {
		player = "{}"
	}
	now := Now()
	created := t.CreatedAt
	if created == "" {
		created = now
	}
	res, err := s.DB.ExecContext(ctx, `INSERT INTO tabs (user_id, title, artist, album, tabber, names_from, format, file_name, size, sha256, source, source_ref,
		folder_id, source_stamp, tempo, bars, duration_s, tracks, tuning, analyzed, status, mastered_at, difficulty, favorite, tags, notes, capo,
		goal_speed, best_speed, player, recording, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		uid, t.Title, t.Artist, t.Album, t.Tabber, t.NamesFrom, t.Format, t.FileName, t.Size, t.SHA256, t.Source, t.SourceRef,
		nullI(t.FolderID), t.SourceStamp, t.Tempo, t.Bars, t.DurationS, string(tracks), t.Tuning, boolInt(t.Analyzed), t.Status, t.MasteredAt,
		t.Difficulty, boolInt(t.Favorite), JoinTags(t.Tags), t.Notes, t.Capo, t.GoalSpeed, t.BestSpeed, player, recordingJSON(t.Recording), created, now)
	if err != nil {
		return conflict(err)
	}
	t.ID, _ = res.LastInsertId()
	return nil
}

func nonNilTracks(t []TabTrack) []TabTrack {
	if t == nil {
		return []TabTrack{}
	}
	return t
}

func recordingJSON(r *Recording) string {
	if r == nil || r.ID == "" {
		return ""
	}
	b, _ := json.Marshal(r)
	return string(b)
}

// UpdateTab saves what a person can change about a tab.
func (s *Store) UpdateTab(ctx context.Context, uid int64, t *Tab) error {
	player := string(t.Player)
	if !json.Valid([]byte(player)) {
		player = "{}"
	}
	if t.Status == "mastered" && t.MasteredAt == "" {
		t.MasteredAt = Now()
	}
	if t.Status != "mastered" {
		t.MasteredAt = ""
	}
	res, err := s.DB.ExecContext(ctx, `UPDATE tabs SET title = ?, artist = ?, album = ?, tabber = ?, names_from = ?, status = ?, mastered_at = ?, difficulty = ?,
		favorite = ?, tags = ?, notes = ?, capo = ?, goal_speed = ?, best_speed = ?, player = ?, recording = ?, updated_at = ?
		WHERE user_id = ? AND id = ?`,
		t.Title, t.Artist, t.Album, t.Tabber, t.NamesFrom, t.Status, t.MasteredAt, t.Difficulty, boolInt(t.Favorite), JoinTags(t.Tags), t.Notes, t.Capo,
		t.GoalSpeed, t.BestSpeed, player, recordingJSON(t.Recording), Now(), uid, t.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetAnalysis stores what was read from the file.
func (s *Store) SetAnalysis(ctx context.Context, uid int64, t *Tab) error {
	tracks, _ := json.Marshal(nonNilTracks(t.Tracks))
	_, err := s.DB.ExecContext(ctx, `UPDATE tabs SET title = ?, artist = ?, album = ?, tabber = ?, names_from = ?, tempo = ?, bars = ?, duration_s = ?, tracks = ?,
		tuning = ?, analyzed = 1, updated_at = ? WHERE user_id = ? AND id = ?`,
		t.Title, t.Artist, t.Album, t.Tabber, t.NamesFrom, t.Tempo, t.Bars, t.DurationS, string(tracks), t.Tuning, Now(), uid, t.ID)
	return err
}

// SetTabSource records where a tab's file lives now (a folder, Songsterr, an upload).
func (s *Store) SetTabSource(ctx context.Context, uid, id int64, source, ref string, folderID *int64, stamp string, missing bool) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE tabs SET source = ?, source_ref = ?, folder_id = ?, source_stamp = ?, source_missing = ?, updated_at = ? WHERE user_id = ? AND id = ?`,
		source, ref, nullI(folderID), stamp, boolInt(missing), Now(), uid, id)
	return err
}

// ReplaceTabFile points a tab at new bytes (the file changed in its folder);
// what was read from the old file is read again.
func (s *Store) ReplaceTabFile(ctx context.Context, uid, id int64, sha string, size int64, format, fileName, stamp string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE tabs SET sha256 = ?, size = ?, format = ?, file_name = ?, source_stamp = ?, source_missing = 0, analyzed = 0, updated_at = ?
		WHERE user_id = ? AND id = ?`, sha, size, format, fileName, stamp, Now(), uid, id)
	return conflict(err)
}

// DeleteTab removes a tab (its sections go with it; practice keeps its title).
func (s *Store) DeleteTab(ctx context.Context, uid, id int64) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM tabs WHERE user_id = ? AND id = ?`, uid, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// TabsInFolder lists a folder's tabs: path → tab.
func (s *Store) TabsInFolder(ctx context.Context, uid, folderID int64) (map[string]Tab, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+tabCols+tabFrom+` WHERE t.user_id = ? AND t.folder_id = ?`, uid, uid, folderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Tab{}
	for rows.Next() {
		t, err := scanTab(rows)
		if err != nil {
			return nil, err
		}
		out[t.SourceRef] = *t
	}
	return out, rows.Err()
}

// SHAInUse reports whether any tab still uses these bytes (files are shared by sha).
func (s *Store) SHAInUse(ctx context.Context, uid int64, sha string) bool {
	var n int
	_ = s.DB.QueryRowContext(ctx, `SELECT COUNT(1) FROM tabs WHERE user_id = ? AND sha256 = ?`, uid, sha).Scan(&n)
	return n > 0
}

// Facet is a value with its count.
type Facet struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// Facets counts tags, tunings, artists and statuses across a person's library.
func (s *Store) Facets(ctx context.Context, uid int64) (map[string]any, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT tags, tuning, artist, status, favorite FROM tabs WHERE user_id = ?`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags, tunings, artists := map[string]int{}, map[string]int{}, map[string]int{}
	status := map[string]int{"to_learn": 0, "learning": 0, "polishing": 0, "mastered": 0}
	favs, total := 0, 0
	for rows.Next() {
		var tg, tu, ar, st string
		var fav int
		if err := rows.Scan(&tg, &tu, &ar, &st, &fav); err != nil {
			return nil, err
		}
		total++
		for _, t := range SplitTags(tg) {
			tags[t]++
		}
		if tu != "" {
			tunings[tu]++
		}
		if ar != "" {
			artists[ar]++
		}
		status[st]++
		favs += fav
	}
	return map[string]any{"tags": sortFacets(tags), "tunings": sortFacets(tunings), "artists": sortFacets(artists), "status": status, "favorites": favs, "total": total}, rows.Err()
}

func sortFacets(m map[string]int) []Facet {
	out := make([]Facet, 0, len(m))
	for k, v := range m {
		out = append(out, Facet{k, v})
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && (out[j].Count > out[j-1].Count || (out[j].Count == out[j-1].Count && strings.ToLower(out[j].Name) < strings.ToLower(out[j-1].Name))); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
