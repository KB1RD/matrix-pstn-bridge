import * as LPN from 'google-libphonenumber';

const phoneUtil = LPN.PhoneNumberUtil.getInstance();

/**
 * Abstraction away from Google's libphonenumber for simplicity.
 * Represents a phone number. Created with `getPhoneNumberFromE164` or
 * `parsePhoneNumber`.
 */
export class PhoneNumber {
  constructor(protected readonly inum: LPN.PhoneNumber) {}

  formatForRegion(region?: string | null): string {
    return phoneUtil.formatInOriginalFormat(this.inum, region || undefined);
  }

  get defaultDisplayName(): string {
    return phoneUtil.format(this.inum, LPN.PhoneNumberFormat.INTERNATIONAL);
  }
  get E164(): string {
    return phoneUtil.format(this.inum, LPN.PhoneNumberFormat.E164);
  }

  get _region(): string | null {
    return phoneUtil.getRegionCodeForNumber(this.inum) || null;
  }

  toString(): string {
    return this.E164;
  }
}

/**
 * Gets a `PhoneNumber` class representing the provided `e164` number. This will
 * return `null` if the number is not strictly E164.
 * @param e164 - The E164 number.
 * @returns A `PhoneNumber` or `null` if the text isn't strict E164.
 */
export function getPhoneNumberFromE164(e164: string): PhoneNumber | null {
  // So its actually difficult to validate a number in a particular format with
  // libphonenumber... This hack checks for errors thrown with an invalid
  // number and checks that the e164 formatted number is the same as the input
  try {
    const num = phoneUtil.parse(e164);
    if (e164 !== phoneUtil.format(num, LPN.PhoneNumberFormat.E164)) {
      return null;
    }
    return new PhoneNumber(num);
  } catch (e) {
    return null;
  }
}

/**
 * Parses phone number text and returns a `PhoneNumber` for that text, or `null`
 * if it can't be parsed.
 * @param text - The text to be parsed.
 * @param sender_e164 - Optionally specify the sender's number to allow the
 * parser to infer which number the user is talking about based on their region.
 * @returns A `PhoneNumber` class or `null` if `text` can't be parsed.
 */
export function parsePhoneNumber(text: string, sender_e164?: string): PhoneNumber | null {
  const sender = sender_e164 && getPhoneNumberFromE164(sender_e164);
  try {
    return new PhoneNumber(phoneUtil.parse(text, (sender && sender._region) || undefined));
  } catch (e) {
    return null;
  }
}

