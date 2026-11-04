import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import "./style.css";
import { DEFAULT_SYSTEM_PROMPT } from "../src/prompt.js";

const requestStatus = z.enum(["pending", "running", "completed", "failed"]);
const summary = z.object({
  id: z.string(),
  title: z.string(),
  status: requestStatus,
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
const details = summary.extend({
  timeline: z.array(
    z.object({ id: z.string(), message: z.string(), created_at: z.string() }),
  ),
  instructions: z.string(),
  system_prompt: z.string(),
  progress_message: z.string().nullable(),
  final_text: z.string().nullable(),
  validation_summary: z.string().nullable(),
  failure_message: z.string().nullable(),
  files: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(["input", "output"]),
      size_bytes: z.number(),
      sha256: z.string(),
    }),
  ),
});
type Summary = z.infer<typeof summary>;
type Details = z.infer<typeof details>;
async function api(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ message: z.string() }).safeParse(value);
    throw new Error(
      error.success
        ? error.data.message
        : "The request could not be completed. Try again.",
    );
  }
  return value;
}
function displayDate(value: string, seconds = false) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: seconds ? "medium" : "short",
  }).format(new Date(value));
}
function displayDuration(item: Summary, now: number) {
  const seconds = Math.max(
    0,
    Math.floor(
      ((item.finished_at ? Date.parse(item.finished_at) : now) -
        Date.parse(item.created_at)) /
        1000,
    ),
  );
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return hours
    ? `${hours}h ${String(minutes).padStart(2, "0")}m ${remainder}s`
    : `${minutes}m ${remainder}s`;
}
function Status({ value }: { value: Summary["status"] }) {
  return (
    <span className={`status ${value}`}>
      {value[0]?.toUpperCase()}
      {value.slice(1)}
    </span>
  );
}

function NewRequest({ onSubmitted }: { onSubmitted: (id: string) => void }) {
  const [instructions, setInstructions] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [promptOpen, setPromptOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [preparation, setPreparation] = useState("");
  const initialized = useRef(false);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const session = z
          .object({
            system_prompt: z.string(),
            workspace: z.object({
              status: z.string(),
              uploaded_bytes: z.number(),
              total_bytes: z.number(),
              failure_message: z.string().nullable(),
            }),
          })
          .parse(await api("/api/session"));
        if (!active) return;
        if (!initialized.current) {
          setSystemPrompt(session.system_prompt);
          initialized.current = true;
        }
        setLoaded(true);
        const w = session.workspace;
        setPreparation(
          w.status === "uploading"
            ? `Preparing your workspace: uploading shared tools (${w.total_bytes ? Math.floor((w.uploaded_bytes * 100) / w.total_bytes) : 0}%). You can submit while preparation continues.`
            : w.status === "pending" || w.status === "preparing"
              ? "Preparing your workspace in the background. You can submit now; work starts when it is ready."
              : w.status === "failed"
                ? (w.failure_message ??
                  "Your workspace needs attention. Contact support.")
                : "",
        );
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load your workspace.",
          );
      }
    }
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submissionKey = useRef(crypto.randomUUID());
  const uploaded = useRef(new Map<File, string>());
  const promptSave = useRef<Promise<unknown>>(Promise.resolve());
  function savePrompt(value: string) {
    promptSave.current = promptSave.current
      .catch(() => {})
      .then(() =>
        api("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ system_prompt: value }),
        }),
      );
    return promptSave.current;
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !loaded) return;
    setBusy(true);
    setError("");
    try {
      if (
        files.length > 8 ||
        files.reduce((sum, f) => sum + f.size, 0) > 20 * 1024 * 1024
      )
        throw new Error(
          "Attach at most eight files, totalling no more than 20 MiB.",
        );
      await savePrompt(systemPrompt);
      const ids: string[] = [];
      for (const file of files) {
        let fileId = uploaded.current.get(file);
        if (!fileId) {
          const form = new FormData();
          form.append("file", file);
          const result = z
            .object({ id: z.string() })
            .parse(
              await api("/api/attachments", { method: "POST", body: form }),
            );
          fileId = result.id;
          uploaded.current.set(file, fileId);
        }
        ids.push(fileId);
      }
      const result = z.object({ id: z.string() }).parse(
        await api("/api/requests", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": submissionKey.current,
          },
          body: JSON.stringify({
            instructions,
            system_prompt: systemPrompt,
            attachment_ids: ids,
          }),
        }),
      );
      onSubmitted(result.id);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Submission failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="new-request">
      <h1 id="new-request">New request</h1>
      {preparation && (
        <p className="notice" role="status">
          {preparation}
        </p>
      )}
      <form onSubmit={submit}>
        <div className="instructions-heading">
          <label htmlFor="instructions">Instructions</label>
          <button
            type="button"
            className="link prompt-toggle"
            aria-expanded={promptOpen}
            aria-controls="system-prompt-panel"
            onClick={() => setPromptOpen((value) => !value)}
          >
            System prompt
          </button>
        </div>
        {promptOpen && (
          <div id="system-prompt-panel" className="system-prompt-panel">
            <label htmlFor="system-prompt">Default system prompt</label>
            <textarea
              id="system-prompt"
              rows={10}
              value={systemPrompt}
              maxLength={16000}
              required
              disabled={busy || !loaded}
              onChange={(event) => setSystemPrompt(event.target.value)}
              onBlur={() => {
                if (loaded && systemPrompt.trim())
                  void savePrompt(systemPrompt).catch((reason) =>
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : "Could not save your system prompt.",
                    ),
                  );
              }}
            />
            <p className="hint">
              Used with your instructions for every new request. Changes save
              when you leave this field. Each request keeps its own copy.
            </p>
          </div>
        )}
        <textarea
          id="instructions"
          name="instructions"
          placeholder="Describe the result you need…"
          rows={5}
          value={instructions}
          required
          maxLength={16000}
          disabled={busy}
          onChange={(event) => setInstructions(event.target.value)}
        />
        <label htmlFor="attachments">
          Input files <span className="optional">(optional)</span>
        </label>
        <input
          id="attachments"
          type="file"
          multiple
          accept=".docx,.txt,.md"
          disabled={busy}
          onChange={(event) => {
            setFiles(Array.from(event.target.files ?? []));
          }}
        />
        <p className="hint">
          One DOCX and text or Markdown files. Up to 8 files; 10 MiB each, 20
          MiB total.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={
            busy || !loaded || !instructions.trim() || !systemPrompt.trim()
          }
        >
          {busy ? "Submitting…" : "Submit request"}
        </button>
      </form>
    </section>
  );
}
function RequestList({
  onOpen,
  refresh,
}: {
  onOpen: (id: string) => void;
  refresh: number;
}) {
  const [items, setItems] = useState<Summary[]>([]);
  const [now, setNow] = useState(Date.now);
  const hasActive = items.some((item) => item.finished_at === null);
  useEffect(() => {
    if (!hasActive) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActive]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [pages, setPages] = useState<Array<string | null>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = z
          .object({
            requests: z.array(summary),
            next_cursor: z.string().nullable(),
          })
          .parse(
            await api(
              `/api/requests${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
            ),
          );
        if (active) {
          setItems(result.requests);
          setNext(result.next_cursor);
          setError("");
        }
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load requests.",
          );
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [cursor, refresh]);
  return (
    <section aria-labelledby="your-requests" className="request-list">
      <h2 id="your-requests">Your requests</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loading ? (
        <p className="muted">Loading requests…</p>
      ) : items.length === 0 ? (
        <p className="muted">
          No requests yet. Submit one above to get started.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Request</th>
                <th>Created</th>
                <th>Status</th>
                <th title="From submission until the result is ready or the request fails, including queue time">
                  Total time
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <button
                      className="link request-title"
                      onClick={() => onOpen(item.id)}
                    >
                      {item.title}
                    </button>
                    <span className="request-id">{item.id}</span>
                  </td>
                  <td className="date">{displayDate(item.created_at)}</td>
                  <td>
                    <Status value={item.status} />
                  </td>
                  <td className="duration">{displayDuration(item, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(pages.length > 0 || next) && (
        <nav aria-label="Request pages" className="pagination">
          <button
            className="secondary"
            disabled={pages.length === 0}
            onClick={() => {
              const copy = [...pages];
              setCursor(copy.pop() ?? null);
              setPages(copy);
            }}
          >
            Previous
          </button>
          <button
            className="secondary"
            disabled={!next}
            onClick={() => {
              setPages([...pages, cursor]);
              setCursor(next);
            }}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
function RequestDetail({
  requestId,
  onBack,
  submitted,
}: {
  requestId: string;
  onBack: () => void;
  submitted: boolean;
}) {
  const [request, setRequest] = useState<Details | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const value = details.parse(
          await api(`/api/requests/${encodeURIComponent(requestId)}`),
        );
        if (active) {
          setRequest(value);
          setError("");
        }
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load request.",
          );
      }
    }
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [requestId]);
  return (
    <section>
      <button className="link back" onClick={onBack}>
        ← All requests
      </button>
      {submitted && (
        <p role="status" className="confirmation">
          Request submitted. You can return to this request for the result.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!request ? (
        <p className="muted">Loading request…</p>
      ) : (
        <>
          <div className="detail-heading">
            <h1>{request.title}</h1>
            <Status value={request.status} />
          </div>
          <p className="request-id">{request.id}</p>
          <p className="muted">Created {displayDate(request.created_at)}</p>
          <h2>Instructions</h2>
          <p className="preserve">{request.instructions}</p>
          <details className="request-prompt">
            <summary>System prompt used for this request</summary>
            <p className="preserve">
              {request.system_prompt ||
                "This request used the earlier built-in prompt."}
            </p>
          </details>
          <section aria-labelledby="status-timeline">
            <h2 id="status-timeline">Status timeline</h2>
            <p className="sr-only" role="status">
              {request.timeline[0]?.message}
            </p>
            <ol className="timeline" aria-label="Status updates, newest first">
              {request.timeline.map((event) => (
                <li key={event.id}>
                  <p>{event.message}</p>
                  <time dateTime={event.created_at}>
                    {displayDate(event.created_at, true)}
                  </time>
                </li>
              ))}
            </ol>
          </section>
          {request.status === "failed" && (
            <p role="alert" className="error">
              {request.failure_message ??
                "The request could not finish. Contact support with the request identifier."}
            </p>
          )}
          {request.status === "completed" && (
            <div className="result">
              <h2>Result</h2>
              {request.final_text && (
                <p className="preserve final-text">{request.final_text}</p>
              )}
              {request.files.filter((f) => f.kind === "output").length > 0 && (
                <ul className="files">
                  {request.files
                    .filter((f) => f.kind === "output")
                    .map((file) => (
                      <li key={file.id}>
                        <a href={`/api/files/${file.id}/download`}>
                          {file.name}
                        </a>
                        <span className="muted">
                          {file.size_bytes < 1024
                            ? `${file.size_bytes} bytes`
                            : `${(file.size_bytes / 1024).toFixed(1)} KiB`}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
              {request.validation_summary && (
                <p className="validation">{request.validation_summary}</p>
              )}
            </div>
          )}
          {request.files.some((f) => f.kind === "input") && (
            <>
              <h2>Input files</h2>
              <ul className="files">
                {request.files
                  .filter((f) => f.kind === "input")
                  .map((file) => (
                    <li key={file.id}>
                      <a href={`/api/files/${file.id}/download`}>{file.name}</a>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
function App() {
  useEffect(() => {
    void api("/api/session?prepare=1").catch(() => {});
  }, []);
  const [selected, setSelected] = useState(() => location.hash.slice(1));
  const [submitted, setSubmitted] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    function changed() {
      setSelected(location.hash.slice(1));
    }
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  function open(id: string) {
    setSubmitted(false);
    location.hash = id;
    setSelected(id);
  }
  function back() {
    location.hash = "";
    setSelected("");
    setSubmitted(false);
    setRefresh((n) => n + 1);
  }
  return (
    <>
      <header>
        <div className="shell">
          <span>Workflow requests</span>
        </div>
      </header>
      <main className="shell">
        {selected ? (
          <RequestDetail
            requestId={selected}
            submitted={submitted}
            onBack={back}
          />
        ) : (
          <>
            <NewRequest
              onSubmitted={(id) => {
                open(id);
                setSubmitted(true);
              }}
            />
            <RequestList onOpen={open} refresh={refresh} />
          </>
        )}
      </main>
    </>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
