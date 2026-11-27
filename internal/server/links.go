package server

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// Pocket Core app links (docs/links.md in pocket-homelab-core), Guitar as the
// target: another Pocket app the person allowed in Core may act here for
// them with a pcx_ token, only within these scopes. Every route not listed
// in linkRoutes stays closed to it (403).

var linkOffers = []core.Offer{
	{Scope: "guitar:read", Name: "See your guitar practice", Description: "Read your songs, how far along you are with each, your practice time, streaks and setlists, for your journal, calendar and dashboards. Never your song notes."},
	{Scope: "guitar:write", Name: "Log guitar practice", Description: "Add practice time done elsewhere (a lesson, another app). It may change nothing you logged yourself."},
}

// portable is what Pocket Move may copy out and bring in for a person
// (docs/move.md in pocket-homelab-core); Register adds move:export/import.
var portable = &core.Portable{
	Exports: []core.PortableExport{
		{Path: "/api/v1/export.json", File: "guitar.json", Kind: core.KindPocket, Title: "Your tabs with their files and parts, your practice, set lists and habit rules"},
		{Path: "/api/v1/export.csv", File: "practice.csv", Kind: core.KindCSV, Title: "Every practice session as a table"},
	},
	Imports: []core.PortableImport{
		{Path: "/api/v1/import", Kind: core.KindPocket, ContentType: "application/json", Title: "Adds the tabs, practice, set lists and habit rules from another box; what you already have is left alone"},
	},
}

// capabilities is what Pocket Search, Pocket Day and Pocket Hub may do here
// (docs/capabilities.md in pocket-homelab-core): one fixed route each, in
// the shape every Pocket app answers in (capabilities.go). Register adds the
// pocket:* offers. There is no quick line to keep: a song here is a tab
// file, and practice needs a length.
var capabilities = core.Capabilities{
	Search: &core.Searchable{What: "Your guitar tabs, by song, artist, album and tag", Kinds: []string{"tab"}, Bangs: []string{"tabs", "tab", "guitar"}},
	Day:    &core.DayFeed{Label: "Guitar", One: "session", Many: "sessions", Unit: "min", What: "The guitar practice you did that day, song by song, and the songs you marked as ones you can play"},
	Widget: &core.Widget{Title: "Guitar practice", What: "Your practice today and this week, your days in a row and the songs you are learning"},
}

type linkRoute struct {
	methods string
	path    *regexp.Regexp
	scope   string // "" = any linked app
}

var linkRoutes = []linkRoute{
	{"GET", regexp.MustCompile(`^/api/v1/auth/me$`), ""},
	{"GET", regexp.MustCompile(`^/api/v1/(dashboard|overlay|stats|practice|tabs|tabs/facets|setlists)$`), "guitar:read"},
	{"GET", regexp.MustCompile(`^/api/v1/(day|summary)/\d{4}-\d{2}-\d{2}$`), "guitar:read"},
	{"GET", regexp.MustCompile(`^/api/v1/(tabs|setlists)/\d+$`), "guitar:read"},
	{"POST", regexp.MustCompile(`^/api/v1/practice$`), "guitar:write"},
	{"PUT DELETE", regexp.MustCompile(`^/api/v1/practice/\d+$`), "guitar:write"},
}

var errLinkScope = errors.New("outside the link's scope")

// linkAllows reports whether a link token with these scopes may make this request.
func linkAllows(scopes []string, r *http.Request) bool {
	if portable.LinkAllows(scopes, r) || capabilities.LinkAllows(scopes, r) {
		return true
	}
	for _, lr := range linkRoutes {
		if !strings.Contains(" "+lr.methods+" ", " "+r.Method+" ") || !lr.path.MatchString(r.URL.Path) {
			continue
		}
		if lr.scope == "" {
			return true
		}
		for _, sc := range scopes {
			if sc == lr.scope {
				return true
			}
		}
	}
	return false
}

// linkUser validates a pcx_ token, checks the route against its scopes and
// maps it to the person it acts for. The second value is the acting app's slug.
func (s *Server) linkUser(ctx context.Context, tok string, r *http.Request) (*store.User, string, error) {
	in, err := s.core.Introspect(ctx, tok)
	if err != nil {
		return nil, "", err
	}
	if !in.Active || !in.Delegated() || in.Audience != "guitar" || in.User == nil || in.User.Email == "" || in.App == nil || in.App.Slug == "" {
		return nil, "", http.ErrNoCookie
	}
	if !linkAllows(strings.Fields(in.Scope), r) {
		return nil, "", errLinkScope
	}
	u, err := s.coreIdentityUser(ctx, in)
	return u, in.App.Slug, err
}

const linkAppKey ctxKey = 2

// linkApp is the acting app's slug when the request came in on a link token.
func linkApp(ctx context.Context) string {
	a, _ := ctx.Value(linkAppKey).(string)
	return a
}
