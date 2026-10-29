package store

import (
	"context"
	"strings"
)

// ---- setlists ----

func (s *Store) setlistItems(ctx context.Context, uid, id int64) ([]int64, int, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT i.tab_id, t.duration_s FROM setlist_items i JOIN tabs t ON t.id = i.tab_id AND t.user_id = i.user_id
		WHERE i.user_id = ? AND i.setlist_id = ? ORDER BY i.sort, i.tab_id`, uid, id)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	ids := []int64{}
	dur := 0
	for rows.Next() {
		var tid int64
		var d int
		if err := rows.Scan(&tid, &d); err != nil {
			return nil, 0, err
		}
		ids = append(ids, tid)
		dur += d
	}
	return ids, dur, rows.Err()
}

// ListSetlists returns a person's setlists with their songs' ids.
func (s *Store) ListSetlists(ctx context.Context, uid int64) ([]Setlist, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id, name, note, created_at, updated_at FROM setlists WHERE user_id = ? ORDER BY LOWER(name), id`, uid)
	if err != nil {
		return nil, err
	}
	out := []Setlist{}
	for rows.Next() {
		var l Setlist
		if err := rows.Scan(&l.ID, &l.Name, &l.Note, &l.CreatedAt, &l.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, l)
	}
	rows.Close()
	for i := range out {
		out[i].TabIDs, out[i].DurationS, err = s.setlistItems(ctx, uid, out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Count = len(out[i].TabIDs)
	}
	return out, nil
}

// GetSetlist loads one of a person's setlists.
func (s *Store) GetSetlist(ctx context.Context, uid, id int64) (*Setlist, error) {
	var l Setlist
	if err := s.DB.QueryRowContext(ctx, `SELECT id, name, note, created_at, updated_at FROM setlists WHERE user_id = ? AND id = ?`, uid, id).
		Scan(&l.ID, &l.Name, &l.Note, &l.CreatedAt, &l.UpdatedAt); err != nil {
		return nil, notFound(err)
	}
	var err error
	l.TabIDs, l.DurationS, err = s.setlistItems(ctx, uid, id)
	l.Count = len(l.TabIDs)
	return &l, err
}

// SaveSetlist creates (ID 0) or updates a setlist and replaces its songs.
// Ids that are not the person's own tabs are dropped.
func (s *Store) SaveSetlist(ctx context.Context, uid int64, l *Setlist) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	now := Now()
	l.Name = strings.TrimSpace(l.Name)
	if l.ID == 0 {
		res, err := tx.ExecContext(ctx, `INSERT INTO setlists (user_id, name, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, uid, l.Name, l.Note, now, now)
		if err != nil {
			return err
		}
		l.ID, _ = res.LastInsertId()
	} else {
		res, err := tx.ExecContext(ctx, `UPDATE setlists SET name = ?, note = ?, updated_at = ? WHERE user_id = ? AND id = ?`, l.Name, l.Note, now, uid, l.ID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
	}
	if l.TabIDs != nil {
		if _, err := tx.ExecContext(ctx, `DELETE FROM setlist_items WHERE user_id = ? AND setlist_id = ?`, uid, l.ID); err != nil {
			return err
		}
		for i, tid := range l.TabIDs {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO setlist_items (user_id, setlist_id, tab_id, sort) SELECT ?, ?, id, ? FROM tabs WHERE user_id = ? AND id = ?`,
				uid, l.ID, i, uid, tid); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// DeleteSetlist removes a setlist (never its songs).
func (s *Store) DeleteSetlist(ctx context.Context, uid, id int64) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM setlists WHERE user_id = ? AND id = ?`, uid, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- Pocket Files folders ----

const folderCols = `f.id, f.user_id, f.space, f.space_name, f.path, f.label, f.last_sync_at, f.last_error, f.created_at,
	(SELECT COUNT(1) FROM tabs WHERE user_id = f.user_id AND folder_id = f.id AND source_missing = 0)`

func scanFolder(row interface{ Scan(...any) error }) (*Folder, error) {
	var f Folder
	if err := row.Scan(&f.ID, &f.UserID, &f.Space, &f.SpaceName, &f.Path, &f.Label, &f.LastSyncAt, &f.LastError, &f.CreatedAt, &f.TabCount); err != nil {
		return nil, notFound(err)
	}
	return &f, nil
}

// ListFolders returns a person's linked folders.
func (s *Store) ListFolders(ctx context.Context, uid int64) ([]Folder, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+folderCols+` FROM folders f WHERE f.user_id = ? ORDER BY f.id`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Folder{}
	for rows.Next() {
		f, err := scanFolder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

// GetFolder loads one of a person's folders.
func (s *Store) GetFolder(ctx context.Context, uid, id int64) (*Folder, error) {
	return scanFolder(s.DB.QueryRowContext(ctx, `SELECT `+folderCols+` FROM folders f WHERE f.user_id = ? AND f.id = ?`, uid, id))
}

// CreateFolder links a folder; the same folder twice is a conflict.
func (s *Store) CreateFolder(ctx context.Context, uid int64, f *Folder) error {
	res, err := s.DB.ExecContext(ctx, `INSERT INTO folders (user_id, space, space_name, path, label) VALUES (?, ?, ?, ?, ?)`, uid, f.Space, f.SpaceName, f.Path, f.Label)
	if err != nil {
		return conflict(err)
	}
	f.ID, _ = res.LastInsertId()
	return nil
}

// UpdateFolderLabel renames a folder link.
func (s *Store) UpdateFolderLabel(ctx context.Context, uid, id int64, label string) error {
	res, err := s.DB.ExecContext(ctx, `UPDATE folders SET label = ? WHERE user_id = ? AND id = ?`, label, uid, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetFolderSync records the outcome of a sync.
func (s *Store) SetFolderSync(ctx context.Context, uid, id int64, at, errText string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE folders SET last_sync_at = ?, last_error = ? WHERE user_id = ? AND id = ?`, at, errText, uid, id)
	return err
}

// DeleteFolder unlinks a folder. Its tabs stay in the library (as uploads
// when keep is true), or go when keep is false.
func (s *Store) DeleteFolder(ctx context.Context, uid, id int64, keep bool) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if keep {
		if _, err := tx.ExecContext(ctx, `UPDATE tabs SET source = 'upload', source_ref = '', folder_id = NULL, source_stamp = '', source_missing = 0 WHERE user_id = ? AND folder_id = ?`, uid, id); err != nil {
			return err
		}
	} else if _, err := tx.ExecContext(ctx, `DELETE FROM tabs WHERE user_id = ? AND folder_id = ?`, uid, id); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM folders WHERE user_id = ? AND id = ?`, uid, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return tx.Commit()
}

// AllFolders lists every linked folder on the box (the background sync).
func (s *Store) AllFolders(ctx context.Context) ([]Folder, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+folderCols+` FROM folders f ORDER BY f.user_id, f.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Folder{}
	for rows.Next() {
		f, err := scanFolder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

// AllSHAs lists every file hash a person's tabs use (orphaned files are cleaned).
func (s *Store) AllSHAs(ctx context.Context, uid int64) (map[string]bool, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT sha256 FROM tabs WHERE user_id = ?`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			return nil, err
		}
		out[h] = true
	}
	return out, rows.Err()
}
