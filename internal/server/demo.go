package server

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"math/rand"
	"time"

	"github.com/abjelosevic88/pocket-homelab-guitar/internal/store"
)

// The demo songs: public-domain melodies and the app's own exercises,
// written in alphaTex so every one of them renders and plays.
//
//go:embed demotabs/*.tex
var demoTabs embed.FS

type demoSong struct {
	file, status, tags, tuning string
	tempo, bars, beats         int
	favorite                   bool
	difficulty, best, goal     int
	tracks                     []store.TabTrack
	sections                   [][3]any // name, start, end
	notes                      string
	weight                     int // how often it was practised
}

var guitarStd = store.TabTrack{Index: 0, Name: "Guitar", Instrument: "Acoustic Guitar (steel)", Strings: 6, Tuning: "E A D G B E"}

func track(name string, t store.TabTrack) store.TabTrack { t.Name = name; return t }

var demoSongs = []demoSong{
	{file: "shuffle-a.tex", status: "polishing", tags: "blues, rhythm", tuning: "Standard", tempo: 96, bars: 12, beats: 4, favorite: true, difficulty: 2, best: 90, goal: 110,
		tracks:   []store.TabTrack{track("Rhythm guitar", guitarStd), {Index: 1, Name: "Bass", Instrument: "Electric Bass (finger)", Strings: 4, Tuning: "E A D G"}},
		sections: [][3]any{{"Turnaround", 9, 12}, {"First four bars", 1, 4}}, notes: "Keep the shuffle swung and the palm muting light.\nWatch the change to D in bar 5.", weight: 9},
	{file: "rising-sun.tex", status: "learning", tags: "fingerstyle, folk", tuning: "Standard", tempo: 76, bars: 16, beats: 3, difficulty: 3, best: 70, goal: 100,
		tracks:   []store.TabTrack{track("Fingerstyle guitar", guitarStd)},
		sections: [][3]any{{"Am – C – D – F", 1, 4}, {"The E chord bars", 7, 8}, {"Ending", 13, 16}}, notes: "Thumb on the bass notes, fingers stay close to the strings.", weight: 8},
	{file: "pentatonic.tex", status: "learning", tags: "lead, technique", tuning: "Standard", tempo: 90, bars: 4, beats: 4, difficulty: 3, best: 75, goal: 120,
		tracks:   []store.TabTrack{track("Lead guitar", guitarStd)},
		sections: [][3]any{{"Up and down", 1, 2}}, notes: "Alternate picking all the way. Slow is smooth.", weight: 7},
	{file: "ode-to-joy.tex", status: "mastered", tags: "classical, melody", tuning: "Standard", tempo: 100, bars: 16, beats: 4, favorite: true, difficulty: 1, best: 110, goal: 100,
		tracks: []store.TabTrack{track("Melody", guitarStd)}, weight: 3},
	{file: "greensleeves.tex", status: "learning", tags: "folk, melody", tuning: "Standard", tempo: 84, bars: 17, beats: 3, difficulty: 2, best: 80, goal: 100,
		tracks: []store.TabTrack{track("Melody", guitarStd)}, sections: [][3]any{{"Second phrase", 9, 17}}, weight: 5},
	{file: "drop-d.tex", status: "to_learn", tags: "metal, rhythm", tuning: "Drop D", tempo: 140, bars: 4, beats: 4, difficulty: 3, goal: 100,
		tracks: []store.TabTrack{{Index: 0, Name: "Rhythm guitar", Instrument: "Distortion Guitar", Strings: 6, Tuning: "D A D G B E"}}, weight: 0},
	{file: "amazing-grace.tex", status: "to_learn", tags: "folk, melody", tuning: "Standard", tempo: 72, bars: 17, beats: 3, difficulty: 1, goal: 100,
		tracks: []store.TabTrack{track("Melody", guitarStd)}, weight: 0},
}

// seedDemo fills the owner's account with a small library and four months of
// plausible practice (DEMO_DATA=true, for screenshots and trying the app). Runs once.
func (s *Server) seedDemo(ctx context.Context, owner int64) error {
	key := fmt.Sprintf("seeded:%d:demo", owner)
	if _, _, done := s.store.CacheGet(ctx, key); done {
		return nil
	}
	rng := rand.New(rand.NewSource(42))
	today, _ := store.ParseDate(store.Today())
	type seeded struct {
		tab      *store.Tab
		sections []int64
		weight   int
	}
	var tabs []seeded
	for i, d := range demoSongs {
		data, err := demoTabs.ReadFile("demotabs/" + d.file)
		if err != nil {
			return err
		}
		t, _, err := s.addTab(ctx, owner, newTab{name: d.file, data: data, source: "upload", status: d.status, tags: d.tags})
		if err != nil {
			return fmt.Errorf("demo %s: %w", d.file, err)
		}
		t.Tempo, t.Bars, t.DurationS, t.Tracks, t.Tuning = d.tempo, d.bars, d.bars*d.beats*60/d.tempo, d.tracks, d.tuning
		if err := s.store.SetAnalysis(ctx, owner, t); err != nil {
			return err
		}
		t.Favorite, t.Difficulty, t.BestSpeed, t.GoalSpeed, t.Notes = d.favorite, d.difficulty, d.best, d.goal, d.notes
		if t.Status == "mastered" {
			t.MasteredAt = today.AddDate(0, 0, -12).Format(time.RFC3339)
		}
		if err := s.store.UpdateTab(ctx, owner, t); err != nil {
			return err
		}
		// added over the last months, newest last
		_, _ = s.store.DB.ExecContext(ctx, `UPDATE tabs SET created_at = ? WHERE id = ?`, today.AddDate(0, 0, -120+i*14).UTC().Format(time.RFC3339), t.ID)
		sd := seeded{tab: t, weight: d.weight}
		for j, x := range d.sections {
			sec := store.Section{TabID: t.ID, Name: x[0].(string), StartBar: x[1].(int), EndBar: x[2].(int), Speed: 60 + rng.Intn(4)*5, GoalSpeed: 100, Sort: j}
			sec.BestSpeed = sec.Speed + 5
			if err := s.store.CreateSection(ctx, owner, &sec); err != nil {
				return err
			}
			sd.sections = append(sd.sections, sec.ID)
		}
		tabs = append(tabs, sd)
	}
	// practice: most days in the last four months, more lately
	total := 0
	for _, t := range tabs {
		total += t.weight
	}
	free := []string{"Scales", "Chord changes", "Improvising", "Technique"}
	n := 0
	for day := 120; day >= 0; day-- {
		p := 0.45 + 0.35*float64(120-day)/120
		if day <= 6 {
			p = 0.9
		}
		if day == 0 {
			p = 1
		}
		if rng.Float64() > p {
			continue
		}
		date := today.AddDate(0, 0, -day)
		at := time.Date(date.Year(), date.Month(), date.Day(), 18+rng.Intn(4), rng.Intn(60), 0, 0, time.Local)
		sessions := 1 + rng.Intn(2)
		for k := 0; k < sessions; k++ {
			pr := store.Practice{StartedAt: at.Format(time.RFC3339), Source: "app", ExternalID: fmt.Sprintf("demo-%d", n)}
			n++
			if rng.Intn(6) == 0 {
				pr.Kind, pr.Title = "free", free[rng.Intn(len(free))]
				pr.DurationS = (5 + rng.Intn(15)) * 60
			} else {
				pick := rng.Intn(total)
				var sd seeded
				for _, t := range tabs {
					if pick < t.weight {
						sd = t
						break
					}
					pick -= t.weight
				}
				id := sd.tab.ID
				pr.TabID, pr.Kind, pr.Title = &id, "tab", sd.tab.Name()
				pr.DurationS = (6 + rng.Intn(24)) * 60
				pr.Speed = 60 + rng.Intn(9)*5
				pr.Loops = rng.Intn(25)
				if len(sd.sections) > 0 && rng.Intn(2) == 0 {
					sid := sd.sections[rng.Intn(len(sd.sections))]
					pr.SectionID = &sid
				}
			}
			if day == 0 {
				pr.DurationS = 14 * 60
			}
			// never in the future (today's demo practice ends before now)
			if end := at.Add(time.Duration(pr.DurationS) * time.Second); end.After(time.Now()) {
				at = time.Now().Add(-time.Duration(pr.DurationS+120*(sessions-k)) * time.Second)
				pr.StartedAt = at.Format(time.RFC3339)
			}
			if err := s.store.CreatePractice(ctx, owner, &pr); err != nil {
				return err
			}
			_ = s.store.SetHabitMark(ctx, owner, pr.ID, store.Now(), "")
			at = at.Add(time.Duration(pr.DurationS+600) * time.Second)
		}
	}
	// a setlist
	ids := []int64{tabs[0].tab.ID, tabs[1].tab.ID, tabs[4].tab.ID, tabs[3].tab.ID}
	if err := s.store.SaveSetlist(ctx, owner, &store.Setlist{Name: "Sunday campfire", Note: "Easy ones first.", TabIDs: ids}); err != nil {
		return err
	}
	if err := s.store.SaveSetlist(ctx, owner, &store.Setlist{Name: "Warm-up", TabIDs: []int64{tabs[2].tab.ID, tabs[5].tab.ID}}); err != nil {
		return err
	}
	pl, _ := json.Marshal(map[string]any{"speed": 85})
	tabs[0].tab.Player = pl
	_ = s.store.UpdateTab(ctx, owner, tabs[0].tab)
	return s.store.CachePut(ctx, key, "1")
}
