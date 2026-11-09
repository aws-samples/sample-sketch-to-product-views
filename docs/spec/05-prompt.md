# 05. Image prompt

A deterministic template turns the specification and the call options into the prompt of one
view's image call. It is object-neutral: the product type, its parts and its details come from the
analysis ([04](04-analysis.md)), never from a list of known categories, so a chair, a shoe, a lamp
or a kettle get the same template. No LLM writes or rewrites it: the same inputs give the same prompt byte for
byte, which keeps durable retries reproducible and every prompt diffable between attempts.
Reference implementation: `shared/src/generate/prompt.ts` (`buildPrompt`), `views.ts`
(`planViewCall`). The image model has no negative-prompt field, so everything to avoid is said
in positive terms. There is no prompt-version constant: the prompt is stored on every candidate.

## Which images each call gets (`planViewCall`)

The analyser decides which image plays which part (`planImages`,
[02](02-data-contracts.md#which-image-plays-which-part)). `sketch` = the design references (every
image read as `sketch` or `photo`, in upload order), then any further material images (`n` counts
them all; `m` counts the further materials). `swatch` = the material sample (the first image read
as `material`; `swatch` is the registry's input id) only when there is one **and** the image entry
lists `swatch` in `acceptsInputs`. `draws(view)` = the spec's `views` (absent →
`[front]`) contains `front`, `back`, or `side` for left/right.

| View | Sketch draws it? | Images, in order | `buildPrompt` options |
|---|---|---|---|
| front | — | sketch…, swatch | `swatch`, `sketchImages = n`, `materialReferences = m` |
| back | no | front render | `view=back`, `frontRender=alone` |
| back | yes | sketch…, swatch, front render | `view=back`, `frontRender=with_sketch`, `sketchImages = n`, `materialReferences = m` |
| left/right | no | front render, back render | `view`, `frontRender=alone`, `backRender` |
| left/right | yes | sketch…, swatch, front render, back render | `view`, `frontRender=with_sketch`, `backRender`, `sketchImages = n`, `materialReferences = m` |

Every call also passes `swatch = hasSwatch`, the view's `corrections` and `requests`, and
`designKinds` (what each design reference is, `planImages(...).designKinds`). A needed
image that is missing is a programming error (throw), never a silent omission. The first image
fills the provider's primary image slot; the rest follow as references
([06](06-generation.md)).

Why: the other views agree with the front because they are made from its render; a second
statement of the construction (the flat sketch, the material sample) only competes with the render unless
the sketch actually draws that view. Profiles also get the back render because a profile joins
the front edge and the back edge.

## Constants (verbatim)

`VIEW_LABEL`: front → `front`, back → `back`, left → `left side`, right → `right side`.

`VIEW_CAMERA` (also told to the critic, unchanged):

| View | Text |
|---|---|
| front | `the front view, seen straight on` |
| back | `the back view, seen from directly behind` |
| left | `the left side view, in full left profile: the camera stands at the object's left, so the front of the object faces the left edge of the image and the back faces the right edge` |
| right | `the right side view, in full right profile: the camera stands at the object's right, so the front of the object faces the right edge of the image and the back faces the left edge` |

There is no table of materials, fits or stagings: one generic material guidance and one staging
sentence cover every object. A product type never selects a rule.

Named sentences:

| Name | Text |
|---|---|
| BACK_NOT_MIRROR | `The back is not a mirror of the front: a front-only logo, print, opening, control or detail stays on the front, and the back shows what the back of this kind of product carries.` |
| NOT_DRAWN | `What is not drawn (the other views, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it.` |
| RENDER_DECIDES | `The attached photograph decides everything about the product: shape, construction, material, colour and pattern, details and proportions. This image shows that same product from another camera position; nothing about the product changes.` |
| NOT_SHOWN_BY_RENDER | `What the photograph does not show (the back, the sides, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it.` |
| DESIGN_KEPT | `Real-world proportions never even out the design: a part drawn short stays short beside a long one, an element drawn on one side only stays on that side and only there, and an edge drawn uneven stays uneven.` |
| SKETCH_ARTWORK | `Artwork drawn on the product (a placed print, a graphic, a gradient, a logo, text, a motif on some parts only) is part of the design, not a colour marker: it stays exactly where the sketch draws it, only on the parts it covers, with its own colours, density and transparency, on top of the base material.` |
| SAMPLE_SCALE | `Each motif of the sample (a check, a stripe, a grain, a woven or printed pattern) keeps the size it has in the sample: a large surface carries many repeats of it, never a few enlarged ones.` |
| SAMPLE_MATERIAL | `Render the main material as the sample shows it: its texture, grain or weave, sheen and weight. The written material names it; where its usual look differs from the sample, follow the sample.` |
| MATERIAL_GUIDANCE | `Rigid parts (wood, metal, plastic, glass, ceramic, stone) keep clean, true edges and catch the light as their finish does: matte, satin or gloss. Soft parts (textile, leather, foam, rubber) show real thickness, seams and stitching, and fold, drape or compress under their own weight.` |
| LEAVE_OUT | `notes, measurements, arrows, codes, signatures, colour chips, other objects, and any figure, hand or body drawn to show it in use` |
| STAGING | `standing or resting as it does in use, with no person, body, mannequin, hands, stand or prop unless {SHOWS} one as part of the product; a soft object keeps the full shape it has in use, held by nothing visible` ({SHOWS}: [below](#sketches-photos-or-both); `the sketch draws` with sketches only) |
| PHOTO_LEAVE_OUT | `anything that is not part of the product (people, hands, other objects, background)` |

`MAX_CORRECTIONS = 4` (the first four), `MAX_REQUESTS = 6` (the last six).
Ordinals: `first` … `seventh`; counts: `one` … `five`.

## Template (`buildPrompt(spec, options)`)

Derived values:

```text
renderOnly = frontRender = "alone";  withRender = frontRender = "with_sketch"
product    = productType.value or "product"
article    = "an" when product starts with a vowel, else "a"
camera     = VIEW_CAMERA[view]
source     = renderOnly ? "the attached photograph" : withRender ? "the attached front photograph" : "the sketch"
materialInWords = not (renderOnly and swatch)            // a render already carries the sample's material
sketches   = renderOnly ? 0 : max(1, sketchImages)
extras     = min(max(0, materialReferences), sketches - 1)   // further materials, last of the sketch images
sampleOrd  = ORD[sketches];  frontOrd = ORD[sketches + (swatch?1:0)]
backOrd    = ORD[renderOnly ? 1 : sketches + (swatch?1:0) + (withRender?1:0)]
```

Lines, in order; a line whose condition fails is omitted (no blank line left behind). `[x]`
marks a conditional fragment. This is the wording with sketches only; with photos among the
design references, the lines listed in [Sketches, photos or both](#sketches-photos-or-both)
change.

```text
OPENING (one line, sentences joined by a space)
  renderOnly:
    "{backRender ? 'The first attached image' : 'The attached image'} is a product photograph of the finished {product} seen from the front, made from the designer's sketch."
    [backRender] BACK_SENTENCE
    "Make a product photograph of the same {product} from one camera angle: {camera}."
  otherwise:
    sketches > 1 and extras > 0 ?
                   "The first {COUNT[sketches-1]} attached images are the designer's images of one {product}; together they are the sketch. Of these, {EXTRAS} {extras > 1 ? 'are samples of other materials of the {product}, not views of it' : 'is a sample of another material of the {product}, not a view of it'}."
    : sketches > 1 ? "The first {COUNT[sketches-1]} attached images are the designer's images of one {product}, each showing the same object; together they are the sketch."
                 : "{(swatch or withRender) ? 'The first attached image' : 'The attached image'} is a designer's sketch of {article} {product}."
    EXTRAS = "the {ORD[i]}" for i from sketches-extras to sketches-1, joined "a, b and c"
    [swatch]     "The {sampleOrd} is a sample of its material."
    [withRender] "The {frontOrd} is a photograph of the finished product made from this same sketch, seen from the front, straight on."
    [backRender] BACK_SENTENCE
    "Turn {sketches > 1 ? 'the sketch' : 'it'} into a single product photograph of the finished {product} from one camera angle: {camera}."
  BACK_SENTENCE = "The {backOrd} is a photograph of the same finished product seen from directly behind. This view joins the two: the front edge as the front photograph shows it, the back edge as the back photograph shows it."
""
"INPUTS"
"- Product: {product}"
[material and materialInWords]  "- Material: {material}"
[color and materialInWords]     "- Colour: {color}"
[dimensions]                    "- Dimensions: {dimensions}"
[swatch and not renderOnly]     "- Material sample: the {sampleOrd} attached image, a sample of the actual material"
[notes]                         "- Designer notes: {notes}"          // option unused by the pipeline
[parts]                         "- Parts the sketch draws:"
  per part                      "  - {name}[: {description}][, {location}]"
[details]                       "- Details the sketch draws (keep each one, where it is):"
  per detail                    "  - {description}: [{location}, ]{view} view"
[parts or details]              "  Every print, logo, graphic or text the sketch draws stays, exactly where it is drawn, listed or not."
[assumptions]                   "", "ASSUMPTIONS (decided where the inputs left this open; follow them)", "- {a}" each
""
"WHICH SOURCE DECIDES WHAT"
  renderOnly: RENDER_DECIDES
              "{NOT_SHOWN_BY_RENDER} {BACK_NOT_MIRROR}"
  otherwise:
    swatch ? "The material sample decides the colour, the material, the finish and the pattern of the main surface; the written inputs name them. When the sketch, a written colour or a written material disagrees with the sample, follow the sample."
           : "The written inputs decide the material, the finish and the colour. When the sketch disagrees, follow the written inputs."
    "The sketch decides the shape and the construction: the silhouette, the proportions between parts, every part and how it joins the rest, openings, closures, seams and edges, and every print, graphic, logo or text drawn on the {product}: where it sits and how it looks."
    "Neither decides the camera, the lighting or the staging. Those follow the output rules below."
[not renderOnly]
""
"HOW TO READ THE SKETCH"
  "The sketch is a design drawing, not a photograph: it may exaggerate, simplify or flatten the object, and its lines show no material weight. Keep the construction and give it real-world proportions[, at the dimensions given when dimensions]."
  DESIGN_KEPT
  SKETCH_VIEWS        // below
  "Render only the {product}. Leave out everything drawn around it that is not part of it: {LEAVE_OUT}."
  [ignored] "On this sketch, leave out: {ignored joined '; '}."
  swatch ? "Sketch colours are approximate markers. Make the {product} from the sample material: its colour, finish and pattern cover the surfaces drawn in the main material. {SAMPLE_SCALE} The sample is a flat piece of material, not part of the product, and does not appear in the image."
  : color ? "Sketch colours are approximate markers. The colour of the {product} is {color}."
  : "Take the colours from the sketch, but render them as real finished materials, evenly coloured, with no pencil, marker or watercolour texture."
  SKETCH_ARTWORK
""
"MATERIALS"
  renderOnly and not materialInWords ? "Render every part in the material the photograph shows, with the same finish, sheen and texture."
  : swatch and not renderOnly        ? SAMPLE_MATERIAL
  : material                         ? "Render each part in its real material: {material}, with the surface, finish and weight that material has."
  : renderOnly                       ? "Render every part in the real material the photograph shows."
  :                                    "Render every part in the real material the sketch suggests."
  MATERIAL_GUIDANCE
  renderOnly ? "Prints, graphics and logos sit exactly where the photograph shows them, at a realistic scale for the product."
             : "Prints, graphics and logos sit exactly where the sketch places them, at a realistic scale for the product."
""
"OUTPUT"
  "One photograph of the {product} from a single camera angle: {camera}. The {product} is shown alone, {STAGING}, centred, whole and fully visible, filling most of the frame."
  [view is left or right] PROFILE_SIDES(view, source)
  "The camera is level with the middle of the {product}, at the same distance from it for every view. The front, the back, the left side and the right side views show the same {product}, which does not move; only the camera does."
  "Seamless white background, soft even studio light that does not change with the angle."
  "Photorealistic, e-commerce quality, true-to-life colour, a clean image with no caption, label, watermark or annotation added around the product."
""
"MUST MATCH"
  renderOnly: "Shape, proportions, parts, details, material and colour must match the attached photograph: same product, only the camera angle changes."
  otherwise:  "Shape, proportions, every part, one-sided elements and {sampleColour} must match the inputs{agree}. Details should match where this angle shows them."
  sampleColour = swatch ? "the colour, material and pattern of the sample" : "colour"
  agree        = withRender ? ", and this view must agree with the attached front photograph: same product, same material, same proportions, same details, only the camera angle changes" : ""
[corrections]
""
"CORRECTIONS FROM THE PREVIOUS ATTEMPT"
"A reviewer rejected the previous image of this view. Fix what it found, and keep everything else as the inputs say:"
  first 4 corrections, each "- {c}."
[requests]
""
"REQUESTS FROM THE DESIGN TEAM"
"The design team reviewed an earlier image of this view and asked for these changes. They overrule the inputs: apply each one even where the sketch, the material sample or the attached photographs show otherwise, and keep everything else as the inputs say:"
  last 6 requests, each "- {trimmed request, with a final '.' added unless it ends in . ! or ?}"
```

`SKETCH_VIEWS`:

```text
shown = spec.views absent ? "The sketch may show the front alone, or the front and the back side by side."
      : "The sketch shows these views: {views joined ', ' or 'none of the front, back or side' when empty}."
"{shown} Use what is drawn for the parts this angle shows. {NOT_DRAWN} {BACK_NOT_MIRROR}"
```

`PROFILE_SIDES(view, source)`, with `other` the opposite side, and `near, far` = `right, left` for
the left view, `left, right` for the right view:

```text
The left and right side views are mirror opposites, not copies. In {source}, the object's {view} side is the {near} half of the picture and its {other} side is the {far} half. This view shows the side that appears on the {near} half of {source}: every asymmetric element there (an off-centre handle, opening, closure, strap, control or panel) is visible here, and every asymmetric element on the {far} half is on the far side, hidden behind the object, except where it protrudes past its outline.
```

No per-detail side rules are added: they are brittle, and there is no human in the loop to
correct them per product.

## Sketches, photos or both

`designKinds` (absent → all sketches) sets the wording. With sketches only, nothing changes: the
template above, byte for byte. With photos, the photo is read as the real product (the product
itself, a prototype or a reference), not as a drawing: the drawing rules (exaggerated
proportions, uneven drawn edges, sketch colours as markers, notes drawn around it) are dropped,
and the output is still a clean studio photograph of the same product.

```text
photoCount = count of "photo" in designKinds;  many = photoCount > 1
mode       = photoCount = 0 ? sketch : photoCount = len(designKinds) ? photo : mixed
PH         = many ? "the photos" : "the photo";   PHO = "{PH} of the product"
-(s)       = a verb agreeing with PH: "show" when many, else "shows" (same for "decide")
SHOWS      = sketch: "the sketch draws";  photo: "{PH} show(s)";  mixed: "the sketch draws or {PH} show(s)"
DESIGN     = sketch: "the sketch";        photo: PH;              mixed: "the sketch, {PH}"
MADE_FROM  = sketch: "the designer's sketch";  photo: PHO;  mixed: "the designer's sketch and {PHO}"
ABOUT      = "(the product itself, a prototype or a reference for it)"
TINT       = "not tinted by the light {many ? 'they were' : 'it was'} taken in"
```

Every mode, every view (render-only included):

| Line | Becomes |
|---|---|
| renderOnly opening | `… seen from the front, made from {MADE_FROM}.` |
| Parts / details headers | `- Parts {SHOWS}:`, `- Details {SHOWS} (keep each one, where it is):` |
| Every print… | `  Every print, logo, graphic or text {SHOWS} stays, exactly where it is[ drawn when sketch], listed or not.` |
| STAGING | `… unless {SHOWS} one as part of the product …` |
| Requests | `… apply each one even where {DESIGN}, the material sample or the attached photographs show otherwise …` |

Photo and mixed, calls that send the design references:

```text
OPENING, first sentences (instead of the sketch sentences):
  photo, no further material:
    sketches > 1 ? "The first {COUNT[sketches-1]} attached images are photos of one {product} {ABOUT}, each showing the same object."
                 : "{(swatch or withRender) ? 'The first attached image' : 'The attached image'} is a photo of {article} {product} {ABOUT}."
  otherwise: "The first {COUNT[sketches-1]} attached images show one {product}." then one sentence per kind,
    in the order of its first image ({R} = its ranks, "The first and the third"):
      sketches: one "{R} is the designer's sketch of it."  many "{R} are the designer's drawings of it; together they are the sketch."
      photos:   one "{R} is a photo of it {ABOUT}."        many "{R} are photos of it {ABOUT}."
      further materials: as in the sketch wording, "{R} is a sample of another material of the {product}, not a view of it." (or plural)
  [withRender] "… made from {mixed ? 'these same images' : many ? 'these same photos' : 'this same photo'}, seen from the front, straight on."
  last sentence: photo: "Make a single clean studio product photograph of the same {product} from one camera angle: {camera}."
                 mixed: "Turn the sketch and {PH} into a single product photograph of the finished {product} from one camera angle: {camera}."
WHICH SOURCE DECIDES WHAT
  swatch:  "… When {DESIGN}, a written colour or a written material disagrees with the sample, follow the sample."
  else:    "{PHO} decide(s) the colour, the material and the finish, except where the written inputs name them: when {PH} and a written colour or material disagree, follow the written inputs."
  photo:   "{many ? 'They also decide' : 'It also decides'} the shape and the construction: … and every print, graphic, logo or text on the {product}: where it sits and how it looks."
  mixed:   the sketch line unchanged, then "{PHO} show(s) its real look: the material, the finish, the thickness of its parts and how they sit. Where {PH} and the sketch differ in shape or construction, follow the sketch."
  "No input decides the camera, the lighting, the background or the staging, not even {many ? "the photos'" : "the photo's"} own. Those follow the output rules below."
"HOW TO READ {mixed ? 'THE SKETCH AND ' : ''}{PH, upper case}"
  photo:  "{PHO} show(s) a real object: keep its shape, its proportions and its construction as photographed[, at the dimensions given], and show it as the finished product, clean and new."
          (no DESIGN_KEPT)
  mixed:  the design-drawing line and DESIGN_KEPT unchanged
  views:  photo: "{PH} show(s) these views: {views}. Use what {it shows|they show} for the parts this angle shows. What {it does|they do} not show (the other views, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it. {BACK_NOT_MIRROR}"
          mixed: "The sketch and {PH} show these views: {views}. Use what is drawn or photographed for the parts this angle shows. What is not drawn or photographed (…) follows its construction: … {BACK_NOT_MIRROR}"
          (views absent: "{subject} may show the front alone, or the front and the back.")
  photo:  "Render only the {product}. Leave out {PHOTO_LEAVE_OUT}."
  mixed:  the sketch leave-out line, then "In {PH}, leave out {PHOTO_LEAVE_OUT}."
  [ignored] "{mixed ? 'In these images' : many ? 'In these photos' : 'In this photo'}, leave out: {ignored joined '; '}."
  colours, photo: swatch ? "Make the {product} from the sample material: its colour, finish and pattern cover the surfaces made of the main material. {SAMPLE_SCALE} The sample is a flat piece of material, not part of the product, and does not appear in the image."
                  : color ? "The colour of the {product} is {color}."
                  : "Keep the colours {PH} show(s) as the true colours of the finished product, {TINT}."
  colours, mixed: as the sketch wording, except with no sample and no colour:
                  "Sketch colours are approximate markers. Take the colours from {PH}, as the true colours of the finished product, {TINT}."
  artwork, photo: "Artwork on the product (a placed print, a graphic, a gradient, a logo, text, a motif on some parts only) stays exactly where {PH} show(s) it, only on the parts it covers, with its own colours, density and transparency, on top of the base material."
  artwork, mixed: SKETCH_ARTWORK
MATERIALS, no sample and no written material: "Render every part in the real material {PH} show(s)."
           photo, prints line: "Prints, graphics and logos sit exactly where {PH} show(s) them, at a realistic scale for the product."
```

## Golden outputs

Rendered by the reference implementation (`planViewCall`, then `buildPrompt`). A conforming
implementation produces these strings exactly (line breaks are `\n`, no trailing newline).

Spec used for G1 to G4, a lounge chair:

```json
{
  "model": "SAMPLE-1",
  "productType": {
    "value": "lounge chair",
    "provenance": "supplied"
  },
  "materialDescription": {
    "value": "oiled oak, wool boucle seat",
    "provenance": "supplied"
  },
  "colorDescription": {
    "value": "natural / ecru",
    "provenance": "supplied"
  },
  "dimensions": {
    "value": "w 78 x d 82 x h 74 cm",
    "provenance": "supplied"
  },
  "views": [
    "front"
  ],
  "parts": [
    {
      "name": "frame",
      "description": "solid wood, rounded edges",
      "location": "all around"
    },
    {
      "name": "seat",
      "description": "deep upholstered cushion",
      "location": "middle"
    },
    {
      "name": "legs",
      "description": "four tapered legs",
      "location": "under the seat"
    }
  ],
  "details": [
    {
      "description": "small brass plaque",
      "location": "left armrest",
      "view": "front"
    }
  ],
  "ignored": [
    "a handwritten note",
    "a colour chip"
  ],
  "assumptions": [
    "The frame is oak and the seat ecru."
  ]
}
```

#### G1. Front, one sketch image, with a material sample

Images, in order: sketch, swatch.

```text
The first attached image is a designer's sketch of a lounge chair. The second is a sample of its material. Turn it into a single product photograph of the finished lounge chair from one camera angle: the front view, seen straight on.

INPUTS
- Product: lounge chair
- Material: oiled oak, wool boucle seat
- Colour: natural / ecru
- Dimensions: w 78 x d 82 x h 74 cm
- Material sample: the second attached image, a sample of the actual material
- Parts the sketch draws:
  - frame: solid wood, rounded edges, all around
  - seat: deep upholstered cushion, middle
  - legs: four tapered legs, under the seat
- Details the sketch draws (keep each one, where it is):
  - small brass plaque: left armrest, front view
  Every print, logo, graphic or text the sketch draws stays, exactly where it is drawn, listed or not.

ASSUMPTIONS (decided where the inputs left this open; follow them)
- The frame is oak and the seat ecru.

WHICH SOURCE DECIDES WHAT
The material sample decides the colour, the material, the finish and the pattern of the main surface; the written inputs name them. When the sketch, a written colour or a written material disagrees with the sample, follow the sample.
The sketch decides the shape and the construction: the silhouette, the proportions between parts, every part and how it joins the rest, openings, closures, seams and edges, and every print, graphic, logo or text drawn on the lounge chair: where it sits and how it looks.
Neither decides the camera, the lighting or the staging. Those follow the output rules below.

HOW TO READ THE SKETCH
The sketch is a design drawing, not a photograph: it may exaggerate, simplify or flatten the object, and its lines show no material weight. Keep the construction and give it real-world proportions, at the dimensions given.
Real-world proportions never even out the design: a part drawn short stays short beside a long one, an element drawn on one side only stays on that side and only there, and an edge drawn uneven stays uneven.
The sketch shows these views: front. Use what is drawn for the parts this angle shows. What is not drawn (the other views, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it. The back is not a mirror of the front: a front-only logo, print, opening, control or detail stays on the front, and the back shows what the back of this kind of product carries.
Render only the lounge chair. Leave out everything drawn around it that is not part of it: notes, measurements, arrows, codes, signatures, colour chips, other objects, and any figure, hand or body drawn to show it in use.
On this sketch, leave out: a handwritten note; a colour chip.
Sketch colours are approximate markers. Make the lounge chair from the sample material: its colour, finish and pattern cover the surfaces drawn in the main material. Each motif of the sample (a check, a stripe, a grain, a woven or printed pattern) keeps the size it has in the sample: a large surface carries many repeats of it, never a few enlarged ones. The sample is a flat piece of material, not part of the product, and does not appear in the image.
Artwork drawn on the product (a placed print, a graphic, a gradient, a logo, text, a motif on some parts only) is part of the design, not a colour marker: it stays exactly where the sketch draws it, only on the parts it covers, with its own colours, density and transparency, on top of the base material.

MATERIALS
Render the main material as the sample shows it: its texture, grain or weave, sheen and weight. The written material names it; where its usual look differs from the sample, follow the sample.
Rigid parts (wood, metal, plastic, glass, ceramic, stone) keep clean, true edges and catch the light as their finish does: matte, satin or gloss. Soft parts (textile, leather, foam, rubber) show real thickness, seams and stitching, and fold, drape or compress under their own weight.
Prints, graphics and logos sit exactly where the sketch places them, at a realistic scale for the product.

OUTPUT
One photograph of the lounge chair from a single camera angle: the front view, seen straight on. The lounge chair is shown alone, standing or resting as it does in use, with no person, body, mannequin, hands, stand or prop unless the sketch draws one as part of the product; a soft object keeps the full shape it has in use, held by nothing visible, centred, whole and fully visible, filling most of the frame.
The camera is level with the middle of the lounge chair, at the same distance from it for every view. The front, the back, the left side and the right side views show the same lounge chair, which does not move; only the camera does.
Seamless white background, soft even studio light that does not change with the angle.
Photorealistic, e-commerce quality, true-to-life colour, a clean image with no caption, label, watermark or annotation added around the product.

MUST MATCH
Shape, proportions, every part, one-sided elements and the colour, material and pattern of the sample must match the inputs. Details should match where this angle shows them.
```

#### G2. Back not drawn by the sketch, with a material sample (render only)

Images: front_render. The written material and colour are left out: the render carries the
sample's material.

```text
The attached image is a product photograph of the finished lounge chair seen from the front, made from the designer's sketch. Make a product photograph of the same lounge chair from one camera angle: the back view, seen from directly behind.

INPUTS
- Product: lounge chair
- Dimensions: w 78 x d 82 x h 74 cm
- Parts the sketch draws:
  - frame: solid wood, rounded edges, all around
  - seat: deep upholstered cushion, middle
  - legs: four tapered legs, under the seat
- Details the sketch draws (keep each one, where it is):
  - small brass plaque: left armrest, front view
  Every print, logo, graphic or text the sketch draws stays, exactly where it is drawn, listed or not.

ASSUMPTIONS (decided where the inputs left this open; follow them)
- The frame is oak and the seat ecru.

WHICH SOURCE DECIDES WHAT
The attached photograph decides everything about the product: shape, construction, material, colour and pattern, details and proportions. This image shows that same product from another camera position; nothing about the product changes.
What the photograph does not show (the back, the sides, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it. The back is not a mirror of the front: a front-only logo, print, opening, control or detail stays on the front, and the back shows what the back of this kind of product carries.

MATERIALS
Render every part in the material the photograph shows, with the same finish, sheen and texture.
Rigid parts (wood, metal, plastic, glass, ceramic, stone) keep clean, true edges and catch the light as their finish does: matte, satin or gloss. Soft parts (textile, leather, foam, rubber) show real thickness, seams and stitching, and fold, drape or compress under their own weight.
Prints, graphics and logos sit exactly where the photograph shows them, at a realistic scale for the product.

OUTPUT
One photograph of the lounge chair from a single camera angle: the back view, seen from directly behind. The lounge chair is shown alone, standing or resting as it does in use, with no person, body, mannequin, hands, stand or prop unless the sketch draws one as part of the product; a soft object keeps the full shape it has in use, held by nothing visible, centred, whole and fully visible, filling most of the frame.
The camera is level with the middle of the lounge chair, at the same distance from it for every view. The front, the back, the left side and the right side views show the same lounge chair, which does not move; only the camera does.
Seamless white background, soft even studio light that does not change with the angle.
Photorealistic, e-commerce quality, true-to-life colour, a clean image with no caption, label, watermark or annotation added around the product.

MUST MATCH
Shape, proportions, parts, details, material and colour must match the attached photograph: same product, only the camera angle changes.
```

#### G3. Left profile not drawn, no material sample, with corrections and requests

Images, in order: front_render, back_render. Corrections:
`part: legs: expected four tapered legs, saw three legs`, `color: the seat is grey, not ecru`.
Requests: `Make the backrest slightly taller`.

```text
The first attached image is a product photograph of the finished lounge chair seen from the front, made from the designer's sketch. The second is a photograph of the same finished product seen from directly behind. This view joins the two: the front edge as the front photograph shows it, the back edge as the back photograph shows it. Make a product photograph of the same lounge chair from one camera angle: the left side view, in full left profile: the camera stands at the object's left, so the front of the object faces the left edge of the image and the back faces the right edge.

INPUTS
- Product: lounge chair
- Material: oiled oak, wool boucle seat
- Colour: natural / ecru
- Dimensions: w 78 x d 82 x h 74 cm
- Parts the sketch draws:
  - frame: solid wood, rounded edges, all around
  - seat: deep upholstered cushion, middle
  - legs: four tapered legs, under the seat
- Details the sketch draws (keep each one, where it is):
  - small brass plaque: left armrest, front view
  Every print, logo, graphic or text the sketch draws stays, exactly where it is drawn, listed or not.

ASSUMPTIONS (decided where the inputs left this open; follow them)
- The frame is oak and the seat ecru.

WHICH SOURCE DECIDES WHAT
The attached photograph decides everything about the product: shape, construction, material, colour and pattern, details and proportions. This image shows that same product from another camera position; nothing about the product changes.
What the photograph does not show (the back, the sides, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it. The back is not a mirror of the front: a front-only logo, print, opening, control or detail stays on the front, and the back shows what the back of this kind of product carries.

MATERIALS
Render each part in its real material: oiled oak, wool boucle seat, with the surface, finish and weight that material has.
Rigid parts (wood, metal, plastic, glass, ceramic, stone) keep clean, true edges and catch the light as their finish does: matte, satin or gloss. Soft parts (textile, leather, foam, rubber) show real thickness, seams and stitching, and fold, drape or compress under their own weight.
Prints, graphics and logos sit exactly where the photograph shows them, at a realistic scale for the product.

OUTPUT
One photograph of the lounge chair from a single camera angle: the left side view, in full left profile: the camera stands at the object's left, so the front of the object faces the left edge of the image and the back faces the right edge. The lounge chair is shown alone, standing or resting as it does in use, with no person, body, mannequin, hands, stand or prop unless the sketch draws one as part of the product; a soft object keeps the full shape it has in use, held by nothing visible, centred, whole and fully visible, filling most of the frame.
The left and right side views are mirror opposites, not copies. In the attached photograph, the object's left side is the right half of the picture and its right side is the left half. This view shows the side that appears on the right half of the attached photograph: every asymmetric element there (an off-centre handle, opening, closure, strap, control or panel) is visible here, and every asymmetric element on the left half is on the far side, hidden behind the object, except where it protrudes past its outline.
The camera is level with the middle of the lounge chair, at the same distance from it for every view. The front, the back, the left side and the right side views show the same lounge chair, which does not move; only the camera does.
Seamless white background, soft even studio light that does not change with the angle.
Photorealistic, e-commerce quality, true-to-life colour, a clean image with no caption, label, watermark or annotation added around the product.

MUST MATCH
Shape, proportions, parts, details, material and colour must match the attached photograph: same product, only the camera angle changes.

CORRECTIONS FROM THE PREVIOUS ATTEMPT
A reviewer rejected the previous image of this view. Fix what it found, and keep everything else as the inputs say:
- part: legs: expected four tapered legs, saw three legs.
- color: the seat is grey, not ecru.

REQUESTS FROM THE DESIGN TEAM
The design team reviewed an earlier image of this view and asked for these changes. They overrule the inputs: apply each one even where the sketch, the material sample or the attached photographs show otherwise, and keep everything else as the inputs say:
- Make the backrest slightly taller.
```

#### G4. Right profile drawn by the sketch (two uploaded images), with a material sample

Spec as above with `views: [front, back, side]`. Images, in order: sketch (two images), swatch,
front_render, back_render.

```text
The first two attached images are the designer's images of one lounge chair, each showing the same object; together they are the sketch. The third is a sample of its material. The fourth is a photograph of the finished product made from this same sketch, seen from the front, straight on. The fifth is a photograph of the same finished product seen from directly behind. This view joins the two: the front edge as the front photograph shows it, the back edge as the back photograph shows it. Turn the sketch into a single product photograph of the finished lounge chair from one camera angle: the right side view, in full right profile: the camera stands at the object's right, so the front of the object faces the right edge of the image and the back faces the left edge.

INPUTS
- Product: lounge chair
- Material: oiled oak, wool boucle seat
- Colour: natural / ecru
- Dimensions: w 78 x d 82 x h 74 cm
- Material sample: the third attached image, a sample of the actual material
- Parts the sketch draws:
  - frame: solid wood, rounded edges, all around
  - seat: deep upholstered cushion, middle
  - legs: four tapered legs, under the seat
- Details the sketch draws (keep each one, where it is):
  - small brass plaque: left armrest, front view
  Every print, logo, graphic or text the sketch draws stays, exactly where it is drawn, listed or not.

ASSUMPTIONS (decided where the inputs left this open; follow them)
- The frame is oak and the seat ecru.

WHICH SOURCE DECIDES WHAT
The material sample decides the colour, the material, the finish and the pattern of the main surface; the written inputs name them. When the sketch, a written colour or a written material disagrees with the sample, follow the sample.
The sketch decides the shape and the construction: the silhouette, the proportions between parts, every part and how it joins the rest, openings, closures, seams and edges, and every print, graphic, logo or text drawn on the lounge chair: where it sits and how it looks.
Neither decides the camera, the lighting or the staging. Those follow the output rules below.

HOW TO READ THE SKETCH
The sketch is a design drawing, not a photograph: it may exaggerate, simplify or flatten the object, and its lines show no material weight. Keep the construction and give it real-world proportions, at the dimensions given.
Real-world proportions never even out the design: a part drawn short stays short beside a long one, an element drawn on one side only stays on that side and only there, and an edge drawn uneven stays uneven.
The sketch shows these views: front, back, side. Use what is drawn for the parts this angle shows. What is not drawn (the other views, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it. The back is not a mirror of the front: a front-only logo, print, opening, control or detail stays on the front, and the back shows what the back of this kind of product carries.
Render only the lounge chair. Leave out everything drawn around it that is not part of it: notes, measurements, arrows, codes, signatures, colour chips, other objects, and any figure, hand or body drawn to show it in use.
On this sketch, leave out: a handwritten note; a colour chip.
Sketch colours are approximate markers. Make the lounge chair from the sample material: its colour, finish and pattern cover the surfaces drawn in the main material. Each motif of the sample (a check, a stripe, a grain, a woven or printed pattern) keeps the size it has in the sample: a large surface carries many repeats of it, never a few enlarged ones. The sample is a flat piece of material, not part of the product, and does not appear in the image.
Artwork drawn on the product (a placed print, a graphic, a gradient, a logo, text, a motif on some parts only) is part of the design, not a colour marker: it stays exactly where the sketch draws it, only on the parts it covers, with its own colours, density and transparency, on top of the base material.

MATERIALS
Render the main material as the sample shows it: its texture, grain or weave, sheen and weight. The written material names it; where its usual look differs from the sample, follow the sample.
Rigid parts (wood, metal, plastic, glass, ceramic, stone) keep clean, true edges and catch the light as their finish does: matte, satin or gloss. Soft parts (textile, leather, foam, rubber) show real thickness, seams and stitching, and fold, drape or compress under their own weight.
Prints, graphics and logos sit exactly where the sketch places them, at a realistic scale for the product.

OUTPUT
One photograph of the lounge chair from a single camera angle: the right side view, in full right profile: the camera stands at the object's right, so the front of the object faces the right edge of the image and the back faces the left edge. The lounge chair is shown alone, standing or resting as it does in use, with no person, body, mannequin, hands, stand or prop unless the sketch draws one as part of the product; a soft object keeps the full shape it has in use, held by nothing visible, centred, whole and fully visible, filling most of the frame.
The left and right side views are mirror opposites, not copies. In the attached front photograph, the object's right side is the left half of the picture and its left side is the right half. This view shows the side that appears on the left half of the attached front photograph: every asymmetric element there (an off-centre handle, opening, closure, strap, control or panel) is visible here, and every asymmetric element on the right half is on the far side, hidden behind the object, except where it protrudes past its outline.
The camera is level with the middle of the lounge chair, at the same distance from it for every view. The front, the back, the left side and the right side views show the same lounge chair, which does not move; only the camera does.
Seamless white background, soft even studio light that does not change with the angle.
Photorealistic, e-commerce quality, true-to-life colour, a clean image with no caption, label, watermark or annotation added around the product.

MUST MATCH
Shape, proportions, every part, one-sided elements and the colour, material and pattern of the sample must match the inputs, and this view must agree with the attached front photograph: same product, same material, same proportions, same details, only the camera angle changes. Details should match where this angle shows them.
```

#### G5. A soft object front, no metadata, no material sample

The same template for a soft object. Spec: `{"model": "SAMPLE-2", "productType": {"value": "floor cushion", "provenance": "observed"}, "views": ["front"]}`. Images: sketch.

```text
The attached image is a designer's sketch of a floor cushion. Turn it into a single product photograph of the finished floor cushion from one camera angle: the front view, seen straight on.

INPUTS
- Product: floor cushion

WHICH SOURCE DECIDES WHAT
The written inputs decide the material, the finish and the colour. When the sketch disagrees, follow the written inputs.
The sketch decides the shape and the construction: the silhouette, the proportions between parts, every part and how it joins the rest, openings, closures, seams and edges, and every print, graphic, logo or text drawn on the floor cushion: where it sits and how it looks.
Neither decides the camera, the lighting or the staging. Those follow the output rules below.

HOW TO READ THE SKETCH
The sketch is a design drawing, not a photograph: it may exaggerate, simplify or flatten the object, and its lines show no material weight. Keep the construction and give it real-world proportions.
Real-world proportions never even out the design: a part drawn short stays short beside a long one, an element drawn on one side only stays on that side and only there, and an edge drawn uneven stays uneven.
The sketch shows these views: front. Use what is drawn for the parts this angle shows. What is not drawn (the other views, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it. The back is not a mirror of the front: a front-only logo, print, opening, control or detail stays on the front, and the back shows what the back of this kind of product carries.
Render only the floor cushion. Leave out everything drawn around it that is not part of it: notes, measurements, arrows, codes, signatures, colour chips, other objects, and any figure, hand or body drawn to show it in use.
Take the colours from the sketch, but render them as real finished materials, evenly coloured, with no pencil, marker or watercolour texture.
Artwork drawn on the product (a placed print, a graphic, a gradient, a logo, text, a motif on some parts only) is part of the design, not a colour marker: it stays exactly where the sketch draws it, only on the parts it covers, with its own colours, density and transparency, on top of the base material.

MATERIALS
Render every part in the real material the sketch suggests.
Rigid parts (wood, metal, plastic, glass, ceramic, stone) keep clean, true edges and catch the light as their finish does: matte, satin or gloss. Soft parts (textile, leather, foam, rubber) show real thickness, seams and stitching, and fold, drape or compress under their own weight.
Prints, graphics and logos sit exactly where the sketch places them, at a realistic scale for the product.

OUTPUT
One photograph of the floor cushion from a single camera angle: the front view, seen straight on. The floor cushion is shown alone, standing or resting as it does in use, with no person, body, mannequin, hands, stand or prop unless the sketch draws one as part of the product; a soft object keeps the full shape it has in use, held by nothing visible, centred, whole and fully visible, filling most of the frame.
The camera is level with the middle of the floor cushion, at the same distance from it for every view. The front, the back, the left side and the right side views show the same floor cushion, which does not move; only the camera does.
Seamless white background, soft even studio light that does not change with the angle.
Photorealistic, e-commerce quality, true-to-life colour, a clean image with no caption, label, watermark or annotation added around the product.

MUST MATCH
Shape, proportions, every part, one-sided elements and colour must match the inputs. Details should match where this angle shows them.
```

#### G6. Front, two design references and a further material, with a material sample

Spec as for G1. The analyser read four images: two sketches, a material and another material.
Images, in order: sketch (the two sketches, the further material), swatch (the first material).
`sketchImages = 3`, `materialReferences = 1`, `designKinds = [sketch, sketch]`.

```text
The first three attached images are the designer's images of one lounge chair; together they are the sketch. Of these, the third is a sample of another material of the lounge chair, not a view of it. The fourth is a sample of its material. Turn the sketch into a single product photograph of the finished lounge chair from one camera angle: the front view, seen straight on.

INPUTS
- Product: lounge chair
- Material: oiled oak, wool boucle seat
- Colour: natural / ecru
- Dimensions: w 78 x d 82 x h 74 cm
- Material sample: the fourth attached image, a sample of the actual material
- Parts the sketch draws:
  - frame: solid wood, rounded edges, all around
  - seat: deep upholstered cushion, middle
  - legs: four tapered legs, under the seat
- Details the sketch draws (keep each one, where it is):
  - small brass plaque: left armrest, front view
  Every print, logo, graphic or text the sketch draws stays, exactly where it is drawn, listed or not.

ASSUMPTIONS (decided where the inputs left this open; follow them)
- The frame is oak and the seat ecru.

WHICH SOURCE DECIDES WHAT
The material sample decides the colour, the material, the finish and the pattern of the main surface; the written inputs name them. When the sketch, a written colour or a written material disagrees with the sample, follow the sample.
The sketch decides the shape and the construction: the silhouette, the proportions between parts, every part and how it joins the rest, openings, closures, seams and edges, and every print, graphic, logo or text drawn on the lounge chair: where it sits and how it looks.
Neither decides the camera, the lighting or the staging. Those follow the output rules below.

HOW TO READ THE SKETCH
The sketch is a design drawing, not a photograph: it may exaggerate, simplify or flatten the object, and its lines show no material weight. Keep the construction and give it real-world proportions, at the dimensions given.
Real-world proportions never even out the design: a part drawn short stays short beside a long one, an element drawn on one side only stays on that side and only there, and an edge drawn uneven stays uneven.
The sketch shows these views: front. Use what is drawn for the parts this angle shows. What is not drawn (the other views, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it. The back is not a mirror of the front: a front-only logo, print, opening, control or detail stays on the front, and the back shows what the back of this kind of product carries.
Render only the lounge chair. Leave out everything drawn around it that is not part of it: notes, measurements, arrows, codes, signatures, colour chips, other objects, and any figure, hand or body drawn to show it in use.
On this sketch, leave out: a handwritten note; a colour chip.
Sketch colours are approximate markers. Make the lounge chair from the sample material: its colour, finish and pattern cover the surfaces drawn in the main material. Each motif of the sample (a check, a stripe, a grain, a woven or printed pattern) keeps the size it has in the sample: a large surface carries many repeats of it, never a few enlarged ones. The sample is a flat piece of material, not part of the product, and does not appear in the image.
Artwork drawn on the product (a placed print, a graphic, a gradient, a logo, text, a motif on some parts only) is part of the design, not a colour marker: it stays exactly where the sketch draws it, only on the parts it covers, with its own colours, density and transparency, on top of the base material.

MATERIALS
Render the main material as the sample shows it: its texture, grain or weave, sheen and weight. The written material names it; where its usual look differs from the sample, follow the sample.
Rigid parts (wood, metal, plastic, glass, ceramic, stone) keep clean, true edges and catch the light as their finish does: matte, satin or gloss. Soft parts (textile, leather, foam, rubber) show real thickness, seams and stitching, and fold, drape or compress under their own weight.
Prints, graphics and logos sit exactly where the sketch places them, at a realistic scale for the product.

OUTPUT
One photograph of the lounge chair from a single camera angle: the front view, seen straight on. The lounge chair is shown alone, standing or resting as it does in use, with no person, body, mannequin, hands, stand or prop unless the sketch draws one as part of the product; a soft object keeps the full shape it has in use, held by nothing visible, centred, whole and fully visible, filling most of the frame.
The camera is level with the middle of the lounge chair, at the same distance from it for every view. The front, the back, the left side and the right side views show the same lounge chair, which does not move; only the camera does.
Seamless white background, soft even studio light that does not change with the angle.
Photorealistic, e-commerce quality, true-to-life colour, a clean image with no caption, label, watermark or annotation added around the product.

MUST MATCH
Shape, proportions, every part, one-sided elements and the colour, material and pattern of the sample must match the inputs. Details should match where this angle shows them.
```

#### G7. Front, photos only (one photo), no material sample

Spec as for G1. The analyser read one image, a photo. Images: sketch (the photo). `designKinds = [photo]`.

```text
The attached image is a photo of a lounge chair (the product itself, a prototype or a reference for it). Make a single clean studio product photograph of the same lounge chair from one camera angle: the front view, seen straight on.

INPUTS
- Product: lounge chair
- Material: oiled oak, wool boucle seat
- Colour: natural / ecru
- Dimensions: w 78 x d 82 x h 74 cm
- Parts the photo shows:
  - frame: solid wood, rounded edges, all around
  - seat: deep upholstered cushion, middle
  - legs: four tapered legs, under the seat
- Details the photo shows (keep each one, where it is):
  - small brass plaque: left armrest, front view
  Every print, logo, graphic or text the photo shows stays, exactly where it is, listed or not.

ASSUMPTIONS (decided where the inputs left this open; follow them)
- The frame is oak and the seat ecru.

WHICH SOURCE DECIDES WHAT
The photo of the product decides the colour, the material and the finish, except where the written inputs name them: when the photo and a written colour or material disagree, follow the written inputs.
It also decides the shape and the construction: the silhouette, the proportions between parts, every part and how it joins the rest, openings, closures, seams and edges, and every print, graphic, logo or text on the lounge chair: where it sits and how it looks.
No input decides the camera, the lighting, the background or the staging, not even the photo's own. Those follow the output rules below.

HOW TO READ THE PHOTO
The photo of the product shows a real object: keep its shape, its proportions and its construction as photographed, at the dimensions given, and show it as the finished product, clean and new.
The photo shows these views: front. Use what it shows for the parts this angle shows. What it does not show (the other views, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it. The back is not a mirror of the front: a front-only logo, print, opening, control or detail stays on the front, and the back shows what the back of this kind of product carries.
Render only the lounge chair. Leave out anything that is not part of the product (people, hands, other objects, background).
In this photo, leave out: a handwritten note; a colour chip.
The colour of the lounge chair is natural / ecru.
Artwork on the product (a placed print, a graphic, a gradient, a logo, text, a motif on some parts only) stays exactly where the photo shows it, only on the parts it covers, with its own colours, density and transparency, on top of the base material.

MATERIALS
Render each part in its real material: oiled oak, wool boucle seat, with the surface, finish and weight that material has.
Rigid parts (wood, metal, plastic, glass, ceramic, stone) keep clean, true edges and catch the light as their finish does: matte, satin or gloss. Soft parts (textile, leather, foam, rubber) show real thickness, seams and stitching, and fold, drape or compress under their own weight.
Prints, graphics and logos sit exactly where the photo shows them, at a realistic scale for the product.

OUTPUT
One photograph of the lounge chair from a single camera angle: the front view, seen straight on. The lounge chair is shown alone, standing or resting as it does in use, with no person, body, mannequin, hands, stand or prop unless the photo shows one as part of the product; a soft object keeps the full shape it has in use, held by nothing visible, centred, whole and fully visible, filling most of the frame.
The camera is level with the middle of the lounge chair, at the same distance from it for every view. The front, the back, the left side and the right side views show the same lounge chair, which does not move; only the camera does.
Seamless white background, soft even studio light that does not change with the angle.
Photorealistic, e-commerce quality, true-to-life colour, a clean image with no caption, label, watermark or annotation added around the product.

MUST MATCH
Shape, proportions, every part, one-sided elements and colour must match the inputs. Details should match where this angle shows them.
```

#### G8. Front, a sketch and a photo, with a material sample

Spec as for G1. The analyser read three images: a sketch, a photo and a material. Images, in order:
sketch (the sketch, the photo), swatch. `sketchImages = 2`, `designKinds = [sketch, photo]`.

```text
The first two attached images show one lounge chair. The first is the designer's sketch of it. The second is a photo of it (the product itself, a prototype or a reference for it). The third is a sample of its material. Turn the sketch and the photo into a single product photograph of the finished lounge chair from one camera angle: the front view, seen straight on.

INPUTS
- Product: lounge chair
- Material: oiled oak, wool boucle seat
- Colour: natural / ecru
- Dimensions: w 78 x d 82 x h 74 cm
- Material sample: the third attached image, a sample of the actual material
- Parts the sketch draws or the photo shows:
  - frame: solid wood, rounded edges, all around
  - seat: deep upholstered cushion, middle
  - legs: four tapered legs, under the seat
- Details the sketch draws or the photo shows (keep each one, where it is):
  - small brass plaque: left armrest, front view
  Every print, logo, graphic or text the sketch draws or the photo shows stays, exactly where it is, listed or not.

ASSUMPTIONS (decided where the inputs left this open; follow them)
- The frame is oak and the seat ecru.

WHICH SOURCE DECIDES WHAT
The material sample decides the colour, the material, the finish and the pattern of the main surface; the written inputs name them. When the sketch, the photo, a written colour or a written material disagrees with the sample, follow the sample.
The sketch decides the shape and the construction: the silhouette, the proportions between parts, every part and how it joins the rest, openings, closures, seams and edges, and every print, graphic, logo or text drawn on the lounge chair: where it sits and how it looks.
The photo of the product shows its real look: the material, the finish, the thickness of its parts and how they sit. Where the photo and the sketch differ in shape or construction, follow the sketch.
No input decides the camera, the lighting, the background or the staging, not even the photo's own. Those follow the output rules below.

HOW TO READ THE SKETCH AND THE PHOTO
The sketch is a design drawing, not a photograph: it may exaggerate, simplify or flatten the object, and its lines show no material weight. Keep the construction and give it real-world proportions, at the dimensions given.
Real-world proportions never even out the design: a part drawn short stays short beside a long one, an element drawn on one side only stays on that side and only there, and an edge drawn uneven stays uneven.
The sketch and the photo show these views: front. Use what is drawn or photographed for the parts this angle shows. What is not drawn or photographed (the other views, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it. The back is not a mirror of the front: a front-only logo, print, opening, control or detail stays on the front, and the back shows what the back of this kind of product carries.
Render only the lounge chair. Leave out everything drawn around it that is not part of it: notes, measurements, arrows, codes, signatures, colour chips, other objects, and any figure, hand or body drawn to show it in use.
In the photo, leave out anything that is not part of the product (people, hands, other objects, background).
In these images, leave out: a handwritten note; a colour chip.
Sketch colours are approximate markers. Make the lounge chair from the sample material: its colour, finish and pattern cover the surfaces drawn in the main material. Each motif of the sample (a check, a stripe, a grain, a woven or printed pattern) keeps the size it has in the sample: a large surface carries many repeats of it, never a few enlarged ones. The sample is a flat piece of material, not part of the product, and does not appear in the image.
Artwork drawn on the product (a placed print, a graphic, a gradient, a logo, text, a motif on some parts only) is part of the design, not a colour marker: it stays exactly where the sketch draws it, only on the parts it covers, with its own colours, density and transparency, on top of the base material.

MATERIALS
Render the main material as the sample shows it: its texture, grain or weave, sheen and weight. The written material names it; where its usual look differs from the sample, follow the sample.
Rigid parts (wood, metal, plastic, glass, ceramic, stone) keep clean, true edges and catch the light as their finish does: matte, satin or gloss. Soft parts (textile, leather, foam, rubber) show real thickness, seams and stitching, and fold, drape or compress under their own weight.
Prints, graphics and logos sit exactly where the sketch places them, at a realistic scale for the product.

OUTPUT
One photograph of the lounge chair from a single camera angle: the front view, seen straight on. The lounge chair is shown alone, standing or resting as it does in use, with no person, body, mannequin, hands, stand or prop unless the sketch draws or the photo shows one as part of the product; a soft object keeps the full shape it has in use, held by nothing visible, centred, whole and fully visible, filling most of the frame.
The camera is level with the middle of the lounge chair, at the same distance from it for every view. The front, the back, the left side and the right side views show the same lounge chair, which does not move; only the camera does.
Seamless white background, soft even studio light that does not change with the angle.
Photorealistic, e-commerce quality, true-to-life colour, a clean image with no caption, label, watermark or annotation added around the product.

MUST MATCH
Shape, proportions, every part, one-sided elements and the colour, material and pattern of the sample must match the inputs. Details should match where this angle shows them.
```
