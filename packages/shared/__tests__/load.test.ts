import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appendFile, mkdtemp, mkdir, open, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync, fstatSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCSDLFile, readExactly, readRegularFile } from '../src/load.js';

let workDir: string;
let nestedDir: string;
let mainPath: string;

/** `mkfifo` is POSIX-only; the FIFO test is skipped where it is missing. */
function hasMkfifo(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v mkfifo'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Where this platform exposes the process's open descriptors, if anywhere. */
const FD_DIR = existsSync('/proc/self/fd')
  ? '/proc/self/fd'
  : existsSync('/dev/fd')
    ? '/dev/fd'
    : undefined;

const mainDocument = `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Main" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing" BaseType="sib.Base">
        <Property Name="Id" Type="Edm.String" />
      </EntityType>
    </Schema>
    <edmx:Reference Uri="sibling.xml"><edmx:Include Namespace="Sib" Alias="sib" /></edmx:Reference>
    <edmx:Reference Uri="../escape.xml"><edmx:Include Namespace="Esc" Alias="esc" /></edmx:Reference>
    <edmx:Reference Uri="file:///etc/hostname"><edmx:Include Namespace="Abs" Alias="abs" /></edmx:Reference>
  </edmx:DataServices>
</edmx:Edmx>`;

const siblingDocument = `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Sib" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Base"><Key><PropertyRef Name="Id" /></Key>
      <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

const suppliedDocument = `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Supplied" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="OnlySupplied">
        <Property Name="Id" Type="Edm.String" />
      </EntityType>
    </Schema>
    <edmx:Reference Uri="sibling.xml"><edmx:Include Namespace="Sib" Alias="sib" /></edmx:Reference>
  </edmx:DataServices>
</edmx:Edmx>`;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'csdl-ref-'));
  nestedDir = join(workDir, 'nested');
  await mkdir(nestedDir);
  // main.xml lives in a subdirectory and reaches outside it with "../escape.xml".
  // The escape target really exists, so a test failure cannot be explained by a
  // missing file.
  await writeFile(join(nestedDir, 'main.xml'), mainDocument, 'utf-8');
  await writeFile(join(nestedDir, 'sibling.xml'), siblingDocument, 'utf-8');
  await writeFile(join(workDir, 'escape.xml'), siblingDocument, 'utf-8');
  mainPath = join(nestedDir, 'main.xml');
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('parseCSDLFile reference resolution', () => {
  it('loads references in the document directory', async () => {
    const metadata = await parseCSDLFile(mainPath);
    expect(metadata.entities.map((e) => e.qualifiedName)).toContain('Sib.Base');
  });

  it('refuses to escape the document directory', async () => {
    const metadata = await parseCSDLFile(mainPath);
    // ../escape.xml points at a file that exists, but it is outside the
    // document's directory, so it must not be read.
    expect(metadata.entities.map((e) => e.qualifiedName)).not.toContain('Esc.Base');
    expect(metadata.unresolvedReferences).toContain('../escape.xml');
  });

  it('refuses absolute file URIs', async () => {
    const metadata = await parseCSDLFile(mainPath);
    expect(metadata.unresolvedReferences).toContain('file:///etc/hostname');
  });

  it('parses supplied content instead of re-reading the file, still resolving references from the path', async () => {
    // The on-disk document declares Main.Thing; the supplied one must win.
    const path = join(nestedDir, 'supplied.xml');
    await writeFile(path, mainDocument, 'utf-8');

    const metadata = await parseCSDLFile(path, suppliedDocument);

    expect(metadata.entities.map((e) => e.qualifiedName)).toContain('Supplied.OnlySupplied');
    expect(metadata.entities.map((e) => e.qualifiedName)).not.toContain('Main.Thing');
    // Relative references still resolve against the supplied path's directory.
    expect(metadata.entities.map((e) => e.qualifiedName)).toContain('Sib.Base');
  });
});

describe('hardened file reads', () => {
  it('reads exactly the requested bytes even if the file grows', async () => {
    const path = join(workDir, 'grows.xml');
    await writeFile(path, 'A'.repeat(64));
    const handle = await open(path, 'r');
    try {
      await appendFile(path, 'B'.repeat(32));

      // A whole-file read (`handle.readFile`) would return the 96 bytes now on
      // disk; the bounded read must return only the 64 that were fstat'ed.
      expect(await readExactly(handle, 64)).toBe('A'.repeat(64));
    } finally {
      await handle.close();
    }
  });

  it.skipIf(!FD_DIR)(
    'closes the handle on success, non-regular and cap-failure paths',
    async () => {
      const capPath = join(workDir, 'capped.xml');
      await writeFile(capPath, siblingDocument, 'utf-8');

      // Count only descriptors to *this test's* files: vitest workers share
      // the process, so the global fd count churns with other test files.
      const tracked = new Set(
        [mainPath, capPath, nestedDir].map((path) => {
          const { dev, ino } = statSync(path);
          return `${dev}:${ino}`;
        }),
      );
      const leakedFds = (): number => {
        let count = 0;
        for (const entry of readdirSync(FD_DIR as string)) {
          try {
            const { dev, ino } = fstatSync(Number(entry));
            if (tracked.has(`${dev}:${ino}`)) count += 1;
          } catch {
            // Closed between readdir and fstat; nothing to count.
          }
        }
        return count;
      };

      // Warm up so any lazy descriptor is already open before counting.
      await readRegularFile(mainPath);
      await readRegularFile(nestedDir).catch(() => undefined);
      await readRegularFile(capPath, 10).catch(() => undefined);

      const before = leakedFds();
      for (let i = 0; i < 25; i += 1) {
        await readRegularFile(mainPath);
        await expect(readRegularFile(nestedDir)).rejects.toThrow(/not a regular file/);
        await expect(readRegularFile(capPath, 10)).rejects.toThrow(/exceed/i);
      }
      // Dropping the `finally` close leaks three descriptors per iteration.
      expect(leakedFds()).toBe(before);
    },
  );

  it('parses empty supplied content as empty instead of re-reading the file', async () => {
    const path = join(workDir, 'empty-supplied.xml');
    await writeFile(path, siblingDocument, 'utf-8');

    // `??` must not become `||`: empty supplied content is still supplied
    // content, so the valid on-disk document must not be silently re-read.
    await expect(parseCSDLFile(path, '')).rejects.toThrow(/empty/i);
  });

  it.skipIf(!hasMkfifo())(
    'reports a FIFO reference as unresolved instead of hanging',
    { timeout: 2000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'csdl-fifo-'));
      try {
        const path = join(dir, 'main.xml');
        await writeFile(
          path,
          `<?xml version="1.0"?>
<edmx:Edmx Version="4.01" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="FifoMain" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Thing"><Key><PropertyRef Name="Id"/></Key>
      <Property Name="Id" Type="Edm.String" Nullable="false" /></EntityType>
    </Schema>
    <edmx:Reference Uri="sibling.xml"><edmx:Include Namespace="Sib" Alias="sib" /></edmx:Reference>
  </edmx:DataServices>
</edmx:Edmx>`,
          'utf-8',
        );
        execFileSync('mkfifo', [join(dir, 'sibling.xml')]);

        const metadata = await parseCSDLFile(path);

        expect(metadata.entities.map((e) => e.qualifiedName)).toContain('FifoMain.Thing');
        expect(metadata.unresolvedReferences).toEqual(['sibling.xml']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
