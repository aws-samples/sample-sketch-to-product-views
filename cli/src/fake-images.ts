import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';

/**
 * A stand-in for `POST /v1/images/edits`: answers with the first image it was sent, as a PNG at
 * the requested size. Lets `--fake-images` run every other stage for real without paying for
 * image generation. Returns the base URL to put in `OPENAI_BASE_URL`.
 */
export async function startFakeImages(): Promise<string> {
  const server = createServer(async (req, res) => {
    try {
      const request = new Request(`http://local${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req as unknown as BodyInit,
        duplex: 'half',
      } as RequestInit);
      const form = await request.formData();
      const image = (form.getAll('image[]')[0] ?? form.getAll('image')[0]) as File | undefined;
      if (!image) throw new Error('no image in the request');
      const [width, height] = String(form.get('size') ?? '1024x1536').split('x').map(Number);
      const png = await sharp(Buffer.from(await image.arrayBuffer()))
        .resize(width, height, { fit: 'contain', background: '#ffffff' })
        .png()
        .toBuffer();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: Date.now(), data: [{ b64_json: png.toString('base64') }] }));
    } catch (error) {
      // The detail goes to the local console, not into the response.
      console.error('[fake-images]', error);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid image request' } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
