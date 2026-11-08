import type { CandidateView, DesignKind, ProductSpec } from '@sketch-to-product-views/contracts';

/**
 * Builds the image-generation prompt: one studio photograph of the product from one camera
 * position. The front is made from the design references (sketches, photos of the product) and
 * the material sample; the back and the two profiles are made from the front render, with those
 * attached again only when they show that view (`./views.ts` decides which). The wording follows
 * what was uploaded: a sketch is read as a design drawing, a photo as the real product.
 *
 * Deliberately a template rather than an LLM call. It is deterministic, so it is safe inside
 * a durable step and a rerun of the same revision produces the same prompt, and every word
 * traces to a spec field or to a rule below, so a wrong image points at the template or the
 * metadata, not at an opaque rewrite. An absent field is left out, never filled in.
 *
 * Object-neutral: the product type and its parts come from the analysis, never from a list of
 * known categories. GPT Image has no negative prompt field: what to avoid is said positively.
 */

/** Short name of each view, for the critic and the judge. */
export const VIEW_LABEL: Record<CandidateView, string> = {
  front: 'front',
  back: 'back',
  left: 'left side',
  right: 'right side',
};

/**
 * Where the camera stands for each view, as the prompt asks for it and the critic is told it.
 * The profiles say which edge of the image the front faces: left and right profiles are
 * otherwise easily swapped.
 */
export const VIEW_CAMERA: Record<CandidateView, string> = {
  front: 'the front view, seen straight on',
  back: 'the back view, seen from directly behind',
  left: "the left side view, in full left profile: the camera stands at the object's left, so the front of the object faces the left edge of the image and the back faces the right edge",
  right:
    "the right side view, in full right profile: the camera stands at the object's right, so the front of the object faces the right edge of the image and the back faces the left edge",
};

export interface PromptOptions {
  /** The designer's free text, passed on as written. */
  notes?: string;
  /**
   * The product has a material sample (input role `swatch`). On a call that sends the sketch it
   * comes right after it and decides the colour, material and pattern. On a render-only call it
   * is not attached, and the written material and colour are left out: the render already
   * carries its material, and the words would contradict it.
   */
  swatch?: boolean;
  /** The view this call renders; the front when omitted. */
  view?: CandidateView;
  /**
   * A photograph of the front, already generated, is attached: after the sketch and the sample
   * when the sketch draws the view being rendered, alone when it does not.
   */
  frontRender?: 'with_sketch' | 'alone';
  /** A photograph of the back, already generated, is attached right after the front one. */
  backRender?: boolean;
  /** What the critic found on this view's previous image, when it was rejected. */
  corrections?: string[];
  /**
   * What the design team asked to change on this view at review, oldest first. Unlike the
   * critic's corrections, these overrule the inputs: the reviewer has seen the images and the
   * sketch, and is asking for a departure from them.
   */
  requests?: string[];
  /**
   * How many uploaded images are attached first, in upload order, on a call that sends the
   * sketch: the sketches and photos the analyser found, then any further material samples. One
   * when omitted. The prompt calls them the sketch together, and numbers the
   * sample and the renders after them.
   */
  sketchImages?: number;
  /**
   * How many of the sketch images, at their end, are further material samples the analyser found
   * beyond the first: sent as references only, and said not to be views.
   */
  materialReferences?: number;
  /**
   * What each design reference is, in upload order (`planImages`): the sketch images before any
   * further material. All sketches when omitted.
   */
  designKinds?: readonly DesignKind[];
}

/** Enough for every image a call can carry: five uploads and two renders. */
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];
const COUNTS = ['one', 'two', 'three', 'four', 'five'];

/** The findings a retry passes on: enough to point at the fault, short enough to stay read. */
export const MAX_CORRECTIONS = 4;

/**
 * The review requests a view keeps, the most recent ones. Every earlier request is sent again
 * each time the view is remade, or the next regeneration would undo it.
 */
export const MAX_REQUESTS = 6;

/** "a", "a and b", "a, b and c". */
const listed = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');

const BACK_NOT_MIRROR =
  'The back is not a mirror of the front: a front-only logo, print, opening, control or detail stays on the front, and the back shows what the back of this kind of product carries.';
const NOT_DRAWN =
  'What is not drawn (the other views, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it.';
const RENDER_DECIDES =
  'The attached photograph decides everything about the product: shape, construction, material, colour and pattern, details and proportions. This image shows that same product from another camera position; nothing about the product changes.';
const NOT_SHOWN_BY_RENDER =
  'What the photograph does not show (the back, the sides, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it.';
// Measured on garments: a short part under a long panel came back long, a one-sided element came
// back even. "Real-world proportions" alone reads as licence to regularise.
const DESIGN_KEPT =
  'Real-world proportions never even out the design: a part drawn short stays short beside a long one, an element drawn on one side only stays on that side and only there, and an edge drawn uneven stays uneven.';
// The sketch colour rule is about the base material. Without this line, a placed watercolour
// print came back as an all-over pattern in the sample's look, its fades and transparency lost.
const SKETCH_ARTWORK =
  'Artwork drawn on the product (a placed print, a graphic, a gradient, a logo, text, a motif on some parts only) is part of the design, not a colour marker: it stays exactly where the sketch draws it, only on the parts it covers, with its own colours, density and transparency, on top of the base material.';
const SAMPLE_SCALE =
  'Each motif of the sample (a check, a stripe, a grain, a woven or printed pattern) keeps the size it has in the sample: a large surface carries many repeats of it, never a few enlarged ones.';
// Not the written material alone: where the name and the sample disagree, the image model
// blends the two.
const SAMPLE_MATERIAL =
  'Render the main material as the sample shows it: its texture, grain or weave, sheen and weight. The written material names it; where its usual look differs from the sample, follow the sample.';
const MATERIAL_GUIDANCE =
  'Rigid parts (wood, metal, plastic, glass, ceramic, stone) keep clean, true edges and catch the light as their finish does: matte, satin or gloss. Soft parts (textile, leather, foam, rubber) show real thickness, seams and stitching, and fold, drape or compress under their own weight.';
const LEAVE_OUT =
  'notes, measurements, arrows, codes, signatures, colour chips, other objects, and any figure, hand or body drawn to show it in use';
const PHOTO_LEAVE_OUT =
  'anything that is not part of the product (people, hands, other objects, background)';
const staging = (shows: string) =>
  `standing or resting as it does in use, with no person, body, mannequin, hands, stand or prop unless ${shows} one as part of the product; a soft object keeps the full shape it has in use, held by nothing visible`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What the design references are: sketches only, photos only, or both. */
type Mode = 'sketch' | 'photo' | 'mixed';

/**
 * Which views the design references show, from the views the analyser read. Without them (a
 * spec built before views were recorded) the sketch is taken to be the front, with the back
 * possibly beside it.
 */
function designViews(
  views: ProductSpec['views'],
  mode: Mode,
  photos: string,
  many: boolean,
): string {
  const subject =
    mode === 'sketch'
      ? 'The sketch'
      : mode === 'photo'
        ? capital(photos)
        : `The sketch and ${photos}`;
  const plural = mode === 'mixed' || (mode === 'photo' && many);
  const listedViews = views?.length ? views.join(', ') : 'none of the front, back or side';
  const shown = !views
    ? mode === 'sketch'
      ? 'The sketch may show the front alone, or the front and the back side by side.'
      : `${subject} may show the front alone, or the front and the back.`
    : `${subject} ${plural ? 'show' : 'shows'} these views: ${listedViews}.`;
  const use =
    mode === 'sketch'
      ? `Use what is drawn for the parts this angle shows. ${NOT_DRAWN}`
      : mode === 'photo'
        ? `Use what ${many ? 'they show' : 'it shows'} for the parts this angle shows. What ${many ? 'they do' : 'it does'} not show (the other views, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it.`
        : 'Use what is drawn or photographed for the parts this angle shows. What is not drawn or photographed (the other views, the depth of the object) follows its construction: the same parts, edges, seams and joints continue around it.';
  return `${shown} ${use} ${BACK_NOT_MIRROR}`;
}

/**
 * The two profiles are not copies of each other. The source image is seen from the front, so
 * its left half is the object's right side: the right profile shows what that half carries,
 * the left profile what the other half carries. No per-detail side rules: they are brittle.
 */
function profileSides(view: 'left' | 'right', source: string): string {
  const other = view === 'left' ? 'right' : 'left';
  const [near, far] = view === 'left' ? ['right', 'left'] : ['left', 'right'];
  return `The left and right side views are mirror opposites, not copies. In ${source}, the object's ${view} side is the ${near} half of the picture and its ${other} side is the ${far} half. This view shows the side that appears on the ${near} half of ${source}: every asymmetric element there (an off-centre handle, opening, closure, strap, control or panel) is visible here, and every asymmetric element on the ${far} half is on the far side, hidden behind the object, except where it protrudes past its outline.`;
}

export function buildPrompt(spec: ProductSpec, options: PromptOptions = {}): string {
  const {
    notes,
    swatch = false,
    view = 'front',
    frontRender,
    backRender = false,
    corrections,
    requests,
    sketchImages = 1,
    materialReferences = 0,
    designKinds = [],
  } = options;
  const renderOnly = frontRender === 'alone';
  const withRender = frontRender === 'with_sketch';
  const product = spec.productType?.value || 'product';
  const color = spec.colorDescription?.value;
  const material = spec.materialDescription?.value;
  const dimensions = spec.dimensions?.value;
  const camera = VIEW_CAMERA[view];

  // How the design references are named. Sketches only keeps the drawing wording unchanged.
  const photoCount = designKinds.filter((k) => k === 'photo').length;
  const mode: Mode =
    photoCount === 0 ? 'sketch' : photoCount === designKinds.length ? 'photo' : 'mixed';
  const many = photoCount > 1;
  const photos = many ? 'the photos' : 'the photo';
  const photosOf = `${photos} of the product`;
  /** The verb agreeing with the photos: "show" or "shows". */
  const agree = (verb: string) => (many ? verb : `${verb}s`);
  const photosShow = `${photos} ${agree('show')}`;
  const shows =
    mode === 'sketch'
      ? 'the sketch draws'
      : mode === 'photo'
        ? photosShow
        : `the sketch draws or ${photosShow}`;
  const designList =
    mode === 'sketch' ? 'the sketch' : mode === 'photo' ? photos : `the sketch, ${photos}`;
  const madeFrom =
    mode === 'sketch'
      ? "the designer's sketch"
      : mode === 'photo'
        ? photosOf
        : `the designer's sketch and ${photosOf}`;
  const takenIn = `not tinted by the light ${many ? 'they were' : 'it was'} taken in`;
  // Where the asymmetry rule of a profile looks: the render when one is attached, else the sketch.
  const source = renderOnly
    ? 'the attached photograph'
    : withRender
      ? 'the attached front photograph'
      : 'the sketch';
  // With a sample, the render shows the material: the written material and colour would contradict it.
  const materialInWords = !(renderOnly && swatch);

  // Each image's rank is the count of the images before it: the sketch images, then the
  // sample, then the front render, then the back render.
  const sketches = renderOnly ? 0 : Math.max(1, sketchImages);
  // At least one sketch image is a design reference.
  const extras = Math.min(Math.max(0, materialReferences), sketches - 1);
  const sampleOrdinal = ORDINALS[sketches];
  const frontOrdinal = ORDINALS[sketches + (swatch ? 1 : 0)];
  const before = renderOnly ? 1 : sketches + (swatch ? 1 : 0) + (withRender ? 1 : 0);
  const backOrdinal = ORDINALS[before];
  const backSentence = backRender
    ? `The ${backOrdinal} is a photograph of the same finished product seen from directly behind. This view joins the two: the front edge as the front photograph shows it, the back edge as the back photograph shows it.`
    : undefined;
  /** The opening's first sentences with photos among the design references: which image is which. */
  function photoOpening(): string {
    const about = '(the product itself, a prototype or a reference for it)';
    if (mode === 'photo' && extras === 0) {
      return sketches > 1
        ? `The first ${COUNTS[sketches - 1]} attached images are photos of one ${product} ${about}, each showing the same object.`
        : `${swatch || withRender ? 'The first attached image' : 'The attached image'} is a photo of ${article(product)} ${product} ${about}.`;
    }
    const at = (kind: DesignKind) => designKinds.flatMap((k, i) => (k === kind ? [i] : []));
    const the = (ranks: number[]) => capital(listed(ranks.map((i) => `the ${ORDINALS[i]}`)));
    const drawn = at('sketch');
    const shot = at('photo');
    const extra = Array.from({ length: extras }, (_, i) => sketches - extras + i);
    // One sentence per kind, in the order their first image is attached.
    const groups: [number[], string][] = [
      [
        drawn,
        drawn.length > 1
          ? "are the designer's drawings of it; together they are the sketch"
          : "is the designer's sketch of it",
      ],
      [shot, shot.length > 1 ? `are photos of it ${about}` : `is a photo of it ${about}`],
      [
        extra,
        extra.length > 1
          ? `are samples of other materials of the ${product}, not views of it`
          : `is a sample of another material of the ${product}, not a view of it`,
      ],
    ];
    return [
      `The first ${COUNTS[sketches - 1]} attached images show one ${product}.`,
      ...groups
        .filter(([ranks]) => ranks.length > 0)
        .sort(([a], [b]) => a[0] - b[0])
        .map(([ranks, text]) => `${the(ranks)} ${text}.`),
    ].join(' ');
  }

  const opening = renderOnly
    ? [
        `${backRender ? 'The first attached image' : 'The attached image'} is a product photograph of the finished ${product} seen from the front, made from ${madeFrom}.`,
        backSentence,
        `Make a product photograph of the same ${product} from one camera angle: ${camera}.`,
      ]
        .filter(Boolean)
        .join(' ')
    : [
        mode !== 'sketch'
          ? photoOpening()
          : sketches > 1
            ? extras > 0
              ? `The first ${COUNTS[sketches - 1]} attached images are the designer's images of one ${product}; together they are the sketch. Of these, ${listed(ORDINALS.slice(sketches - extras, sketches).map((o) => `the ${o}`))} ${extras > 1 ? `are samples of other materials of the ${product}, not views of it` : `is a sample of another material of the ${product}, not a view of it`}.`
              : `The first ${COUNTS[sketches - 1]} attached images are the designer's images of one ${product}, each showing the same object; together they are the sketch.`
            : `${swatch || withRender ? 'The first attached image' : 'The attached image'} is a designer's sketch of ${article(product)} ${product}.`,
        swatch ? `The ${sampleOrdinal} is a sample of its material.` : undefined,
        withRender
          ? `The ${frontOrdinal} is a photograph of the finished product made from ${mode === 'sketch' ? 'this same sketch' : mode === 'mixed' ? 'these same images' : many ? 'these same photos' : 'this same photo'}, seen from the front, straight on.`
          : undefined,
        backSentence,
        mode === 'photo'
          ? `Make a single clean studio product photograph of the same ${product} from one camera angle: ${camera}.`
          : mode === 'mixed'
            ? `Turn the sketch and ${photos} into a single product photograph of the finished ${product} from one camera angle: ${camera}.`
            : `Turn ${sketches > 1 ? 'the sketch' : 'it'} into a single product photograph of the finished ${product} from one camera angle: ${camera}.`,
      ]
        .filter(Boolean)
        .join(' ');

  const lines = [
    opening,
    '',
    'INPUTS',
    `- Product: ${product}`,
    material && materialInWords ? `- Material: ${material}` : undefined,
    color && materialInWords ? `- Colour: ${color}` : undefined,
    dimensions ? `- Dimensions: ${dimensions}` : undefined,
    swatch && !renderOnly
      ? `- Material sample: the ${sampleOrdinal} attached image, a sample of the actual material`
      : undefined,
    notes ? `- Designer notes: ${notes}` : undefined,
    spec.parts?.length ? `- Parts ${shows}:` : undefined,
    ...(spec.parts ?? []).map(
      (p) =>
        `  - ${p.name}${p.description ? `: ${p.description}` : ''}${p.location ? `, ${p.location}` : ''}`,
    ),
    spec.details?.length ? `- Details ${shows} (keep each one, where it is):` : undefined,
    ...(spec.details ?? []).map(
      (d) => `  - ${d.description}: ${d.location ? `${d.location}, ` : ''}${d.view} view`,
    ),
    // The lists name construction and placed details; a list without the print reads as a
    // product without one.
    spec.parts?.length || spec.details?.length
      ? `  Every print, logo, graphic or text ${shows} stays, exactly where it is${mode === 'sketch' ? ' drawn' : ''}, listed or not.`
      : undefined,
    ...(spec.assumptions?.length
      ? [
          '',
          'ASSUMPTIONS (decided where the inputs left this open; follow them)',
          ...spec.assumptions.map((a) => `- ${a}`),
        ]
      : []),
    '',
    'WHICH SOURCE DECIDES WHAT',
    ...(renderOnly
      ? [RENDER_DECIDES, `${NOT_SHOWN_BY_RENDER} ${BACK_NOT_MIRROR}`]
      : [
          swatch
            ? `The material sample decides the colour, the material, the finish and the pattern of the main surface; the written inputs name them. When ${designList}, a written colour or a written material disagrees with the sample, follow the sample.`
            : mode === 'sketch'
              ? 'The written inputs decide the material, the finish and the colour. When the sketch disagrees, follow the written inputs.'
              : `${capital(photosOf)} ${agree('decide')} the colour, the material and the finish, except where the written inputs name them: when ${photos} and a written colour or material disagree, follow the written inputs.`,
          mode === 'photo'
            ? `${many ? 'They also decide' : 'It also decides'} the shape and the construction: the silhouette, the proportions between parts, every part and how it joins the rest, openings, closures, seams and edges, and every print, graphic, logo or text on the ${product}: where it sits and how it looks.`
            : `The sketch decides the shape and the construction: the silhouette, the proportions between parts, every part and how it joins the rest, openings, closures, seams and edges, and every print, graphic, logo or text drawn on the ${product}: where it sits and how it looks.`,
          mode === 'mixed'
            ? `${capital(photosOf)} ${agree('show')} its real look: the material, the finish, the thickness of its parts and how they sit. Where ${photos} and the sketch differ in shape or construction, follow the sketch.`
            : undefined,
          mode === 'sketch'
            ? 'Neither decides the camera, the lighting or the staging. Those follow the output rules below.'
            : `No input decides the camera, the lighting, the background or the staging, not even ${many ? "the photos'" : "the photo's"} own. Those follow the output rules below.`,
        ]),
    ...(renderOnly
      ? []
      : [
          '',
          mode === 'sketch'
            ? 'HOW TO READ THE SKETCH'
            : `HOW TO READ ${mode === 'mixed' ? 'THE SKETCH AND ' : ''}${photos.toUpperCase()}`,
          // A photo shows the real object: the drawing rules (exaggeration, colour markers) do not apply.
          mode === 'photo'
            ? `${capital(photosOf)} ${agree('show')} a real object: keep its shape, its proportions and its construction as photographed${dimensions ? ', at the dimensions given' : ''}, and show it as the finished product, clean and new.`
            : `The sketch is a design drawing, not a photograph: it may exaggerate, simplify or flatten the object, and its lines show no material weight. Keep the construction and give it real-world proportions${dimensions ? ', at the dimensions given' : ''}.`,
          mode === 'photo' ? undefined : DESIGN_KEPT,
          designViews(spec.views, mode, photos, many),
          mode === 'photo'
            ? `Render only the ${product}. Leave out ${PHOTO_LEAVE_OUT}.`
            : `Render only the ${product}. Leave out everything drawn around it that is not part of it: ${LEAVE_OUT}.`,
          mode === 'mixed' ? `In ${photos}, leave out ${PHOTO_LEAVE_OUT}.` : undefined,
          ...(spec.ignored?.length
            ? [
                `${mode === 'sketch' ? 'On this sketch' : mode === 'mixed' ? 'In these images' : many ? 'In these photos' : 'In this photo'}, leave out: ${spec.ignored.join('; ')}.`,
              ]
            : []),
          mode === 'photo'
            ? swatch
              ? `Make the ${product} from the sample material: its colour, finish and pattern cover the surfaces made of the main material. ${SAMPLE_SCALE} The sample is a flat piece of material, not part of the product, and does not appear in the image.`
              : color
                ? `The colour of the ${product} is ${color}.`
                : `Keep the colours ${photosShow} as the true colours of the finished product, ${takenIn}.`
            : swatch
              ? `Sketch colours are approximate markers. Make the ${product} from the sample material: its colour, finish and pattern cover the surfaces drawn in the main material. ${SAMPLE_SCALE} The sample is a flat piece of material, not part of the product, and does not appear in the image.`
              : color
                ? `Sketch colours are approximate markers. The colour of the ${product} is ${color}.`
                : mode === 'mixed'
                  ? `Sketch colours are approximate markers. Take the colours from ${photos}, as the true colours of the finished product, ${takenIn}.`
                  : 'Take the colours from the sketch, but render them as real finished materials, evenly coloured, with no pencil, marker or watercolour texture.',
          mode === 'photo'
            ? `Artwork on the product (a placed print, a graphic, a gradient, a logo, text, a motif on some parts only) stays exactly where ${photosShow} it, only on the parts it covers, with its own colours, density and transparency, on top of the base material.`
            : SKETCH_ARTWORK,
        ]),
    '',
    'MATERIALS',
    renderOnly && !materialInWords
      ? 'Render every part in the material the photograph shows, with the same finish, sheen and texture.'
      : swatch && !renderOnly
        ? SAMPLE_MATERIAL
        : material
          ? `Render each part in its real material: ${material}, with the surface, finish and weight that material has.`
          : renderOnly
            ? 'Render every part in the real material the photograph shows.'
            : mode === 'sketch'
              ? 'Render every part in the real material the sketch suggests.'
              : `Render every part in the real material ${photosShow}.`,
    MATERIAL_GUIDANCE,
    renderOnly
      ? 'Prints, graphics and logos sit exactly where the photograph shows them, at a realistic scale for the product.'
      : mode === 'photo'
        ? `Prints, graphics and logos sit exactly where ${photosShow} them, at a realistic scale for the product.`
        : 'Prints, graphics and logos sit exactly where the sketch places them, at a realistic scale for the product.',
    '',
    'OUTPUT',
    `One photograph of the ${product} from a single camera angle: ${camera}. The ${product} is shown alone, ${staging(shows)}, centred, whole and fully visible, filling most of the frame.`,
    view === 'left' || view === 'right' ? profileSides(view, source) : undefined,
    `The camera is level with the middle of the ${product}, at the same distance from it for every view. The front, the back, the left side and the right side views show the same ${product}, which does not move; only the camera does.`,
    'Seamless white background, soft even studio light that does not change with the angle.',
    'Photorealistic, e-commerce quality, true-to-life colour, a clean image with no caption, label, watermark or annotation added around the product.',
    '',
    'MUST MATCH',
    renderOnly
      ? 'Shape, proportions, parts, details, material and colour must match the attached photograph: same product, only the camera angle changes.'
      : `Shape, proportions, every part, one-sided elements and ${swatch ? 'the colour, material and pattern of the sample' : 'colour'} must match the inputs${withRender ? ', and this view must agree with the attached front photograph: same product, same material, same proportions, same details, only the camera angle changes' : ''}. Details should match where this angle shows them.`,
    ...(corrections?.length
      ? [
          '',
          'CORRECTIONS FROM THE PREVIOUS ATTEMPT',
          'A reviewer rejected the previous image of this view. Fix what it found, and keep everything else as the inputs say:',
          ...corrections.slice(0, MAX_CORRECTIONS).map((c) => `- ${c}.`),
        ]
      : []),
    ...(requests?.length
      ? [
          '',
          'REQUESTS FROM THE DESIGN TEAM',
          `The design team reviewed an earlier image of this view and asked for these changes. They overrule the inputs: apply each one even where ${designList}, the material sample or the attached photographs show otherwise, and keep everything else as the inputs say:`,
          ...requests.slice(-MAX_REQUESTS).map((r) => `- ${sentence(r.trim())}`),
        ]
      : []),
  ];

  return lines.filter((l) => l !== undefined).join('\n');
}
