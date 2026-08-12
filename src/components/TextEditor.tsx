import { useEffect, useRef, useState } from "react";

import * as ipc from "../ipc";
import { locationCaps, refusal } from "../location";
import type { Volume } from "../types";
import { MarkdownView } from "./MarkdownView";
import { NewFileIcon, PanelIcon } from "./icons";

const TYPES = [".txt", ".md", ".json", ".js", ".ts", ".csv"];

interface Props {
  /** Omit `path` to begin a new document. */
  path?: string;
  parent: string;
  initialText: string;
  /** Mounted volumes: Save has to know whether the disk underneath will take
   * the write, and a read-only one refuses it for a different reason than a
   * phone does. */
  volumes?: Volume[];
  onClose: () => void;
  onCreated: (path: string) => void;
  onSaved: (name: string) => void;
}

/**
 * A deliberately small text editor. It does no syntax magic, no accounts, and
 * no hidden autosave: every visible character is the file and Save is explicit.
 *
 * A file read off a phone or a nearby device opens here too, as a reader: the
 * text still arrives, but saving would go out through the local filesystem and
 * fail, so the editor says so up front rather than at the end of an edit.
 */
export function TextEditor({ path: initialPath, parent, initialText, volumes = [], onClose, onCreated, onSaved }: Props) {
  const [path, setPath] = useState(initialPath);
  const [name, setName] = useState(initialPath ? basename(initialPath) : "untitled.txt");
  const [text, setText] = useState(initialText);
  const [savedText, setSavedText] = useState(initialText);
  const [previewOpen, setPreviewOpen] = useState(() => isMarkdown(initialPath ?? "untitled.txt"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  // A document with a path would be written over itself; one without would be
  // made in the folder behind the editor. Different questions, different answer
  // on a device, so ask the one that matches what Save would actually do.
  const at = locationCaps(path ?? parent, volumes);
  const writable = path ? at.modify : at.create;
  const dirty = text !== savedText;
  const lines = text ? text.split("\n").length : 1;
  const markdown = isMarkdown(path ?? name);
  // A new Markdown document should feel complete as soon as it becomes one,
  // while an explicit close remains respected for the rest of the edit.
  const markdownRef = useRef(markdown);

  useEffect(() => {
    if (markdown && !markdownRef.current) setPreviewOpen(true);
    if (!markdown) setPreviewOpen(false);
    markdownRef.current = markdown;
  }, [markdown]);

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
    if (saving || !writable) return;
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
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p" && markdown) {
        e.preventDefault();
        setPreviewOpen((open) => !open);
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
    <section
      className="editor-shell"
      role="dialog"
      aria-modal="true"
      aria-label={path ? `${writable ? "Editing" : "Viewing"} ${basename(path)}` : "New text file"}
    >
      <header className="editor-bar">
        <button className="editor-close" onClick={close} aria-label="Close editor">×</button>
        <div className="editor-title">
          <NewFileIcon size={15} />
          {path ? <span>{basename(path)}</span> : <span>New text file</span>}
          {dirty && <i title="Unsaved changes" />}
        </div>
        <div className="editor-actions">
          {markdown && (
            <button
              className={`editor-preview-toggle ${previewOpen ? "on" : ""}`}
              onClick={() => setPreviewOpen((open) => !open)}
              title={`${previewOpen ? "Hide" : "Show"} Markdown preview (⇧⌘P)`}
              aria-label={`${previewOpen ? "Hide" : "Show"} Markdown preview`}
              aria-pressed={previewOpen}
            >
              <PanelIcon size={17} />
              <span>Preview</span>
            </button>
          )}
          {writable && (
            <button className="editor-save" onClick={() => void save()} disabled={saving || (!dirty && !!path)}>
              {saving ? "Saving…" : path ? "Save" : "Create"}
            </button>
          )}
        </div>
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

      <div className={`editor-body${markdown && previewOpen ? " split" : ""}`}>
        <div className="editor-source">
          <textarea
            ref={editorRef}
            className="editor-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={!writable}
            spellCheck={false}
            placeholder="Start typing…"
            onKeyDown={(e) => {
              if (e.key !== "Tab" || !writable) return;
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
        {markdown && previewOpen && (
          <div className="editor-markdown-preview" aria-label="Markdown preview">
            <MarkdownView path={path ?? previewPath(parent, name)} source={text} />
          </div>
        )}
      </div>
      <footer className="editor-foot">
        <span>{lines} {lines === 1 ? "line" : "lines"}</span>
        {error ? (
          <span className="editor-error">{error}</span>
        ) : (
          <span>{writable ? (dirty ? "Unsaved" : "Saved") : refusal(at, "save changes")}</span>
        )}
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

function isMarkdown(fileName: string) {
  return /\.(?:md|markdown)$/i.test(fileName.trim());
}

function previewPath(parent: string, fileName: string) {
  return `${parent.replace(/\/$/, "")}/${fileName.trim() || "untitled.md"}`;
}
