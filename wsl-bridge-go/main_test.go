package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func setupTestServer(t *testing.T) (*httptest.Server, string, string) {
	t.Helper()
	root := t.TempDir()
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatalf("eval symlinks: %v", err)
	}

	backend := filepath.Join(resolvedRoot, "backend")
	frontend := filepath.Join(resolvedRoot, "frontend-v5")
	if err := os.MkdirAll(filepath.Join(backend, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(frontend, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	sample := "line1\nline2  \nline3\nline4\nline5\n"
	if err := os.WriteFile(filepath.Join(backend, "src", "app.py"), []byte(sample), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(frontend, "src", "index.ts"), []byte("export const ok = true;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(frontend, ".gitignore"), []byte("ignored.log\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(frontend, "ignored.log"), []byte("noise\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, args := range [][]string{
		{"init", "-q"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Test"},
		{"add", "."},
		{"commit", "-q", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = frontend
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v failed: %v (%s)", args, err, string(out))
		}
	}

	token := "test-go-v3-token"
	cfg := bridgeConfig{Root: resolvedRoot, Token: token, Host: "127.0.0.1", Port: 0}
	ts := httptest.NewServer(newHandler(cfg))
	t.Cleanup(ts.Close)
	return ts, resolvedRoot, token
}

func doReq(t *testing.T, method, url, token string, body any) (int, map[string]any) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode json: %v", err)
	}
	return resp.StatusCode, out
}

func TestServerSideLineSliceRead(t *testing.T) {
	ts, _, token := setupTestServer(t)

	code, data := doReq(t, http.MethodPost, ts.URL+"/api/read", token, map[string]any{
		"paths": []string{"backend/src/app.py:2-4"},
	})
	if code != 200 {
		t.Fatalf("expected 200, got %d %v", code, data)
	}
	files := data["files"].([]any)
	f := files[0].(map[string]any)
	if f["sliced"] != true {
		t.Fatalf("expected sliced=true, got %v", f)
	}
	content := f["content"].(string)
	if !strings.Contains(content, "line2") || !strings.Contains(content, "line4") || strings.Contains(content, "line1") {
		t.Fatalf("unexpected sliced content: %q", content)
	}
}

func TestTolerantPatchAndUndo(t *testing.T) {
	ts, root, token := setupTestServer(t)

	// Note: file has trailing spaces on "line2  ", search omits trailing spaces
	code, data := doReq(t, http.MethodPost, ts.URL+"/api/patch", token, map[string]any{
		"path":    "backend/src/app.py",
		"search":  "line2\nline3",
		"replace": "line2_patched\nline3_patched",
	})
	if code != 200 || data["matchMode"] != "tolerant-line" {
		t.Fatalf("expected tolerant-line patch 200, got %d %v", code, data)
	}
	undoID := data["undoId"].(string)
	if undoID == "" {
		t.Fatalf("expected non-empty undoId")
	}

	b, _ := os.ReadFile(filepath.Join(root, "backend", "src", "app.py"))
	if !strings.Contains(string(b), "line2_patched") {
		t.Fatalf("patched content missing: %s", string(b))
	}

	// Undo should restore original file exactly
	code, undoRes := doReq(t, http.MethodPost, ts.URL+"/api/undo", token, map[string]any{
		"undoId": undoID,
	})
	if code != 200 || undoRes["action"] != "restored" {
		t.Fatalf("expected undo restored 200, got %d %v", code, undoRes)
	}
	b2, _ := os.ReadFile(filepath.Join(root, "backend", "src", "app.py"))
	if strings.Contains(string(b2), "line2_patched") || !strings.Contains(string(b2), "line2  \nline3") {
		t.Fatalf("undo did not restore original content: %q", string(b2))
	}
}

func TestWriteNewFileAndUndoDeletes(t *testing.T) {
	ts, root, token := setupTestServer(t)

	code, data := doReq(t, http.MethodPost, ts.URL+"/api/write", token, map[string]any{
		"path":    "backend/src/temp_new.txt",
		"content": "temporary\n",
	})
	if code != 200 {
		t.Fatalf("expected 200 write, got %d %v", code, data)
	}
	undoID := data["undoId"].(string)

	code, undoRes := doReq(t, http.MethodPost, ts.URL+"/api/undo", token, map[string]any{
		"undoId": undoID,
	})
	if code != 200 || undoRes["action"] != "deleted" {
		t.Fatalf("expected undo deleted 200, got %d %v", code, undoRes)
	}
	if _, err := os.Stat(filepath.Join(root, "backend", "src", "temp_new.txt")); !os.IsNotExist(err) {
		t.Fatalf("expected newly created file to be deleted on undo")
	}
}
