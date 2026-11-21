package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var (
	chromeVersionURL = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json"
	chromeVersionRe  = regexp.MustCompile(`^\d+\.\d+\.\d+\.\d+$`)
)

const (
	chromeVersionCacheKey = "songsterr:chrome-version"
	chromeVersionTTL      = 72 * time.Hour
	chromeVersionFallback = "157.0.0.0"
)

func (s *Server) chromeVersion(ctx context.Context) string {
	if v, at, ok := s.store.CacheGet(ctx, chromeVersionCacheKey); ok && chromeVersionRe.MatchString(v) {
		if t, err := time.Parse(time.RFC3339Nano, at); err == nil && time.Since(t) < chromeVersionTTL {
			return v
		}
	}
	s.chromeVersionMu.Lock()
	defer s.chromeVersionMu.Unlock()
	if v, at, ok := s.store.CacheGet(ctx, chromeVersionCacheKey); ok && chromeVersionRe.MatchString(v) {
		if t, err := time.Parse(time.RFC3339Nano, at); err == nil && time.Since(t) < chromeVersionTTL {
			return v
		}
	}
	v := chromeVersionFallback
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, chromeVersionURL, nil)
	if err == nil {
		res, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err == nil {
			defer res.Body.Close()
			if res.StatusCode == http.StatusOK {
				var payload struct {
					Channels struct {
						Stable struct {
							Version string `json:"version"`
						} `json:"Stable"`
					} `json:"channels"`
				}
				if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&payload); err == nil {
					if candidate := strings.TrimSpace(payload.Channels.Stable.Version); chromeVersionRe.MatchString(candidate) {
						v = candidate
					}
				}
			}
		}
	}
	if err := s.store.CachePut(ctx, chromeVersionCacheKey, v); err != nil {
		s.log.Warn("could not cache Chrome version", "error", err)
	}
	return v
}

func (s *Server) songsterrUserAgent(ctx context.Context) string {
	return "Mozilla/5.0 (compatible; HeadlessChrome/" + s.chromeVersion(ctx) + "; " + s.cfg.UserAgent + ")"
}
