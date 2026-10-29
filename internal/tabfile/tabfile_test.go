package tabfile

import "testing"

func TestFromFileName(t *testing.T) {
	for in, want := range map[string][2]string{
		"Metallica - Master of Puppets.gp":      {"Metallica", "Master of Puppets"},
		"Some_Band_-_Song_(v2).gp5":             {"Some Band", "Song"},
		"Riff412b _1_.gp4":                      {"", "Riff412b 1"},
		"/tabs/Artist – Title [Guitar Pro].gpx": {"Artist", "Title"},
	} {
		a, ti := FromFileName(in)
		if a != want[0] || ti != want[1] {
			t.Errorf("%q → %q %q, want %q", in, a, ti, want)
		}
	}
}

func TestReadAlphaTexAndJunk(t *testing.T) {
	m, ok := Read("x.tex", []byte("\\title \"Song\"\n\\artist 'Band'\n.\n:4 0.1"))
	if !ok || m.Format != "alphatex" || m.Title != "Song" || m.Artist != "Band" {
		t.Fatalf("alphatex = %+v %v", m, ok)
	}
	if _, ok := Read("x.gp5", []byte("hello world, not a tab")); ok {
		t.Fatal("junk accepted")
	}
	m, ok = Read("x.xml", []byte(`<?xml version="1.0"?><score-partwise><work><work-title>Air</work-title></work><identification><creator type="composer">Bach</creator></identification></score-partwise>`))
	if !ok || m.Title != "Air" || m.Artist != "Bach" {
		t.Fatalf("musicxml = %+v", m)
	}
}
