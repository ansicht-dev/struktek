/**
 * The starter library has to parse.
 *
 * It is the first thing a new user sees, and it is exactly the kind of content
 * that rots silently: it lives in a string array, nothing imports it at build
 * time, and a new rule in the format would break it without breaking anything
 * else. Running the shipped templates through the real parser — against the
 * shipped blocks — is cheap insurance.
 */

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadTemplate, readBlockFile, render } from '../../core';
import { BLOCKS, newTemplateBody, TEMPLATES } from '../../host/seedContent';

/** Rebuild the block library the way the loader would, from the seed paths. */
function seededBlocks(): {
  names: Map<string, readonly string[]>;
  bodies: Map<string, Map<string, string>>;
} {
  const names = new Map<string, string[]>();
  const bodies = new Map<string, Map<string, string>>();
  for (const block of BLOCKS) {
    const [, type, filename] = block.path;
    if (!type || !filename) throw new Error('A seeded block needs blocks/<type>/<instance>');
    const instance = filename.replace(/\.[^.]+$/, '');
    (names.get(type) ?? names.set(type, []).get(type)!).push(instance);
    // Through the real splitter: a seeded block carries a header, and what
    // renders is only what sits below it.
    const file = readBlockFile(block.body, parseYaml);
    (bodies.get(type) ?? bodies.set(type, new Map()).get(type)!).set(instance, file.body);
  }
  return { names, bodies };
}

const blocks = seededBlocks();

const load = (source: string, name: string) =>
  loadTemplate(source, { name, parseYaml, blockTypes: blocks.names });

describe('starter library', () => {
  it('ships at least four templates and two block types', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(4);
    expect(blocks.names.size).toBeGreaterThanOrEqual(2);
  });

  it.each(TEMPLATES.map((t) => [t.path.join('/'), t] as const))(
    '%s parses with no diagnostics',
    (path, template) => {
      const model = load(template.body, path);
      expect(model.diagnostics).toEqual([]);
    },
  );

  it.each(TEMPLATES.map((t) => [t.path.join('/'), t] as const))(
    '%s renders to non-empty text once its required fields are filled',
    (_path, template) => {
      const model = load(template.body, 'fixture');
      const values: Record<string, string> = {};
      for (const field of model.fields) {
        if (!field.required) continue;
        values[field.name] =
          field.type.kind === 'choice'
            ? field.type.options[0]!
            : field.type.kind === 'blockType'
              ? blocks.names.get(field.type.name)![0]!
              : 'VALUE';
      }
      const result = render(model.nodes, { values, fields: model.fields, blocks: blocks.bodies });
      expect(result.text.length).toBeGreaterThan(0);
      // Every required field was supplied, so nothing should report as unfilled
      // except fields that only appear inside optional segments.
      const requiredNames = model.fields.filter((f) => f.required).map((f) => f.name);
      expect(result.unfilled.filter((n) => requiredNames.includes(n))).toEqual([]);
    },
  );

  it('leaves no placeholder syntax in a rendered prompt', () => {
    for (const template of TEMPLATES) {
      const model = load(template.body, 'fixture');
      const values = Object.fromEntries(
        model.fields.map((field) => [
          field.name,
          field.type.kind === 'choice'
            ? field.type.options[0]!
            : field.type.kind === 'blockType'
              ? blocks.names.get(field.type.name)![0]!
              : 'VALUE',
        ]),
      );
      const { text } = render(model.nodes, { values, fields: model.fields, blocks: blocks.bodies });
      expect(text).not.toMatch(/\{\{|\}\}/);
    }
  });

  it('every block instance referenced by a pin exists', () => {
    for (const template of TEMPLATES) {
      const model = load(template.body, 'fixture');
      for (const field of model.fields) {
        if (field.type.kind !== 'blockType' || field.pin === undefined) continue;
        expect(blocks.names.get(field.type.name)).toContain(field.pin);
      }
    }
  });

  it('the blank-template body parses too', () => {
    const model = load(newTemplateBody('scratch'), 'scratch');
    expect(model.diagnostics).toEqual([]);
    expect(model.name).toBe('scratch');
  });
});
