import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevicePreferences } from '../electron/preferences.cjs';

test('device preferences commit, preserve concurrent patches and survive restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prefs = new DevicePreferences(directory);
  await Promise.all([prefs.save({ appearance: 'LIGHT' }), prefs.save({ reader: { mode: 'PAGED' } }), prefs.save({ reader: { fit: 'HEIGHT' } })]);
  assert.deepEqual(await new DevicePreferences(directory).get(), { appearance: 'LIGHT', reader: { mode: 'PAGED', fit: 'HEIGHT' } });
  assert.throws(() => prefs.save(JSON.parse('{"__proto__":{"polluted":true}}')), /Unknown preference/);
});

test('failed publish retains last confirmed preferences and rejects save', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await new DevicePreferences(directory).save({ appearance: 'LIGHT' });
  const prefs = new DevicePreferences(directory, undefined, { publish: async () => { throw new Error('disk full'); } });
  await assert.rejects(prefs.save({ appearance: 'DARK' }), /disk full/);
  assert.equal((await prefs.get()).appearance, 'LIGHT');
});

test('a key is rejected without OS encryption and never stored as plaintext', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(new DevicePreferences(directory).save({ aiApiKey: 'synthetic-key' }), /not saved/);
  const encryption = { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('opaque-test-ciphertext'), decryptString: () => 'synthetic-key' };
  const prefs = new DevicePreferences(directory, encryption);
  await prefs.save({ aiApiKey: 'synthetic-key' });
  assert.equal((await prefs.get()).aiApiKey, 'synthetic-key');
  assert.equal((await readFile(join(directory, 'device-preferences.json'), 'utf8')).includes('synthetic-key'), false);
  await assert.rejects(new DevicePreferences(directory, { ...encryption, getSelectedStorageBackend: () => 'basic_text' }).get(), /unavailable/);
});

test('desktop AI endpoint saves keep custom hosts and normalize Anthropic without duplicating v1', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prefs = new DevicePreferences(directory);
  await prefs.save({ aiProvider: 'openai', aiEndpoint: 'https://private-custom.example.org/v1/' });
  assert.equal((await prefs.get()).aiEndpoint, 'https://private-custom.example.org/v1');
  assert.throws(() => prefs.save({ aiEndpoint: 'http://192.168.1.5/v1' }), /https:\/\/ URL/);
  await prefs.save({ aiProvider: 'anthropic', aiEndpoint: 'https://api.anthropic.com/v1/' });
  assert.equal((await prefs.get()).aiEndpoint, 'https://api.anthropic.com');
  await prefs.save({ aiProvider: 'openai', aiEndpoint: 'https://api.openai.com/v1/' });
  assert.equal((await prefs.get()).aiEndpoint, 'https://api.openai.com/v1');
});

test('stored invalid endpoints fall back to defaults without losing provider or encrypted API key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'device-preferences.json'), JSON.stringify({ version: 1, preferences: { aiProvider: 'anthropic', aiEndpoint: 'http://old-custom.example.org/v1', aiModel: 'kept-model' }, encryptedAiKey: Buffer.from('ciphertext').toString('base64') }));
  const encryption = { isEncryptionAvailable: () => true, decryptString: () => 'synthetic-kept-key', encryptString: () => Buffer.from('ciphertext') };
  const prefs = new DevicePreferences(directory, encryption);
  const value = await prefs.get();
  assert.equal(value.aiEndpoint, ''); assert.equal(value.aiProvider, 'anthropic'); assert.equal(value.aiApiKey, 'synthetic-kept-key'); assert.equal(value.aiModel, 'kept-model');
  await prefs.save({ appearance: 'DARK' });
  const stored = JSON.parse(await readFile(join(directory, 'device-preferences.json'), 'utf8'));
  assert.equal(stored.preferences.aiEndpoint, ''); assert.ok(stored.encryptedAiKey); assert.equal(stored.preferences.aiApiKey, undefined);
});

test('changing AI provider uses its working default rather than keeping the other provider path', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nyora-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prefs = new DevicePreferences(directory);
  await prefs.save({ aiProvider: 'openai', aiEndpoint: 'https://api.openai.com/v1' });
  const switched = await prefs.save({ aiProvider: 'anthropic' }); assert.equal(switched.aiEndpoint, '');
  await assert.rejects(prefs.save({ aiEndpoint: 'https://api.openai.com/v1' }), /selected provider/);
  assert.equal((await prefs.get()).aiProvider, 'anthropic');
});
