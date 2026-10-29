package server

import "testing"

func TestSongsterrSummary(t *testing.T) {
	r := summarize(songsterrSong{SongID: 455118, Artist: "Metallica", Title: "Master of Puppets", Tracks: []songsterrTrack{
		{InstrumentID: 67, Instrument: "Baritone Sax", Views: 2000},
		{InstrumentID: 30, Instrument: "Distortion Guitar", Views: 195757, Tuning: []int{64, 59, 55, 50, 45, 40}, Difficulty: 4},
		{InstrumentID: 30, Instrument: "Distortion Guitar", Views: 3275, Tuning: []int{64, 59, 55, 50, 45, 38}, Difficulty: 7},
		{InstrumentID: 33, Instrument: "Electric Bass (finger)", Views: 900},
		{InstrumentID: 1024, Instrument: "Drums", Views: 500},
	}})
	if r.Guitars != 2 || !r.Bass || !r.Drums || r.Difficulty != 4 || len(r.Tuning) != 6 || r.Tuning[5] != 40 {
		t.Fatalf("summary = %+v", r)
	}
	if r.URL != "https://www.songsterr.com/a/wsa/metallica-master-of-puppets-tab-s455118" || songsterrURL.FindStringSubmatch(r.URL)[1] != "455118" {
		t.Fatalf("url = %s", r.URL)
	}
	if u := songsterrTabURL(7, "Björk", "Jóga!"); songsterrURL.FindStringSubmatch(u) == nil {
		t.Fatalf("odd names must still give an address the importer takes: %s", u)
	}
}
