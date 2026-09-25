'use strict';
/**
 * tests/unit/accountNameMatch.test.js
 *
 * Phase 2a — the account-holder name check that stands between a mistyped
 * account number and a store's settlement money landing in a stranger's
 * account.
 *
 * Both failure directions are real and both are tested:
 *   - too strict, and owners are refused their own accounts because their bank
 *     writes "MR J DOE" where they typed "John Doe"
 *   - too loose, and it stops being a check at all
 */

const { namesPlausiblyMatch, normalizeTokens } = require('../../src/utils/accountNameMatch');

describe('namesPlausiblyMatch — real bank formatting must still match', () => {
  test.each([
    ['John Doe', 'JOHN DOE', 'exact, different case'],
    ['John Doe', 'MR JOHN DOE', 'bank prefixes a title'],
    ['Mr John Doe', 'JOHN DOE', 'owner types the title instead'],
    ['John Doe', 'DOE JOHN', 'bank reverses the order'],
    ['John Doe', 'J DOE', 'bank holds an initial'],
    ['J Doe', 'JOHN DOE', 'owner types an initial'],
    ['John Doe', 'JOHN MICHAEL DOE', 'bank holds a middle name'],
    ['John Michael Doe', 'JOHN DOE', 'owner includes a middle name the bank lacks'],
    ["O'Brien Sarah", 'SARAH OBRIEN', 'apostrophe and order'],
    ['Anna-Marie Smith', 'ANNA MARIE SMITH', 'hyphenated first name'],
    ['Kwazakhele Threads (Pty) Ltd', 'KWAZAKHELE THREADS PTY LTD', 'business punctuation'],
    ['Threads Pty Ltd', 'THREADS LIMITED', 'company suffix variants'],
    ['  John   Doe  ', 'JOHN DOE', 'stray whitespace'],
  ])('matches: %s vs %s (%s)', (submitted, resolved) => {
    expect(namesPlausiblyMatch(submitted, resolved)).toBe(true);
  });
});

describe('namesPlausiblyMatch — genuinely different people must NOT match', () => {
  test.each([
    ['John Doe', 'JANE SMITH', 'completely different'],
    ['John Doe', 'JOHN SMITH', 'same first name, different surname'],
    ['John Doe', 'PETER DOE', 'same surname, different first name'],
    ['John Doe', 'JOHN', 'bank holds only a first name that is not the surname'],
    ['Nomsa Dlamini', 'NOMSA MBEKI', 'realistic near-miss'],
  ])('rejects: %s vs %s (%s)', (submitted, resolved) => {
    expect(namesPlausiblyMatch(submitted, resolved)).toBe(false);
  });

  test('a single initial is not evidence of ownership', () => {
    // The strength floor. Without it "J" would satisfy "JOHN DOE" and the check
    // would be trivially bypassable by typing one letter.
    expect(namesPlausiblyMatch('J', 'JOHN DOE')).toBe(false);
    expect(namesPlausiblyMatch('J D', 'JOHN DOE')).toBe(false);
  });

  test('initials alone never reach the strength floor, however many', () => {
    expect(namesPlausiblyMatch('J M D', 'JOHN MICHAEL DOE')).toBe(false);
  });

  test('a repeated token cannot be satisfied twice by one occurrence', () => {
    // 'JOHN JOHN' must not match 'JOHN DOE' by consuming the single JOHN twice.
    expect(namesPlausiblyMatch('John John', 'JOHN DOE')).toBe(false);
  });
});

describe('namesPlausiblyMatch — degenerate input fails closed', () => {
  test.each([
    [null, 'JOHN DOE'],
    ['John Doe', null],
    [undefined, undefined],
    ['', 'JOHN DOE'],
    ['John Doe', ''],
    ['   ', 'JOHN DOE'],
    ['12345', 'JOHN DOE'],
    ['Mr', 'JOHN DOE'],
    ['(Pty) Ltd', 'THREADS PTY LTD'],
  ])('rejects rather than throws: %s vs %s', (submitted, resolved) => {
    expect(namesPlausiblyMatch(submitted, resolved)).toBe(false);
  });

  test('a name of only titles and company noise normalizes to nothing', () => {
    // Important: these must not be treated as a match with each other just
    // because both reduce to an empty token list.
    expect(normalizeTokens('Mr The And')).toEqual([]);
    expect(namesPlausiblyMatch('Mr The And', 'The Pty Ltd')).toBe(false);
  });
});

describe('normalizeTokens', () => {
  test('strips titles, company noise, punctuation and digits', () => {
    // The apostrophe is removed (OBRIEN), while the hyphen separates — so a
    // hyphenated surname yields two real components rather than one fused word.
    expect(normalizeTokens("Mr John O'Brien-Doe (Pty) Ltd 123"))
      .toEqual(['JOHN', 'OBRIEN', 'DOE']);
  });

  test('is case-insensitive and whitespace-tolerant', () => {
    expect(normalizeTokens('  jOhN   dOe ')).toEqual(['JOHN', 'DOE']);
  });
});
