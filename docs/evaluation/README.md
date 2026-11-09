# Evaluation

How the 2D critic is designed and how to measure it. The measurement data is not included; the
method and the findings carry over.

- [Aspect table](attribute-schema.csv): the aspects the critic compares for any object (object
  type, shape, proportions, parts, colour, material, pattern, presentation), what each is
  compared with (`sketch`, `spec` for a supplied product fact, `swatch` for the material
  sample), its weight (must, should, nice) and whether a confirmed difference fails the view. It
  is mirrored in `contracts/src/attributes.ts`, and a test keeps the two aligned.

## Method

1. **Compare, don't describe twice.** One call sees the sketch, the generated view and the
   material sample together and answers `same`, `different` or `cant_tell` per aspect, with a
   one-line reason ([07](../spec/07-critic.md)).
2. **Fail only on hard facts, confirmed twice.** The wrong object, a colour that is not the
   supplied one or the sample's, an unusable image, or a requested change not applied. Anything
   else warns. The second reading runs at temperature 0.7 (`CONFIRMATION_TEMPERATURE`) so it is
   independent of the first; `critic:measure` reports how often the second reading overturns a
   fail.
3. **Evaluate on generated views a person labelled.** The question is how often the critic fails
   a view a person would accept (each one buys a paid regeneration) and passes one a person
   would reject.
4. **Test with negatives.** A recoloured image, and a view judged against another product's
   sketch. A judge that rejects everything also "catches" every negative.

## Findings from the earlier critic

The earlier critic read each image separately into a closed vocabulary, and code compared the
words.

- **Synonyms failed good images.** Two words for the same part or feature were compared as
  different.
- **Finished-product photos make poor positives.** They are low resolution, watermarked and
  worn, and the product sometimes changed from the sketch during development. Both critics
  rejected almost every real photo, so their score on negatives meant nothing. Generated views a
  person labelled are the better test set; the harness below uses them.

## Measuring the critic

`shared/scripts/critic-measure.ts` replays the current critic on stored views of deployed runs
and compares its verdicts with a person's labels. It reads the revision table and the artifacts
bucket, and calls the critic model; nothing is written to the deployment.

### 1. Label the views

Open each run in the web app and mark every generated view you can judge: `good` when you would
send it on as it is, `bad` when you would ask for it to be remade. Judge the image against the
sketch, the material sample and the product facts, as a designer would; ignore the critic's
verdict on screen. Note why in a few words when it is `bad`, or when it is `good` despite a
visible difference.

Write one row per view, CSV with a header (or a JSON array of the same objects):

```csv
revisionId,view,attempt,label,note
7f3c…,front,1,good,
7f3c…,left,1,bad,"strap on the wrong side"
7f3c…,left,2,good,
```

- `revisionId`: the run id (in the app URL);
- `view`: `front`, `back`, `left` or `right` (empty means `front`);
- `attempt`: the attempt number shown on the view;
- `label`: `good` or `bad`; `note`: optional.

Aim for about ten products across different kinds of objects, every view of every attempt, plus
the two built negatives. Label rejected attempts too: a view the critic failed is exactly the
case to check.

### 2. Run it

```bash
npm run build
TABLE_NAME=<revisions table> ARTIFACTS_BUCKET=<artifacts bucket> AWS_REGION=<region> \
EVALUATION_MODEL=critic-sonnet \
  npm run critic:measure -w @sketch-to-product-views/shared -- /path/to/labels.csv --out results.csv
```

Without `--yes` it only prints how many model calls it would make (one comparison per view, a
second for a view it would fail, one request check per view that had design notes) and reads
nothing. Add `--yes` to run. The names of the table and the bucket are Terraform outputs; the
credentials are your usual AWS ones. The views are judged one at a time, with the run's own
design notes as requests.

### 3. Read the result

The script prints, for the critic now and for the verdict stored with the run:

- a confusion table, human good/bad against pass/warn/fail;
- **false fail**: good views failed, out of the good ones (the cost to cut);
- **false pass**: bad views not failed, out of the bad ones (a warn counts as a pass, since it is
  accepted);
- per aspect, how often it was answered `different` on good views (noise) and on bad ones;
- how many confirmation calls were made and how many overturned a fail.

`results.csv` has one row per label: the stored and the new verdict, what failed and what the
second reading confirmed, the aspects answered `different`, the issues, the scores, and any
error (a missing candidate, sketch or spec).
