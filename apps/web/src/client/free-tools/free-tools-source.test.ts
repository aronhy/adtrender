import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import initializeMath from './source/calculations.js';
import initializePolicies from './source/policies.js';
import { freeToolsCatalog } from './catalog';

const here = new URL('.', import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('provenance.json', here), 'utf8'));
const source = (name: string) => readFileSync(new URL(`source/${name}`, here), 'utf8');
const unwrap = (text: string) => text.slice(provenance.prefix.length, -provenance.suffix.length);
const api: any = {};
initializeMath(api);
initializePolicies(api);
const app = unwrap(source('app.js'));
const context: any = { window: api, URL };
vm.runInNewContext(app.slice(app.indexOf('  const n ='), app.indexOf('  const accents=')) + '\nglobalThis.registry = tools;', context);
const registry: any[] = context.registry;

describe('approved free tools source and copy', () => {
  for (const entry of provenance.files) {
    it(`retains every byte of ${entry.file}`, () => {
      const text = source(entry.file);
      if (entry.wrapped) {
        expect(text.startsWith(provenance.prefix)).toBe(true);
        expect(text.endsWith(provenance.suffix)).toBe(true);
      }
      const original = entry.wrapped ? unwrap(text) : text;
      expect(Buffer.byteLength(original)).toBe(entry.bytes);
      expect(createHash('sha256').update(original).digest('hex')).toBe(entry.sha256);
    });
  }
  it('exposes the same 17 names and slugs in the main-site menu', () => {
    expect(freeToolsCatalog).toHaveLength(17);
    expect(new Set(freeToolsCatalog.map(tool => tool.slug)).size).toBe(17);
    expect(JSON.parse(JSON.stringify(freeToolsCatalog))).toEqual(JSON.parse(JSON.stringify(registry.map(({id,slug,name,short}) => ({id,slug,name,short})))));
  });
});

describe('calculator business examples', () => {
  const expected: Record<string, string> = {F01:'5.00',F02:'3,500.00',F03:'35.00',F04:'50.00',F05:'600.00',F06:'820.00',F09:'20.00',F10:'5,000',F11:'1,000.00'};
  for (const [id, output] of Object.entries(expected)) {
    it(`${id} returns ${output}`, () => {
      const tool = registry.find(tool => tool.id === id);
      const result = api.FreeToolMath.calculate(id, tool.example);
      expect(api.FreeToolMath.format(result.primary.exact, {decimals:result.primary.unit === 'count' ? 0 : 2})).toBe(output);
    });
  }
  it('rejects a zero advertising-spend denominator', () => {
    const values = {...registry.find(tool => tool.id === 'F01').example, adSpend:'0'};
    expect(() => api.FreeToolMath.calculate('F01',values)).toThrow();
    try { api.FreeToolMath.calculate('F01',values); } catch (error: any) { expect(error.field).toBe('adSpend'); }
  });
  it('calculates estimated CPA from CPC and CVR without rounding inputs', () => {
    const result = api.FreeToolMath.calculate('F09',{mode:'estimate',cpc:'0.40',cvr:'2',target:''});
    expect(result.primary.exact).toBe('20/1');
  });
});

describe('English store policy templates', () => {
  const titles: Record<string,string> = {F18:'Privacy Policy',F19:'Refund Policy',F20:'Terms and Conditions',F21:'Returns and Exchanges Policy',F22:'Shipping Policy'};
  for (const [id,title] of Object.entries(titles)) {
    it(`generates ${title} as editable plain text`, () => {
      const tool = registry.find(tool => tool.id === id);
      const result = api.FreePolicies.generate(id,tool.example);
      expect(result.title).toBe(title);
      expect(result.text.startsWith(title+'\n\n')).toBe(true);
      expect(result.text).toContain('Northline Supply');
      expect(result.text).toContain('support@example.com');
      expect(result.text.length).toBeGreaterThan(500);
    });
  }
  it('rejects unsupported shop URL schemes', () => {
    const tool = registry.find(tool => tool.id === 'F22');
    expect(() => api.FreePolicies.generate('F22',{...tool.example,website:'javascript:alert(1)'})).toThrow();
  });
  it('does not require physical-return fields for a refund without returned goods', () => {
    const tool = registry.find(tool => tool.id === 'F19');
    const result = api.FreePolicies.generate('F19',{...tool.example,refundIncludesReturns:'no',returnWindow:'bad',returnConditions:''});
    expect(result.text).not.toContain('Refunds involving returned goods');
  });
});
