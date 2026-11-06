// FOUND-01, ADR-037 D1: what the reproducibility gate decides. It needs Docker and has never run, so this
// is what shows it can fail. The second half drives the real gate with a stand-in for the docker command
// that writes small OCI tarballs. It proves the gate's logic, and nothing about real images.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildArguments,
  createBuilderArguments,
  removeBuilderArguments,
  runGate,
} from '../../infrastructure/scripts/reproducible-gate.mjs';
import {
  compareImages,
  exitCodeFor,
  filesThatDiffer,
  imageDescriptor,
  imageResult,
  listTar,
  reportFailures,
  verdictFor,
} from '../../infrastructure/scripts/reproducible-rules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (text: string | Buffer) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

const image = (manifestSeed: string, layers: string[]) => ({
  index: { manifests: [{ digest: sha(manifestSeed), mediaType: 'x' }] },
  manifest: { config: { digest: sha(`config-${manifestSeed}`) }, layers: layers.map((l) => ({ digest: sha(l) })) },
});

describe('compareImages', () => {
  it('reads identical manifests as the same', () => {
    expect(compareImages(image('m', ['a', 'b']), image('m', ['a', 'b']))).toEqual({
      same: true,
      differentLayers: [],
    });
  });

  it('decides on the manifest digest first, whatever the layers claim', () => {
    expect(compareImages(image('m', ['a']), image('m', ['b'])).same).toBe(true);
  });

  it('names one changed layer, at its position', () => {
    expect(compareImages(image('m1', ['a', 'b', 'c']), image('m2', ['a', 'x', 'c']))).toEqual({
      same: false,
      differentLayers: [{ index: 1, a: sha('b'), b: sha('x') }],
    });
  });

  it('names what is left over when the layer counts differ, either way round', () => {
    const short = image('m1', ['a']);
    const long = image('m2', ['a', 'b', 'c']);
    expect(compareImages(short, long).differentLayers).toEqual([
      { index: 1, a: null, b: sha('b') },
      { index: 2, a: null, b: sha('c') },
    ]);
    expect(compareImages(long, short).differentLayers).toEqual([
      { index: 1, a: sha('b'), b: null },
      { index: 2, a: sha('c'), b: null },
    ]);
  });

  it('says so when only the config differs, and still does not read as the same', () => {
    const result = compareImages(image('m1', ['a']), image('m2', ['a']));
    expect(result.same).toBe(false);
    expect(result.differentLayers).toEqual([]);
    expect(result.reason).toMatch(/config/);
  });

  it('never reads two missing things as the same', () => {
    for (const [a, b] of [
      [null, null],
      [undefined, undefined],
      [{}, {}],
      [{ index: {} }, { index: {} }],
      [{ index: { manifests: [] } }, { index: { manifests: [] } }],
      [{ index: { manifests: [{}] } }, { index: { manifests: [{}] } }],
      [{ index: { manifests: [{ digest: 'nope' }] } }, { index: { manifests: [{ digest: 'nope' }] } }],
    ]) {
      expect(compareImages(a, b).same).toBe(false);
    }
    expect(compareImages(image('m', ['a']), null).same).toBe(false);
    expect(compareImages(null, image('m', ['a'])).same).toBe(false);
  });

  it('does not choose among several images', () => {
    const several = {
      index: { manifests: [{ digest: sha('1') }, { digest: sha('2') }] },
      manifest: { layers: [] },
    };
    expect(compareImages(several, several).same).toBe(false);
  });

  it('ignores an attestation beside the image, because it records when the build ran', () => {
    const withAttestation = (seed: string) => ({
      index: {
        manifests: [
          { digest: sha('image') },
          {
            digest: sha(seed),
            annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
          },
        ],
      },
      manifest: { layers: [] },
    });
    expect(imageDescriptor(withAttestation('x').index)?.digest).toBe(sha('image'));
    expect(compareImages(withAttestation('x'), withAttestation('y')).same).toBe(true);
  });
});

describe('filesThatDiffer', () => {
  const file = (path: string, hash = 'h', size = 1) => ({ path, size, hash });

  it('finds nothing in two identical listings, in any order', () => {
    expect(filesThatDiffer([file('a'), file('b')], [file('b'), file('a')])).toEqual([]);
    expect(filesThatDiffer([], [])).toEqual([]);
  });

  it('names an added file', () => {
    expect(filesThatDiffer([file('a')], [file('a'), file('new')])).toEqual(['new']);
  });

  it('names a removed file', () => {
    expect(filesThatDiffer([file('a'), file('gone')], [file('a')])).toEqual(['gone']);
  });

  it('names changed contents, and a changed size', () => {
    expect(filesThatDiffer([file('a', 'h1')], [file('a', 'h2')])).toEqual(['a']);
    expect(filesThatDiffer([file('a', 'h', 1)], [file('a', 'h', 2)])).toEqual(['a']);
  });

  it('answers sorted names and nothing else', () => {
    const answer = filesThatDiffer(
      [file('z', 'CANARY-A'), file('b', 'CANARY-A')],
      [file('z', 'CANARY-B'), file('a')],
    );
    expect(answer).toEqual(['a', 'b', 'z']);
    expect(JSON.stringify(answer)).not.toContain('CANARY');
  });
});

describe('imageResult', () => {
  const good = (seed: string) => ({ status: 0, tarball: true, image: image(seed, ['a']) });

  it('compares two good builds', () => {
    expect(imageResult('web', good('m'), good('m'))).toMatchObject({
      name: 'web',
      failed: false,
      same: true,
    });
    expect(imageResult('web', good('m1'), good('m2'))).toMatchObject({ failed: false, same: false });
  });

  it.each([
    ['a build that failed, even with a tarball', { ...good('m'), status: 1 }],
    ['a build that was killed', { ...good('m'), status: null }],
    ['a missing tarball', { status: 0, tarball: false, image: null }],
    ['a tarball with no image in it', { status: 0, tarball: true, image: null }],
    ['a build that never ran', undefined],
  ])('fails on %s, in either place, and never as the same', (_, bad) => {
    for (const result of [imageResult('web', good('m'), bad), imageResult('web', bad, good('m'))]) {
      expect(result.failed).toBe(true);
      expect(result.same).toBe(false);
      expect(result.builds.filter((build: { ok: boolean }) => !build.ok)).toHaveLength(1);
    }
  });
});

const goodBuild = { ok: true, manifestDigest: sha('m') };
const entry = (name: string, same: boolean) => ({
  name,
  failed: false,
  same,
  differentLayers: [],
  builds: [goodBuild, goodBuild],
});
const failed = (name: string) => ({
  name,
  failed: true,
  same: false,
  differentLayers: [],
  builds: [goodBuild, { ok: false, reason: 'the build failed' }],
});
const allSame = { images: [entry('web', true), entry('worker', true)] };
const oneDiffers = { images: [entry('web', false), entry('worker', true)] };

describe('exitCodeFor and verdictFor', () => {
  it.each([
    ['same', allSame, false, 0, 'Reproducible: yes'],
    ['same, report only', allSame, true, 0, 'Reproducible: yes'],
    ['different', oneDiffers, false, 1, 'Reproducible: NO'],
    ['different, report only', oneDiffers, true, 0, 'Reproducible: NO (report only)'],
    ['a failed build', { images: [failed('web'), entry('worker', true)] }, false, 1, 'Reproducible: NO'],
    [
      'a failed build, report only',
      { images: [failed('web'), entry('worker', true)] },
      true,
      1,
      'Reproducible: NO',
    ],
    [
      'a failed build beside a difference, report only',
      { images: [entry('web', false), failed('worker')] },
      true,
      1,
      'Reproducible: NO',
    ],
  ])('%s', (_, report, reportOnly, code, verdict) => {
    expect(exitCodeFor(report, { reportOnly })).toBe(code);
    expect(verdictFor(report, { reportOnly })).toBe(verdict);
  });

  it.each([
    ['a report with no images', { images: [] }],
    ['a report with no image list', {}],
    ['no report', null],
    ['nothing at all', undefined],
    ['a report that leaves out an image', { images: [entry('web', true)] }],
    ['a report that stopped early', { error: 'x', images: [entry('web', true), entry('worker', true)] }],
    [
      'a build that did not succeed, marked the same',
      {
        images: [
          { ...entry('web', true), builds: [goodBuild, { ok: false }] },
          entry('worker', true),
        ],
      },
    ],
    [
      'only one build, marked the same',
      { images: [{ ...entry('web', true), builds: [goodBuild] }, entry('worker', true)] },
    ],
    [
      'an image with no comparison',
      {
        images: [
          { name: 'web', builds: [goodBuild, goodBuild] },
          entry('worker', true),
        ],
      },
    ],
  ])('fails %s in both modes, and never as the same', (_, report) => {
    expect(exitCodeFor(report, { reportOnly: false })).toBe(1);
    expect(exitCodeFor(report, { reportOnly: true })).toBe(1);
    expect(verdictFor(report, { reportOnly: true })).toBe('Reproducible: NO');
    expect(reportFailures(report).length).toBeGreaterThan(0);
  });

  it('is not report-only unless told so', () => {
    expect(exitCodeFor(oneDiffers)).toBe(1);
    expect(verdictFor(oneDiffers)).toBe('Reproducible: NO');
  });
});

/** A tar entry. The size is what the header claims, for the cases that lie about it. */
function tarEntry(path: string, contents: string | Buffer, options: { type?: string; mtime?: number; mode?: number; linkname?: string } = {}) {
  const body = Buffer.from(contents);
  const header = Buffer.alloc(512);
  const octal = (value: number, at: number, width: number) =>
    header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, at, 'latin1');
  header.write(path, 0, 100, 'utf8');
  octal(options.mode ?? 0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(body.length, 124, 12);
  octal(options.mtime ?? 0, 136, 12);
  header.write(options.type ?? '0', 156, 'latin1');
  if (options.linkname) header.write(options.linkname, 157, 100, 'utf8');
  header.write('ustar\0' + '00', 257, 'latin1');
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}
const tarOf = (entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);
async function* chunksOf(bytes: Buffer, size = 97) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

describe('listTar', () => {
  it('lists every entry, across chunk boundaries, with the same answer as one chunk', async () => {
    const tar = tarOf([tarEntry('./a.txt', 'hello'), tarEntry('dir/', '', { type: '5' }), tarEntry('b.bin', Buffer.alloc(2000, 7))]);
    const listing = await listTar(chunksOf(tar));
    expect(listing.map(({ path, size }: { path: string; size: number }) => [path, size])).toEqual([
      ['a.txt', 5],
      ['dir/', 0],
      ['b.bin', 2000],
    ]);
    expect(await listTar(chunksOf(tar, tar.length))).toEqual(listing);
  });

  it('gives different contents different hashes, and holds no contents', async () => {
    const [a] = await listTar(chunksOf(tarOf([tarEntry('f', 'sk-CANARY-one')])));
    const [b] = await listTar(chunksOf(tarOf([tarEntry('f', 'sk-CANARY-two')])));
    expect(a.hash).not.toBe(b.hash);
    expect(JSON.stringify([a, b])).not.toContain('CANARY');
  });

  it.each([
    ['the time', { mtime: 99 }],
    ['the mode', { mode: 0o755 }],
    ['the link target', { linkname: 'elsewhere' }],
  ])('notices a file that differs only in %s, because that changes the layer', async (_, change) => {
    const [plain] = await listTar(chunksOf(tarOf([tarEntry('f', 'same')])));
    const [changed] = await listTar(chunksOf(tarOf([tarEntry('f', 'same', change)])));
    expect(changed.hash).not.toBe(plain.hash);
  });

  it('follows a long name in a PAX header and a GNU one', async () => {
    const long = `${'d/'.repeat(80)}file`;
    const record = (text: string) => {
      const size = Buffer.byteLength(text) + 2;
      const digits = String(size + String(size).length);
      return `${digits} ${text}\n`;
    };
    const pax = tarEntry('PaxHeader', record(`path=${long}`), { type: 'x' });
    const gnu = tarEntry('././@LongLink', `${long}\0`, { type: 'L' });
    expect((await listTar(chunksOf(tarOf([pax, tarEntry('short', 'x')]))))[0].path).toBe(long);
    expect((await listTar(chunksOf(tarOf([gnu, tarEntry('short', 'x')]))))[0].path).toBe(long);
  });

  it('refuses what is not a tar, rather than reading it as empty', async () => {
    await expect(listTar(chunksOf(Buffer.alloc(0)))).rejects.toThrow();
    await expect(listTar(chunksOf(Buffer.alloc(512, 65)))).rejects.toThrow(/checksum/);
  });

  it('refuses a tar that is cut short', async () => {
    const tar = tarEntry('a', Buffer.alloc(2000, 1));
    await expect(listTar(chunksOf(tar.subarray(0, 1000)))).rejects.toThrow(/cut short/);
    await expect(listTar(chunksOf(tar.subarray(0, 100)))).rejects.toThrow(/cut short/);
  });
});

const MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const INDEX_TYPE = 'application/vnd.oci.image.index.v1+json';
const LAYER_TYPE = 'application/vnd.oci.image.layer.v1.tar+gzip';

/** A small but real OCI layout, as a tar, with one gzip layer per entry in `layers`. */
function ociTarball(layers: Record<string, string>[], { nested = false, configSeed = 'c' } = {}) {
  const blobs: Buffer[] = [];
  const blob = (bytes: Buffer) => {
    const digest = sha(bytes);
    blobs.push(tarEntry(`blobs/${digest.replace(':', '/')}`, bytes));
    return digest;
  };
  const config = blob(Buffer.from(JSON.stringify({ seed: configSeed })));
  const layerDescriptors = layers.map((files) => {
    const tar = tarOf(Object.entries(files).map(([path, text]) => tarEntry(path, text)));
    const gz = gzipSync(tar, { level: 1 });
    gz[4] = gz[5] = gz[6] = gz[7] = 0;
    return { mediaType: LAYER_TYPE, digest: blob(gz), size: gz.length };
  });
  const manifest = Buffer.from(
    JSON.stringify({ schemaVersion: 2, mediaType: MANIFEST_TYPE, config: { digest: config }, layers: layerDescriptors }),
  );
  const manifestDescriptor = { mediaType: MANIFEST_TYPE, digest: blob(manifest), size: manifest.length };
  const inner = { schemaVersion: 2, manifests: [manifestDescriptor] };
  const top = nested
    ? { schemaVersion: 2, manifests: [{ mediaType: INDEX_TYPE, digest: blob(Buffer.from(JSON.stringify(inner))) }] }
    : inner;
  return tarOf([tarEntry('oci-layout', '{"imageLayoutVersion":"1.0.0"}'), tarEntry('index.json', JSON.stringify(top)), ...blobs]);
}

type Build = { status?: number | null; tar?: Buffer | null; throws?: boolean };
type Scenario = (image: string, run: number) => Build;

describe('runGate, with a stand-in for docker', () => {
  let folder: string;
  let calls: string[][];
  const logs: string[] = [];
  let tarballsSeenDuringBuilds: string[][];

  const scratchRoot = () => join(folder, '.local', 'reproducible');
  const report = () => JSON.parse(readFileSync(join(scratchRoot(), 'report.json'), 'utf8'));
  const leftovers = () =>
    readdirSync(scratchRoot()).filter((name: string) => name !== 'report.json');

  const fakeExec =
    (scenario: Scenario, { createStatus = 0, removeStatus = 0 } = {}) =>
    async (args: string[]) => {
      calls.push(args);
      if (args[1] === 'create') return createStatus;
      if (args[1] === 'rm') return removeStatus;
      const output = args[args.indexOf('--output') + 1] ?? '';
      const dest = /dest=([^,]+)/.exec(output)?.[1] ?? '';
      const [image = '', run = ''] = (dest.split('/').pop() ?? '').replace('.tar', '').split('-');
      tarballsSeenDuringBuilds.push(readdirSync(dirname(join(folder, dest))));
      const build = scenario(image, Number(run));
      if (build.throws) throw new Error('docker went away');
      if (build.tar) writeFileSync(join(folder, dest), build.tar);
      return build.status ?? 0;
    };

  const gate = (scenario: Scenario, options: { reportOnly?: boolean; createStatus?: number; removeStatus?: number; stopped?: () => boolean; commitEpoch?: () => string } = {}) => {
    const { reportOnly = false, createStatus, removeStatus, stopped, commitEpoch } = options;
    return runGate({
      root: folder,
      reportOnly,
      exec: fakeExec(scenario, {
        ...(createStatus === undefined ? {} : { createStatus }),
        ...(removeStatus === undefined ? {} : { removeStatus }),
      }),
      commitEpoch: commitEpoch ?? (() => '1700000000\n'),
      ...(stopped ? { stopped } : {}),
      log: (line: string) => logs.push(line),
      warn: (line: string) => logs.push(line),
    });
  };
  const same: Scenario = () => ({ tar: ociTarball([{ a: 'one' }, { b: 'two' }]) });
  /** The web image differs on one file, and the other changes nothing. */
  const webDiffers: Scenario = (name, run) => ({
    tar:
      name === 'web'
        ? ociTarball([{ a: 'one' }, { 'server-action-key': `key-${run}`, kept: 'x' }])
        : ociTarball([{ a: 'one' }]),
  });
  const builderName = () => calls[0]?.[calls[0].indexOf('--name') + 1];
  const expectCleanedUp = () => {
    expect(leftovers()).toEqual([]);
    expect(calls.at(-1)).toEqual(['buildx', 'rm', '--force', builderName()]);
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'reproducible-'));
    calls = [];
    logs.length = 0;
    tarballsSeenDuringBuilds = [];
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('passes identical builds, and cleans up', async () => {
    expect(await gate(same)).toBe(0);
    expect(logs).toContain('Reproducible: yes');
    expect(report().images.map((i: { name: string; same: boolean }) => [i.name, i.same])).toEqual([
      ['web', true],
      ['worker', true],
    ]);
    expect(report().sourceDateEpoch).toBe('1700000000');
    expectCleanedUp();
  });

  it('follows an index nested in an index, as buildx can write', async () => {
    expect(await gate(() => ({ tar: ociTarball([{ a: 'one' }], { nested: true }) }))).toBe(0);
    expect(report().images[0].builds[0].manifestDigest).toMatch(/^sha256:/);
  });

  it('fails images that differ, and names the file', async () => {
    expect(await gate(webDiffers)).toBe(1);
    expect(logs).toContain('Reproducible: NO');
    const [web, worker] = report().images;
    expect(web.same).toBe(false);
    expect(web.differentLayers).toHaveLength(1);
    expect(web.differentLayers[0].index).toBe(1);
    expect(web.differingPaths).toEqual(['server-action-key']);
    expect(web.differingPathCount).toBe(1);
    expect(worker.same).toBe(true);
    expectCleanedUp();
  });

  it('passes them in report-only, and says so in the log and the report', async () => {
    expect(await gate(webDiffers, { reportOnly: true })).toBe(0);
    expect(logs).toContain('Reproducible: NO (report only)');
    expect(report().reportOnly).toBe(true);
    expect(report().images[0].differingPaths).toEqual(['server-action-key']);
    expectCleanedUp();
  });

  it('puts no file contents in the report or the log', async () => {
    const secret = 'sk-CANARY-do-not-repeat';
    await gate((_, run) => ({ tar: ociTarball([{ 'a.txt': `${secret}-${run}` }]) }), {
      reportOnly: true,
    });
    expect(readFileSync(join(scratchRoot(), 'report.json'), 'utf8')).not.toContain('CANARY');
    expect(logs.join('\n')).not.toContain('CANARY');
    expect(report().images[0].differingPaths).toEqual(['a.txt']);
  });

  it('says so when only the config differs', async () => {
    const result = await gate(
      (_, run) => ({ tar: ociTarball([{ a: 'one' }], { configSeed: `c${run}` }) }),
      { reportOnly: true },
    );
    expect(result).toBe(0);
    expect(report().images[0]).toMatchObject({ same: false, differentLayers: [] });
    expect(report().images[0].reason).toMatch(/config/);
  });

  it.each([true, false])('fails a build that fails, with report-only %s', async (reportOnly) => {
    const code = await gate(
      (name, run) => (name === 'web' && run === 1 ? { status: 1 } : same(name, run)),
      { reportOnly },
    );
    expect(code).toBe(1);
    expect(logs).toContain('Reproducible: NO');
    expect(report().images[0].failed).toBe(true);
    expectCleanedUp();
  });

  it('does not spend a second build on one that already failed', async () => {
    await gate((name, run) => (name === 'web' ? { status: 1 } : same(name, run)));
    const webBuilds = calls.filter((args) => args.includes('infrastructure/containers/Dockerfile.web'));
    expect(webBuilds).toHaveLength(1);
  });

  it.each([true, false])(
    'fails when the second tarball is missing, with report-only %s',
    async (reportOnly) => {
      const code = await gate(
        (name, run) => (run === 2 && name === 'worker' ? { status: 0, tar: null } : same(name, run)),
        { reportOnly },
      );
      expect(code).toBe(1);
      expect(logs).toContain('Reproducible: NO');
      expect(report().images[1].builds[1].reason).toMatch(/no tarball/);
      expectCleanedUp();
    },
  );

  it.each([
    ['empty', Buffer.alloc(0)],
    ['not a tar', Buffer.alloc(4096, 65)],
    ['a tar with no index', tarOf([tarEntry('oci-layout', '{}')])],
    ['a tar whose index points at nothing', tarOf([tarEntry('index.json', JSON.stringify({ manifests: [{ digest: sha('x') }] }))])],
    ['a tar whose index is not JSON', tarOf([tarEntry('index.json', 'nope')])],
  ])('fails a tarball that is %s, even in report-only', async (_, tar) => {
    expect(await gate(() => ({ tar }), { reportOnly: true })).toBe(1);
    expect(logs).toContain('Reproducible: NO');
    expectCleanedUp();
  });

  it('fails when a layer that differs cannot be read, and still deletes the tarballs', async () => {
    const broken = (run: number) => {
      const bad = Buffer.from(`not gzip ${run}`);
      const layer = { mediaType: LAYER_TYPE, digest: sha(bad) };
      const manifest = Buffer.from(JSON.stringify({ config: { digest: sha('c') }, layers: [layer] }));
      const digest = sha(manifest);
      return tarOf([
        tarEntry('index.json', JSON.stringify({ manifests: [{ mediaType: MANIFEST_TYPE, digest }] })),
        tarEntry(`blobs/${digest.replace(':', '/')}`, manifest),
        tarEntry(`blobs/${layer.digest.replace(':', '/')}`, bad),
      ]);
    };
    expect(await gate((_, run) => ({ tar: broken(run) }), { reportOnly: true })).toBe(1);
    expect(report().images[0].failed).toBe(true);
    expectCleanedUp();
  });

  it('fails with no images when the builder cannot be created, and still tries to remove it', async () => {
    expect(await gate(same, { createStatus: 1, reportOnly: true })).toBe(1);
    expect(report().images).toEqual([]);
    expect(report().error).toMatch(/builder/);
    expect(logs).toContain('Reproducible: NO');
    expectCleanedUp();
  });

  it('fails when the commit has no usable time, before building anything', async () => {
    expect(await gate(same, { commitEpoch: () => 'not a time', reportOnly: true })).toBe(1);
    expect(calls.filter((args) => args[1] === 'build')).toEqual([]);
    expect(report().error).toMatch(/time/);
  });

  it('fails, cleans up and keeps its error text out of the report when docker throws', async () => {
    const code = await gate(
      (name, run) => (run === 2 ? { throws: true } : same(name, run)),
      { reportOnly: true },
    );
    expect(code).toBe(1);
    expect(report().error).not.toContain('docker went away');
    expectCleanedUp();
  });

  it('stops building when told to, and still cleans up', async () => {
    let builds = 0;
    const code = await gate(
      (name, run) => {
        builds += 1;
        return same(name, run);
      },
      { stopped: () => builds >= 1, reportOnly: true },
    );
    expect(code).toBe(1);
    expect(builds).toBe(1);
    expectCleanedUp();
  });

  it('still answers when the builder cannot be removed, and says so', async () => {
    expect(await gate(same, { removeStatus: 1 })).toBe(0);
    expect(logs.join('\n')).toMatch(/could not remove builder ensemus-reproducible-/);
  });

  it('removes an older report first, so a crash cannot leave a pass behind', async () => {
    mkdirSync(scratchRoot(), { recursive: true });
    writeFileSync(join(scratchRoot(), 'report.json'), '{"old":true}');
    await gate(same);
    expect(report().old).toBeUndefined();
  });

  it('fails when the report cannot be written', async () => {
    mkdirSync(join(scratchRoot(), 'report.json', 'in-the-way'), { recursive: true });
    await expect(gate(same)).rejects.toThrow();
  });

  it('deletes the first image before it builds the next, because the disk is small', async () => {
    await gate(same);
    const atWorkerStart = tarballsSeenDuringBuilds[2];
    expect(atWorkerStart).toEqual([]);
  });

  it('builds each image twice, on its own builder, from the commit time', async () => {
    await gate(same);
    const builds = calls.filter((args) => args[1] === 'build');
    expect(builds).toHaveLength(4);
    const names = builds.map((args) => args[args.indexOf('--builder') + 1]);
    expect(new Set(names)).toEqual(new Set([builderName()]));
    for (const args of builds) {
      expect(args).toContain('--no-cache');
      expect(args).toContain('SOURCE_DATE_EPOCH=1700000000');
    }
  });

  it('gives each run its own builder', async () => {
    await gate(same);
    const first = builderName();
    calls = [];
    await gate(same);
    expect(builderName()).not.toBe(first);
  });
});

describe('the docker commands', () => {
  const build = (buildArgs: string[]) =>
    buildArguments({
      builder: 'b',
      dockerfile: 'infrastructure/containers/Dockerfile.web',
      buildArgs,
      epoch: '1700000000',
      dest: '.local/reproducible/t/web-1.tar',
    });

  it('asks for what ADR-037 D1 names', () => {
    const args = build(['ENSEMUS_RELEASE=reproducible']);
    expect(args.slice(0, 2)).toEqual(['buildx', 'build']);
    expect(args).toContain('--no-cache');
    expect(args).toContain('--provenance=false');
    expect(args[args.indexOf('--file') + 1]).toBe('infrastructure/containers/Dockerfile.web');
    expect(args).toContain('SOURCE_DATE_EPOCH=1700000000');
    expect(args).toContain('ENSEMUS_RELEASE=reproducible');
    expect(args).toContain('type=oci,dest=.local/reproducible/t/web-1.tar,rewrite-timestamp=true');
    expect(args.at(-1)).toBe('.');
  });

  it('creates a docker-container builder on a pinned BuildKit', () => {
    const args = createBuilderArguments('b');
    expect(args.slice(0, 2)).toEqual(['buildx', 'create']);
    expect(args[args.indexOf('--driver') + 1]).toBe('docker-container');
    expect(args[args.indexOf('--driver-opt') + 1]).toMatch(/^image=moby\/buildkit:\S+@sha256:[0-9a-f]{64}$/);
  });

  it('removes only the builder it was given', () => {
    expect(removeBuilderArguments('b')).toEqual(['buildx', 'rm', '--force', 'b']);
  });

  it('never prunes, and the source says where the clean-up is', () => {
    const source = readFileSync(join(root, 'infrastructure/scripts/reproducible-gate.mjs'), 'utf8');
    expect(source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')).not.toMatch(/prune/);
    expect(source).toMatch(/finally/);
  });

  it('keeps tarballs where the build context cannot pick them up', () => {
    expect(readFileSync(join(root, '.dockerignore'), 'utf8').split(/\r?\n/)).toContain('.local');
  });
});

describe('the command line', () => {
  it('refuses a flag it does not know, so a typo cannot skip anything', () => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'infrastructure/scripts/reproducible-gate.mjs'), '--report-onyl'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage');
  });
});
