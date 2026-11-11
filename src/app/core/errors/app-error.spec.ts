import { describeError, errorText, toAppError } from './app-error';

describe('toAppError', () => {
  it('keeps structured errors of the backend', () => {
    expect(toAppError({ code: 'invalid_query', message: 'syntax error' })).toEqual({
      code: 'invalid_query',
      message: 'syntax error',
    });
  });

  it('maps unknown codes and other values to "unknown"', () => {
    expect(toAppError({ code: 'brand_new', message: 'x' }).code).toBe('unknown');
    expect(toAppError(new Error('boom'))).toEqual({ code: 'unknown', message: 'boom' });
    expect(toAppError('plain')).toEqual({ code: 'unknown', message: 'plain' });
    expect(toAppError(null).message).toBe('unknown error');
  });

  it('has a text for every code', () => {
    expect(errorText({ code: 'too_large', message: 'file is too large' })).toBe(
      'Die Datei ist zu groß.',
    );
    expect(errorText(new Error('boom'))).toBe('Unerwarteter Fehler.');
  });

  it('adds what the server said where that helps', () => {
    expect(describeError({ code: 'auth_failed', message: 'password authentication failed' })).toBe(
      'Die Anmeldung wurde abgelehnt. password authentication failed',
    );
    expect(describeError({ code: 'cancelled', message: 'cancelled' })).toBe('Abgebrochen.');
    expect(describeError({ code: 'timeout', message: 'no answer within 20 s' })).toBe(
      'Keine Antwort in der vorgesehenen Zeit.',
    );
  });
});
