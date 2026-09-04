"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";

interface EmbeddingModelInfo {
  provider: string;
  model: string;
  dimensions: number;
  free: boolean;
  note?: string;
}

interface SettingsResponse {
  config?: Record<string, Record<string, unknown>>;
  providers?: { provider: string; configured: boolean }[];
  credentials?: { provider: string; hint: string }[];
  embeddingModels?: EmbeddingModelInfo[];
  encryptionConfigured?: boolean;
  error?: string;
}

/**
 * Runtime settings.
 *
 * Everything here overrides `.env` in the database, so provider, model, and
 * retrieval tuning can change without a redeploy. Embedding changes are the one
 * exception that needs a follow-up action — they only take effect once the
 * vectors are rebuilt from the Vault page.
 */
export default function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        const json = (await res.json()) as SettingsResponse;
        if (!res.ok) throw new Error(json.error ?? "Could not load settings.");

        setData(json);
        // Flatten the nested config into the dotted keys the API expects.
        const flat: Record<string, unknown> = {};
        for (const [group, entries] of Object.entries(json.config ?? {})) {
          for (const [key, value] of Object.entries(entries)) flat[`${group}.${key}`] = value;
        }
        setValues(flat);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load settings.");
      }
    })();
  }, []);

  function set(key: string, value: unknown) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setMessage("");
    setError("");

    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: values, credentials: secrets }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed.");

      setSecrets({});
      setMessage(`Saved ${json.saved?.length ?? 0} settings.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  if (error && !data) {
    return (
      <div className="card border-[#5c2a2a]">
        <p className="text-sm text-[var(--color-bad)]">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
        <Loader2 size={14} className="animate-spin" /> Loading settings…
      </p>
    );
  }

  const embeddingModels = data.embeddingModels ?? [];
  const selectedEmbedding = `${values["embedding.provider"]}/${values["embedding.model"]}`;

  return (
    <div className="pb-20">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          These override <code>.env</code> at runtime. Blank fields fall back to the environment.
        </p>
      </header>

      {/* ---------------------------------------------------------- LLM --- */}
      <Section title="Language model" note="Used for answering, triage, query expansion and grounding.">
        <Field label="Provider">
          <select
            className="input"
            value={String(values["llm.provider"] ?? "")}
            onChange={(e) => set("llm.provider", e.target.value)}
          >
            {(data.providers ?? []).map((p) => (
              <option key={p.provider} value={p.provider}>
                {p.provider}
                {p.configured ? "" : " (no key)"}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Model">
          <input
            className="input"
            value={String(values["llm.model"] ?? "")}
            onChange={(e) => set("llm.model", e.target.value)}
            placeholder="ministral-14b-latest"
          />
        </Field>

        <Field label="Temperature">
          <input
            type="number"
            step="0.1"
            min="0"
            max="2"
            className="input"
            value={String(values["llm.temperature"] ?? "")}
            onChange={(e) => set("llm.temperature", Number(e.target.value))}
          />
        </Field>

        <Field label="Max output tokens">
          <input
            type="number"
            className="input"
            value={String(values["llm.maxOutputTokens"] ?? "")}
            onChange={(e) => set("llm.maxOutputTokens", Number(e.target.value))}
          />
        </Field>
      </Section>

      {/* ---------------------------------------------------- embeddings --- */}
      <Section
        title="Embeddings"
        note="Changing this does not re-embed anything on its own — rebuild from the Vault page afterwards. Existing vectors stay in their own space until you do."
      >
        <div className="sm:col-span-2">
          <label className="label">Model</label>
          <select
            className="input"
            value={selectedEmbedding}
            onChange={(e) => {
              const chosen = embeddingModels.find(
                (m) => `${m.provider}/${m.model}` === e.target.value,
              );
              if (!chosen) return;
              set("embedding.provider", chosen.provider);
              set("embedding.model", chosen.model);
              set("embedding.dimensions", chosen.dimensions);
            }}
          >
            {embeddingModels.map((m) => (
              <option key={`${m.provider}/${m.model}`} value={`${m.provider}/${m.model}`}>
                {m.free ? "[free] " : ""}
                {m.provider}/{m.model} — {m.dimensions}d
              </option>
            ))}
          </select>

          {embeddingModels.find((m) => `${m.provider}/${m.model}` === selectedEmbedding)?.note && (
            <p className="mt-1.5 text-xs text-[var(--color-muted)]">
              {embeddingModels.find((m) => `${m.provider}/${m.model}` === selectedEmbedding)?.note}
            </p>
          )}
        </div>

        <Field label="Dimensions">
          <input
            type="number"
            className="input"
            value={String(values["embedding.dimensions"] ?? "")}
            onChange={(e) => set("embedding.dimensions", Number(e.target.value))}
          />
        </Field>

        <Field label="Batch size">
          <input
            type="number"
            className="input"
            value={String(values["embedding.batchSize"] ?? "")}
            onChange={(e) => set("embedding.batchSize", Number(e.target.value))}
          />
        </Field>
      </Section>

      {/* ----------------------------------------------------- retrieval --- */}
      <Section title="Retrieval" note="Tune here, then measure with npm run eval — not by intuition.">
        <Field label="Top K (chunks in the prompt)">
          <input
            type="number"
            className="input"
            value={String(values["retrieval.topK"] ?? "")}
            onChange={(e) => set("retrieval.topK", Number(e.target.value))}
          />
        </Field>

        <Field label="Candidate K (before fusion)">
          <input
            type="number"
            className="input"
            value={String(values["retrieval.candidateK"] ?? "")}
            onChange={(e) => set("retrieval.candidateK", Number(e.target.value))}
          />
        </Field>

        <Field label="Minimum similarity">
          <input
            type="number"
            step="0.05"
            className="input"
            value={String(values["retrieval.minScore"] ?? "")}
            onChange={(e) => set("retrieval.minScore", Number(e.target.value))}
          />
        </Field>

        <Field label="Neighbour window">
          <input
            type="number"
            min="0"
            className="input"
            value={String(values["retrieval.neighborWindow"] ?? "")}
            onChange={(e) => set("retrieval.neighborWindow", Number(e.target.value))}
          />
        </Field>

        <Field label="Context token budget">
          <input
            type="number"
            className="input"
            value={String(values["retrieval.contextTokenBudget"] ?? "")}
            onChange={(e) => set("retrieval.contextTokenBudget", Number(e.target.value))}
          />
        </Field>

        <Field label="Reranker">
          <select
            className="input"
            value={String(values["retrieval.reranker"] ?? "none")}
            onChange={(e) => set("retrieval.reranker", e.target.value)}
          >
            <option value="none">none</option>
            <option value="cohere">cohere</option>
            <option value="jina">jina</option>
          </select>
        </Field>

        <Toggle
          label="Hybrid search (vector + full text)"
          checked={Boolean(values["retrieval.hybrid"])}
          onChange={(v) => set("retrieval.hybrid", v)}
        />
        <Toggle
          label="Query expansion"
          checked={Boolean(values["retrieval.queryExpansion"])}
          onChange={(v) => set("retrieval.queryExpansion", v)}
        />
      </Section>

      {/* ----------------------------------------------------- grounding --- */}
      <Section
        title="Grounding gate"
        note="Scores at or above auto-send go out unattended; at or above review are queued; below that are blocked."
      >
        <Field label="Auto-send threshold">
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            className="input"
            value={String(values["grounding.autosendThreshold"] ?? "")}
            onChange={(e) => set("grounding.autosendThreshold", Number(e.target.value))}
          />
        </Field>

        <Field label="Review threshold">
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            className="input"
            value={String(values["grounding.reviewThreshold"] ?? "")}
            onChange={(e) => set("grounding.reviewThreshold", Number(e.target.value))}
          />
        </Field>

        <Field label="Judge provider (blank = same as answering)">
          <input
            className="input"
            value={String(values["grounding.provider"] ?? "")}
            onChange={(e) => set("grounding.provider", e.target.value)}
            placeholder="same as answering"
          />
        </Field>

        <Field label="Judge model">
          <input
            className="input"
            value={String(values["grounding.model"] ?? "")}
            onChange={(e) => set("grounding.model", e.target.value)}
            placeholder="same as answering"
          />
        </Field>

        <Toggle
          label="Grounding enabled"
          checked={Boolean(values["grounding.enabled"])}
          onChange={(v) => set("grounding.enabled", v)}
        />
        <Toggle
          label="Require citations"
          checked={Boolean(values["grounding.requireCitations"])}
          onChange={(v) => set("grounding.requireCitations", v)}
        />
      </Section>

      {/* --------------------------------------------------------- email --- */}
      <Section title="Email" note="Dry run renders and logs messages without delivering them.">
        <Field label="From address">
          <input
            className="input"
            value={String(values["email.fromEmail"] ?? "")}
            onChange={(e) => set("email.fromEmail", e.target.value)}
            placeholder="relay@yourdomain.com"
          />
        </Field>

        <Field label="From name">
          <input
            className="input"
            value={String(values["email.fromName"] ?? "")}
            onChange={(e) => set("email.fromName", e.target.value)}
          />
        </Field>

        <Field label="Replies per sender per day">
          <input
            type="number"
            className="input"
            value={String(values["email.rateLimitPerSenderPerDay"] ?? "")}
            onChange={(e) => set("email.rateLimitPerSenderPerDay", Number(e.target.value))}
          />
        </Field>

        <Toggle
          label="Dry run (do not actually send)"
          checked={Boolean(values["email.dryRun"])}
          onChange={(v) => set("email.dryRun", v)}
        />
      </Section>

      {/* ----------------------------------------------------------- keys --- */}
      <Section
        title="Provider keys"
        note={
          data.encryptionConfigured
            ? "Stored encrypted with AES-256-GCM. Leave blank to keep using the environment variable."
            : "SETTINGS_ENCRYPTION_KEY is not set, so keys cannot be stored here yet. Generate one with: openssl rand -base64 32"
        }
      >
        {(data.providers ?? []).map((p) => {
          const stored = data.credentials?.find((c) => c.provider === p.provider);
          return (
            <Field key={p.provider} label={p.provider}>
              <input
                type="password"
                className="input"
                disabled={!data.encryptionConfigured}
                value={secrets[p.provider] ?? ""}
                onChange={(e) => setSecrets((s) => ({ ...s, [p.provider]: e.target.value }))}
                placeholder={
                  stored ? `stored ····${stored.hint}` : p.configured ? "set in .env" : "not set"
                }
              />
            </Field>
          );
        })}
      </Section>

      <div className="fixed inset-x-0 bottom-0 border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 backdrop-blur md:left-60">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-3">
          <button onClick={save} disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save settings
          </button>
          {message && <span className="text-sm text-[var(--color-ok)]">{message}</span>}
          {error && <span className="text-sm text-[var(--color-bad)]">{error}</span>}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card mt-4">
      <h2 className="font-medium">{title}</h2>
      {note && <p className="mt-1 text-xs text-[var(--color-muted)]">{note}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 self-end pb-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[var(--color-accent)]"
      />
      {label}
    </label>
  );
}
