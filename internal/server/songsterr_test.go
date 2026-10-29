package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"testing"
)

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

func TestSongsterrUploadKeepsOrigin(t *testing.T) {
	a := newApp(t, nil)
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	fw, _ := mw.CreateFormFile("file", "Metallica - One.gp")
	_, _ = fw.Write([]byte(tex("", "")))
	_ = mw.WriteField("songsterr_url", "https://www.songsterr.com/a/wsa/metallica-one-tab-s23")
	_ = mw.WriteField("title", "One")
	_ = mw.WriteField("artist", "Metallica")
	_ = mw.Close()
	req, _ := http.NewRequest("POST", a.url+"/api/v1/tabs", &b)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	code, raw := a.do(req, a.alice)
	var res map[string]any
	_ = json.Unmarshal(raw, &res)
	tab := firstAdded(t, res)
	if code != 201 || tab["source"] != "songsterr" || tab["origin_url"] != "https://www.songsterr.com/a/wsa/metallica-one-tab-s23" || tab["title"] != "One" || tab["artist"] != "Metallica" {
		t.Fatalf("songsterr upload = %d %v", code, tab)
	}
	// a made-up address is refused
	b.Reset()
	mw = multipart.NewWriter(&b)
	fw, _ = mw.CreateFormFile("file", "x.gp")
	_, _ = fw.Write([]byte(tex("X", "Y")))
	_ = mw.WriteField("songsterr_url", "https://evil.example/a/wsa/x-tab-s1")
	_ = mw.Close()
	req, _ = http.NewRequest("POST", a.url+"/api/v1/tabs", &b)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if code, _ := a.do(req, a.alice); code != 400 {
		t.Fatalf("foreign address accepted: %d", code)
	}
	a.expect(400, a.alice, "GET", "/api/v1/songsterr/part?song=1&revision=2&image=../../etc&part=0", nil)
	a.expect(400, a.alice, "GET", "/api/v1/songsterr/song?url=https://example.com/", nil)
}
