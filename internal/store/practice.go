package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// ---- sections ----

const sectionCols = `s.id, s.user_id, s.tab_id, s.name, s.start_bar, s.end_bar, s.speed, s.goal_speed, s.best_speed, s.color, s.sort, s.created_at,
	COALESCE((SELECT MAX(started_at) FROM practice WHERE user_id = s.user_id AND section_id = s.id), ''),
	COALESCE((SELECT SUM(duration_s) FROM practice WHERE user_id = s.user_id AND section_id = s.id), 0)`

func scanSection(row interface{ Scan(...any) error }) (*Section, error) {
	var x Section
	if err := row.Scan(&x.ID, &x.UserID, &x.TabID, &x.Name, &x.StartBar, &x.EndBar, &x.Speed, &x.GoalSpeed, &x.BestSpeed, &x.Color, &x.Sort, &x.CreatedAt,
		&x.LastPracticedAt, &x.PracticeS); err != nil {
		return nil, notFound(err)
	}
	return &x, nil
}

// ListSections returns a tab's sections in song order.
func (s *Store) ListSections(ctx context.Context, uid, tabID int64) ([]Section, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+sectionCols+` FROM sections s WHERE s.user_id = ? AND s.tab_id = ? ORDER BY s.sort, s.start_bar, s.id`, uid, tabID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Section{}
	for rows.Next() {
		x, err := scanSection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *x)
	}
	return out, rows.Err()
}

// GetSection loads one of a person's sections.
func (s *Store) GetSection(ctx context.Context, uid, id int64) (*Section, error) {
	return scanSection(s.DB.QueryRowContext(ctx, `SELECT `+sectionCols+` FROM sections s WHERE s.user_id = ? AND s.id = ?`, uid, id))
}

// CreateSection adds a section to one of the person's tabs.
func (s *Store) CreateSection(ctx context.Context, uid int64, x *Section) error {
	res, err := s.DB.ExecContext(ctx, `INSERT INTO sections (user_id, tab_id, name, start_bar, end_bar, speed, goal_speed, best_speed, color, sort, created_at)
		SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM tabs WHERE user_id = ? AND id = ?`,
		uid, x.Name, x.StartBar, x.EndBar, x.Speed, x.GoalSpeed, x.BestSpeed, x.Color, x.Sort, firstSet(x.CreatedAt, Now()), uid, x.TabID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	x.ID, _ = res.LastInsertId()
	return nil
}

// UpdateSection saves a section.
func (s *Store) UpdateSection(ctx context.Context, uid int64, x *Section) error {
	res, err := s.DB.ExecContext(ctx, `UPDATE sections SET name = ?, start_bar = ?, end_bar = ?, speed = ?, goal_speed = ?, best_speed = ?, color = ?, sort = ?
		WHERE user_id = ? AND id = ?`, x.Name, x.StartBar, x.EndBar, x.Speed, x.GoalSpeed, x.BestSpeed, x.Color, x.Sort, uid, x.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteSection removes a section (its practice stays, without the section).
func (s *Store) DeleteSection(ctx context.Context, uid, id int64) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM sections WHERE user_id = ? AND id = ?`, uid, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func firstSet(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// ---- practice ----

const practiceCols = `id, user_id, tab_id, section_id, title, kind, started_at, ended_at, date, duration_s, speed, loops, note, source, external_id,
	habit_marked_at, habit_error, created_at, updated_at`

func scanPractice(row interface{ Scan(...any) error }) (*Practice, error) {
	var p Practice
	var tab, sec sql.NullInt64
	if err := row.Scan(&p.ID, &p.UserID, &tab, &sec, &p.Title, &p.Kind, &p.StartedAt, &p.EndedAt, &p.Date, &p.DurationS, &p.Speed, &p.Loops, &p.Note,
		&p.Source, &p.ExternalID, &p.HabitMarkedAt, &p.HabitError, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, notFound(err)
	}
	if tab.Valid {
		v := tab.Int64
		p.TabID = &v
	}
	if sec.Valid {
		v := sec.Int64
		p.SectionID = &v
	}
	return &p, nil
}

// ParseTime reads RFC3339 (with or without fraction) or a local "2006-01-02T15:04".
func ParseTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, f := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		var t time.Time
		var err error
		if strings.Contains(f, "Z07") {
			t, err = time.Parse(f, s)
		} else {
			t, err = time.ParseInLocation(f, s, time.Local)
		}
		if err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// normalize fills the derived fields: the local date from the start, the end from the length.
func (p *Practice) normalize() {
	if t, ok := ParseTime(p.StartedAt); ok {
		p.StartedAt = t.Format(time.RFC3339)
		p.Date = t.In(time.Local).Format("2006-01-02")
		if p.DurationS > 0 {
			p.EndedAt = t.Add(time.Duration(p.DurationS) * time.Second).Format(time.RFC3339)
		}
	}
	if p.Source == "" {
		p.Source = "app"
	}
	if p.Kind != "free" {
		p.Kind = "tab"
	}
}

// CreatePractice saves practice time. With an external id the same session
// sent again (the player saves every minute, a retry, a linked app) updates
// the row it made the first time instead of adding another.
func (s *Store) CreatePractice(ctx context.Context, uid int64, p *Practice) error {
	p.normalize()
	now := Now()
	res, err := s.DB.ExecContext(ctx, `INSERT INTO practice (user_id, tab_id, section_id, title, kind, started_at, ended_at, date, duration_s, speed, loops, note,
		source, external_id, created_at, updated_at)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE (? IS NULL OR EXISTS (SELECT 1 FROM tabs WHERE user_id = ? AND id = ?))
		  AND (? IS NULL OR EXISTS (SELECT 1 FROM sections WHERE user_id = ? AND id = ?))
		ON CONFLICT(user_id, source, external_id) WHERE external_id <> '' DO UPDATE SET tab_id = excluded.tab_id, section_id = excluded.section_id,
		title = excluded.title, kind = excluded.kind, started_at = excluded.started_at, ended_at = excluded.ended_at, date = excluded.date,
		duration_s = MAX(practice.duration_s, excluded.duration_s), speed = MAX(practice.speed, excluded.speed), loops = MAX(practice.loops, excluded.loops),
		note = CASE WHEN excluded.note <> '' THEN excluded.note ELSE practice.note END, updated_at = excluded.updated_at, habit_marked_at = ''`,
		uid, nullI(p.TabID), nullI(p.SectionID), p.Title, p.Kind, p.StartedAt, p.EndedAt, p.Date, p.DurationS, p.Speed, p.Loops, p.Note, p.Source, p.ExternalID, now, now,
		nullI(p.TabID), uid, nullI(p.TabID), nullI(p.SectionID), uid, nullI(p.SectionID))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if p.ExternalID != "" {
		return s.DB.QueryRowContext(ctx, `SELECT id FROM practice WHERE user_id = ? AND source = ? AND external_id = ?`, uid, p.Source, p.ExternalID).Scan(&p.ID)
	}
	p.ID, _ = res.LastInsertId()
	return nil
}

// GetPractice loads one of a person's sessions.
func (s *Store) GetPractice(ctx context.Context, uid, id int64) (*Practice, error) {
	return scanPractice(s.DB.QueryRowContext(ctx, `SELECT `+practiceCols+` FROM practice WHERE user_id = ? AND id = ?`, uid, id))
}

// UpdatePractice saves the editable fields; habit rules look at the day again.
func (s *Store) UpdatePractice(ctx context.Context, uid int64, p *Practice) error {
	p.normalize()
	res, err := s.DB.ExecContext(ctx, `UPDATE practice SET tab_id = ?, section_id = ?, title = ?, kind = ?, started_at = ?, ended_at = ?, date = ?, duration_s = ?,
		speed = ?, loops = ?, note = ?, habit_marked_at = '', habit_error = '', updated_at = ? WHERE user_id = ? AND id = ?
		AND (? IS NULL OR EXISTS (SELECT 1 FROM tabs WHERE user_id = ? AND id = ?))`,
		nullI(p.TabID), nullI(p.SectionID), p.Title, p.Kind, p.StartedAt, p.EndedAt, p.Date, p.DurationS, p.Speed, p.Loops, p.Note, Now(), uid, p.ID,
		nullI(p.TabID), uid, nullI(p.TabID))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeletePractice removes a session.
func (s *Store) DeletePractice(ctx context.Context, uid, id int64) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM practice WHERE user_id = ? AND id = ?`, uid, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// PracticeFilter narrows the practice log.
type PracticeFilter struct {
	From, To      string
	TabID         int64
	Asc           bool
	Limit, Offset int
}

// ListPractice returns a page of a person's sessions and how many match.
func (s *Store) ListPractice(ctx context.Context, uid int64, f PracticeFilter) ([]Practice, int, error) {
	conds := []string{"user_id = ?"}
	args := []any{uid}
	if f.From != "" {
		conds = append(conds, "date >= ?")
		args = append(args, f.From)
	}
	if f.To != "" {
		conds = append(conds, "date <= ?")
		args = append(args, f.To)
	}
	if f.TabID > 0 {
		conds = append(conds, "tab_id = ?")
		args = append(args, f.TabID)
	}
	where := " WHERE " + strings.Join(conds, " AND ")
	var total int
	if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(1) FROM practice`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	dir := "DESC"
	if f.Asc {
		dir = "ASC"
	}
	q := `SELECT ` + practiceCols + ` FROM practice` + where + ` ORDER BY started_at ` + dir + `, id ` + dir
	if f.Limit > 0 {
		q += fmt.Sprintf(" LIMIT %d OFFSET %d", f.Limit, f.Offset)
	}
	rows, err := s.DB.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Practice{}
	for rows.Next() {
		p, err := scanPractice(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *p)
	}
	return out, total, rows.Err()
}

// DaySeconds sums practice per local day in [from, to].
func (s *Store) DaySeconds(ctx context.Context, uid int64, from, to string) (map[string]int, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT date, SUM(duration_s) FROM practice WHERE user_id = ? AND date >= ? AND date <= ? GROUP BY date`, uid, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var d string
		var n int
		if err := rows.Scan(&d, &n); err != nil {
			return nil, err
		}
		out[d] = n
	}
	return out, rows.Err()
}

// PracticeDates lists every day with practice, oldest first.
func (s *Store) PracticeDates(ctx context.Context, uid int64) ([]string, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT DISTINCT date FROM practice WHERE user_id = ? AND duration_s > 0 ORDER BY date`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// SetHabitMark records that the habit rules looked at a session (or why not).
func (s *Store) SetHabitMark(ctx context.Context, uid, id int64, markedAt, errText string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE practice SET habit_marked_at = ?, habit_error = ? WHERE user_id = ? AND id = ?`, markedAt, errText, uid, id)
	return err
}

// PendingHabits lists recent sessions no habit rule has looked at yet.
func (s *Store) PendingHabits(ctx context.Context, uid int64, since string) ([]Practice, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+practiceCols+` FROM practice WHERE user_id = ? AND date >= ? AND habit_marked_at = '' ORDER BY started_at`, uid, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Practice
	for rows.Next() {
		p, err := scanPractice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// DayMinutes is a day's practice in minutes.
func (s *Store) DayMinutes(ctx context.Context, uid int64, date string) float64 {
	var n int
	_ = s.DB.QueryRowContext(ctx, `SELECT COALESCE(SUM(duration_s), 0) FROM practice WHERE user_id = ? AND date = ?`, uid, date).Scan(&n)
	return float64(n) / 60
}

// TabSecondsSince sums practice per tab since a date (for "most practised").
type TabTime struct {
	TabID    *int64 `json:"tab_id"`
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Seconds  int    `json:"seconds"`
	Sessions int    `json:"sessions"`
}

// TimeByTab sums practice per song (or per free title) in [from, to].
func (s *Store) TimeByTab(ctx context.Context, uid int64, from, to string, limit int) ([]TabTime, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT p.tab_id, COALESCE(t.title, p.title), COALESCE(t.artist, ''), SUM(p.duration_s), COUNT(1)
		FROM practice p LEFT JOIN tabs t ON t.id = p.tab_id AND t.user_id = p.user_id
		WHERE p.user_id = ? AND p.date >= ? AND p.date <= ?
		GROUP BY COALESCE(CAST(p.tab_id AS TEXT), 'free:' || p.title) ORDER BY SUM(p.duration_s) DESC LIMIT ?`, uid, from, to, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TabTime{}
	for rows.Next() {
		var x TabTime
		var id sql.NullInt64
		if err := rows.Scan(&id, &x.Title, &x.Artist, &x.Seconds, &x.Sessions); err != nil {
			return nil, err
		}
		if id.Valid {
			v := id.Int64
			x.TabID = &v
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// ---- habit rules ----

func scanRule(row interface{ Scan(...any) error }) (*HabitRule, error) {
	var r HabitRule
	var en int
	if err := row.Scan(&r.ID, &r.UserID, &r.MinMinutes, &r.HabitID, &r.HabitName, &en, &r.CreatedAt); err != nil {
		return nil, notFound(err)
	}
	r.Enabled = en == 1
	return &r, nil
}

const ruleCols = `id, user_id, min_minutes, habit_id, habit_name, enabled, created_at`

// ListRules returns a person's habit rules.
func (s *Store) ListRules(ctx context.Context, uid int64) ([]HabitRule, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT `+ruleCols+` FROM habit_rules WHERE user_id = ? ORDER BY id`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HabitRule{}
	for rows.Next() {
		r, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// GetRule loads one of a person's rules.
func (s *Store) GetRule(ctx context.Context, uid, id int64) (*HabitRule, error) {
	return scanRule(s.DB.QueryRowContext(ctx, `SELECT `+ruleCols+` FROM habit_rules WHERE user_id = ? AND id = ?`, uid, id))
}

// CreateRule saves a rule.
func (s *Store) CreateRule(ctx context.Context, uid int64, r *HabitRule) error {
	res, err := s.DB.ExecContext(ctx, `INSERT INTO habit_rules (user_id, min_minutes, habit_id, habit_name, enabled) VALUES (?, ?, ?, ?, ?)`,
		uid, r.MinMinutes, r.HabitID, r.HabitName, boolInt(r.Enabled))
	if err != nil {
		return err
	}
	r.ID, _ = res.LastInsertId()
	r.CreatedAt = Now()
	return nil
}

// UpdateRule saves a rule.
func (s *Store) UpdateRule(ctx context.Context, uid int64, r *HabitRule) error {
	res, err := s.DB.ExecContext(ctx, `UPDATE habit_rules SET min_minutes = ?, habit_id = ?, habit_name = ?, enabled = ? WHERE user_id = ? AND id = ?`,
		r.MinMinutes, r.HabitID, r.HabitName, boolInt(r.Enabled), uid, r.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteRule removes a rule.
func (s *Store) DeleteRule(ctx context.Context, uid, id int64) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM habit_rules WHERE user_id = ? AND id = ?`, uid, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// HabitMarked reports whether a rule already ticked its habit that day.
func (s *Store) HabitMarked(ctx context.Context, uid, ruleID int64, date string) bool {
	var n int
	_ = s.DB.QueryRowContext(ctx, `SELECT COUNT(1) FROM habit_marks WHERE user_id = ? AND rule_id = ? AND date = ?`, uid, ruleID, date).Scan(&n)
	return n > 0
}

// MarkHabitDay remembers that a rule ticked its habit that day.
func (s *Store) MarkHabitDay(ctx context.Context, uid, ruleID int64, date string) error {
	_, err := s.DB.ExecContext(ctx, `INSERT OR IGNORE INTO habit_marks (user_id, rule_id, date, marked_at) VALUES (?, ?, ?, ?)`, uid, ruleID, date, Now())
	return err
}
