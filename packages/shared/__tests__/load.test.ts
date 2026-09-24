import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCSDLFile } from '../src/load.js';

let workDir: string;
let nestedDir: string;
let mainPath: string;

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
});
