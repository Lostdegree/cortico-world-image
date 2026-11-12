import { ImageWorld } from '../src/world.js';
import { samplePng } from '../src/png.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOverrides, txt2ImgWorkflow, img2ImgWorkflow, unetTxt2ImgWorkflow, comfyDraw, comfyEdit } from '../src/comfyui.js';

test('single-call boundaries and explicit zero/empty values', () => {
  const opts = validateOverrides({ steps: 1, cfg: 0, seed: 0, denoise: 0, negative: '', size: '800x600' });
  assert.deepEqual(opts, { steps: 1, cfg: 0, seed: 0, denoise: 0, negative: '', size: '800x600' });
  assert.deepEqual(validateOverrides({}), {});
  for (const value of [{ steps: 0 }, { steps: 1.5 }, { cfg: 31 }, { seed: -1 }, { seed: 2 ** 53 }, { denoise: 1.1 }, { negative: null }, { size: 'nonsense' }]) {
    assert.throws(() => validateOverrides(value));
  }
  assert.equal(validateOverrides({ seed: Number.MAX_SAFE_INTEGER }).seed, Number.MAX_SAFE_INTEGER);
});

test('built-in workflows apply all values and retain defaults', () => {
  const opts = { steps: 4, cfg: 0, seed: 0, denoise: 0, negative: '', size: '800x600', image: 'ref.png' };
  const draw = txt2ImgWorkflow(opts), edit = img2ImgWorkflow(opts), unet = unetTxt2ImgWorkflow(opts);
  for (const graph of [draw, edit]) {
    assert.deepEqual([graph[3].inputs.steps, graph[3].inputs.cfg, graph[3].inputs.seed, graph[3].inputs.denoise], [4, 0, 0, 0]);
    assert.equal(graph[7].inputs.text, '');
  }
  assert.equal(unet[8].inputs.denoise, 0);
  assert.equal(draw[5].inputs.width, 800);
  assert.equal(draw[5].inputs.height, 600);
  assert.equal(txt2ImgWorkflow()[3].inputs.denoise, 1);
  assert.equal(img2ImgWorkflow()[3].inputs.denoise, 0.6);
});

test('world sends overrides for draw and edit, rejects unsupported cloud', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'image-overrides-'));
  const png = samplePng(64, 64);
  const image = join(dir, 'ref.png');
  writeFileSync(image, png);
  const requests = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/upload/image') return Response.json({ name: 'ref.png' });
    if (path === '/prompt') { requests.push(JSON.parse(options.body).prompt); return Response.json({ prompt_id: 'p' }); }
    if (path === '/history/p') return Response.json({ p: { outputs: { 9: { images: [{ filename: 'out.png' }] } } } });
    if (path === '/view') return new Response(png, { headers: { 'content-type': 'image/png' } });
    throw new Error(`unexpected request ${url}`);
  };
  try {
    const models = [{ name: 'local', preset: 'comfyui', baseUrl: 'http://local', ckpt: 'x', steps: 20, cfg: 7, negative: 'default', denoise: 0.6 }];
    const world = new ImageWorld({ dataDir: dir, cfg: { models, probeBeforeDraw: false, idleUnloadMinutes: 0 } });
    const tool = (name) => world.tools().find((item) => item.name === name).handler;
    const params = { prompt: 'test', steps: 3, cfg: 0, seed: 0, negative: '', denoise: 0, size: '800x600' };
    assert.equal((await tool('image_draw')(params)).failed, undefined);
    assert.equal((await tool('image_edit')({ ...params, image })).failed, undefined);
    for (const graph of requests) {
      assert.deepEqual([graph[3].inputs.steps, graph[3].inputs.cfg, graph[3].inputs.seed, graph[3].inputs.denoise], [3, 0, 0, 0]);
      assert.equal(graph[7].inputs.text, '');
    }
    const invalid = await tool('image_draw')({ prompt: 'test', steps: 151 });
    assert.equal(invalid.failed, true);
    assert.equal(requests.length, 2);
    const cloud = new ImageWorld({ dataDir: dir, cfg: { models: [{ name: 'cloud', preset: 'openai', baseUrl: 'http://cloud', model: 'm' }] }, secret: () => 'key' });
    const result = await cloud.tools().find((item) => item.name === 'image_draw').handler({ prompt: 'test', seed: 0 });
    assert.equal(result.failed, true);
    assert.match(result.text, /不支持参数.*seed/);
  } finally {
    globalThis.fetch = oldFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('metadata and disconnected placeholders cannot satisfy overrides', async () => {
  const workflow = {
    1: { class_type: 'SaveImage', inputs: { images: ['2', 0] }, _meta: { title: '{{steps}}' } },
    2: { class_type: 'Example', inputs: { value: 1 } },
    3: { class_type: 'Example', inputs: { steps: '{{steps}}' } },
  };
  await assert.rejects(comfyDraw({ workflow, overrides: { steps: 4 } }), /steps.*占位符/);
  workflow[2].inputs.steps = '{{steps}}';
  await assert.rejects(comfyDraw({ workflow, overrides: { steps: 4 } }), /没有配置 ComfyUI 地址/);
});

test('custom workflow rejects unrepresented overrides before network or upload', async () => {
  const workflow = { 1: { class_type: 'Example', inputs: { text: '{{prompt}}', width: '{{width}}' } } };
  await assert.rejects(comfyDraw({ workflow, overrides: { steps: 4 } }), /steps.*占位符/);
  await assert.rejects(comfyDraw({ workflow, overrides: { size: '800x600' } }), /size.*占位符/);
  await assert.rejects(comfyEdit({ workflow, overrides: { negative: '' } }), /negative.*占位符/);
});
