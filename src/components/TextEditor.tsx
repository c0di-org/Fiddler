import { useEffect, useRef, useState } from "react";

import * as ipc from "../ipc";
import { NewFileIcon } from "./icons";

const TYPES = [".txt", ".md", ".json", ".js", ".ts", ".csv"];

interface Props {
  /** Omit `path` to begin a new document. */
  path?: string;
  parent: string;
  initialText: string;
  onClose: () => void;
  onCreated: (path: string) => void;
  onSaved: (name: string) => void;
}

/**
 * A deliberately small text editor. It does no syntax magic, no accounts, and
 * no hidden autosave: every visible character is the file and Save is explicit.
 */
export function TextEditor({ path: initialPath, parent, initialText, onClose, onCreated, onSaved }: Props) {
  const [path, setPath] = useState(initialPath);
  const [name, setName] = useState(initialPath ? basename(initialPath) : "untitled.txt");
  const [text, setText] = useState(initialText);
  const [savedText, setSavedText] = useState(initialText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== savedText;
  const lines = text ? text.split("\n").length : 1;

  useEffect(() => {
    const target = path ? editorRef.current : inputRef.current;
    target?.focus();
    if (!path && inputRef.current) inputRef.current.select();
  }, [path]);

  const close = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  };

  const save = async () => {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      if (path) {
        await ipc.writeTextFile(path, text);
      } else {
        const created = await ipc.createTextFile(parent, name, text);
        setPath(created);
        onCreated(created);
      }
      setSavedText(text);
      onSaved(path ? basename(path) : name.trim());
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const switchType = (extension: string) => {
    setName((current) => withExtension(current, extension));
    inputRef.current?.focus();
  };

  return (
    <section className="editor-shell" role="dialog" aria-modal="true" aria-label={path ? `Editing ${basename(path)}` : "New text file"}>
      <header className="editor-bar">
        <button className="editor-close" onClick={close} aria-label="Close editor">×</button>
        <div className="editor-title">
          <NewFileIcon size={15} />
          {path ? <span>{basename(path)}</span> : <span>New text file</span>}
          {dirty && <i title="Unsaved changes" />}
        </div>
        <button className="editor-save" onClick={() => void save()} disabled={saving || (!dirty && !!path)}>
          {saving ? "Saving…" : path ? "Save" : "Create"}
        </button>
      </header>

      {!path && (
        <div className="editor-file-meta">
          <label>
            <span>File name</span>
            <input
              ref={inputRef}
              value={name}
              placeholder="notes.md"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") editorRef.current?.focus();
              }}
            />
          </label>
          <div className="editor-types" aria-label="Choose file type">
            {TYPES.map((extension) => (
              <button key={extension} className={name.endsWith(extension) ? "on" : ""} onClick={() => switchType(extension)}>
                {extension}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="editor-body">
        <textarea
          ref={editorRef}
          className="editor-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder="Start typing…"
          onKeyDown={(e) => {
            if (e.key !== "Tab") return;
            e.preventDefault();
            const node = e.currentTarget;
            const start = node.selectionStart;
            const end = node.selectionEnd;
            const next = `${text.slice(0, start)}  ${text.slice(end)}`;
            setText(next);
            requestAnimationFrame(() => node.setSelectionRange(start + 2, start + 2));
          }}
        />
      </div>
      <footer className="editor-foot">
        <span>{lines} {lines === 1 ? "line" : "lines"}</span>
        {error ? <span className="editor-error">{error}</span> : <span>{dirty ? "Unsaved" : "Saved"}</span>}
      </footer>
    </section>
  );
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function withExtension(name: string, extension: string) {
  const clean = name.trim() || "untitled";
  const dot = clean.lastIndexOf(".");
  return dot > 0 ? `${clean.slice(0, dot)}${extension}` : `${clean}${extension}`;
}
