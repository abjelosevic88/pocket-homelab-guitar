package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/ai"
	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// aiFor is the person's AI: Pocket AI through Core, their own
// OpenAI-compatible key, or nil with why.
func (s *Server) aiFor(ctx context.Context, uid int64, st store.Settings) (*ai.Client, string, string) {
	email := ""
	if u, err := s.store.GetUser(ctx, uid); err == nil {
		email = u.Email
	}
	pocket, status := s.core.SelectAI(ctx, email, st.AIProvider, st.OpenAIKey != "")
	if pocket != nil {
		if !status.Ready {
			return nil, "", "Pocket AI: " + status.Detail
		}
		c := ai.New("", "", "", 150*time.Second)
		c.Pocket = pocket.WithModel(st.AIPocketModel)
		return c, "pocket", ""
	}
	if st.OpenAIKey == "" {
		return nil, "", status.Detail
	}
	return ai.New(st.OpenAIBaseURL, st.OpenAIKey, st.OpenAIModel, 150*time.Second), "openai", ""
}

func (s *Server) handleAIStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	st, _ := s.store.GetSettings(ctx, actorID(ctx))
	cl, used, why := s.aiFor(ctx, actorID(ctx), st)
	writeJSON(w, http.StatusOK, map[string]any{"ready": cl != nil, "provider": used, "detail": why})
}

func (s *Server) handleAIModels(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	c, status := s.core.SelectAI(ctx, userFrom(ctx).Email, "pocket", false)
	if c == nil || !status.Ready {
		writeErr(w, http.StatusServiceUnavailable, status.Detail)
		return
	}
	models, err := c.Models(ctx)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, models)
}

func validAIProvider(v string) bool { return core.ValidAIProvider(v) }

func validPocketModel(v string) bool { return core.ValidInferenceModel(v) }

const aiVoice = `You are a patient, practical guitar teacher looking at someone's own practice log and song library: songs with their tempo, tuning, tracks, how far along they are (want to learn, learning, polishing, can play it), the speed they play them at (percent of the written tempo), the parts (sections, as bar ranges) they loop, and minutes practised. Use only the data given; never invent songs, sessions or numbers. Be concrete and short: name bars, speeds and minutes. No emojis, no exclamation marks, no motivational filler.`

var statusWords = map[string]string{"to_learn": "want to learn", "learning": "learning", "polishing": "polishing", "mastered": "can play it"}

// practiceDigest renders a period's practice as compact text for the model.
func (s *Server) practiceDigest(ctx context.Context, uid int64, from, to string) string {
	ps, _, err := s.store.ListPractice(ctx, uid, store.PracticeFilter{From: from, To: to, Asc: true})
	if err != nil {
		return ""
	}
	var b strings.Builder
	st, _ := s.store.GetSettings(ctx, uid)
	cur, best := s.streaks(ctx, uid)
	fmt.Fprintf(&b, "Period %s to %s. Daily goal %d min. Current streak %d days (longest %d).\n", from, to, st.DailyGoalMin, cur, best)
	tabs, _, _ := s.store.ListTabs(ctx, uid, store.TabFilter{Sort: "recent", Limit: 40})
	if len(tabs) > 0 {
		b.WriteString("Songs (title | status | tuning | tempo | best speed | practised):\n")
		for _, t := range tabs {
			fmt.Fprintf(&b, "%s | %s | %s | %d bpm | %d%% | %s\n", t.Name(), statusWords[t.Status], firstNonEmpty(t.Tuning, "?"), t.Tempo, t.BestSpeed, fmtMinutes(float64(t.PracticeS)/60))
		}
	}
	if len(ps) > 0 {
		b.WriteString("Practice (date time | what | minutes | top speed | loops | note):\n")
		for _, p := range ps {
			t := ""
			if tt, ok := store.ParseTime(p.StartedAt); ok {
				t = tt.In(time.Local).Format("Mon 2006-01-02 15:04")
			}
			note := strings.ReplaceAll(p.Note, "\n", " ")
			if len(note) > 280 {
				note = note[:280] + "…"
			}
			fmt.Fprintf(&b, "%s | %s | %d | %d%% | %d | %s\n", t, p.Title, (p.DurationS+30)/60, p.Speed, p.Loops, note)
		}
	}
	return b.String()
}

func fmtMinutes(m float64) string {
	if m >= 120 {
		return fmt.Sprintf("%.1f h", m/60)
	}
	return fmt.Sprintf("%.0f min", m)
}

// handlePlan writes a short practice plan for one song (or one section).
func (s *Server) handlePlan(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	st, _ := s.store.GetSettings(ctx, uid)
	cl, used, why := s.aiFor(ctx, uid, st)
	if cl == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "not_configured": true, "error": firstNonEmpty(why, "no AI is set up (Settings → AI)")})
		return
	}
	var in struct {
		TabID     int64 `json:"tab_id"`
		SectionID int64 `json:"section_id"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	t, err := s.store.GetTab(ctx, uid, in.TabID)
	if err != nil {
		s.fail(w, err, "tab")
		return
	}
	secs, _ := s.store.ListSections(ctx, uid, t.ID)
	var b strings.Builder
	fmt.Fprintf(&b, "Song: %s. Status: %s. Tuning: %s. Capo: %d. Tempo: %d bpm. Bars: %d. Length: %d s. Difficulty (their rating 1-5, 0 = none): %d.\n",
		t.Name(), statusWords[t.Status], firstNonEmpty(t.Tuning, "unknown"), t.Capo, t.Tempo, t.Bars, t.DurationS, t.Difficulty)
	fmt.Fprintf(&b, "Goal speed %d%%, best so far %d%%. Practised %s in %d sessions.\n", t.GoalSpeed, t.BestSpeed, fmtMinutes(float64(t.PracticeS)/60), t.PlayCount)
	for _, tr := range t.Tracks {
		fmt.Fprintf(&b, "Track: %s (%s, %s)\n", tr.Name, tr.Instrument, firstNonEmpty(tr.Tuning, "no tuning"))
	}
	focus := ""
	for _, x := range secs {
		fmt.Fprintf(&b, "Section \"%s\": bars %d-%d, practising at %d%%, best %d%%, goal %d%%, practised %s.\n", x.Name, x.StartBar, x.EndBar, x.Speed, x.BestSpeed, x.GoalSpeed, fmtMinutes(float64(x.PracticeS)/60))
		if x.ID == in.SectionID {
			focus = x.Name
		}
	}
	if t.Notes != "" {
		n := t.Notes
		if len(n) > 1500 {
			n = n[:1500] + "…"
		}
		b.WriteString("Their notes on the song: " + strings.ReplaceAll(n, "\n", " ") + "\n")
	}
	ask := "Write a practice plan for this song for the next week: 4 to 7 short numbered steps, each with which part (bars or section), at what speed (percent), for how many minutes, and what to listen for. Start slow enough to play cleanly; raise speed in small steps. End with one line 'Today:' with what to do in today's session."
	if focus != "" {
		ask = "Write a practice plan for the section \"" + focus + "\" for the next week: 4 to 6 short numbered steps with speed (percent), minutes and what to listen for, ending with one line 'Today:' with today's session."
	}
	text, err := cl.Complete(ctx, aiVoice, ask+"\n\n"+b.String(), false)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "provider": used, "text": strings.TrimSpace(text)})
}

// handleAsk answers a question about the person's playing.
func (s *Server) handleAsk(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	st, _ := s.store.GetSettings(ctx, uid)
	cl, used, why := s.aiFor(ctx, uid, st)
	if cl == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": why})
		return
	}
	var in struct {
		Question string `json:"question"`
	}
	if err := decode(r, &in); err != nil || strings.TrimSpace(in.Question) == "" {
		writeErr(w, http.StatusBadRequest, "question is required")
		return
	}
	to := store.Today()
	digest := s.practiceDigest(ctx, uid, store.AddDays(to, -89), to)
	prompt := "Question: " + strings.TrimSpace(in.Question) + "\n\nTheir songs and practice:\n" + digest +
		"\nAnswer in a few sentences, with the data that backs it. If the data cannot answer it, say so and answer from general guitar teaching, marked as such."
	text, err := cl.Complete(ctx, aiVoice, prompt, false)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "provider": used, "text": strings.TrimSpace(text)})
}
