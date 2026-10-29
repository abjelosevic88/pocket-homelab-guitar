// Package tabfile recognises tab files (Guitar Pro 3–8, MusicXML, alphaTex)
// and reads the names in them: title, artist, album and who wrote the tab.
// Everything else (tracks, tunings, tempo, bars) is read by alphaTab in the
// browser the first time the tab is opened.
package tabfile

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"io"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// MaxSize is the largest tab file accepted.
const MaxSize = 25 << 20

// Exts are the file extensions the library takes, with their format.
var Exts = map[string]string{
	".gp": "gp", ".gp7": "gp", ".gp8": "gp", ".gpx": "gpx", ".gp5": "gp5", ".gp4": "gp4", ".gp3": "gp3",
	".xml": "musicxml", ".musicxml": "musicxml", ".mxl": "musicxml", ".tex": "alphatex", ".atex": "alphatex", ".alphatex": "alphatex",
}

// Supported reports whether a file name looks like a tab.
func Supported(name string) bool {
	_, ok := Exts[strings.ToLower(filepath.Ext(name))]
	return ok
}

// Meta is what the file says about itself.
type Meta struct {
	Format string
	Title  string
	Artist string
	Album  string
	Tabber string
}

// Read detects the format of b (named name) and reads its names. ok is false
// when b is not a tab file this app can open.
func Read(name string, b []byte) (Meta, bool) {
	ext := strings.ToLower(filepath.Ext(name))
	m := Meta{Format: Exts[ext]}
	switch {
	case len(b) > 4 && string(b[:4]) == "PK\x03\x04":
		// GP7/8 (.gp) and compressed MusicXML (.mxl) are zip files.
		if mm, ok := readZip(b); ok {
			return mm, true
		}
		return m, false
	case len(b) > 4 && string(b[:4]) == "BCFZ":
		m.Format = "gpx"
		return m, true
	case len(b) > 20 && b[0] > 10 && b[0] <= 30 && strings.HasPrefix(string(b[1:]), "FICHIER GUITAR PRO"):
		return readGP345(b), true
	}
	head := string(b[:min(len(b), 4096)])
	switch {
	case strings.Contains(head, "<score-partwise") || strings.Contains(head, "<score-timewise"):
		return readMusicXML(b), true
	case m.Format == "alphatex" || strings.HasPrefix(strings.TrimSpace(head), `\title`) || strings.Contains(head, `\track`):
		return readAlphaTex(b), true
	}
	return m, false
}

// ---- Guitar Pro 3, 4 and 5 ----

// readGP345 reads the header of a GP3/4/5 file: a 31-byte version string,
// then title, subtitle, artist, album, words, music (GP5), copyright, tab
// author as int-size + byte-size + bytes strings.
func readGP345(b []byte) Meta {
	m := Meta{Format: "gp5"}
	ver := string(b[1 : 1+min(int(b[0]), 30)])
	switch {
	case strings.Contains(ver, "v3."):
		m.Format = "gp3"
	case strings.Contains(ver, "v4."):
		m.Format = "gp4"
	}
	r := bytes.NewReader(b[31:])
	str := func() string {
		var n int32
		if binary.Read(r, binary.LittleEndian, &n) != nil || n < 1 || n > 4096 {
			return ""
		}
		var l [1]byte
		if _, err := r.Read(l[:]); err != nil {
			return ""
		}
		buf := make([]byte, n-1)
		if _, err := io.ReadFull(r, buf); err != nil {
			return ""
		}
		if int(l[0]) < len(buf) {
			buf = buf[:l[0]]
		}
		return clean(latin1(buf))
	}
	m.Title = str()
	_ = str() // subtitle
	m.Artist = str()
	m.Album = str()
	_ = str() // words
	if m.Format == "gp5" {
		_ = str() // music
	}
	_ = str() // copyright
	m.Tabber = str()
	return m
}

func latin1(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

// ---- Guitar Pro 7/8 and compressed MusicXML (zip) ----

func readZip(b []byte) (Meta, bool) {
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return Meta{}, false
	}
	open := func(f *zip.File) []byte {
		if f.UncompressedSize64 > 64<<20 {
			return nil
		}
		rc, err := f.Open()
		if err != nil {
			return nil
		}
		defer rc.Close()
		data, _ := io.ReadAll(io.LimitReader(rc, 64<<20))
		return data
	}
	for _, f := range zr.File {
		if f.Name == "Content/score.gpif" {
			return readGPIF(open(f)), true
		}
	}
	// MusicXML: META-INF/container.xml names the root file; else the first .xml/.musicxml
	for _, f := range zr.File {
		n := strings.ToLower(f.Name)
		if strings.HasPrefix(n, "meta-inf/") || !(strings.HasSuffix(n, ".xml") || strings.HasSuffix(n, ".musicxml")) {
			continue
		}
		if data := open(f); data != nil && (bytes.Contains(data, []byte("<score-partwise")) || bytes.Contains(data, []byte("<score-timewise"))) {
			return readMusicXML(data), true
		}
	}
	return Meta{}, false
}

func readGPIF(b []byte) Meta {
	var doc struct {
		Score struct {
			Title       string `xml:"Title"`
			Artist      string `xml:"Artist"`
			Album       string `xml:"Album"`
			Tabber      string `xml:"Tabber"`
			ScoreAuthor string `xml:"Music"`
		} `xml:"Score"`
	}
	_ = xml.Unmarshal(b, &doc)
	return Meta{Format: "gp", Title: clean(doc.Score.Title), Artist: clean(doc.Score.Artist), Album: clean(doc.Score.Album), Tabber: clean(doc.Score.Tabber)}
}

// ---- MusicXML ----

func readMusicXML(b []byte) Meta {
	var doc struct {
		Work struct {
			Title string `xml:"work-title"`
		} `xml:"work"`
		MovementTitle  string `xml:"movement-title"`
		Identification struct {
			Creators []struct {
				Type string `xml:"type,attr"`
				Name string `xml:",chardata"`
			} `xml:"creator"`
		} `xml:"identification"`
	}
	d := xml.NewDecoder(bytes.NewReader(b))
	d.Strict = false
	d.CharsetReader = func(_ string, in io.Reader) (io.Reader, error) { return in, nil }
	_ = d.Decode(&doc)
	m := Meta{Format: "musicxml", Title: clean(firstNonEmpty(doc.Work.Title, doc.MovementTitle))}
	for _, c := range doc.Identification.Creators {
		switch strings.ToLower(c.Type) {
		case "composer", "artist":
			if m.Artist == "" {
				m.Artist = clean(c.Name)
			}
		case "arranger", "transcriber":
			if m.Tabber == "" {
				m.Tabber = clean(c.Name)
			}
		}
	}
	return m
}

// ---- alphaTex ----

var texMeta = regexp.MustCompile(`(?m)^\s*\\(title|artist|album|tab)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))`)

func readAlphaTex(b []byte) Meta {
	m := Meta{Format: "alphatex"}
	head := string(b[:min(len(b), 8192)])
	for _, x := range texMeta.FindAllStringSubmatch(head, -1) {
		v := clean(firstNonEmpty(x[2], x[3], x[4]))
		switch x[1] {
		case "title":
			m.Title = v
		case "artist":
			m.Artist = v
		case "album":
			m.Album = v
		case "tab":
			m.Tabber = v
		}
	}
	return m
}

// ---- file names ----

var (
	nameNoise  = regexp.MustCompile(`(?i)\s*[\[(](?:guitar ?pro|gp\d?|tab|tabs|ver(?:sion)?\s*\d+|v\d+|\d+)[\])]\s*$`)
	underscore = regexp.MustCompile(`[_]+`)
	spaces     = regexp.MustCompile(`\s+`)
)

// FromFileName reads "Artist - Title.gp5" (or just "Title.gp") from a file name.
func FromFileName(name string) (artist, title string) {
	base := strings.TrimSuffix(filepath.Base(name), filepath.Ext(name))
	base = underscore.ReplaceAllString(base, " ")
	for {
		n := nameNoise.ReplaceAllString(base, "")
		if n == base {
			break
		}
		base = n
	}
	base = strings.TrimSpace(spaces.ReplaceAllString(base, " "))
	for _, sep := range []string{" - ", " – ", " — "} {
		if i := strings.Index(base, sep); i > 0 {
			return strings.TrimSpace(base[:i]), strings.TrimSpace(base[i+len(sep):])
		}
	}
	return "", base
}

func clean(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 32 {
			return ' '
		}
		return r
	}, s)
	s = strings.TrimSpace(spaces.ReplaceAllString(s, " "))
	switch strings.ToLower(s) {
	case "-", "--", "?", "unknown", "untitled", "n/a":
		return ""
	}
	return s
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}
