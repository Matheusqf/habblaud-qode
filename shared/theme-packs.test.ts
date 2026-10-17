// Pacotes de tema (shared/theme-packs): schema, precedência (?theme= > build > padrão), fallback
// de ids desconhecidos, JSON de build e toggles de apelidos/sazonais.
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PACK_ID,
  HABBLAUD_PACK,
  QODE_PACK,
  parseThemePackJson,
  resetThemePack,
  resolveThemePack,
  resolveThemePackId,
  safeCssValue,
  safeCssColor,
  safeFontStack,
  utf8Bytes,
  LOGO_MAX_BYTES,
  validateThemePack,
} from './theme-packs';
import { PRODUCT_NAME, setProductName } from './brand';
import { nicknamesEnabled } from './nicknames';

afterEach(() => {
  resetThemePack();
  setProductName('QODE Office');
});

describe('pacotes shipping (habblaud e qode) válidos contra o schema', () => {
  it('valida os dois built-ins, com ids/name/palette/fonts/scenery/toggles', () => {
    expect(validateThemePack(HABBLAUD_PACK)).toEqual(HABBLAUD_PACK);
    expect(validateThemePack(QODE_PACK)).toEqual(QODE_PACK);
    expect(HABBLAUD_PACK.id).toBe(DEFAULT_PACK_ID);
    expect(QODE_PACK.brand.text).toBe('QODE Office');
    expect(QODE_PACK.scenery).toEqual({ office: 'gather', rooms: 'openspace', garden: 'river', fx: 'off' });
  });
});

describe('validador do schema', () => {
  const base = { ...HABBLAUD_PACK };

  it('aceita um pacote próprio e rejeita o que foge do schema', () => {
    expect(validateThemePack(base)).toEqual(base);
    expect(validateThemePack({ ...base, id: 'Empresa X' })).toBeUndefined();
    expect(validateThemePack({ ...base, palette: { accent: '#fff' } })).toBeUndefined();
    expect(validateThemePack({ ...base, palette: {} })).toBeUndefined();
    expect(validateThemePack({ ...base, fonts: { ...base.fonts, brand: '' } })).toBeUndefined();
    expect(validateThemePack({ ...base, scenery: { office: 'neon' } })).toBeUndefined();
    expect(validateThemePack({ ...base, scenery: { escola: 'gather' } })).toBeUndefined();
    expect(validateThemePack({ ...base, nicknames: 'sim' })).toBeUndefined();
    expect(validateThemePack(null)).toBeUndefined();
  });
});

describe('precedência do id do pacote', () => {
  it('?theme= vence a build; senão VITE_HABBLAUD_THEME; senão o padrão', () => {
    expect(resolveThemePackId('?theme=qode', 'habblaud')).toBe('qode');
    expect(resolveThemePackId('', 'qode')).toBe('qode');
    expect(resolveThemePackId('', undefined)).toBe('habblaud');
  });

  it('id desconhecido passa à origem seguinte (URL inválida → build → padrão)', () => {
    expect(resolveThemePackId('?theme=nada', 'qode')).toBe('qode');
    expect(resolveThemePackId('', 'nada')).toBe('habblaud');
    expect(resolveThemePackId('?theme=nada', 'nada')).toBe('habblaud');
    expect(resolveThemePackId('?theme=', 'qode')).toBe('qode');
  });
});

describe('resolveThemePack com pacote JSON da build', () => {
  it('JSON válido de mesmo id vence o built-in; com id diferente, é ignorado', () => {
    const pack = resolveThemePack('?theme=custom', { VITE_HABBLAUD_THEME_JSON: JSON.stringify({ ...QODE_PACK, id: 'custom', name: 'Custom' }) });
    expect(pack.name).toBe('Custom');
    expect(resolveThemePack('', { VITE_HABBLAUD_THEME_JSON: JSON.stringify({ ...QODE_PACK, id: 'custom' }) }).id).toBe('habblaud');
  });

  it('JSON inválido cai no built-in; env de build resolve o qode', () => {
    expect(resolveThemePack('', { VITE_HABBLAUD_THEME: 'qode' }).id).toBe('qode');
    expect(resolveThemePack('', { VITE_HABBLAUD_THEME_JSON: '{não é json}' }).id).toBe('habblaud');
    expect(parseThemePackJson(undefined)).toBeUndefined();
  });
});

describe('toggles do pacote', () => {
  it('nicknames: ?nicknames=1 liga mesmo com o padrão do pacote desligado; 0 desliga sempre', () => {
    expect(nicknamesEnabled('', undefined, false)).toBe(false);
    expect(nicknamesEnabled('?nicknames=1', undefined, false)).toBe(true);
    expect(nicknamesEnabled('?nicknames=0', undefined, false)).toBe(false);
    expect(nicknamesEnabled('?nicknames=0', undefined, true)).toBe(false);
    expect(nicknamesEnabled(undefined, undefined, true)).toBe(true);
  });
});

describe('brand compartilhado (live binding)', () => {
  it('padrão do projeto e troca pelo pacote', () => {
    expect(PRODUCT_NAME).toBe('QODE Office');
    setProductName('HabbLaud');
    expect(PRODUCT_NAME).toBe('HabbLaud');
  });
});

describe('pacote JSON: valores CSS seguros', () => {
  it('recusa paleta/fontes que fecham a regra ou carregam url()', () => {
    expect(safeCssValue('#12151d')).toBe(true);
    expect(safeCssValue('system-ui, "Segoe UI", sans-serif')).toBe(true);
    expect(safeCssValue('red} body{display:none')).toBe(false);
    expect(safeCssValue('url(https://x.example/a.png)')).toBe(false);
    expect(safeCssValue('</style><script>')).toBe(false);
    const base = HABBLAUD_PACK;
    expect(validateThemePack({ ...base, palette: { '--accent': 'red;}*{color:red' } })).toBeUndefined();
  });
});

describe('ids herdados do Object.prototype não são pacotes', () => {
  const evil = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'prototype'];
  it('?theme=<id do prototype> passa à origem seguinte (build) ou ao padrão', () => {
    for (const id of evil) {
      expect(resolveThemePackId(`?theme=${id}`, undefined)).toBe('habblaud');
      expect(resolveThemePackId(`?theme=${id}`, 'qode')).toBe('qode');
      expect(resolveThemePackId('', id)).toBe('habblaud');
    }
  });
  it('resolveThemePack devolve sempre um pacote com forma válida', () => {
    for (const id of evil) {
      const p = resolveThemePack(`?theme=${encodeURIComponent(id)}`, {});
      expect(p.id).toBe('habblaud');
      expect(validateThemePack(p)).toBeDefined();
    }
    expect(resolveThemePack('?theme=constructor', { VITE_HABBLAUD_THEME: 'qode' }).id).toBe('qode');
  });
  it('JSON com id do prototype é recusado', () => {
    expect(parseThemePackJson(JSON.stringify({ ...HABBLAUD_PACK, id: '__proto__' }))).toBeUndefined();
    expect(resolveThemePack('?theme=constructor', { VITE_HABBLAUD_THEME_JSON: JSON.stringify({ ...HABBLAUD_PACK, id: 'constructor' }) }).id).toBe('habblaud');
  });
});

describe('paleta: allowlist de cores (sem image-set/url/var)', () => {
  it('aceita só a gramática de cor suportada', () => {
    for (const ok of ['#fff', '#ffff', '#12151d', '#12151dcc', 'rgba(124, 200, 255, 0.13)', 'rgb(1 2 3 / 50%)', 'hsl(210, 50%, 40%)', 'transparent', 'rebeccapurple'])
      expect(safeCssColor(ok), ok).toBe(true);
  });
  it('recusa image-set e variantes, url, var, gradientes e injeção', () => {
    for (const bad of [
      'image-set("https://x.example/a.png" 1x)', '-webkit-image-set(url(a.png) 1x)', 'IMAGE-SET("a.png" 1x)', 'image-set( "a" 1x , "b" 2x )',
      'url(https://x.example/a.png)', 'var(--x)', 'linear-gradient(red, blue)', 'red; background: url(x)', 'rgb(1,2,3) url(x)', '#12151d}', 'expression(alert(1))',
    ])
      expect(safeCssColor(bad), bad).toBe(false);
    expect(validateThemePack({ ...HABBLAUD_PACK, palette: { '--ui-bg': 'image-set("https://x.example/a.png" 1x)' } })).toBeUndefined();
  });
  it('fontes: só nomes de família', () => {
    expect(safeFontStack('system-ui, -apple-system, "Segoe UI", Roboto, sans-serif')).toBe(true);
    expect(safeFontStack('x, url(a.woff)')).toBe(false);
    expect(safeFontStack('"a" ; b')).toBe(false);
  });
  it('limite do logo é em bytes UTF-8', () => {
    expect(utf8Bytes('é')).toBe(2);
    const multi = '<svg>' + 'é'.repeat(LOGO_MAX_BYTES / 2) + '</svg>'; // < 8192 unidades UTF-16, > 8192 bytes
    expect(multi.length).toBeLessThan(LOGO_MAX_BYTES + 20);
    expect(validateThemePack({ ...HABBLAUD_PACK, brand: { ...HABBLAUD_PACK.brand, logo: multi } })).toBeUndefined();
  });
});
