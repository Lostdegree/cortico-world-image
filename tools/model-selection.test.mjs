import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChainEntries, runChain, entryState } from '../src/chain.js';
import { ImageWorld } from '../src/world.js';

const entries = parseChainEntries([
  {name:'local', preset:'comfyui', baseUrl:'http://127.0.0.1:8188', ckpt:'a'},
  {name:'local2', preset:'comfyui', baseUrl:'http://localhost:8188', ckpt:'b'},
  {name:'cloud', preset:'openai', baseUrl:'https://example.com', model:'c'},
]).entries;

test('named selection defaults to strict; fallback needs separate cross-endpoint permission', async () => {
  const calls = [];
  const runner = async e => { calls.push(e.name); if (e.name !== 'cloud') throw Error('failed'); return {}; };
  await assert.rejects(runChain(entries, runner, {only:'local'}));
  assert.deepEqual(calls.splice(0), ['local']);
  await assert.rejects(runChain(entries, runner, {only:'local', fallback:true}));
  assert.deepEqual(calls.splice(0), ['local','local2']);
  await runChain(entries, runner, {only:'local', fallback:true, allowCrossEndpoint:true});
  assert.deepEqual(calls, ['local','local2','cloud']);
});

test('unnamed selection preserves chain order; unknown name does not fall back', async () => {
  const calls = [];
  await runChain(entries, async e => {calls.push(e.name); if(e.name !== 'cloud') throw Error('failed'); return {};});
  assert.deepEqual(calls, ['local','local2','cloud']);
  await assert.rejects(runChain(entries, async () => ({}), {only:'missing', fallback:true, allowCrossEndpoint:true}), /没有叫/);
});

test('discovery includes disabled and incomplete entries without addresses or secret names', async () => {
  const world = new ImageWorld({cfg:{models:JSON.stringify([
    {name:'off', preset:'comfyui', baseUrl:'http://127.0.0.1:9999', ckpt:'a', enabled:false},
    {name:'no-key', preset:'openai', baseUrl:'https://secret.example', apiKeySecret:'PRIVATE_SECRET'},
    {name:'bad', preset:'comfyui', baseUrl:'http://localhost:8188'},
  ])}});
  const result = await world.tools().find(t => t.name === 'image_models').handler({});
  assert.equal(typeof result.text, 'string');
  assert.match(result.text, /off.*已停用/);
  assert.match(result.text, /no-key.*没有密钥/);
  assert.match(result.text, /bad.*没配 ckpt/);
  assert.doesNotMatch(result.text, /secret\.example|PRIVATE_SECRET|127\.0\.0\.1/);
  const draw = await world.tools().find(t => t.name === 'image_draw').handler({prompt:'x', model:'off'});
  assert.match(draw.text, /已停用/);
  assert.doesNotMatch(draw.text, /没有叫/);
});

test('exact entry names override aliases and ambiguous aliases fail before running', async () => {
  const list = parseChainEntries([
    { name:'first', model:'chosen', baseUrl:'https://example.com' },
    { name:'chosen', model:'shared', baseUrl:'https://example.com' },
    { name:'third', model:'shared', baseUrl:'https://example.com' },
  ]).entries;
  const calls = [];
  const runner = async entry => { calls.push(entry.name); return {}; };
  await runChain(list, runner, { only:'chosen' });
  assert.deepEqual(calls, ['chosen']);
  await assert.rejects(runChain(list, runner, { only:'shared', fallback:true, allowCrossEndpoint:true }), /匹配了多档/);
  assert.deepEqual(calls, ['chosen']);
});

test('generated duplicate names never collide with existing names', () => {
  const list = parseChainEntries(['a', 'a#3', 'a'].map(name => ({name, baseUrl:'https://example.com'})));
  assert.deepEqual(list.entries.map(entry => entry.name), ['a', 'a#3', 'a#4']);
  assert.equal(new Set(list.entries.map(entry => entry.name)).size, 3);
});

test('invalid preset is unusable rather than silently treated as openai', () => {
  const entry = parseChainEntries([{name:'bad',preset:'wrong',baseUrl:'https://example.com'}]).entries[0];
  assert.equal(entryState(entry, {apiKey:'x'}).ok, false);
});
