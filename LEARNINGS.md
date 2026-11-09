# Learnings: sketch to four photoreal views

What is worth knowing before you build on this pipeline. Each item links to the code or the
document behind it. The pipeline is object-neutral; confirm each finding on your own objects.

1. **One image per view, chained.** Generate the front from the sketch and the material sample. Generate
   the back from the front render, and the two profiles from the front and back renders. A
   multi-panel sheet crops badly, and `n` cannot assign different views to the outputs. Per-view
   camera templates say which frame edge the object's front faces, and tell the two profiles
   they are mirror opposites. ([prompt](shared/src/generate/prompt.ts), [spec](docs/spec/README.md))
2. **No invented defaults.** A default value is a fact no input supplied: it changes the
   generated product, and the critic then scores against the wrong spec. Every spec field is either
   *supplied* (metadata) or *observed* (images). ([`contracts/src/spec.ts`](contracts/src/spec.ts))
3. **Decide which source wins.**
   - The sketch decides construction and proportions.
   - The material sample decides colour, material and pattern, and wins over written colour. When the two
     disagree, the image model blends them.
   - The colour a sketch is drawn in never decides the product's colour.
   - Placed artwork stays where it is drawn.
4. **The prompt is code, not an LLM call.** A model fills a structured analysis. A deterministic
   template (`buildPrompt`) writes the image prompt. Durable retries stay reproducible and every
   prompt is diffable.
5. **The verdict is computed in code, not by the model.** The critic compares each view with
   the sketch and the material sample, aspect by aspect and part by part, in one call. Code
   applies weights (must, should, nice); only a hard fact both readings confirm fails the view.
   A single LLM score could not name what was wrong, and two separate readings compared as
   strings failed good images on synonyms.
   ([verdict.ts](shared/src/qc/judge/verdict.ts), [evaluation](docs/evaluation/README.md))
6. **Retries are targeted, not rerolls.** Only failed views and the views derived from them are
   remade, each with its own critic issues (at most 4) in the prompt. When the budget runs out,
   the best attempt goes to a human, flagged as rejected. The pipeline never auto-accepts.
7. **Agree where designs may go before sending real ones.** Pre-release designs are sensitive.
   Know which Regions your inference profiles route to, and what a third-party API retains,
   before you send a real sketch.
