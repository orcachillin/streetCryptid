import { validateGeneratedCryptid } from '../cryptid-generator';
import { MAX_SIGIL_COLUMNS, MAX_SIGIL_LINES, sigilMeasurements } from '../profile';
import { repairCryptidName, repairSigil, sigilHasEnoughInk } from '../sigil-repair';

describe('repairSigil', () => {
  it('leaves clean art untouched', () => {
    const art = ['  /^--^\\', ' ( o  o )', '  \\ ~~ /', " _/'  '\\_"].join('\n');
    const { sigil, repairs } = repairSigil(art);

    expect(sigil).toBe(art);
    expect(repairs).toEqual([]);
  });

  it('transliterates box-drawing and block characters one cell at a time', () => {
    const { sigil } = repairSigil(['┌──┐', '│●●│', '└──┘'].join('\n'));

    expect(sigil).toBe(['+--+', '|oo|', '+--+'].join('\n'));
  });

  it('keeps columns aligned when it substitutes glyphs', () => {
    const before = ['╱▔▔╲', '▏●  ●▕'];
    const { sigil } = repairSigil(before.join('\n'));

    sigil.split('\n').forEach((line, index) => {
      expect(line.length).toBe(before[index].length);
    });
  });

  it('strips markdown fences and surrounding commentary', () => {
    const raw = [
      'Here is your cryptid icon:',
      '```',
      '  /\\_/\\',
      ' ( o.o )',
      '  > ^ <',
      '```',
      'I hope you like this little guy!',
    ].join('\n');
    const { sigil } = repairSigil(raw);

    expect(sigil).toBe(['  /\\_/\\', ' ( o.o )', '  > ^ <'].join('\n'));
  });

  it('dedents only when a line would otherwise not fit', () => {
    const padded = ['          /\\_/\\', '         ( o.o )'];
    expect(repairSigil(padded.join('\n')).sigil).toBe(padded.join('\n'));

    const tooWide = [`${' '.repeat(10)}${'#'.repeat(24)}`, `${' '.repeat(10)}${'#'.repeat(22)}`];
    expect(repairSigil(tooWide.join('\n')).sigil).toBe(['#'.repeat(24), '#'.repeat(22)].join('\n'));
  });

  it('never mistakes repeated-glyph art for commentary', () => {
    const wings = ['WWWW    WWWW', 'ooooo   ooooo', 'MMMMM  MMMMM', 'vvvv    vvvv'];

    expect(repairSigil(wings.join('\n')).sigil).toBe(wings.join('\n'));
  });

  it('still strips real sentences wrapped around the art', () => {
    const raw = ['Here is your cryptid icon:', 'oooo    oooo', 'I hope you like it.'].join('\n');

    expect(repairSigil(raw).sigil).toBe('oooo    oooo');
  });

  it('clips over-wide lines and drops extra lines', () => {
    const raw = Array.from({ length: 20 }, () => '#'.repeat(60)).join('\n');
    const measurements = sigilMeasurements(repairSigil(raw).sigil);

    expect(measurements.columns).toBe(MAX_SIGIL_COLUMNS);
    expect(measurements.lines).toBe(MAX_SIGIL_LINES);
  });

  it('reports what it had to change', () => {
    const { repairs } = repairSigil('```\n  ●●\n\n  ~~\n```');

    expect(repairs).toContain('removed markdown code fences');
    expect(repairs).toContain('replaced non-ASCII drawing characters');
    expect(repairs).toContain('closed gaps between art lines');
  });
});

describe('repairCryptidName', () => {
  it('unwraps quoting, markdown, and labels', () => {
    expect(repairCryptidName('**"Fog Moth"**').name).toBe('Fog Moth');
    expect(repairCryptidName('NAME: Alley Shuck').name).toBe('Alley Shuck');
  });

  it('shortens long names at a word boundary', () => {
    const { name, repairs } = repairCryptidName(
      'The Whispering Alleyway Moth of Perpetual Drizzle'
    );

    expect(name).toBe('The Whispering Alleyway');
    expect(name.length).toBeLessThanOrEqual(24);
    expect(repairs).toContain('shortened the name');
  });

  it('takes the first non-empty line', () => {
    expect(repairCryptidName('\n\nRain Stag\nsome commentary').name).toBe('Rain Stag');
  });
});

describe('sigilHasEnoughInk', () => {
  it('rejects art that survived as almost nothing', () => {
    expect(sigilHasEnoughInk('( )')).toBe(false);
    expect(sigilHasEnoughInk('')).toBe(false);
  });

  it('accepts a small but real drawing', () => {
    expect(sigilHasEnoughInk('(o o)\n \\_/ ')).toBe(true);
  });
});

describe('validateGeneratedCryptid', () => {
  it('repairs system output instead of rejecting it', () => {
    const generated = validateGeneratedCryptid(
      {
        name: '"The Whispering Alleyway Moth of Drizzle"',
        sigil: '```\n ┌───┐\n │●·●│\n └───┘\n```',
      },
      'system'
    );

    expect(generated.name).toBe('The Whispering Alleyway');
    expect(generated.sigil).toBe([' +---+', ' |o.o|', ' +---+'].join('\n'));
    expect(generated.repairs?.length).toBeGreaterThan(0);
  });

  it('explains itself when the drawing repairs down to nothing', () => {
    expect(() => validateGeneratedCryptid({ name: 'Eye', sigil: '(👁)' }, 'system')).toThrow(
      'The drawing was mostly characters that cannot be shown.'
    );
  });

  it('still rejects output with no drawing left in it', () => {
    expect(() => validateGeneratedCryptid({ name: 'Eye', sigil: '(👁)' }, 'system')).toThrow(
      'does not fit the profile grid'
    );
  });

  it('passes offline art through untouched', () => {
    const art = ['    __', '   /  \\', '   |  |', '  _/  \\_'].join('\n');
    const generated = validateGeneratedCryptid({ name: 'Night Crawler', sigil: art }, 'local');

    expect(generated.sigil).toBe(art);
    expect(generated.repairs).toBeUndefined();
  });
});
