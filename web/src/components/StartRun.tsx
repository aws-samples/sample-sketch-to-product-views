import { useEffect, useMemo, useRef, useState } from 'react';
import { ZoomImage } from './ZoomImage';
import { clean, removedHint, type CleanKind } from '../lib/clean';
import { askToNotify } from '../lib/notify';
import {
  MAX_IMAGES,
  sanitizeText,
  validatePackage,
  validateProductMetadataFile,
  validateProductMetadataText,
  type InputFile,
  type ProductMetadata,
} from '@sketch-to-product-views/contracts';
import {
  listModels,
  submitRevision,
  uploadFile,
  type ModelSummary,
  type StartRequest,
} from '../lib/api';
import {
  ATTEMPT_CHOICES,
  settingChoices,
  settingsToSend,
  type DeploymentDefaults,
  type SettingKey,
} from '../lib/settings';

/**
 * Assemble a package and submit it.
 *
 * `validatePackage` is the same rule the API and the pipeline run; here it only fails fast
 * before bytes are uploaded.
 */

interface Staged {
  file: File;
  /** Object URL for the thumbnail, revoked on removal. */
  preview: string;
}

const MAX_NOTES = 4000;

/** What `POST /api/revisions` accepts as a generator. */
const IMAGE_MODEL_CATEGORIES = new Set(['image-control']);

/** The API's product id rule (`api/src/routes/uploads.ts`). */
const PRODUCT_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** A product id from a filename: unsafe characters become `-`. */
function productIdFrom(filename: string): string {
  const id = filename
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64);
  return id || 'product';
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** `undefined` for an empty box, the validated details, or the reason they are not valid. */
function parseMetadata(text: string): { metadata?: ProductMetadata; error?: string } {
  if (!text.trim()) return {};
  const result = validateProductMetadataText(text);
  return result.ok ? { metadata: result.metadata } : { error: result.error.message };
}

export function StartRun({ onStarted }: { onStarted: (revisionId: string) => void }) {
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelId, setModelId] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productId, setProductId] = useState('');
  const [staged, setStaged] = useState<Staged[]>([]);
  const [metadataText, setMetadataText] = useState('');
  const [metadataFileError, setMetadataFileError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [deployment, setDeployment] = useState<DeploymentDefaults | undefined>();
  const [chosen, setChosen] = useState<Partial<Record<SettingKey, string>>>({});
  const [attempts, setAttempts] = useState<number | undefined>();
  // Hidden characters the last clean of each field removed, for its hint.
  const [removed, setRemoved] = useState<Partial<Record<CleanKind, number>>>({});
  const cleanField = (value: string, kind: CleanKind, set: (text: string) => void) => {
    const result = clean(value, kind);
    if (result.text !== value) set(result.text);
    setRemoved((current) => ({ ...current, [kind]: result.removed }));
  };

  useEffect(() => {
    let live = true;
    // Without the list the API falls back to its default model, so a failure hides the picker.
    listModels()
      .then((r) => {
        if (!live) return;
        const usable = r.models.filter((m) => IMAGE_MODEL_CATEGORIES.has(m.category));
        setModels(usable);
        setDeployment(r.deployment);
        setModelId(usable.find((m) => m.id === r.defaultModelId)?.id ?? usable[0]?.id ?? '');
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Revoke surviving previews on unmount, read through a ref so a removal does not revoke the rest.
  const previews = useRef<Staged[]>(staged);
  useEffect(() => {
    previews.current = staged;
  }, [staged]);
  useEffect(() => () => previews.current.forEach((s) => URL.revokeObjectURL(s.preview)), []);

  const metadata = useMemo(() => parseMetadata(metadataText), [metadataText]);
  const trimmedId = sanitizeText(productId);

  // Nothing staged, nothing to critique: an untouched form should not open with errors.
  const errors = useMemo(() => {
    const list = staged.length > 0 ? [...validatePackage(staged).errors] : [];
    if (trimmedId && !PRODUCT_ID.test(trimmedId)) {
      list.push('Product ID: letters, digits, dot, dash or underscore, up to 64 characters.');
    }
    if (metadataFileError) list.push(metadataFileError);
    else if (metadata.error) list.push(metadata.error);
    return list;
  }, [staged, trimmedId, metadata.error, metadataFileError]);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    // Copied before the updater runs: the caller clears the input underneath us.
    const picked = Array.from(files);
    setStaged((current) => {
      const next = [...current];
      for (const file of picked) {
        if (next.length >= MAX_IMAGES) break;
        next.push({ file, preview: URL.createObjectURL(file) });
      }
      return next;
    });
  };

  const removeStaged = (index: number) =>
    setStaged((current) => {
      URL.revokeObjectURL(current[index].preview);
      return current.filter((_, j) => j !== index);
    });

  const loadMetadataFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const result = validateProductMetadataFile({
      name: file.name,
      type: file.type,
      size: file.size,
      text,
    });
    setMetadataFileError(result.ok ? null : result.error.message);
    setMetadataText(result.ok ? result.metadata.text : text);
    setRemoved((current) => ({
      ...current,
      details: result.ok ? clean(text, 'details').removed : 0,
    }));
  };

  const choices = useMemo(
    () => settingChoices(models.find((m) => m.id === modelId)?.params, deployment),
    [models, modelId, deployment],
  );
  // Another model offers other values, so its own defaults apply again.
  useEffect(() => setChosen({}), [modelId]);
  const defaultAttempts = deployment?.attemptBudget ?? 2;
  const attemptCount = attempts ?? defaultAttempts;

  /** The model, notes and settings of the run. */
  const options = (): Pick<StartRequest, 'modelId' | 'notes' | 'settings'> => {
    const settings = settingsToSend(choices, chosen, attemptCount, defaultAttempts);
    const cleanNotes = sanitizeText(notes, { multiline: true });
    return {
      ...(modelId ? { modelId } : {}),
      ...(cleanNotes ? { notes: cleanNotes } : {}),
      ...(settings ? { settings } : {}),
    };
  };

  const start = async (body: StartRequest) => {
    setBusy(true);
    setError(null);
    try {
      const { revisionId } = await submitRevision(body);
      onStarted(revisionId);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const startFromUpload = async () => {
    const first = staged[0];
    if (!first) {
      setError('At least one image is required.');
      return;
    }
    const id = trimmedId || productIdFrom(first.file.name);
    setBusy(true);
    setError(null);
    try {
      // In parallel: each upload is an independent presign → PUT → confirm.
      const inputs: InputFile[] = await Promise.all(
        staged.map(async ({ file }) => {
          const uploaded = await uploadFile(file, id);
          return { filename: uploaded.filename, url: uploaded.url, key: uploaded.key };
        }),
      );
      await start({
        productId: id,
        inputs,
        ...(metadata.metadata ? { productMetadata: metadata.metadata } : {}),
        ...options(),
      });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="intake">
      <section className="docket">
        <header className="docket__head">
          <h2>New run</h2>
          <p>
            Drop in one to {MAX_IMAGES} images: sketches or photos of the product and, optionally, a
            sample of its material. No need to say which is which: the analyser decides, and the run
            page shows what it read each image as. Product details and design notes are optional.
          </p>
        </header>

        <div className="docket__body">
          <div className="specimens">
            <Dropplate
              dragging={dragging}
              onDragging={setDragging}
              disabled={busy || staged.length >= MAX_IMAGES}
              onFiles={addFiles}
            />

            {staged.map((s, i) => (
              <Specimen
                key={s.preview}
                staged={s}
                disabled={busy}
                onRemove={() => removeStaged(i)}
              />
            ))}
          </div>

          <div className="titleblock">
            <div className="field">
              <label htmlFor="f-product">Product ID</label>
              <input
                id="f-product"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                onBlur={() => cleanField(productId, 'single', setProductId)}
                placeholder="taken from the first image's filename"
                maxLength={64}
              />
              <RemovedHint count={removed.single} />
            </div>
            {models.length > 0 ? (
              <div className="field">
                <label htmlFor="f-model">Image model</label>
                <select id="f-model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id} title={m.description}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {choices.length > 0 ? (
              <fieldset className="settings">
                <legend>Generation settings</legend>
                {choices.map((c) => (
                  <div className="field" key={c.key}>
                    <label htmlFor={`f-${c.key}`}>{c.label}</label>
                    <select
                      id={`f-${c.key}`}
                      value={chosen[c.key] ?? c.defaultValue}
                      onChange={(e) => setChosen({ ...chosen, [c.key]: e.target.value })}
                    >
                      {c.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label ?? o.value}
                          {o.value === c.defaultValue ? ' (default)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                <div className="field">
                  <label htmlFor="f-attempts">Attempts before review</label>
                  <select
                    id="f-attempts"
                    value={attemptCount}
                    onChange={(e) => setAttempts(Number(e.target.value))}
                  >
                    {ATTEMPT_CHOICES.map((n) => (
                      <option key={n} value={n}>
                        {n}
                        {n === defaultAttempts ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="hint">
                  Up to {attemptCount * 4} image calls before review. A larger size and a higher
                  quality cost more and take longer.
                </p>
              </fieldset>
            ) : null}
            <div className="field field--tall">
              <label htmlFor="f-notes">Design notes</label>
              <textarea
                id="f-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => cleanField(notes, 'multiline', setNotes)}
                rows={3}
                maxLength={MAX_NOTES}
                placeholder="optional, e.g. matte finish, a longer handle"
              />
              <RemovedHint count={removed.multiline} />
            </div>
            <div className="field field--tall">
              <label htmlFor="f-metadata">Product details (optional)</label>
              <textarea
                id="f-metadata"
                className="mono"
                value={metadataText}
                onChange={(e) => {
                  setMetadataFileError(null);
                  setMetadataText(e.target.value);
                }}
                onBlur={() => cleanField(metadataText, 'details', setMetadataText)}
                rows={5}
                placeholder="plain text or JSON, e.g. lounge chair, walnut frame, cream wool seat, 78 cm wide"
              />
              <RemovedHint count={removed.details} />
              {metadata.metadata ? (
                <p className="hint">
                  Read as {metadata.metadata.format === 'json' ? 'JSON' : 'plain text'}, as data
                  only: the analyser takes the product type, colour, material and dimensions from
                  it.
                </p>
              ) : null}
              <label className="btn btn--quiet btn--small file-btn">
                Load a .txt or .json file
                <input
                  type="file"
                  accept="text/plain,application/json,.txt,.json"
                  disabled={busy}
                  onChange={(e) => {
                    void loadMetadataFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>
        </div>

        <footer className="docket__foot">
          <div className="docket__issues">
            {errors.length > 0 ? <IssueList className="error" messages={errors} /> : null}
          </div>

          <button
            className="btn btn--primary"
            disabled={busy || staged.length === 0 || errors.length > 0}
            onClick={() => {
              // A user gesture, which a permission prompt needs.
              void askToNotify();
              void startFromUpload();
            }}
          >
            Submit package
          </button>
        </footer>
      </section>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

/** The file picker and drop target: one label around one `<input type=file>`. */
function Dropplate({
  dragging,
  disabled,
  onDragging,
  onFiles,
}: {
  dragging: boolean;
  disabled: boolean;
  onDragging: (dragging: boolean) => void;
  onFiles: (files: FileList | null) => void;
}) {
  return (
    <label
      className={`dropplate${dragging ? ' dropplate--over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        onDragging(true);
      }}
      onDragLeave={() => onDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        onDragging(false);
        if (!disabled) onFiles(e.dataTransfer.files);
      }}
    >
      <input
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        disabled={disabled}
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <span className="dropplate__text">
        Drop images here, or <u>choose files</u>
      </span>
      <span className="dropplate__limit">One to {MAX_IMAGES} images, as JPEG, PNG or WebP</span>
    </label>
  );
}

/** One staged file: thumbnail, name and remove. What it is, the analyser decides. */
function Specimen({
  staged,
  disabled,
  onRemove,
}: {
  staged: Staged;
  disabled: boolean;
  onRemove: () => void;
}) {
  const name = staged.file.name;
  return (
    <figure className="specimen">
      <ZoomImage src={staged.preview} alt={name} />
      <figcaption>
        <span className="specimen__name" title={name}>
          {name}
        </span>
        <button
          className="btn btn--quiet"
          disabled={disabled}
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          Remove
        </button>
      </figcaption>
    </figure>
  );
}

function IssueList({ className, messages }: { className: string; messages: string[] }) {
  return (
    <ul className={className}>
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

function RemovedHint({ count = 0 }: { count?: number }) {
  const hint = removedHint(count);
  return hint ? <p className="hint">{hint}</p> : null;
}
