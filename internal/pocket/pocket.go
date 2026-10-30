// Package pocket talks to sibling Pocket apps: Pocket Habits (a day's
// practice ticks a habit) and Pocket Files (folders of tabs). Same
// bearer-token JSON API everywhere.
package pocket

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Client is a bearer-token JSON client for one Pocket app.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// New creates a client.
func New(baseURL, token string, timeout time.Duration) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), Token: token, HTTP: &http.Client{Timeout: timeout}}
}

// Configured reports whether URL and token are set.
func (c *Client) Configured() bool { return c != nil && c.BaseURL != "" && c.Token != "" }

// ErrNotFound is a 404 from the sibling app.
var ErrNotFound = errors.New("not found")

func (c *Client) do(ctx context.Context, method, path string, q url.Values, body any, v any) error {
	_, err := c.call(ctx, method, path, q, body, v, false)
	return err
}

// Call is one JSON request. A 409 Conflict is an answer, not a failure: its
// body (what is in the way) is decoded into v and the status returned with a
// nil error. Every other status of 300 and up is an error.
func (c *Client) Call(ctx context.Context, method, path string, q url.Values, body any, v any) (int, error) {
	return c.call(ctx, method, path, q, body, v, true)
}

func (c *Client) call(ctx context.Context, method, path string, q url.Values, body any, v any, conflictOK bool) (int, error) {
	if !c.Configured() {
		return 0, errors.New("not configured")
	}
	u := c.BaseURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return res.StatusCode, errors.New("token rejected (401)")
	}
	if res.StatusCode == http.StatusNotFound {
		return res.StatusCode, ErrNotFound
	}
	if res.StatusCode >= 300 && (res.StatusCode != http.StatusConflict || !conflictOK) {
		var e struct {
			Error string `json:"error"`
		}
		b, _ := io.ReadAll(io.LimitReader(res.Body, 2000))
		_ = json.Unmarshal(b, &e)
		if e.Error != "" {
			return res.StatusCode, fmt.Errorf("HTTP %d: %s", res.StatusCode, e.Error)
		}
		return res.StatusCode, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	if v == nil || res.StatusCode == http.StatusNoContent {
		return res.StatusCode, nil
	}
	return res.StatusCode, json.NewDecoder(res.Body).Decode(v)
}

// Health is the connection test for any Pocket app: /healthz plus a token check.
func (c *Client) Health(ctx context.Context) (string, error) {
	var out struct {
		Status  string `json:"status"`
		Version string `json:"version"`
	}
	if !c.Configured() {
		return "", errors.New("not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/healthz", nil)
	if err != nil {
		return "", err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	var me map[string]any
	if err := c.do(ctx, http.MethodGet, "/api/v1/auth/me", nil, nil, &me); err != nil {
		return out.Version, err
	}
	return out.Version, nil
}

// ---------------- Pocket Habits ----------------

// Habit is a Pocket Habits habit.
type Habit struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
	Days  string `json:"days"`
}

// Habits lists the person's habits.
func (c *Client) Habits(ctx context.Context) ([]Habit, error) {
	var out []Habit
	if err := c.do(ctx, http.MethodGet, "/api/v1/habits", nil, nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []Habit{}
	}
	return out, nil
}

// MarkHabit ticks a habit on a date (status 1 = done).
func (c *Client) MarkHabit(ctx context.Context, habitID int64, date string) error {
	return c.do(ctx, http.MethodPut, fmt.Sprintf("/api/v1/habits/%d/entries/%s", habitID, date), nil, map[string]any{"status": 1}, nil)
}

// ---------------- Pocket Files ----------------

// Space is a place in Pocket Files: the person's own files, a mount, a share.
type Space struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Perm     string `json:"perm"`
	IsDir    bool   `json:"is_dir"`
	ReadOnly bool   `json:"read_only"`
}

// Entry is a file or folder in Pocket Files.
type Entry struct {
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	IsDir    bool      `json:"is_dir"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

// Stamp identifies a version of a file (size and modification time).
func (e Entry) Stamp() string { return fmt.Sprintf("%d@%d", e.Size, e.Modified.UnixMilli()) }

// Listing is one folder.
type Listing struct {
	Path     string  `json:"path"`
	Entries  []Entry `json:"entries"`
	Writable bool    `json:"writable"`
}

// Spaces lists the places the person can open.
func (c *Client) Spaces(ctx context.Context) ([]Space, error) {
	var out []Space
	err := c.do(ctx, http.MethodGet, "/api/v1/spaces", nil, nil, &out)
	return out, err
}

// List lists a folder.
func (c *Client) List(ctx context.Context, space, path string) (*Listing, error) {
	var out Listing
	if err := c.do(ctx, http.MethodGet, "/api/v1/fs/list", url.Values{"space": {space}, "path": {path}}, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Read downloads a file (up to max bytes).
func (c *Client) Read(ctx context.Context, space, path string, max int64) ([]byte, error) {
	if !c.Configured() {
		return nil, errors.New("not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/api/v1/fs/raw?"+url.Values{"space": {space}, "path": {path}}.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("larger than %d MB", max>>20)
	}
	return b, nil
}

// Upload saves a file into a folder; a name already taken gets a new name.
func (c *Client) Upload(ctx context.Context, space, dir, name string, data []byte) (*Entry, error) {
	if !c.Configured() {
		return nil, errors.New("not configured")
	}
	q := url.Values{"space": {space}, "path": {dir}, "name": {name}, "conflict": {"rename"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, c.BaseURL+"/api/v1/fs/upload?"+q.Encode(), bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/octet-stream")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(res.Body, 4000)).Decode(&e)
		if e.Error != "" {
			return nil, fmt.Errorf("HTTP %d: %s", res.StatusCode, e.Error)
		}
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var e Entry
	if err := json.NewDecoder(res.Body).Decode(&e); err != nil {
		return nil, err
	}
	return &e, nil
}
