import type { Attribute, Relationship, SchemaModel } from './types';

export type ReviewSeverity = 'error' | 'warning' | 'info';
export type NormalFormStatus = 'pass' | 'risk' | 'unknown';

export interface NormalFormAssessment {
  status: NormalFormStatus;
  summary: string;
  evidence: string[];
}

export interface SchemaReviewReport {
  issues: SchemaReviewIssue[];
  normalForms: { first: NormalFormAssessment; second: NormalFormAssessment; third: NormalFormAssessment };
}

export type ReviewFix =
  | { kind: 'mark-derived-virtual'; entityId: string; attributeId: string }
  | { kind: 'index-foreign-key'; entityId: string; attributeId: string }
  | { kind: 'normalize-multivalued'; entityId: string; attributeId: string }
  | { kind: 'normalize-many-to-many'; relationshipId: string };

export interface SchemaReviewIssue {
  id: string;
  ruleId: string;
  severity: ReviewSeverity;
  confidence: 'high' | 'medium' | 'low';
  title: string;
  explanation: string;
  entityId?: string;
  attributeId?: string;
  relationshipId?: string;
  fix?: ReviewFix;
}

function walk(attributes: Attribute[], visit: (attribute: Attribute) => void): void {
  for (const attribute of attributes) {
    visit(attribute);
    if (attribute.children) walk(attribute.children, visit);
  }
}

function textHasExplicitDependency(notes: string, pattern: RegExp): boolean {
  return pattern.test(notes);
}

function hasAssociativeBridge(model: SchemaModel, relationship: Relationship): boolean {
  return model.entities.some((entity) => {
    if (entity.kind !== 'associative') return false;
    const endpoints = new Set(model.relationships
      .filter((edge) => edge.id !== relationship.id && (edge.from === entity.id || edge.to === entity.id))
      .flatMap((edge) => [edge.from, edge.to])
      .filter((id) => id !== entity.id));
    return endpoints.has(relationship.from) && endpoints.has(relationship.to);
  });
}

function relationshipSignature(relationship: Relationship): string {
  const endpoints = [relationship.from, relationship.to].sort();
  const cards = relationship.from <= relationship.to
    ? [relationship.fromCardinality, relationship.toCardinality]
    : [relationship.toCardinality, relationship.fromCardinality];
  return JSON.stringify([endpoints, relationship.label.trim().toLocaleLowerCase(), cards]);
}

function dependencyCycles(model: SchemaModel): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const entity of model.entities) adjacency.set(entity.id, new Set());
  for (const entity of model.entities) {
    walk(entity.attributes, (attribute) => {
      if (attribute.isFK && attribute.foreignKeyRef && adjacency.has(attribute.foreignKeyRef.entityId)) {
        adjacency.get(entity.id)?.add(attribute.foreignKeyRef.entityId);
      }
    });
  }
  const cycles = new Map<string, string[]>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string) => {
    if (onStack.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const key = [...new Set(cycle)].sort().join('|');
      cycles.set(key, cycle);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    onStack.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) visit(next);
    stack.pop();
    onStack.delete(node);
  };
  for (const entity of model.entities) visit(entity.id);
  return [...cycles.values()];
}

function namingStyle(name: string): 'snake' | 'camel' | 'other' {
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) return 'snake';
  if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name)) return 'camel';
  return 'other';
}

export function analyzeSchema(model: SchemaModel): SchemaReviewReport {
  const issues: SchemaReviewIssue[] = [];
  const ambiguityPattern = /\b(confirm|provisional|ambiguous|not specified|not fully specified|unresolved|unclear|must be confirmed)\b/i;
  const issue = (value: SchemaReviewIssue) => issues.push(value);
  const relationDegree = new Map(model.entities.map((entity) => [entity.id, 0]));
  for (const relationship of model.relationships) {
    relationDegree.set(relationship.from, (relationDegree.get(relationship.from) ?? 0) + 1);
    relationDegree.set(relationship.to, (relationDegree.get(relationship.to) ?? 0) + 1);
  }
  const specializationMembers = new Set<string>();
  for (const specialization of model.specializations) {
    specializationMembers.add(specialization.parent);
    specialization.children.forEach((id) => specializationMembers.add(id));
  }
  for (const entity of model.entities) {
    if (entity.isSpecializationOf) specializationMembers.add(entity.id);
    if (!entity.attributes.some((attribute) => attribute.isPK)) {
      issue({ id: `missing-pk:${entity.id}`, ruleId: 'missing-primary-key', severity: 'error', confidence: 'high', title: `No primary key in ${entity.name}`, explanation: 'No top-level attribute is marked as a primary key. Choose a key that matches the real identity rule; the reviewer will not invent one.', entityId: entity.id });
    }
    if (ambiguityPattern.test(entity.notes)) {
      issue({ id: `ambiguity:entity:${entity.id}`, ruleId: 'ambiguous-input', severity: 'info', confidence: 'high', title: `Confirm an assumption about ${entity.name}`, explanation: `Preserved entity note: ${entity.notes}`, entityId: entity.id });
    }
    if ((relationDegree.get(entity.id) ?? 0) === 0 && !specializationMembers.has(entity.id)) {
      issue({ id: `orphan:${entity.id}`, ruleId: 'orphan-entity', severity: 'warning', confidence: 'high', title: `${entity.name} is not connected`, explanation: 'This entity has no relationship or specialization edge. It may be an intentional standalone lookup, or a missing relationship.', entityId: entity.id });
    }

    const keyAttributes = entity.attributes.filter((attribute) => attribute.isPK);
    const nonKeyAttributes = entity.attributes.filter((attribute) => !attribute.isPK && attribute.kind !== 'derived');
    const explicitPartial = entity.attributes.find((attribute) => textHasExplicitDependency(attribute.notes, /partial dependency|depends only on part of/i));
    const compositeKey = keyAttributes.length > 1;
    if (explicitPartial) {
      issue({ id: `2nf:${entity.id}:${explicitPartial.id}`, ruleId: '2nf-partial-dependency', severity: 'warning', confidence: 'medium', title: `Possible 2NF violation in ${entity.name}`, explanation: `The notes for “${explicitPartial.name}” explicitly describe a partial dependency. Confirm its functional dependency and move it only when that dependency is established.`, entityId: entity.id, attributeId: explicitPartial.id });
    } else if (compositeKey && nonKeyAttributes.length > 0) {
      issue({ id: `2nf-risk:${entity.id}`, ruleId: '2nf-needs-functional-dependencies', severity: 'info', confidence: 'low', title: `Check 2NF dependencies in ${entity.name}`, explanation: 'This entity has a composite primary key and non-key attributes. The model does not declare functional dependencies, so a 2NF violation cannot be concluded from structure alone.', entityId: entity.id });
    }
    const explicitTransitive = entity.attributes.find((attribute) => textHasExplicitDependency(attribute.notes, /transitive dependency|depends on (?:a|another|non[- ]key)/i));
    if (explicitTransitive) {
      issue({ id: `3nf:${entity.id}:${explicitTransitive.id}`, ruleId: '3nf-transitive-dependency', severity: 'warning', confidence: 'medium', title: `Possible 3NF violation in ${entity.name}`, explanation: `The notes for “${explicitTransitive.name}” suggest a transitive dependency. Confirm the determinant before decomposing the entity.`, entityId: entity.id, attributeId: explicitTransitive.id });
    }

    const styleCounts = new Map<'snake' | 'camel' | 'other', number>();
    for (const attribute of entity.attributes) {
      const style = namingStyle(attribute.name);
      styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
      if (attribute.kind === 'multivalued') {
        issue({ id: `1nf:${entity.id}:${attribute.id}`, ruleId: '1nf-multivalued-attribute', severity: 'warning', confidence: 'high', title: `Multivalued attribute ${entity.name}.${attribute.name}`, explanation: 'A multivalued attribute is not atomic in a relational table. Normalize it into a child relation; its values and any declared components will be preserved.', entityId: entity.id, attributeId: attribute.id, fix: { kind: 'normalize-multivalued', entityId: entity.id, attributeId: attribute.id } });
      }
      if (ambiguityPattern.test(attribute.notes)) {
        issue({ id: `ambiguity:attribute:${entity.id}:${attribute.id}`, ruleId: 'ambiguous-input', severity: 'info', confidence: 'high', title: `Confirm ${entity.name}.${attribute.name}`, explanation: `Preserved attribute note: ${attribute.notes}`, entityId: entity.id, attributeId: attribute.id });
      }
      if (attribute.kind === 'derived' && attribute.isStored === true) {
        issue({ id: `stored-derived:${entity.id}:${attribute.id}`, ruleId: 'stored-derived-attribute', severity: 'warning', confidence: 'high', title: `Derived value ${entity.name}.${attribute.name} is stored`, explanation: 'This derived attribute is explicitly marked as stored. Stored derived values can become stale; keep the formula as virtual unless storage is an intentional, maintained requirement.', entityId: entity.id, attributeId: attribute.id, fix: { kind: 'mark-derived-virtual', entityId: entity.id, attributeId: attribute.id } });
      }
      if (attribute.isFK && !attribute.isIndexed && !attribute.isPK && !attribute.isUnique) {
        issue({ id: `fk-index:${entity.id}:${attribute.id}`, ruleId: 'foreign-key-without-index', severity: 'warning', confidence: 'medium', title: `Foreign key ${entity.name}.${attribute.name} is not indexed`, explanation: 'The foreign-key column has no explicit index, primary-key or unique constraint. Indexing is often beneficial for joins and referential actions; validate workload and database behavior.', entityId: entity.id, attributeId: attribute.id, fix: { kind: 'index-foreign-key', entityId: entity.id, attributeId: attribute.id } });
      }
    }
    const usedStyles = [...styleCounts.entries()].filter(([style, count]) => style !== 'other' && count > 0);
    if (usedStyles.length > 1) {
      issue({ id: `naming:${entity.id}`, ruleId: 'inconsistent-attribute-naming', severity: 'info', confidence: 'medium', title: `Mixed naming styles in ${entity.name}`, explanation: `Attributes mix ${usedStyles.map(([style]) => style === 'snake' ? 'snake_case' : 'camelCase').join(' and ')}. This is a consistency suggestion, not a data-integrity error.`, entityId: entity.id });
    }
  }

  const signatures = new Map<string, Relationship>();
  for (const relationship of model.relationships) {
    if (ambiguityPattern.test(relationship.notes)) {
      issue({ id: `ambiguity:relationship:${relationship.id}`, ruleId: 'ambiguous-input', severity: 'info', confidence: 'high', title: `Confirm relationship “${relationship.label || relationship.id}”`, explanation: `Preserved relationship note: ${relationship.notes}`, relationshipId: relationship.id });
    }
    if (relationship.fromCardinality === 'M:N' || relationship.toCardinality === 'M:N') {
      if (!hasAssociativeBridge(model, relationship)) {
        issue({ id: `mn-junction:${relationship.id}`, ruleId: 'many-to-many-without-junction', severity: 'warning', confidence: 'high', title: 'Many-to-many relationship has no junction entity', explanation: 'Relational schemas normally represent M:N links with a junction table. A matching associative entity connected to both endpoints was not found.', relationshipId: relationship.id, fix: { kind: 'normalize-many-to-many', relationshipId: relationship.id } });
      }
    }
    const signature = relationshipSignature(relationship);
    const duplicate = signatures.get(signature);
    if (duplicate) {
      issue({ id: `redundant:${relationship.id}`, ruleId: 'redundant-relationship', severity: 'warning', confidence: 'medium', title: 'Relationship duplicates another link', explanation: `This relationship duplicates “${duplicate.label || 'unnamed relationship'}” between the same entities with matching cardinalities. Confirm it is not a distinct business relationship before removal.`, relationshipId: relationship.id });
    } else signatures.set(signature, relationship);
  }
  for (const cycle of dependencyCycles(model)) {
    if (cycle.length < 2) continue;
    const firstEntityId = cycle[0];
    const names = cycle.map((id) => model.entities.find((entity) => entity.id === id)?.name ?? id);
    issue({ id: `fk-cycle:${[...new Set(cycle)].sort().join(':')}`, ruleId: 'circular-foreign-key-dependency', severity: 'info', confidence: 'medium', title: 'Circular foreign-key dependency', explanation: `Foreign-key references form a cycle (${names.join(' → ')}). Cycles can be valid but may complicate insert/delete ordering; verify nullable and deferrable constraints.`, ...(firstEntityId ? { entityId: firstEntityId } : {}) });
  }
  model.notes.forEach((note, index) => {
    if (ambiguityPattern.test(note)) issue({ id: `ambiguity:model:${index}`, ruleId: 'ambiguous-input', severity: 'info', confidence: 'high', title: 'Confirm a preserved schema assumption', explanation: note });
  });

  const firstFindings = issues.filter((item) => item.ruleId === '1nf-multivalued-attribute');
  const secondFindings = issues.filter((item) => item.ruleId === '2nf-partial-dependency' || item.ruleId === '2nf-needs-functional-dependencies');
  const thirdFindings = issues.filter((item) => item.ruleId === '3nf-transitive-dependency');
  const hasCompositeKeyAndNonKey = model.entities.some((entity) => entity.attributes.filter((attribute) => attribute.isPK).length > 1 && entity.attributes.some((attribute) => !attribute.isPK && attribute.kind !== 'derived'));
  return {
    issues,
    normalForms: {
      first: { status: firstFindings.length ? 'risk' : 'pass', summary: firstFindings.length ? `${firstFindings.length} multivalued attribute(s) require normalization.` : 'No explicitly multivalued attributes were found.', evidence: firstFindings.map((item) => item.title) },
      second: { status: secondFindings.some((item) => item.ruleId === '2nf-partial-dependency') ? 'risk' : hasCompositeKeyAndNonKey || firstFindings.length > 0 ? 'unknown' : 'pass', summary: secondFindings.length ? 'Review the findings; functional dependencies are not fully represented.' : firstFindings.length > 0 ? 'Resolve 1NF risks before drawing conclusions about higher normal forms.' : hasCompositeKeyAndNonKey ? 'Composite keys exist, but functional dependencies are not declared.' : 'No composite key with non-key attributes was found.', evidence: secondFindings.map((item) => item.title) },
      third: { status: thirdFindings.length ? 'risk' : 'unknown', summary: thirdFindings.length ? 'Notes suggest a transitive dependency; confirm it with functional dependencies.' : '3NF cannot be proven without declared functional dependencies.', evidence: thirdFindings.map((item) => item.title) },
    },
  };
}
