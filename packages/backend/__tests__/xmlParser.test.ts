import { describe, it, expect } from 'vitest';
import { parseCSDL } from '../src/services/xmlParser.js';

describe('XML Parser', () => {
  const minimalCSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="TestService.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
        <Property Name="Price" Type="Edm.Decimal" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('should parse minimal CSDL with one entity', async () => {
    const result = await parseCSDL(minimalCSDL);
    
    expect(result).toBeDefined();
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].name).toBe('Product');
  });

  it('should extract entity properties', async () => {
    const result = await parseCSDL(minimalCSDL);
    const product = result.entities[0];
    
    expect(product.properties).toHaveLength(3);
    expect(product.properties[0].name).toBe('Id');
    expect(product.properties[0].type).toBe('Edm.Int32');
    expect(product.properties[0].nullable).toBe(false);
  });

  it('should identify key properties', async () => {
    const result = await parseCSDL(minimalCSDL);
    const product = result.entities[0];
    
    expect(product.keys).toContain('Id');
    expect(product.properties[0].isKey).toBe(true);
  });

  it('should handle nullable properties', async () => {
    const result = await parseCSDL(minimalCSDL);
    const product = result.entities[0];
    
    const nameProp = product.properties.find(p => p.name === 'Name');
    expect(nameProp?.nullable).toBe(true);
  });

  const csdlWithRelationships = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="TestService.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Order">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <NavigationProperty Name="Customer" Type="TestService.Models.Customer" />
      </EntityType>
      <EntityType Name="Customer">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <NavigationProperty Name="Orders" Type="Collection(TestService.Models.Order)" />
      </EntityType>
      <Association Name="Order_Customer">
        <End Type="TestService.Models.Order" Role="Order" Multiplicity="1" />
        <End Type="TestService.Models.Customer" Role="Customer" Multiplicity="*" />
      </Association>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('should parse entities with relationships', async () => {
    const result = await parseCSDL(csdlWithRelationships);
    
    expect(result.entities).toHaveLength(2);
    expect(result.relationships).toHaveLength(1);
  });

  it('should extract navigation properties', async () => {
    const result = await parseCSDL(csdlWithRelationships);
    const order = result.entities.find(e => e.name === 'Order');
    
    expect(order?.navigationProperties).toHaveLength(1);
    expect(order?.navigationProperties[0].name).toBe('Customer');
  });

  it('should parse association ends', async () => {
    const result = await parseCSDL(csdlWithRelationships);
    const rel = result.relationships[0];
    
    expect(rel.name).toBe('Order_Customer');
    expect(rel.from.entity).toBe('Order');
    expect(rel.from.multiplicity).toBe('1');
    expect(rel.to.entity).toBe('Customer');
    expect(rel.to.multiplicity).toBe('*');
  });

  it('should handle empty/invalid XML gracefully', async () => {
    await expect(parseCSDL('')).rejects.toThrow();
    await expect(parseCSDL('invalid xml')).rejects.toThrow();
  });

  it('should handle CSDL without entities', async () => {
    const emptyCSDL = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="EmptyService.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    
    const result = await parseCSDL(emptyCSDL);
    expect(result.entities).toHaveLength(0);
  });

  const csdlWithComplexTypes = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="TestService.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <ComplexType Name="Address">
        <Property Name="Street" Type="Edm.String" />
        <Property Name="City" Type="Edm.String" />
        <Property Name="ZipCode" Type="Edm.String" />
      </ComplexType>
      <EntityType Name="Person">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
        <Property Name="Name" Type="Edm.String" />
        <Property Name="Address" Type="TestService.Models.Address" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('should parse complex types', async () => {
    const result = await parseCSDL(csdlWithComplexTypes);
    
    expect(result.entities).toHaveLength(2);
    const address = result.entities.find(e => e.name === 'Address');
    expect(address).toBeDefined();
    expect(address?.properties).toHaveLength(3);
  });

  const csdlWithMultipleNamespaces = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="ServiceA.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Product">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
    </Schema>
    <Schema Namespace="ServiceB.Models" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Category">
        <Key>
          <PropertyRef Name="Id" />
        </Key>
        <Property Name="Id" Type="Edm.Int32" Nullable="false" />
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('should handle multiple schemas/namespaces', async () => {
    const result = await parseCSDL(csdlWithMultipleNamespaces);
    
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0].namespace).toBe('ServiceA.Models');
    expect(result.entities[1].namespace).toBe('ServiceB.Models');
  });
});
