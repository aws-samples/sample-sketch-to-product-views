import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProductSpec } from '@sketch-to-product-views/contracts';
import { VIEW_CAMERA, buildPrompt } from '../src/generate/prompt.js';

type Fields = Partial<
  Record<'productType' | 'materialDescription' | 'colorDescription' | 'dimensions', string>
>;

/** A spec whose every field was supplied. */
const spec = (fields: Fields): ProductSpec => ({
  model: 'MODEL-10',
  ...Object.fromEntries(
    Object.entries(fields).map(([k, value]) => [k, { value, provenance: 'supplied' as const }]),
  ),
});

const chair = spec({
  productType: 'lounge chair',
  materialDescription: 'oiled oak, wool boucle seat',
  colorDescription: 'natural / ecru',
  dimensions: 'w 78 x d 82 x h 74 cm',
});

/** Words that would make the template garment-specific. */
const GARMENT_WORDS =
  /garment|fabric|sleeve|neckline|mannequin that holds|\bhem\b|collar|swatch|chest height/i;

test('the front is one studio photograph from the sketch, one of the four views', () => {
  const prompt = buildPrompt(chair);
  assert.match(
    prompt,
    /^The attached image is a designer's sketch of a lounge chair\. Turn it into a single product photograph of the finished lounge chair from one camera angle: the front view, seen straight on\./,
  );
  assert.match(prompt, /OUTPUT\nOne photograph of the lounge chair from a single camera angle/);
  assert.match(
    prompt,
    /The front, the back, the left side and the right side views show the same lounge chair, which does not move; only the camera does\./,
  );
  assert.match(prompt, /Seamless white background, soft even studio light/);
  assert.match(prompt, /The back is not a mirror of the front/);
  assert.match(
    prompt,
    /must match the inputs\. Details should match where this angle shows them\.$/,
  );
});

test('the template is object-neutral for every view and input', () => {
  for (const s of [chair, spec({}), spec({ productType: 'floor cushion' })]) {
    for (const options of [
      {},
      { swatch: true },
      { view: 'back' as const, frontRender: 'alone' as const },
      { view: 'left' as const, frontRender: 'with_sketch' as const, backRender: true },
      { view: 'right' as const, frontRender: 'alone' as const, swatch: true, backRender: true },
    ]) {
      assert.doesNotMatch(buildPrompt(s, options), GARMENT_WORDS);
    }
  }
});

test('the object is staged alone, whole, with no person or prop unless the sketch draws one', () => {
  const prompt = buildPrompt(chair);
  assert.match(
    prompt,
    /The lounge chair is shown alone, standing or resting as it does in use, with no person, body, mannequin, hands, stand or prop unless the sketch draws one as part of the product; a soft object keeps the full shape it has in use, held by nothing visible, centred, whole and fully visible/,
  );
});

test('every supplied field reaches the prompt', () => {
  const prompt = buildPrompt(chair);
  assert.match(prompt, /- Product: lounge chair\n/);
  assert.match(prompt, /- Material: oiled oak, wool boucle seat\n/);
  assert.match(prompt, /- Colour: natural \/ ecru\n/);
  assert.match(prompt, /- Dimensions: w 78 x d 82 x h 74 cm\n/);
  assert.match(prompt, /The colour of the lounge chair is natural \/ ecru/);
  assert.match(prompt, /give it real-world proportions, at the dimensions given\./);
  assert.match(
    prompt,
    /Render each part in its real material: oiled oak, wool boucle seat, with the surface, finish and weight that material has\./,
  );
});

test('an absent field is left out, never invented', () => {
  const prompt = buildPrompt(spec({}));
  assert.match(prompt, /designer's sketch of a product\./);
  assert.match(prompt, /- Product: product\n/);
  assert.doesNotMatch(prompt, /- Material:|- Colour:|- Dimensions:|undefined|at the dimensions/);
  assert.match(prompt, /Take the colours from the sketch, but render them as real finished/);
  assert.match(prompt, /the real material the sketch suggests/);
});

test('the article follows the product type', () => {
  assert.match(buildPrompt(spec({ productType: 'espresso machine' })), /sketch of an espresso/);
  assert.match(buildPrompt(spec({ productType: 'kettle' })), /sketch of a kettle/);
});

test('the same spec always gives the same prompt, since it feeds a durable step', () => {
  assert.equal(buildPrompt(chair), buildPrompt(chair));
  assert.equal(
    buildPrompt(chair, { view: 'left', frontRender: 'alone' }),
    buildPrompt(chair, { view: 'left', frontRender: 'alone' }),
  );
});

test('materials get one generic guidance, never a table of names', () => {
  const prompt = buildPrompt(spec({ productType: 'kettle', materialDescription: 'zz99 mystery' }));
  assert.match(prompt, /MATERIALS\nRender each part in its real material: zz99 mystery/);
  assert.match(prompt, /Rigid parts \(wood, metal, plastic, glass, ceramic, stone\)/);
  assert.match(prompt, /Soft parts \(textile, leather, foam, rubber\)/);
});

test('sizes and one-sided elements are kept as drawn, with no rule per product name', () => {
  const prompt = buildPrompt(spec({ productType: 'asymmetric bag' }));
  assert.match(prompt, /a part drawn short stays short beside a long one/);
  assert.match(prompt, /stays on that side and only there/);
  assert.match(prompt, /Shape, proportions, every part, one-sided elements and colour must match/);
  assert.doesNotMatch(
    buildPrompt(chair, { view: 'back', frontRender: 'alone' }),
    /a part drawn short/,
  );
});

test('artwork drawn on the product is design, not a colour marker, whatever decides the material', () => {
  for (const options of [{}, { swatch: true }]) {
    const prompt = buildPrompt(chair, options);
    assert.match(prompt, /Sketch colours are approximate markers/);
    assert.match(
      prompt,
      /Artwork drawn on the product .* is part of the design, not a colour marker: .* with its own colours, density and transparency/,
    );
  }
  assert.match(buildPrompt(spec({})), /no pencil, marker or watercolour texture\.\nArtwork drawn/);
});

test('the parts the sketch draws are listed, and the lists never hide a print', () => {
  const prompt = buildPrompt({
    ...chair,
    parts: [
      { name: 'seat', description: 'deep cushion', location: 'middle' },
      { name: 'legs', description: '', location: '' },
    ],
  });
  assert.match(prompt, /- Parts the sketch draws:\n {2}- seat: deep cushion, middle\n {2}- legs\n/);
  assert.match(prompt, /Every print, logo, graphic or text the sketch draws stays/);
  assert.doesNotMatch(buildPrompt(chair), /Parts the sketch draws|Every print, logo/);
});

test('the marks the analyser set aside are left out, after the generic list', () => {
  const prompt = buildPrompt({ ...chair, ignored: ['a handwritten note', 'a colour chip'] });
  assert.match(
    prompt,
    /Render only the lounge chair\. Leave out everything drawn around it that is not part of it: notes, measurements, arrows, codes, signatures, colour chips, other objects, and any figure, hand or body drawn to show it in use\.\nOn this sketch, leave out: a handwritten note; a colour chip\./,
  );
  assert.doesNotMatch(buildPrompt(chair), /On this sketch/);
});

test('designer notes reach the prompt only when given', () => {
  const s = spec({ productType: 'desk lamp' });
  assert.match(buildPrompt(s, { notes: 'The arm folds.' }), /- Designer notes: The arm folds/);
  assert.doesNotMatch(buildPrompt(s), /Designer notes/);
});

test('a spec without views takes the sketch as the front, with the back possibly beside it', () => {
  assert.match(
    buildPrompt(chair),
    /The sketch may show the front alone, or the front and the back side by side\. Use what is drawn for the parts this angle shows\./,
  );
});

test('the views the sketch draws are named, and what is not drawn follows the construction', () => {
  const prompt = buildPrompt({ ...chair, views: ['back'] });
  assert.match(prompt, /The sketch shows these views: back\. Use what is drawn/);
  assert.match(prompt, /What is not drawn \(the other views, the depth of the object\)/);
  assert.doesNotMatch(prompt, /may show the front alone/);
  assert.match(
    buildPrompt({ ...chair, views: [] }),
    /The sketch shows these views: none of the front, back or side\./,
  );
});

test('every detail the sketch draws is listed for the image model, with where it is', () => {
  const prompt = buildPrompt({
    ...chair,
    details: [
      { description: 'brass plaque', location: 'left armrest', view: 'front' },
      { description: 'embossed logo', location: '', view: 'back' },
    ],
  });
  assert.match(
    prompt,
    /- Details the sketch draws \(keep each one, where it is\):\n {2}- brass plaque: left armrest, front view\n {2}- embossed logo: back view\n/,
  );
  assert.doesNotMatch(buildPrompt(chair), /Details the sketch draws/);
});

test('the assumptions are listed for the image model, and omitted when there are none', () => {
  const prompt = buildPrompt({ ...chair, assumptions: ['The frame is oak and the seat ecru.'] });
  assert.match(prompt, /ASSUMPTIONS[^\n]*\n- The frame is oak and the seat ecru\./);
  assert.doesNotMatch(buildPrompt(chair), /ASSUMPTIONS/);
});

test('with a material sample, the sample decides colour, material and pattern over the words', () => {
  const prompt = buildPrompt(
    {
      model: 'P1',
      productType: { value: 'running shoe', provenance: 'supplied' },
      colorDescription: { value: 'cobalt / white sole', provenance: 'supplied' },
    },
    { swatch: true },
  );
  assert.match(
    prompt,
    /^The first attached image is a designer's sketch of a running shoe\. The second is a sample of its material\. Turn it into/,
  );
  assert.match(
    prompt,
    /- Colour: cobalt \/ white sole\n- Material sample: the second attached image/,
  );
  assert.match(
    prompt,
    /The material sample decides the colour, the material, the finish and the pattern/,
  );
  assert.match(prompt, /When the sketch, a written colour or a written material disagrees/);
  assert.match(prompt, /Make the running shoe from the sample material/);
  assert.match(prompt, /keeps the size it has in the sample/);
  assert.doesNotMatch(prompt, /The colour of the running shoe is cobalt/);
  assert.match(prompt, /the colour, material and pattern of the sample must match the inputs\./);
});

test('with a material sample, the material comes from the sample, not from the written name', () => {
  const prompt = buildPrompt(chair, { swatch: true });
  assert.match(prompt, /- Material: oiled oak, wool boucle seat\n/);
  assert.match(prompt, /Render the main material as the sample shows it/);
  assert.doesNotMatch(prompt, /Render each part in its real material/);
});

test('a back the sketch does not draw is made from the front render alone', () => {
  const prompt = buildPrompt(chair, { view: 'back', frontRender: 'alone' });
  assert.match(
    prompt,
    /^The attached image is a product photograph of the finished lounge chair seen from the front, made from the designer's sketch\. Make a product photograph of the same lounge chair from one camera angle: the back view, seen from directly behind\./,
  );
  assert.match(prompt, /WHICH SOURCE DECIDES WHAT\nThe attached photograph decides everything/);
  assert.match(prompt, /What the photograph does not show \(the back, the sides/);
  assert.match(prompt, /The back is not a mirror of the front/);
  assert.doesNotMatch(prompt, /HOW TO READ THE SKETCH|designer's sketch of a|- Material sample:/);
  // No sample: the written material and colour still apply, the render was made from them.
  assert.match(prompt, /- Material: oiled oak, wool boucle seat\n- Colour: natural \/ ecru\n/);
  assert.match(prompt, /Prints, graphics and logos sit exactly where the photograph shows them/);
  assert.match(
    prompt,
    /MUST MATCH\nShape, proportions, parts, details, material and colour must match the attached photograph: same product, only the camera angle changes\./,
  );
});

test('with a material sample, a render-only call drops the written material and colour', () => {
  const prompt = buildPrompt(chair, { view: 'back', frontRender: 'alone', swatch: true });
  assert.doesNotMatch(prompt, /- Material:|- Colour:|- Material sample:|material sample/);
  assert.match(prompt, /- Product: lounge chair\n- Dimensions: w 78 x d 82 x h 74 cm\n/);
  assert.match(
    prompt,
    /Render every part in the material the photograph shows, with the same finish, sheen and texture\./,
  );
});

test('a profile the sketch draws gets the sketch, the sample and the front render, and must agree with the render', () => {
  const prompt = buildPrompt(
    { ...chair, views: ['front', 'side'] },
    { view: 'left', swatch: true, frontRender: 'with_sketch' },
  );
  assert.match(
    prompt,
    /^The first attached image is a designer's sketch of a lounge chair\. The second is a sample of its material\. The third is a photograph of the finished product made from this same sketch, seen from the front, straight on\. Turn it into a single product photograph of the finished lounge chair from one camera angle: the left side view/,
  );
  assert.match(prompt, /The sketch shows these views: front, side\./);
  assert.match(prompt, /HOW TO READ THE SKETCH/);
  assert.match(
    prompt,
    /must match the inputs, and this view must agree with the attached front photograph: same product, same material, same proportions, same details, only the camera angle changes\./,
  );
  assert.match(
    prompt,
    /In the attached front photograph, the object's left side is the right half/,
  );
  // Without a sample the render is the second image.
  assert.match(
    buildPrompt(
      { ...chair, views: ['front', 'side'] },
      { view: 'left', frontRender: 'with_sketch' },
    ),
    /The second is a photograph of the finished product/,
  );
});

test('the two profiles state opposite camera positions and are told they are mirror opposites', () => {
  const left = buildPrompt(chair, { view: 'left', frontRender: 'alone' });
  const right = buildPrompt(chair, { view: 'right', frontRender: 'alone' });
  assert.match(
    left,
    /the camera stands at the object's left, so the front of the object faces the left edge of the image and the back faces the right edge/,
  );
  assert.match(
    right,
    /the camera stands at the object's right, so the front of the object faces the right edge of the image and the back faces the left edge/,
  );
  for (const prompt of [left, right]) {
    assert.match(prompt, /The left and right side views are mirror opposites, not copies\./);
  }
  assert.match(
    left,
    /In the attached photograph, the object's left side is the right half of the picture and its right side is the left half\./,
  );
  assert.match(
    right,
    /In the attached photograph, the object's right side is the left half of the picture and its left side is the right half\./,
  );
  assert.doesNotMatch(
    buildPrompt(chair, { view: 'back', frontRender: 'alone' }),
    /mirror opposites/,
  );
  // The camera line is the one the critic is told, so the two cannot drift.
  assert.match(left, new RegExp(VIEW_CAMERA.left.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a view rejected once is told what to fix, four findings at most', () => {
  const prompt = buildPrompt(spec({ productType: 'kettle' }), {
    view: 'left',
    frontRender: 'alone',
    corrections: ['a', 'b', 'c', 'd', 'e'],
  });
  assert.match(
    prompt,
    /CORRECTIONS FROM THE PREVIOUS ATTEMPT\n[^\n]*\n- a\.\n- b\.\n- c\.\n- d\.$/,
  );
  assert.doesNotMatch(buildPrompt(spec({ productType: 'kettle' })), /CORRECTIONS/);
});

test('several uploaded images are the sketch together, and the sample and renders are numbered after them', () => {
  const prompt = buildPrompt(
    { ...chair, views: ['front', 'side'] },
    { view: 'left', swatch: true, frontRender: 'with_sketch', backRender: true, sketchImages: 3 },
  );
  assert.match(
    prompt,
    /^The first three attached images are the designer's images of one lounge chair, each showing the same object; together they are the sketch\. The fourth is a sample of its material\. The fifth is a photograph of the finished product made from this same sketch, seen from the front, straight on\. The sixth is a photograph of the same finished product seen from directly behind\./,
  );
  assert.match(prompt, /Turn the sketch into a single product photograph/);
  assert.match(
    prompt,
    /- Material sample: the fourth attached image, a sample of the actual material/,
  );
  assert.equal(buildPrompt(chair, { sketchImages: 1 }), buildPrompt(chair));
});

test('the design team requests come last, overrule the inputs, and keep the most recent six', () => {
  const prompt = buildPrompt(spec({ productType: 'kettle' }), {
    corrections: ['the spout is missing'],
    requests: ['r1', 'r2', 'r3.', 'r4', 'r5', 'r6', ' r7 '],
  });
  assert.match(
    prompt,
    /CORRECTIONS FROM THE PREVIOUS ATTEMPT[\s\S]*REQUESTS FROM THE DESIGN TEAM\n[^\n]*overrule the inputs[^\n]*\n- r2\.\n- r3\.\n- r4\.\n- r5\.\n- r6\.\n- r7\.$/,
  );
  assert.doesNotMatch(buildPrompt(spec({ productType: 'kettle' })), /REQUESTS FROM/);
});

test('sketches only keep the drawing wording, whether or not their kinds are given', () => {
  const options = { swatch: true, sketchImages: 2 };
  assert.equal(
    buildPrompt(chair, { ...options, designKinds: ['sketch', 'sketch'] }),
    buildPrompt(chair, options),
  );
});

test('photos only are read as the real product, without the drawing rules', () => {
  const prompt = buildPrompt({ ...chair, views: ['front'] }, { designKinds: ['photo'] });
  assert.match(
    prompt,
    /^The attached image is a photo of a lounge chair \(the product itself, a prototype or a reference for it\)\. Make a single clean studio product photograph of the same lounge chair from one camera angle: the front view, seen straight on\./,
  );
  assert.match(
    prompt,
    /\nThe photo of the product decides the colour, the material and the finish/,
  );
  assert.match(prompt, /\nIt also decides the shape and the construction/);
  assert.match(prompt, /\nHOW TO READ THE PHOTO\n/);
  assert.match(
    prompt,
    /Leave out anything that is not part of the product \(people, hands, other objects, background\)\./,
  );
  assert.doesNotMatch(prompt, /sketch|exaggerate|approximate markers|drawn short/i);

  const two = buildPrompt(spec({ productType: 'kettle' }), {
    sketchImages: 2,
    designKinds: ['photo', 'photo'],
  });
  assert.match(
    two,
    /^The first two attached images are photos of one kettle [^\n]*, each showing the same object\./,
  );
  assert.match(two, /Keep the colours the photos show as the true colours of the finished product/);
  assert.doesNotMatch(two, /sketch/i);
});

test('photos only, on the views made from the front render, still name the photos', () => {
  const back = buildPrompt(chair, { view: 'back', frontRender: 'alone', designKinds: ['photo'] });
  assert.match(back, /made from the photo of the product\./);
  assert.doesNotMatch(back, /sketch/i);
  const right = buildPrompt(
    { ...chair, views: ['front', 'side'] },
    {
      view: 'right',
      frontRender: 'with_sketch',
      backRender: true,
      swatch: true,
      designKinds: ['photo'],
    },
  );
  assert.match(
    right,
    /The third is a photograph of the finished product made from this same photo/,
  );
  assert.match(
    right,
    /The fourth is a photograph of the same finished product seen from directly behind/,
  );
  assert.doesNotMatch(right, /sketch/i);
});

test('mixed references: the sketch decides the construction, the photos the real look, each image named', () => {
  const prompt = buildPrompt(chair, {
    swatch: true,
    sketchImages: 4,
    materialReferences: 1,
    designKinds: ['photo', 'sketch', 'photo'],
  });
  assert.match(
    prompt,
    /^The first four attached images show one lounge chair\. The first and the third are photos of it \(the product itself, a prototype or a reference for it\)\. The second is the designer's sketch of it\. The fourth is a sample of another material of the lounge chair, not a view of it\. The fifth is a sample of its material\. Turn the sketch and the photos into a single product photograph/,
  );
  assert.match(prompt, /- Material sample: the fifth attached image/);
  assert.match(prompt, /\nThe sketch decides the shape and the construction/);
  assert.match(prompt, /\nThe photos of the product show its real look[^\n]*follow the sketch\./);
  assert.match(prompt, /\nHOW TO READ THE SKETCH AND THE PHOTOS\n/);
  assert.match(prompt, /Sketch colours are approximate markers/);
  assert.match(prompt, /\nIn the photos, leave out anything that is not part of the product/);
});
