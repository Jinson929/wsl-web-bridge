package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	defaultHost       = "127.0.0.1"
	defaultPort       = 18423
	maxFileBytes      = 200 * 1024
	maxTotalReadBytes = 800 * 1024
	maxOutputChars    = 80000
	maxBodyBytes      = 5 * 1024 * 1024
	defaultTimeoutSec = 30
	maxTimeoutSec     = 120
	maxUndoSnapshots  = 50
)

var ignoredDirs = map[string]bool{
	".git":           true,
	"node_modules":   true,
	"__pycache__":    true,
	".venv":          true,
	"venv":           true,
	".mypy_cache":    true,
	".pytest_cache":  true,
	".ruff_cache":    true,
	"dist":           true,
	"build":          true,
	"out":            true,
	"coverage":       true,
	".next":          true,
	".nuxt":          true,
	".turbo":         true,
	".cache":         true,
	".pnpm-store":    true,
	"target":         true,
	"vendor":         true,
	".gradle":        true,
	".idea":          true,
	".vscode-server": true,
}

var lineRangePattern = regexp.MustCompile(`^(.+?):(\d+)(?:-(\d+))?$`)

type bridgeConfig struct {
	Root  string
	Token string
	Host  string
	Port  int
}

type treeNode struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"`
	Type     string     `json:"type"`
	Size     int64      `json:"size,omitempty"`
	Children []treeNode `json:"children,omitempty"`
	HasMore  bool       `json:"hasMore,omitempty"`
}

type searchItem struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type fileSnapshot struct {
	ID        string
	AbsPath   string
	RelPath   string
	Existed   bool
	Content   []byte
	CreatedAt time.Time
}

type undoStore struct {
	mu    sync.Mutex
	order []string
	items map[string]*fileSnapshot
}

func newUndoStore() *undoStore {
	return &undoStore{
		items: make(map[string]*fileSnapshot),
	}
}

func (u *undoStore) save(absPath, relPath string) string {
	raw, err := os.ReadFile(absPath)
	existed := err == nil
	if !existed {
		raw = nil
	}

	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	id := "undo_" + hex.EncodeToString(buf)

	u.mu.Lock()
	defer u.mu.Unlock()
	u.items[id] = &fileSnapshot{
		ID:        id,
		AbsPath:   absPath,
		RelPath:   relPath,
		Existed:   existed,
		Content:   raw,
		CreatedAt: time.Now(),
	}
	u.order = append(u.order, id)
	if len(u.order) > maxUndoSnapshots {
		evict := u.order[0]
		u.order = u.order[1:]
		delete(u.items, evict)
	}
	return id
}

func (u *undoStore) restore(id string) (*fileSnapshot, error) {
	u.mu.Lock()
	snap, ok := u.items[id]
	if ok {
		delete(u.items, id)
	}
	u.mu.Unlock()

	if !ok {
		return nil, fmt.Errorf("undo snapshot not found or already used: %s", id)
	}
	if snap.Existed {
		if err := os.MkdirAll(filepath.Dir(snap.AbsPath), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(snap.AbsPath, snap.Content, 0o644); err != nil {
			return nil, err
		}
	} else {
		if err := os.Remove(snap.AbsPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	return snap, nil
}

func generateToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func isWithinRoot(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}

func resolveSafePath(root, relPath string) (string, error) {
	cleaned := strings.TrimSpace(relPath)
	if cleaned == "" {
		cleaned = "."
	}
	if filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, "/") || strings.HasPrefix(cleaned, "\\") {
		return "", fmt.Errorf("absolute paths are not allowed: %s", relPath)
	}

	joined := filepath.Clean(filepath.Join(root, cleaned))
	if !isWithinRoot(root, joined) {
		return "", fmt.Errorf("path escapes workspace root: %s", relPath)
	}

	resolved, err := filepath.EvalSymlinks(joined)
	if err == nil {
		if !isWithinRoot(root, resolved) {
			return "", fmt.Errorf("symlink escapes workspace root: %s", relPath)
		}
		return resolved, nil
	}

	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	curr := filepath.Dir(joined)
	for {
		ancResolved, ancErr := filepath.EvalSymlinks(curr)
		if ancErr == nil {
			if !isWithinRoot(root, ancResolved) {
				return "", fmt.Errorf("parent symlink escapes workspace root: %s", relPath)
			}
			return joined, nil
		}
		if !errors.Is(ancErr, os.ErrNotExist) {
			return "", ancErr
		}
		parent := filepath.Dir(curr)
		if parent == curr {
			return "", fmt.Errorf("unable to resolve parent directory: %s", relPath)
		}
		curr = parent
	}
}

func parseReadPathSpec(raw string) (path string, startLine int, endLine int, hasRange bool) {
	trimmed := strings.TrimSpace(raw)
	m := lineRangePattern.FindStringSubmatch(trimmed)
	if m == nil {
		return trimmed, 0, 0, false
	}
	s, err1 := strconv.Atoi(m[2])
	if err1 != nil || s < 1 {
		return trimmed, 0, 0, false
	}
	e := s + 150
	if m[3] != "" {
		if parsedEnd, err2 := strconv.Atoi(m[3]); err2 == nil && parsedEnd >= s {
			e = parsedEnd
		}
	}
	return strings.TrimSpace(m[1]), s, e, true
}

func isProbablyBinary(data []byte) bool {
	sample := data
	if len(sample) > 8192 {
		sample = sample[:8192]
	}
	if bytes.IndexByte(sample, 0) >= 0 {
		return true
	}
	return !utf8.Valid(sample)
}

func truncateText(s string, limit int) (string, bool) {
	if len(s) <= limit {
		return s, false
	}
	return s[:limit] + fmt.Sprintf("\n... [truncated %d bytes]", len(s)-limit), true
}

func runCmd(ctx context.Context, cwd string, name string, args ...string) (stdout, stderr string, exitCode int, timedOut bool, durationMs int64) {
	start := time.Now()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")

	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	err := cmd.Run()
	durationMs = time.Since(start).Milliseconds()

	stdout, _ = truncateText(outBuf.String(), maxOutputChars)
	stderr, _ = truncateText(errBuf.String(), maxOutputChars)

	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return stdout, strings.TrimSpace(stderr + "\nCommand timed out"), -1, true, durationMs
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return stdout, stderr, exitErr.ExitCode(), false, durationMs
		}
		return stdout, strings.TrimSpace(stderr + "\n" + err.Error()), -1, false, durationMs
	}
	return stdout, stderr, 0, false, durationMs
}

func computeUnifiedDiff(relPath, oldText, newText string) string {
	if oldText == newText {
		return ""
	}
	diffBin, err := exec.LookPath("diff")
	if err != nil {
		return ""
	}
	fOld, err := os.CreateTemp("", "wsl-bridge-old-*")
	if err != nil {
		return ""
	}
	defer os.Remove(fOld.Name())
	_, _ = fOld.WriteString(oldText)
	_ = fOld.Close()

	fNew, err := os.CreateTemp("", "wsl-bridge-new-*")
	if err != nil {
		return ""
	}
	defer os.Remove(fNew.Name())
	_, _ = fNew.WriteString(newText)
	_ = fNew.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, diffBin, "-u", "--label", "a/"+relPath, "--label", "b/"+relPath, fOld.Name(), fNew.Name())
	out, _ := cmd.Output()
	diffText, _ := truncateText(string(out), 20000)
	return diffText
}

// applySingleEdit attempts exact match first, then falls back to line-normalized tolerant matching
// (normalizing CRLF and ignoring trailing whitespace per line).
func applySingleEdit(content, search, replace string, replaceAll bool) (updated string, mode string, err error) {
	if search == "" {
		return "", "", errors.New("search block cannot be empty")
	}

	// 1. Exact match
	occ := strings.Count(content, search)
	if occ == 1 || (occ > 1 && replaceAll) {
		if replaceAll {
			return strings.ReplaceAll(content, search, replace), "exact", nil
		}
		return strings.Replace(content, search, replace, 1), "exact", nil
	}
	if occ > 1 && !replaceAll {
		return "", "", fmt.Errorf("search block matched %d times (provide more context or set replaceAll=true)", occ)
	}

	// 2. Line-normalized tolerant fallback (handles CRLF and trailing whitespace differences)
	lineEnding := "\n"
	if strings.Contains(content, "\r\n") {
		lineEnding = "\r\n"
	}
	normContent := strings.ReplaceAll(content, "\r\n", "\n")
	normSearch := strings.ReplaceAll(search, "\r\n", "\n")
	normReplace := strings.ReplaceAll(replace, "\r\n", "\n")

	contentLines := strings.Split(normContent, "\n")
	searchLines := strings.Split(normSearch, "\n")
	replaceLines := strings.Split(normReplace, "\n")

	if len(searchLines) == 0 || len(searchLines) > len(contentLines) {
		return "", "", errors.New("search block not found")
	}

	normLine := func(s string) string {
		return strings.TrimRight(s, " \t")
	}

	var matches []int
	for i := 0; i <= len(contentLines)-len(searchLines); i++ {
		ok := true
		for j := 0; j < len(searchLines); j++ {
			if normLine(contentLines[i+j]) != normLine(searchLines[j]) {
				ok = false
				break
			}
		}
		if ok {
			matches = append(matches, i)
			i += len(searchLines) - 1
		}
	}

	if len(matches) == 0 {
		return "", "", errors.New("search block not found (exact and tolerant-line matching both failed)")
	}
	if len(matches) > 1 && !replaceAll {
		return "", "", fmt.Errorf("tolerant-line match found %d occurrences (provide more context or set replaceAll=true)", len(matches))
	}

	// Reassemble from end to start so indices stay valid
	resultLines := append([]string(nil), contentLines...)
	for idx := len(matches) - 1; idx >= 0; idx-- {
		pos := matches[idx]
		head := append([]string(nil), resultLines[:pos]...)
		tail := resultLines[pos+len(searchLines):]
		resultLines = append(append(head, replaceLines...), tail...)
	}

	joined := strings.Join(resultLines, lineEnding)
	return joined, "tolerant-line", nil
}

func buildTree(root, targetDir string, maxDepth, maxEntries int) (map[string]any, error) {
	count := 0
	truncated := false

	type dirEntryPair struct {
		fullPath string
		node     treeNode
	}

	listDirect := func(current string) []dirEntryPair {
		entries, err := os.ReadDir(current)
		if err != nil {
			return nil
		}
		sort.Slice(entries, func(i, j int) bool {
			di, dj := entries[i].IsDir(), entries[j].IsDir()
			if di != dj {
				return di
			}
			return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
		})

		var out []dirEntryPair
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() && ignoredDirs[name] {
				continue
			}
			full := filepath.Join(current, name)
			resolved, err := filepath.EvalSymlinks(full)
			if err != nil || !isWithinRoot(root, resolved) {
				continue
			}
			if count >= maxEntries {
				truncated = true
				break
			}
			rel, err := filepath.Rel(root, full)
			if err != nil {
				continue
			}
			relSlash := filepath.ToSlash(rel)
			count++
			if entry.IsDir() {
				out = append(out, dirEntryPair{
					fullPath: full,
					node: treeNode{
						Name:     name,
						Path:     relSlash,
						Type:     "dir",
						Children: []treeNode{},
						HasMore:  true,
					},
				})
			} else {
				var size int64
				if info, statErr := entry.Info(); statErr == nil {
					size = info.Size()
				}
				out = append(out, dirEntryPair{
					fullPath: full,
					node: treeNode{
						Name: name,
						Path: relSlash,
						Type: "file",
						Size: size,
					},
				})
			}
		}
		return out
	}

	rootPairs := listDirect(targetDir)
	topNodes := make([]treeNode, len(rootPairs))
	for i, p := range rootPairs {
		topNodes[i] = p.node
	}

	type queueItem struct {
		fullPath string
		nodePtr  *treeNode
		depth    int
	}

	var queue []queueItem
	for i := range rootPairs {
		if topNodes[i].Type == "dir" {
			queue = append(queue, queueItem{
				fullPath: rootPairs[i].fullPath,
				nodePtr:  &topNodes[i],
				depth:    1,
			})
		}
	}

	for qIdx := 0; qIdx < len(queue); qIdx++ {
		item := queue[qIdx]
		if item.depth >= maxDepth {
			continue
		}
		if count >= maxEntries {
			truncated = true
			break
		}
		children := listDirect(item.fullPath)
		item.nodePtr.Children = make([]treeNode, len(children))
		for i, c := range children {
			item.nodePtr.Children[i] = c.node
		}
		if !truncated {
			item.nodePtr.HasMore = false
		}
		for i := range children {
			if item.nodePtr.Children[i].Type == "dir" {
				queue = append(queue, queueItem{
					fullPath: children[i].fullPath,
					nodePtr:  &item.nodePtr.Children[i],
					depth:    item.depth + 1,
				})
			}
		}
	}

	baseRel, _ := filepath.Rel(root, targetDir)
	return map[string]any{
		"root":      filepath.ToSlash(root),
		"base":      filepath.ToSlash(baseRel),
		"entries":   topNodes,
		"truncated": truncated,
	}, nil
}

func runGitLsFiles(dir string) ([]string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "ls-files", "--cached", "--others", "--exclude-standard")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		return nil, false
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var files []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			files = append(files, filepath.ToSlash(line))
		}
	}
	return files, true
}

func walkFilesFallback(root, baseDir, prefix string) []string {
	var files []string
	_ = filepath.WalkDir(baseDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != baseDir && ignoredDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		resolved, evalErr := filepath.EvalSymlinks(path)
		if evalErr != nil || !isWithinRoot(root, resolved) {
			return nil
		}
		rel, relErr := filepath.Rel(baseDir, path)
		if relErr != nil {
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		if prefix != "" {
			relSlash = prefix + "/" + relSlash
		}
		files = append(files, relSlash)
		return nil
	})
	return files
}

func collectSearchableFiles(root string) ([]string, string) {
	if files, ok := runGitLsFiles(root); ok {
		return files, "git-ls-files"
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, "walkdir"
	}

	var all []string
	usedGit := false
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() && ignoredDirs[name] {
			continue
		}
		full := filepath.Join(root, name)
		resolved, evalErr := filepath.EvalSymlinks(full)
		if evalErr != nil || !isWithinRoot(root, resolved) {
			continue
		}
		if !entry.IsDir() {
			all = append(all, name)
			continue
		}
		if subFiles, ok := runGitLsFiles(full); ok {
			usedGit = true
			for _, sf := range subFiles {
				all = append(all, name+"/"+sf)
			}
		} else {
			all = append(all, walkFilesFallback(root, full, name)...)
		}
	}

	if usedGit {
		return all, "multi-repo-git-ls-files"
	}
	return all, "walkdir"
}

func matchesTokens(path string, tokens []string) bool {
	lower := strings.ToLower(path)
	for _, tok := range tokens {
		if !strings.Contains(lower, tok) {
			return false
		}
	}
	return true
}

func newHandler(cfg bridgeConfig) http.Handler {
	snapshots := newUndoStore()

	setCORS := func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if strings.HasPrefix(origin, "chrome-extension://") || strings.HasPrefix(origin, "extension://") {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	}

	sendJSON := func(w http.ResponseWriter, r *http.Request, status int, payload any) {
		setCORS(w, r)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(payload)
	}

	checkAuth := func(w http.ResponseWriter, r *http.Request) bool {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			sendJSON(w, r, http.StatusUnauthorized, map[string]any{"error": "Missing Bearer token"})
			return false
		}
		provided := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
		if subtle.ConstantTimeCompare([]byte(provided), []byte(cfg.Token)) != 1 {
			sendJSON(w, r, http.StatusForbidden, map[string]any{"error": "Invalid token"})
			return false
		}
		return true
	}

	readJSONBody := func(r *http.Request, dst any) error {
		limited := io.LimitReader(r.Body, maxBodyBytes+1)
		raw, err := io.ReadAll(limited)
		if err != nil {
			return err
		}
		if len(raw) > maxBodyBytes {
			return errors.New("request body exceeds 5MB limit")
		}
		if len(bytes.TrimSpace(raw)) == 0 {
			raw = []byte("{}")
		}
		return json.Unmarshal(raw, dst)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			setCORS(w, r)
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if r.URL.Path == "/api/health" && r.Method == http.MethodGet {
			sendJSON(w, r, http.StatusOK, map[string]any{
				"ok":      true,
				"service": "wsl-web-bridge",
				"version": "3.0.0-go",
			})
			return
		}

		if !checkAuth(w, r) {
			return
		}

		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/info":
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			branchOut, _, rc, _, _ := runCmd(ctx, cfg.Root, "git", "rev-parse", "--abbrev-ref", "HEAD")
			var branch any
			if rc == 0 && strings.TrimSpace(branchOut) != "" {
				branch = strings.TrimSpace(branchOut)
			}
			distro := os.Getenv("WSL_DISTRO_NAME")
			if distro == "" {
				distro = "Linux"
			}
			sendJSON(w, r, http.StatusOK, map[string]any{
				"ok":        true,
				"root":      filepath.ToSlash(cfg.Root),
				"name":      filepath.Base(cfg.Root),
				"distro":    distro,
				"gitBranch": branch,
				"goVersion": runtime.Version(),
				"version":   "3.0.0-go",
			})

		case r.Method == http.MethodGet && r.URL.Path == "/api/tree":
			relDir := r.URL.Query().Get("dir")
			if relDir == "" {
				relDir = "."
			}
			depth := 1
			if dStr := r.URL.Query().Get("depth"); dStr != "" {
				if parsed, err := strconv.Atoi(dStr); err == nil {
					depth = parsed
				}
			}
			if depth < 1 {
				depth = 1
			} else if depth > 6 {
				depth = 6
			}
			limit := 2000
			if lStr := r.URL.Query().Get("limit"); lStr != "" {
				if parsed, err := strconv.Atoi(lStr); err == nil {
					limit = parsed
				}
			}
			if limit < 50 {
				limit = 50
			} else if limit > 10000 {
				limit = 10000
			}

			target, err := resolveSafePath(cfg.Root, relDir)
			if err != nil {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			info, statErr := os.Stat(target)
			if statErr != nil || !info.IsDir() {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": "Not a directory: " + relDir})
				return
			}
			data, err := buildTree(cfg.Root, target, depth, limit)
			if err != nil {
				sendJSON(w, r, http.StatusInternalServerError, map[string]any{"error": err.Error()})
				return
			}
			sendJSON(w, r, http.StatusOK, data)

		case r.Method == http.MethodGet && r.URL.Path == "/api/search":
			q := strings.TrimSpace(r.URL.Query().Get("q"))
			limit := 100
			if lStr := r.URL.Query().Get("limit"); lStr != "" {
				if parsed, err := strconv.Atoi(lStr); err == nil {
					limit = parsed
				}
			}
			if limit < 1 {
				limit = 1
			} else if limit > 500 {
				limit = 500
			}
			if q == "" {
				sendJSON(w, r, http.StatusOK, map[string]any{
					"ok":           true,
					"query":        "",
					"source":       "none",
					"totalMatched": 0,
					"truncated":    false,
					"results":      []searchItem{},
				})
				return
			}

			tokens := strings.Fields(strings.ToLower(q))
			files, source := collectSearchableFiles(cfg.Root)
			results := make([]searchItem, 0, limit)
			totalMatched := 0
			for _, f := range files {
				if matchesTokens(f, tokens) {
					totalMatched++
					if len(results) < limit {
						results = append(results, searchItem{
							Name: filepath.Base(f),
							Path: f,
						})
					}
				}
			}
			sendJSON(w, r, http.StatusOK, map[string]any{
				"ok":           true,
				"query":        q,
				"source":       source,
				"totalMatched": totalMatched,
				"truncated":    totalMatched > len(results),
				"results":      results,
			})

		case r.Method == http.MethodGet && r.URL.Path == "/api/git/diff":
			staged := strings.EqualFold(r.URL.Query().Get("staged"), "true")
			ctx1, cancel1 := context.WithTimeout(r.Context(), 10*time.Second)
			defer cancel1()
			statusOut, statusErr, statusRC, _, _ := runCmd(ctx1, cfg.Root, "git", "status", "-sb")

			ctx2, cancel2 := context.WithTimeout(r.Context(), 15*time.Second)
			defer cancel2()
			diffArgs := []string{"diff"}
			if staged {
				diffArgs = append(diffArgs, "--cached")
			}
			diffOut, diffErr, _, _, _ := runCmd(ctx2, cfg.Root, "git", diffArgs...)
			sendJSON(w, r, http.StatusOK, map[string]any{
				"ok":        statusRC == 0,
				"status":    strings.TrimSpace(statusOut),
				"diff":      diffOut,
				"stderr":    strings.TrimSpace(statusErr + "\n" + diffErr),
				"truncated": len(diffOut) >= maxOutputChars,
			})

		case r.Method == http.MethodPost && r.URL.Path == "/api/read":
			var req struct {
				Paths []string `json:"paths"`
			}
			if err := readJSONBody(r, &req); err != nil {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			if len(req.Paths) == 0 || len(req.Paths) > 25 {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": "paths must contain 1 to 25 items"})
				return
			}

			filesOut := make([]map[string]any, 0, len(req.Paths))
			totalBytes := 0
			for _, rawSpec := range req.Paths {
				rel, startLine, endLine, hasRange := parseReadPathSpec(rawSpec)
				target, err := resolveSafePath(cfg.Root, rel)
				if err != nil {
					sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": err.Error()})
					return
				}
				info, statErr := os.Stat(target)
				if statErr != nil || info.IsDir() {
					filesOut = append(filesOut, map[string]any{"path": rel, "error": "File not found"})
					continue
				}
				raw, readErr := os.ReadFile(target)
				if readErr != nil {
					filesOut = append(filesOut, map[string]any{"path": rel, "error": readErr.Error()})
					continue
				}
				if isProbablyBinary(raw) {
					filesOut = append(filesOut, map[string]any{"path": rel, "error": "Binary file skipped", "size": len(raw)})
					continue
				}

				fullText := strings.ReplaceAll(string(raw), "\r\n", "\n")
				allLines := strings.Split(fullText, "\n")
				totalLines := len(allLines)

				var selectedText string
				actualStart := 1
				actualEnd := totalLines
				if hasRange {
					if startLine > totalLines {
						selectedText = ""
						actualStart = startLine
						actualEnd = totalLines
					} else {
						actualStart = startLine
						actualEnd = endLine
						if actualEnd > totalLines {
							actualEnd = totalLines
						}
						selectedText = strings.Join(allLines[actualStart-1:actualEnd], "\n")
					}
				} else {
					selectedText = fullText
				}

				truncated := false
				if len(selectedText) > maxFileBytes {
					selectedText = selectedText[:maxFileBytes]
					truncated = true
				}
				if totalBytes+len(selectedText) > maxTotalReadBytes {
					filesOut = append(filesOut, map[string]any{"path": rel, "error": "Batch size limit exceeded"})
					continue
				}
				totalBytes += len(selectedText)
				relNorm, _ := filepath.Rel(cfg.Root, target)
				filesOut = append(filesOut, map[string]any{
					"path":       filepath.ToSlash(relNorm),
					"content":    selectedText,
					"lines":      strings.Count(selectedText, "\n") + 1,
					"totalLines": totalLines,
					"startLine":  actualStart,
					"endLine":    actualEnd,
					"sliced":     hasRange,
					"truncated":  truncated,
				})
			}
			sendJSON(w, r, http.StatusOK, map[string]any{"ok": true, "files": filesOut})

		case r.Method == http.MethodPost && r.URL.Path == "/api/exec":
			var req struct {
				Command string `json:"command"`
				Cwd     string `json:"cwd"`
				Timeout int    `json:"timeout"`
			}
			if err := readJSONBody(r, &req); err != nil {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			if strings.TrimSpace(req.Command) == "" {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": "command must be a non-empty string"})
				return
			}
			targetCwd, err := resolveSafePath(cfg.Root, req.Cwd)
			if err != nil {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			info, statErr := os.Stat(targetCwd)
			if statErr != nil || !info.IsDir() {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": "cwd is not a directory"})
				return
			}
			timeout := req.Timeout
			if timeout <= 0 {
				timeout = defaultTimeoutSec
			} else if timeout > maxTimeoutSec {
				timeout = maxTimeoutSec
			}

			relCwd, _ := filepath.Rel(cfg.Root, targetCwd)
			log.Printf("EXEC cwd=%s cmd=%q", filepath.ToSlash(relCwd), req.Command)

			bashBin, err := exec.LookPath("bash")
			if err != nil {
				bashBin = "/bin/sh"
			}
			ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeout)*time.Second)
			defer cancel()
			stdout, stderr, rc, timedOut, durationMs := runCmd(ctx, targetCwd, bashBin, "-lc", req.Command)
			sendJSON(w, r, http.StatusOK, map[string]any{
				"ok":         rc == 0,
				"returncode": rc,
				"stdout":     stdout,
				"stderr":     stderr,
				"truncated":  len(stdout) >= maxOutputChars || len(stderr) >= maxOutputChars,
				"timedOut":   timedOut,
				"durationMs": durationMs,
			})

		case r.Method == http.MethodPost && r.URL.Path == "/api/write":
			var req struct {
				Path    string  `json:"path"`
				Content *string `json:"content"`
			}
			if err := readJSONBody(r, &req); err != nil {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			if strings.TrimSpace(req.Path) == "" || req.Content == nil {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": "path and content are required"})
				return
			}
			target, err := resolveSafePath(cfg.Root, req.Path)
			if err != nil {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			relNorm, _ := filepath.Rel(cfg.Root, target)
			relSlash := filepath.ToSlash(relNorm)
			oldBytes, _ := os.ReadFile(target)
			undoID := snapshots.save(target, relSlash)

			if mkErr := os.MkdirAll(filepath.Dir(target), 0o755); mkErr != nil {
				sendJSON(w, r, http.StatusInternalServerError, map[string]any{"error": mkErr.Error()})
				return
			}
			if wrErr := os.WriteFile(target, []byte(*req.Content), 0o644); wrErr != nil {
				sendJSON(w, r, http.StatusInternalServerError, map[string]any{"error": wrErr.Error()})
				return
			}
			log.Printf("WRITE path=%s bytes=%d undo=%s", relSlash, len(*req.Content), undoID)
			sendJSON(w, r, http.StatusOK, map[string]any{
				"ok":           true,
				"path":         relSlash,
				"bytesWritten": len(*req.Content),
				"undoId":       undoID,
				"diff":         computeUnifiedDiff(relSlash, string(oldBytes), *req.Content),
			})

		case r.Method == http.MethodPost && r.URL.Path == "/api/patch":
			type patchEdit struct {
				Search     string `json:"search"`
				Replace    string `json:"replace"`
				ReplaceAll bool   `json:"replaceAll"`
			}
			var req struct {
				Diff       string      `json:"diff"`
				Path       string      `json:"path"`
				Search     string      `json:"search"`
				Replace    string      `json:"replace"`
				ReplaceAll bool        `json:"replaceAll"`
				Edits      []patchEdit `json:"edits"`
			}
			if err := readJSONBody(r, &req); err != nil {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}

			// Mode 1: Unified diff via git apply
			if strings.TrimSpace(req.Diff) != "" {
				diffInput := req.Diff
				if !strings.HasSuffix(diffInput, "\n") {
					diffInput += "\n"
				}
				checkCmd := exec.Command("git", "apply", "--check", "-")
				checkCmd.Dir = cfg.Root
				checkCmd.Stdin = strings.NewReader(diffInput)
				var checkErr bytes.Buffer
				checkCmd.Stderr = &checkErr
				if err := checkCmd.Run(); err != nil {
					sendJSON(w, r, http.StatusConflict, map[string]any{
						"ok":     false,
						"error":  "git apply --check failed",
						"stderr": strings.TrimSpace(checkErr.String()),
					})
					return
				}
				applyCmd := exec.Command("git", "apply", "-")
				applyCmd.Dir = cfg.Root
				applyCmd.Stdin = strings.NewReader(diffInput)
				var applyErr bytes.Buffer
				applyCmd.Stderr = &applyErr
				err := applyCmd.Run()
				log.Printf("PATCH (git-apply) ok=%v", err == nil)
				sendJSON(w, r, http.StatusOK, map[string]any{
					"ok":     err == nil,
					"mode":   "git-apply",
					"stderr": strings.TrimSpace(applyErr.String()),
				})
				return
			}

			// Mode 2: Exact or line-normalized tolerant search/replace
			if strings.TrimSpace(req.Path) == "" {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": "Either 'diff' or 'path' with 'search'/'replace' is required"})
				return
			}
			target, err := resolveSafePath(cfg.Root, req.Path)
			if err != nil {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			origBytes, err := os.ReadFile(target)
			if err != nil {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": "File does not exist: " + req.Path})
				return
			}

			edits := req.Edits
			if len(edits) == 0 {
				edits = []patchEdit{{Search: req.Search, Replace: req.Replace, ReplaceAll: req.ReplaceAll}}
			}

			original := string(origBytes)
			updated := original
			matchMode := "exact"
			for i, e := range edits {
				nextUpdated, m, editErr := applySingleEdit(updated, e.Search, e.Replace, e.ReplaceAll)
				if editErr != nil {
					sendJSON(w, r, http.StatusConflict, map[string]any{
						"ok":    false,
						"error": fmt.Sprintf("Edit #%d in %s: %v", i+1, req.Path, editErr),
					})
					return
				}
				updated = nextUpdated
				if m != "exact" {
					matchMode = m
				}
			}

			relNorm, _ := filepath.Rel(cfg.Root, target)
			relSlash := filepath.ToSlash(relNorm)
			undoID := snapshots.save(target, relSlash)

			if wrErr := os.WriteFile(target, []byte(updated), 0o644); wrErr != nil {
				sendJSON(w, r, http.StatusInternalServerError, map[string]any{"error": wrErr.Error()})
				return
			}
			log.Printf("PATCH (%s) path=%s edits=%d undo=%s", matchMode, relSlash, len(edits), undoID)
			sendJSON(w, r, http.StatusOK, map[string]any{
				"ok":        true,
				"mode":      "search-replace",
				"matchMode": matchMode,
				"path":      relSlash,
				"undoId":    undoID,
				"diff":      computeUnifiedDiff(relSlash, original, updated),
			})

		case r.Method == http.MethodPost && r.URL.Path == "/api/undo":
			var req struct {
				UndoID string `json:"undoId"`
			}
			if err := readJSONBody(r, &req); err != nil {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
			if strings.TrimSpace(req.UndoID) == "" {
				sendJSON(w, r, http.StatusBadRequest, map[string]any{"error": "undoId is required"})
				return
			}
			snap, err := snapshots.restore(req.UndoID)
			if err != nil {
				sendJSON(w, r, http.StatusNotFound, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			action := "restored"
			if !snap.Existed {
				action = "deleted"
			}
			log.Printf("UNDO id=%s path=%s action=%s", req.UndoID, snap.RelPath, action)
			sendJSON(w, r, http.StatusOK, map[string]any{
				"ok":     true,
				"path":   snap.RelPath,
				"action": action,
			})

		default:
			sendJSON(w, r, http.StatusNotFound, map[string]any{"error": "Unknown route: " + r.URL.Path})
		}
	})
}

func main() {
	defaultToken := os.Getenv("WSL_BRIDGE_TOKEN")
	if defaultToken == "" {
		defaultToken = os.Getenv("NEON_BRIDGE_TOKEN")
	}
	rootFlag := flag.String("root", ".", "Workspace directory inside WSL to expose")
	portFlag := flag.Int("port", defaultPort, "Localhost port to bind")
	tokenFlag := flag.String("token", defaultToken, "Auth token (auto-generated if omitted)")
	flag.Parse()

	absRoot, err := filepath.Abs(*rootFlag)
	if err != nil {
		log.Fatalf("Failed to resolve root path: %v", err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(absRoot)
	if err != nil {
		log.Fatalf("Workspace root does not exist: %s (%v)", absRoot, err)
	}
	info, err := os.Stat(resolvedRoot)
	if err != nil || !info.IsDir() {
		log.Fatalf("Workspace root is not a directory: %s", resolvedRoot)
	}

	token := strings.TrimSpace(*tokenFlag)
	if token == "" {
		token, err = generateToken()
		if err != nil {
			log.Fatalf("Failed to generate token: %v", err)
		}
	}

	cfg := bridgeConfig{
		Root:  resolvedRoot,
		Token: token,
		Host:  defaultHost,
		Port:  *portFlag,
	}

	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	distro := os.Getenv("WSL_DISTRO_NAME")
	if distro == "" {
		distro = "Linux"
	}

	fmt.Println(strings.Repeat("=", 64))
	fmt.Println("  WSL Web Bridge Server (Go v3.0) is running")
	fmt.Println(strings.Repeat("=", 64))
	fmt.Printf("  Endpoint : http://%s\n", addr)
	fmt.Printf("  Workspace: %s\n", cfg.Root)
	fmt.Printf("  WSL      : %s\n", distro)
	fmt.Printf("  Token    : %s\n", cfg.Token)
	fmt.Println(strings.Repeat("=", 64))
	fmt.Println("  Paste the Endpoint and Token into the WSL Web Bridge Side Panel.")
	fmt.Println("  Press Ctrl+C to stop.")
	fmt.Println()

	srv := &http.Server{
		Addr:              addr,
		Handler:           newHandler(cfg),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}
