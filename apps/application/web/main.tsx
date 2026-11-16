import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import "./style.css";

const requestStatus = z.enum(["pending", "running", "completed", "failed"]);
const summary = z.object({
  id: z.string(),
  title: z.string(),
  status: requestStatus,
  created_at: z.string(),
});
const details = summary.extend({
  instructions: z.string(),
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
function displayDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
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
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submissionKey = useRef(crypto.randomUUID());
  const uploaded = useRef(new Map<File, string>());
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
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
          body: JSON.stringify({ instructions, attachment_ids: ids }),
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
      <form onSubmit={submit}>
        <label htmlFor="instructions">Instructions</label>
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
        <button type="submit" disabled={busy || !instructions.trim()}>
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
          {request.status === "pending" && (
            <p role="status" className="notice">
              Your request is pending.
            </p>
          )}
          {request.status === "running" && (
            <p role="status" className="notice">
              Your request is running. The result will appear here when it is
              ready.
            </p>
          )}
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
