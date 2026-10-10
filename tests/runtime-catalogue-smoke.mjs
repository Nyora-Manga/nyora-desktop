// Native offline catalogue conformance against the actual bundled helper.
// Source traffic is forbidden; browser-shaped headers do not change desktop membership.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagedHelper } from '../electron/helper.cjs';
import { SourceRelay } from '../electron/relay.cjs';
import { verifyJava } from '../scripts/runtime-validation.mjs';

assert.ok(['arm64', 'x64'].includes(process.arch), 'Catalogue acceptance requires a supported native runner');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = resolve(project, 'vendor/helper');
const bundled = join(project, 'resources/helper');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(join(bundled, 'manifest.json'), 'utf8'));
assert.equal(manifest.arch, process.arch, 'Helper must match the native runner architecture');
assert.equal(manifest.platform, process.platform, 'Helper must match the native runner platform');
assert.equal(digest(await readFile(join(bundled, 'nyora-helper.jar'))), manifest.jarSha256);
async function policyFile(relative) {
  const bytes = await readFile(join(shared, relative));
  assert.equal(digest(bytes), manifest.source.files[relative], `Bundled helper policy must match ${relative}`);
  return bytes.toString('utf8');
}
const raw = JSON.parse(await policyFile('data/catalogue.json')).sources;
const registry = await policyFile('data/engine/EngineRegistry.kt');
const sourceEngine = await policyFile('data/engine/SourceEngine.kt');
const catalogue = await policyFile('src/jvmMain/kotlin/com/nyora/hasan72341/shared/extension/DataDrivenCatalog.kt');
const nativePolicy = await policyFile('src/jvmMain/kotlin/com/nyora/hasan72341/shared/extension/NativeBrowserSourcePolicy.kt');
const patches = await policyFile('src/commonMain/kotlin/com/nyora/hasan72341/shared/SourcePatches.kt');
const legacy = await policyFile('src/jvmMain/kotlin/com/nyora/hasan72341/shared/extension/LegacyMangaId.kt');
// Parse the pinned factory/policy declarations, not capability guesses from names/domains.
const enumKeys = new Map([...sourceEngine.matchAll(/^\s*([A-Z_]+)\("([a-z0-9]+)"\)/gm)].map(match => [match[1], match[2]]));
const engines = new Set([...registry.matchAll(/^\s*"([a-z0-9]+)"\s+to Creator/gm)].map(match => match[1]));
for (const match of registry.matchAll(/^\s*EngineId\.([A-Z_]+)\.key\s+to Creator/gm)) {
  assert.ok(enumKeys.has(match[1]), 'Unrecognized bundled enum engine'); engines.add(enumKeys.get(match[1]));
}
const native = catalogue.match(/NATIVE_BACKED_ENGINES\s*=\s*setOf\(([^)]*)\)/);
const dead = patches.match(/val DEAD_SOURCES[^=]*=\s*setOf\(([\s\S]*?)\n\s*\)/);
const retired = legacy.match(/canonicalDataSourceId\([^\n]*= when[^\n]*\{([\s\S]*?)\n\}/);
const domainOverrides = patches.match(/val DOMAIN_OVERRIDES[^=]*=\s*mapOf\(([\s\S]*?)\n\s*\)/);
const challengeDomains = nativePolicy.match(/CHALLENGE_ONLY_DOMAINS\s*=\s*mapOf\(([\s\S]*?)\n\s*\)/);
assert.ok(engines.size > 30 && native && dead && retired && domainOverrides && challengeDomains, 'Catalogue policy declaration changed; update this parser explicitly');
for (const match of native[1].matchAll(/"([a-z0-9]+)"/g)) engines.add(match[1]);
const normalizePatch = id => id.replace(/^DD_/i, '').toLowerCase();
const deadIds = new Set([...dead[1].matchAll(/"([^"]+)"/g)].map(match => normalizePatch(match[1])));
const retiredIds = new Set([...retired[1].matchAll(/^\s*"([^"]+)"\s*->\s*"([^"]+)"/gm)].filter(match => match[1] !== match[2]).map(match => match[1]));
const patchedDomains = new Map([...domainOverrides[1].matchAll(/"([^"]+)"\s+to\s+"([^"]+)"/g)].map(match => [normalizePatch(match[1]), match[2]]));
const auditedDomains = new Map([...challengeDomains[1].matchAll(/"([^"]+)"\s+to\s+"([^"]+)"/g)].map(match => [match[1], match[2]]));
assert.deepEqual([...auditedDomains.keys()].sort(), ['epsilonscan', 'klikmanga'], 'Native exceptions must remain bounded to the two audited identities');
const id = source => `data:${source.id.toLowerCase()}`;
const cf = source => String(source.antiBot).toLowerCase() === 'cloudflare' || /^[AB]$/i.test(source.cfWall || '');
const nativeException = source => source.engine === 'madara' && source.needsCustomLogic !== true &&
  !String(source.brokenReason || '').trim() && !deadIds.has(normalizePatch(source.id)) &&
  !retiredIds.has(source.id.toLowerCase()) && engines.has(source.engine) &&
  auditedDomains.get(source.id.toLowerCase()) === (patchedDomains.get(normalizePatch(source.id)) || source.domain);
const reasons = source => [source.broken === true && !nativeException(source) && 'broken', deadIds.has(normalizePatch(source.id)) && 'canonical-health-patch',
  !engines.has(source.engine) && 'unsupported-engine', retiredIds.has(source.id.toLowerCase()) && 'retired-identity'].filter(Boolean);
const eligible = raw.filter(source => !reasons(source).length);
const cfEligible = eligible.filter(cf);
assert.ok(cfEligible.some(source => source.cfWall === 'B'), 'Fixture must contain supported Wall-B sources');
const java = join(bundled, 'jre/bin', process.platform === 'win32' ? 'java.exe' : 'java');
await verifyJava(java, { arch: process.arch });
const temporary = await mkdtemp(join(tmpdir(), 'nyora-native-catalogue-smoke-'));
let token, portFile, helper;
let sourceRequests = 0;
const relay = new SourceRelay({ catalogueLookup: () => { sourceRequests++; throw new Error('Catalogue checks must never fetch a source'); },
  sessionForSource: () => { throw new Error('Source sessions are forbidden in catalogue checks'); } });
try {
  const credentials = await relay.start();
  helper = new ManagedHelper({ profileRoot: join(temporary, 'profile'), javaPath: java, jarPath: join(bundled, 'nyora-helper.jar'),
    relay: { url: `${credentials.baseUrl}/fetch`, token: credentials.token },
    launcher: (file, args, options) => {
      token = options.env.NYORA_HELPER_TOKEN;
      portFile = args.find(argument => argument.startsWith('-Dnyora.helper.port-file=')).split('=', 2)[1];
      return spawn(file, args, options);
    } });
  const health = await helper.start();
  assert.equal(health.sourceTransport, 'chromium');
  const normal = JSON.parse((await helper.request('/sources/catalog')).bytes).entries;
  const port = (await readFile(portFile, 'utf8')).trim();
  const endpoint = `http://127.0.0.1:${port}/sources/catalog`;
  const browserHeaders = { Origin: 'https://untrusted.invalid', 'Sec-Fetch-Mode': 'cors' };
  for (const authorization of [undefined, 'Bearer wrong-credential']) {
    const headers = { ...browserHeaders, ...(authorization ? { Authorization: authorization } : {}) };
    assert.equal((await fetch(endpoint, { headers, signal: AbortSignal.timeout(3000) })).status, 401);
  }
  const response = await fetch(endpoint, { headers: { ...browserHeaders, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const shaped = (await response.json()).entries;
  const ids = rows => rows.map(row => row.id).sort();
  assert.deepEqual(ids(normal), eligible.map(id).sort(), 'Desktop must expose every valid bundled source and retain health/engine/retired filters');
  assert.deepEqual(ids(shaped), ids(normal), 'Browser-shaped headers cannot remove authenticated desktop CF sources');
  const present = new Set(ids(shaped));
  for (const source of cfEligible) assert.ok(present.has(id(source)), `Eligible CF source missing: ${id(source)}`);
  const knownChallengeOnlyOverrides = raw.filter(source => source.broken === true && nativeException(source)).map(source => ({
    id: id(source), engine: source.engine, domain: source.domain, cloudflareMetadata: cf(source), originalBrokenFlag: source.broken,
  }));
  assert.deepEqual(knownChallengeOnlyOverrides.map(source => source.id).sort(), ['data:epsilonscan', 'data:klikmanga']);
  for (const source of knownChallengeOnlyOverrides) assert.ok(present.has(source.id), `Audited challenge-only source missing: ${source.id}`);
  const excluded = raw.filter(source => cf(source) && reasons(source).length).map(source => ({ id: id(source), reasons: reasons(source), brokenReason: source.brokenReason || null }));
  for (const source of excluded) assert.ok(!present.has(source.id), `Unavailable source must remain excluded: ${source.id}`);
  assert.equal(sourceRequests, 0);
  const population = predicate => ({ raw: raw.filter(predicate).length, eligible: eligible.filter(predicate).length,
    runtimeIds: eligible.filter(predicate).map(id).sort() });
  const result = { arch: process.arch, health, jarSha256: manifest.jarSha256, raw: raw.length, runtime: normal.length,
    cloudflare: population(cf), wallA: population(source => /^A$/i.test(source.cfWall || '')), wallB: population(source => /^B$/i.test(source.cfWall || '')),
    knownChallengeOnlyOverrides,
    knownCloudflareRuntimeIds: [...new Set([...cfEligible.map(id), ...knownChallengeOnlyOverrides.map(source => source.id)])].sort(),
    excludedCloudflare: excluded, browserHeadersPreserveMembership: true, missingWrongAuthenticationRejected: true, sourceRequests };
  const output = join(project, 'test-results/runtime-catalogue-smoke');
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`PASS: ${normal.length} eligible sources; ${cfEligible.length} CF (${result.wallB.eligible} Wall-B); browser-shaped headers preserve membership; missing/wrong auth rejected; zero source requests`);
} finally {
  await helper?.stop(); await relay.stop(); await rm(temporary, { recursive: true, force: true });
}
