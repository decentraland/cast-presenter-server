// Package ipc implements the JSON-lines protocol between the Node parent and the sidecar.
package ipc

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"sync"
)

const maxLineBytes = 1 << 20

// Command is one line read from the Node parent on stdin.
type Command struct {
	Type           string  `json:"type"`
	ID             int64   `json:"id,omitempty"`
	URL            string  `json:"url,omitempty"`
	Token          string  `json:"token,omitempty"`
	PresentationID string  `json:"presentationId,omitempty"`
	PayloadBase64  string  `json:"payloadBase64,omitempty"`
	Metadata       string  `json:"metadata,omitempty"`
	VideoPath      string  `json:"videoPath,omitempty"`
	AudioPath      *string `json:"audioPath,omitempty"`
}

// Event is one line written to the Node parent on stdout.
type Event struct {
	Type             string `json:"type"`
	ID               int64  `json:"id,omitempty"`
	Code             string `json:"code,omitempty"`
	Message          string `json:"message,omitempty"`
	RoomMetadata     string `json:"roomMetadata,omitempty"`
	Metadata         string `json:"metadata,omitempty"`
	Identity         string `json:"identity,omitempty"`
	PayloadBase64    string `json:"payloadBase64,omitempty"`
	Count            *int   `json:"count,omitempty"`
	ParticipantCount *int   `json:"participantCount,omitempty"`
	Reason           string `json:"reason,omitempty"`
}

// Writer emits Events as JSON lines and is safe for concurrent use.
type Writer struct {
	mu  sync.Mutex
	enc *json.Encoder
}

// NewWriter returns a Writer that encodes Events onto w.
func NewWriter(w io.Writer) *Writer {
	return &Writer{enc: json.NewEncoder(w)}
}

// Send writes ev as one line.
func (w *Writer) Send(ev Event) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.enc.Encode(ev)
}

// Ack answers the command with the given id.
func (w *Writer) Ack(id int64) error {
	return w.Send(Event{Type: "ack", ID: id})
}

// Error answers the command with the given id, or reports an unsolicited error when id is 0.
func (w *Writer) Error(id int64, code, msg string) error {
	return w.Send(Event{Type: "error", ID: id, Code: code, Message: msg})
}

// ReadLoop calls handle for every well-formed line of r until EOF or a read error.
// Malformed lines are logged and skipped.
func ReadLoop(r io.Reader, handle func(Command)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), maxLineBytes)
	for sc.Scan() {
		line := sc.Bytes()
		var cmd Command
		if err := json.Unmarshal(line, &cmd); err != nil {
			log.Printf("skipping malformed line (%d bytes): %v", len(line), err)
			continue
		}
		handle(cmd)
	}
	return sc.Err()
}
